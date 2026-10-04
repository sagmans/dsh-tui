#!/usr/bin/env node
/** Herdr's real terminal boundary exposes dispatch and lifecycle failures invisible to standalone PTYs. */
import { spawnSync } from 'node:child_process'
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import yaml from 'js-yaml'
import { preparePtyLaunch } from './pty-launch.mjs'
import { editorText } from './dogfood-observation.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCENARIOS = JSON.parse(readFileSync(join(ROOT, 'tools/dogfood-scenarios.json'), 'utf8'))
const INVENTORY = JSON.parse(readFileSync(join(ROOT, 'tools/feature-inventory.json'), 'utf8'))
const PROFILE = 'tui'
const PACKAGE = '@sagmans/dsh-tui'
const BASE = '@deepseek-ai/dsh-base'
const PRIVATE_DIR_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const DEADLINE_MS = 30_000
const CLI_TIMEOUT_MS = 10_000
const READ_INTERVAL_MS = 100
const SETTLE_MS = 100
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024
const FREE_ENV = ['PATH', 'LANG', 'LC_ALL', 'SystemRoot', 'USER', 'LOGNAME', 'SHELL']
const STARTUP_FIELDS = ['sessionId', 'resume', 'resumePicker', 'model', 'provider', 'preset', 'color', 'bell']
const SUPPORTED = new Set(['commands', 'pickers', 'stash', 'chords', 'guards', 'stash-confirm', 'appearance', 'history', 'bindings', 'external-editor', 'completion', 'history-consent', 'external-editor-failure'])
const KEY_NAMES = { escape: 'esc', backspace: 'backspace', pageup: 'pageup', pagedown: 'pagedown' }
const SUBMIT_KEYS = new Set(['ctrl+s', 'ctrl+enter', 'alt+enter'])
const ALLOWED = new Set(['--scenario', '--launcher', '--list'])
const EXIT_MARKER = 'HERDR_DOGFOOD_EXIT'
const SHELL_MARKER = 'HERDR_DOGFOOD_SHELL_RESTORED'
const SESSION_PREFIX = 'dsh-dogfood-'
const EVIDENCE_PREFIX = '/var/tmp/dsh-tui-herdr-'
const TERMINAL = 'xterm-256color'
const PERMISSION_MODE = 'workspace-write'
const ENABLED = '1'
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 }
const PRIVATE_CONFIG = [
  'onboarding = false',
  '[terminal]',
  'default_shell = "/bin/sh"',
  'shell_mode = "non_login"',
  '[experimental]',
  'allow_nested = true',
  '[update]',
  'version_check = false',
  'manifest_check = false',
  '[ui.toast]',
  'delivery = "off"',
].join('\n') + '\n'
const options = process.argv.slice(2)
for (let i = 0; i < options.length; i++) {
  if (!ALLOWED.has(options[i])) throw new Error('herdr dogfood: unknown option ' + options[i])
  if (options[i] !== '--list' && (!options[++i] || options[i].startsWith('--'))) throw new Error('herdr dogfood: option requires a value')
}
const option = name => options[options.indexOf(name) + 1]
const selected = [...SCENARIOS.free.filter(row => SUPPORTED.has(row.id)), ...(SCENARIOS.herdr ?? [])].filter(row => !options.includes('--scenario') || row.id === option('--scenario'))
if (!selected.length) throw new Error('herdr dogfood: no supported matching scenarios')
if (options.includes('--list')) { console.log(selected.map(row => row.id).join('\n')); process.exit(0) }
if (process.env.HERDR_ENV !== ENABLED) throw new Error('herdr dogfood: requires a Herdr-managed caller pane')
const evidence = realpathSync(mkdtempSync(EVIDENCE_PREFIX))
chmodSync(evidence, PRIVATE_DIR_MODE)
const session = SESSION_PREFIX + evidence.split('-').at(-1).toLowerCase()
const config = join(evidence, 'herdr.toml')
writeFileSync(config, PRIVATE_CONFIG, { mode: PRIVATE_FILE_MODE })
const parentEnv = { ...process.env }
const serverHome = join(evidence, 'herdr-home')
mkdirSync(serverHome, { mode: PRIVATE_DIR_MODE })
const sessionEnv = Object.fromEntries(FREE_ENV.flatMap(field => process.env[field] === undefined ? [] : [[field, process.env[field]]]))
// macOS user-service startup needs the real account home; XDG state and the test config stay isolated.
sessionEnv.HOME = process.env.HOME
sessionEnv.XDG_CONFIG_HOME = serverHome
sessionEnv.XDG_STATE_HOME = serverHome
sessionEnv.TERM = TERMINAL
sessionEnv.HERDR_ENV = ENABLED
sessionEnv.HERDR_CONFIG_PATH = config
sessionEnv.HERDR_SESSION = session
const quote = value => "'" + String(value).replaceAll("'", "'\"'\"'") + "'"
const INPUT_FIELDS = new Set(['command', 'key', 'type', 'prompt', 'paste', 'outerZoom', 'resize', 'signal'])
const observations = new Map()
const results = []
let outer
let pane
let started = false
let cleanup = 'not-started'
let cancelled
let cleaning = false
const cleanupErrors = []
const signalHandlers = Object.fromEntries(Object.keys(SIGNAL_EXIT_CODES).map(signal => [signal, () => { cancelled ??= signal }]))
for (const [signal, handler] of Object.entries(signalHandlers)) process.on(signal, handler)
const herdrVersion = cli(['--version'], parentEnv).trim()

/** Nonzero transport exits must never masquerade as successful key dispatch. */
function cli(args, env = sessionEnv) {
  const result = spawnSync('herdr', args, { env, encoding: 'utf8', timeout: CLI_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES })
  if (result.error || result.status !== 0) throw new Error('herdr dogfood: ' + args.join(' ') + ': ' + (result.error?.message ?? result.stderr.trim()))
  return result.stdout
}
const json = (args, env) => JSON.parse(cli(args, env))
const save = (path, content) => writeFileSync(path, content, { mode: PRIVATE_FILE_MODE })
const visible = () => cli(['pane', 'read', pane, '--source', 'visible', '--format', 'text'])
const normalized = text => text.replace(/\s+/gu, ' ')
const key = name => cli(['pane', 'send-keys', pane, KEY_NAMES[name] ?? name])

/** Bounded current-screen reads reject stale scrollback and require a second stable observation. */
async function wait(predicate, label, read = visible) {
  const deadline = Date.now() + DEADLINE_MS
  let last = ''
  while (Date.now() < deadline) {
    if (cancelled && !cleaning) throw new Error('herdr dogfood: cancelled by ' + cancelled)
    last = read()
    if (predicate(last)) {
      await delay(SETTLE_MS)
      const settled = read()
      if (predicate(settled)) return settled
    }
    await delay(READ_INTERVAL_MS)
  }
  throw new Error('herdr dogfood: timed out waiting for ' + label + '; current screen: ' + last)
}

/** Only allocations below this run's canonical evidence directory may be removed. */
function clean(path) {
  const canonical = realpathSync(path)
  if (!canonical.startsWith(evidence + sep)) throw new Error('herdr dogfood: refusing unsafe cleanup')
  rmSync(canonical, { recursive: true })
}

async function run(scenario) {
  const steps = []
  observations.set(scenario.id, steps)
  const folder = join(evidence, scenario.id)
  const home = join(folder, 'home')
  const workspace = join(folder, 'workspace')
  const osHome = join(folder, 'os-home')
  const temp = join(folder, 'tmp')
  const profile = join(home, 'profiles', PROFILE)
  for (const path of [workspace, osHome, temp, join(profile, 'node_modules', '@sagmans')]) mkdirSync(path, { recursive: true, mode: PRIVATE_DIR_MODE })
  save(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-herdr-dogfood-profile', private: true, type: 'module', dependencies: { [PACKAGE]: 'link:' + ROOT }, dsh: { profile: { bundles: [BASE, PACKAGE] } } }))
  symlinkSync(ROOT, join(profile, 'node_modules', '@sagmans', 'dsh-tui'), 'dir')
  if (scenario.config) {
    const startup = STARTUP_FIELDS.map(field => '    ' + field + ': !!js ctx.tuiStartup.' + field).join('\n')
    const preferences = yaml.dump(scenario.config).trimEnd().split('\n').map(line => '    ' + line).join('\n')
    save(join(profile, 'cordis.patch.yml'), '- id: tui\n  config:\n' + startup + '\n' + preferences + '\n')
  }
  const safeFile = name => {
    const path = resolve(workspace, name)
    if (!path.startsWith(workspace + sep)) throw new Error('herdr dogfood: escaped scratch workspace')
    return path
  }
  for (const file of scenario.files ?? []) save(safeFile(file.path), file.content)
  const env = Object.fromEntries(FREE_ENV.flatMap(field => process.env[field] === undefined ? [] : [[field, process.env[field]]]))
  Object.assign(env, { HOME: osHome, DSH_HOME: home, TMPDIR: temp, TMP: temp, TEMP: temp, DSH_PERMISSION_MODE: PERMISSION_MODE, DSH_TELEMETRY_DISABLED: ENABLED, TERM: TERMINAL })
  if (scenario.editor) env.VISUAL = scenario.editor === 'missing'
    ? join(workspace, 'missing-editor')
    : JSON.stringify(process.execPath) + ' ' + JSON.stringify(join(ROOT, 'tools/dogfood-editor.mjs'))
  const launch = preparePtyLaunch({ home, env, launcher: options.includes('--launcher') ? option('--launcher') : '' })
  const exitFile = join(folder, 'exit-code')
  const script = join(folder, 'launch.sh')
  const command = ['env', '-i', ...Object.entries(env).map(([name, value]) => name + '=' + value), launch.command, ...launch.argsPrefix, '--profile', PROFILE, ...(scenario.args ?? [])].map(quote).join(' ')
  save(script, '#!/bin/sh\ncd ' + quote(workspace) + ' || exit 1\n' + command + '\ncode=$?\nprintf \'%s\\n\' "$code" > ' + quote(exitFile) + '\nprintf \'%s %s\\n\' ' + quote(EXIT_MARKER) + ' "$code"\n')
  cli(['pane', 'run', pane, 'sh ' + quote(script)])
  try {
    await wait(text => text.includes('ready') && text.includes('tui-session-'), 'ready session')
    cli(['pane', 'send-text', pane, '/status']); key('ctrl+s')
    await wait(text => normalized(text).includes('tokens in 0 out 0'), 'initial status receipt')
    save(join(folder, '000.txt'), visible())
    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i]
      // Retain attempts as distinct from postconditions so a transport receipt cannot inflate behavior proof.
      const observation = { index: i + 1, status: 'attempted', input: Object.fromEntries(Object.entries(step).filter(([name]) => INPUT_FIELDS.has(name))), postconditions: Object.fromEntries(Object.entries(step).filter(([name]) => !INPUT_FIELDS.has(name))), artifact: scenario.id + '/' + String(i + 1).padStart(3, '0') + '.txt' }
      steps.push(observation)
      const before = visible()
      if (step.command !== undefined) {
        if (/[\x00-\x1f\x7f]/u.test(step.command) || !INVENTORY.commands.some(row => row.command === step.command.split(' ')[0])) throw new Error('herdr dogfood: nonlocal or unsafe command')
        const submit = step.submit ?? 'ctrl+s'
        if (!SUBMIT_KEYS.has(submit)) throw new Error('herdr dogfood: unsupported submit key')
        key('ctrl+u'); cli(['pane', 'send-text', pane, step.command]); key(submit)
      } else if (step.key !== undefined) {
        if (SUBMIT_KEYS.has(step.key)) throw new Error('herdr dogfood: standalone submit refused')
        key(step.key)
      } else if (step.type !== undefined) {
        if (/[\x00-\x08\x0b-\x1f\x7f]/u.test(step.type)) throw new Error('herdr dogfood: unsafe typed input')
        cli(['pane', 'send-text', pane, step.type])
      } else if (step.outerZoom !== undefined) {
        const previousRows = json(['pane', 'get', pane]).result.pane.scroll.viewport_rows
        cli(['pane', 'zoom', outer, step.outerZoom ? '--on' : '--off'], parentEnv)
        const geometry = await wait(text => {
          const rows = JSON.parse(text).result.pane.scroll.viewport_rows
          return rows > 0 && rows !== previousRows
        }, 'actual terminal geometry change', () => cli(['pane', 'get', pane]))
        save(join(folder, 'geometry-' + String(i + 1) + '.json'), geometry)
      } else if (step.file !== undefined) {
        const path = safeFile(step.file)
        if (!realpathSync(path).startsWith(workspace + sep) || lstatSync(path).isSymbolicLink()) throw new Error('herdr dogfood: unsafe file assertion')
        const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        try {
          const stat = fstatSync(fd)
          if (!stat.isFile() || stat.nlink !== 1) throw new Error('herdr dogfood: shared file assertion refused')
          const content = readFileSync(fd, 'utf8')
          if (step.contains !== undefined && !content.includes(step.contains)) throw new Error('herdr dogfood: missing durable content')
          if (step.mode !== undefined && (stat.mode & 0o777) !== step.mode) throw new Error('herdr dogfood: wrong private file mode')
        } finally { closeSync(fd) }
      } else if (Object.keys(step).some(field => !['expect', 'absent', 'scope', 'settled', 'changed'].includes(field))) {
        throw new Error('herdr dogfood: unsupported step ' + (i + 1))
      }
      if (step.exit) await wait(text => text.includes(EXIT_MARKER), 'exit receipt')
      else if (step.expect !== undefined || step.absent !== undefined || step.changed) {
        await wait(text => {
          const scoped = step.scope === 'editor' ? editorText(text) : text
          if (scoped === undefined) return false
          const value = normalized(scoped)
          return (step.expect === undefined || value.includes(normalized(step.expect))) && (step.absent === undefined || !value.includes(normalized(step.absent))) && (!step.changed || text !== before) && (!step.settled || text.trimEnd().split('\n').slice(-4).some(line => line.includes('ready')))
        }, JSON.stringify(step.expect ?? step.absent ?? 'changed frame'))
      } else if (step.file === undefined) throw new Error('herdr dogfood: missing postcondition')
      const observed = visible()
      save(join(folder, String(i + 1).padStart(3, '0') + '.txt'), observed)
      Object.assign(observation, { status: 'postconditions-satisfied', frameChanged: observed !== before })
    }
    if (!existsSync(exitFile)) { key('ctrl+c'); key('ctrl+u'); cli(['pane', 'send-text', pane, '/quit']); key('ctrl+s') }
    await wait(() => existsSync(exitFile), 'durable process exit')
    if (readFileSync(exitFile, 'utf8').trim() !== String(scenario.expectExit ?? 0)) throw new Error('herdr dogfood: unexpected process exit')
    cli(['pane', 'run', pane, 'printf \'%s\\n\' ' + quote(SHELL_MARKER)])
    await wait(text => text.includes(SHELL_MARKER), 'usable shell restoration')
    save(join(folder, 'final.txt'), visible())
  } catch (error) {
    try { save(join(folder, 'failed.txt'), visible()) } catch (observationError) { console.error(observationError.message) }
    throw error
  } finally {
    if (existsSync(exitFile)) clean(home)
  }
}

const report = () => save(join(evidence, 'report.json'), JSON.stringify({
  transport: 'herdr', session, resources: { outer, pane, started }, cleanup, cleanupErrors, cancelled: cancelled ?? null,
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  preconditions: { managedCaller: process.env.HERDR_ENV === ENABLED, credentials: 'excluded', profileHome: 'private', shell: 'non_login', serverHome: 'account HOME; private XDG; remote update checks disabled' },
  revision: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim(),
  dirty: spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim() !== '',
  herdrVersion, scenarios: results.map(row => ({ ...row, steps: observations.get(row.id) ?? [] })),
  featureCoverage: INVENTORY.features.map(feature => ({ id: feature.id, scenarios: feature.scenarios.map(id => ({ id, status: results.find(row => row.id === id)?.status ?? 'not-run-on-herdr' })) })),
  limits: ['Current pane cells and durable effects only; no physical keyboard or hardware-latency proof.', 'Shell usability is restoration evidence; standalone PTY gate owns raw escape restoration assertions.'],
}, null, 2) + '\n')

console.log('herdr dogfood: free, credential-free; evidence ' + evidence)
try {
  cli(['config', 'check'])
  outer = json(['pane', 'split', '--current', '--direction', 'down', '--cwd', evidence, '--no-focus'], parentEnv).result.pane.pane_id
  const nested = ['env', '-i', ...Object.entries(sessionEnv).map(([name, value]) => name + '=' + value), 'herdr', '--session', session].map(quote).join(' ')
  const nestedScript = join(evidence, 'nested.sh')
  save(nestedScript, '#!/bin/sh\nexec ' + nested + '\n')
  cli(['pane', 'run', outer, 'sh ' + quote(nestedScript)], parentEnv)
  started = true
  await wait(text => { try { return JSON.parse(text).result.panes.length > 0 } catch { return false } }, 'named session readiness', () => { try { return cli(['pane', 'list']) } catch { return '' } })
  const anchor = json(['pane', 'list']).result.panes[0].pane_id
  cli(['pane', 'zoom', outer, '--on'], parentEnv)
  for (const scenario of selected) {
    try {
      pane = json(['pane', 'split', anchor, '--direction', 'down', '--cwd', evidence, '--no-focus']).result.pane.pane_id
      cli(['pane', 'zoom', pane, '--on'])
      await run(scenario)
      cli(['pane', 'close', pane])
      results.push({ id: scenario.id, status: 'passed', assertions: scenario.steps.length })
      console.log('herdr dogfood: PASS ' + scenario.id)
    } catch (error) {
      results.push({ id: scenario.id, status: 'failed', error: error.message })
      console.error(error.message); process.exitCode = 1
      // A failed interactive run may still own input; subsequent commands must never enter that application.
      break
    }
    report()
  }
} catch (error) {
  if (outer) {
    try { save(join(evidence, 'startup-failed.txt'), cli(['pane', 'read', outer, '--source', 'recent', '--lines', '80', '--format', 'text'], parentEnv)) }
    catch (observationError) { console.error(observationError.message) }
  }
  console.error(error.message); process.exitCode = 1
} finally {
  cleaning = true
  // One failed cleanup must not strand independently owned panes or credential-free homes.
  const attempt = operation => {
    try { operation() } catch (error) { cleanupErrors.push(error.message); console.error(error.message) }
  }
  if (started) {
    let owned
    attempt(() => {
      const current = json(['session', 'list', '--json'])
      owned = (Array.isArray(current) ? current : current.sessions)?.find(row => row.name === session)
    })
    if (owned?.running) attempt(() => cli(['session', 'stop', session, '--json']))
    if (owned) attempt(() => cli(['session', 'delete', session, '--json']))
    attempt(() => {
      const listed = json(['session', 'list', '--json'])
      const sessions = Array.isArray(listed) ? listed : listed.sessions
      if (!Array.isArray(sessions) || sessions.some(row => row.name === session)) throw new Error('herdr dogfood: owned session survived cleanup')
    })
  }
  if (outer) {
    attempt(() => cli(['pane', 'close', outer], parentEnv))
    attempt(() => {
      if (json(['pane', 'list'], parentEnv).result.panes.some(row => row.pane_id === outer)) throw new Error('herdr dogfood: outer pane survived cleanup')
    })
  }
  for (const scenario of selected) {
    const home = join(evidence, scenario.id, 'home')
    if (existsSync(home)) attempt(() => clean(home))
  }
  cleanup = cleanupErrors.length ? 'failed' : 'verified'
  if (cleanupErrors.length) process.exitCode = 1
  if (cancelled) process.exitCode = SIGNAL_EXIT_CODES[cancelled]
  report()
  for (const [signal, handler] of Object.entries(signalHandlers)) process.removeListener(signal, handler)
}
console.log('herdr dogfood: ' + results.filter(row => row.status === 'passed').length + '/' + selected.length + ' passed; cleanup ' + cleanup)
