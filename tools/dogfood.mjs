#!/usr/bin/env node
/** Exercise the installed Harness and linked TUI through real PTY input, never imported handlers. */
import { spawnSync } from 'node:child_process'
import { chmodSync, closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import pty from 'node-pty'
import yaml from 'js-yaml'
import { LOCAL_COMMANDS } from '../lib/input/submission.js'
import { ACTION_CATALOG } from '../lib/input/action-catalog.js'
import { TUI_TOKENS, PALETTE_NAMES, CARD_ROW_CLASSES } from '../lib/theme-tokens.js'
import { preparePtyLaunch } from './pty-launch.mjs'
import { PtyScreen } from './pty-screen.mjs'
import { editorText } from './dogfood-observation.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCENARIOS = JSON.parse(readFileSync(join(ROOT, 'tools/dogfood-scenarios.json'), 'utf8'))
const INVENTORY = JSON.parse(readFileSync(join(ROOT, 'tools/feature-inventory.json'), 'utf8'))
if (JSON.stringify(INVENTORY.commands.map(row => row.command).sort()) !== JSON.stringify([...LOCAL_COMMANDS].sort())) throw new Error('dogfood: command inventory drifted')
if (JSON.stringify(INVENTORY.actions.map(row => [row.id, row.defaultKeys])) !== JSON.stringify(ACTION_CATALOG.map(row => [row.id, row.defaultKeys]))) throw new Error('dogfood: action inventory drifted')
if (JSON.stringify(INVENTORY.appearance.tokens) !== JSON.stringify(TUI_TOKENS) || JSON.stringify(INVENTORY.appearance.paletteNames) !== JSON.stringify(PALETTE_NAMES) || JSON.stringify(INVENTORY.appearance.cardRowClasses) !== JSON.stringify(CARD_ROW_CLASSES)) throw new Error('dogfood: appearance inventory drifted')
for (const scenario of [...SCENARIOS.free, ...SCENARIOS.paid]) {
  if (!/^[a-z][a-z0-9-]*$/u.test(scenario.id)) throw new Error('dogfood: invalid scenario id')
}
for (const feature of INVENTORY.features) {
  for (const source of feature.sources) if (!existsSync(join(ROOT, source))) throw new Error(`dogfood: missing feature owner ${source}`)
  for (const id of feature.scenarios) if (![...SCENARIOS.free, ...SCENARIOS.paid, ...SCENARIOS.manual, ...(SCENARIOS.herdr ?? [])].some(row => row.id === id)) throw new Error(`dogfood: missing scenario ${id} for ${feature.id}`)
}
for (const scenario of SCENARIOS.free) {
  if (scenario.catalog) scenario.steps = INVENTORY.actions.flatMap(row => [
    { command: `/keys ${row.layer}`, expect: 'actions' },
    { type: row.id, expect: `${row.id} =` },
    { key: 'escape', absent: 'actions' },
  ]).concat([{ command: '/quit', exit: true }])
}
const PROFILE = 'tui'
const PACKAGE = '@sagmans/dsh-tui'
const BASE = '@deepseek-ai/dsh-base'
const STARTUP_FIELDS = ['sessionId', 'resume', 'resumePicker', 'model', 'provider', 'preset', 'color', 'bell']
const COLS = 100
const ROWS = 30
const FREE_DEADLINE_MS = 15_000
const PAID_DEADLINE_MS = 180_000
const DEADLINE_MS = process.argv.includes('--paid') ? PAID_DEADLINE_MS : FREE_DEADLINE_MS
const OSC52_PREFIX = '\x1b]52;'
const FRAME_SETTLE_MS = 50
const EXIT_GRACE_MS = 5000
const MAX_RAW_BYTES = 64 * 1024 * 1024
const PRIVATE_DIR_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const TERMINAL_NAME = 'xterm-256color'
const ISOLATION_SENTINEL = 'dogfood-isolation-sentinel'
const ENABLED_ENV_VALUE = '1'
const HERDR_GATE_TIMEOUT_MS = 15 * 60 * 1000
const HERDR_RUNNER = join(ROOT, 'tools/dogfood-herdr.mjs')
const HERDR_EVIDENCE = /evidence (\S+)/u
const PERMISSION_MODE = 'workspace-write'
const EVIDENCE_PREFIX = 'dsh-tui-dogfood-'
const READY = 'ready'
const RESTORE = ['\x1b[?1049l', '\x1b[?25h', '\x1b[?1006l']
const FREE_ENV = ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SystemRoot']
const KEYS = {
  'ctrl+c': '\x03', 'ctrl+d': '\x04', 'ctrl+x': '\x18', 'ctrl+u': '\x15',
  'ctrl+s': '\x13', 'ctrl+enter': '\x1b[13;5u', 'alt+enter': '\x1b\r',
  enter: '\r', escape: '\x1b', tab: '\t', backspace: '\x7f',
  left: '\x1b[D', right: '\x1b[C', up: '\x1b[A', down: '\x1b[B',
  home: '\x1b[H', end: '\x1b[F', delete: '\x1b[3~',
  'ctrl+a': '\x01', 'ctrl+e': '\x05', 'ctrl+w': '\x17', 'ctrl+k': '\x0b',
  'ctrl+r': '\x12', 'ctrl+t': '\x14', 'ctrl+o': '\x0f', 'ctrl+y': '\x19',
  'shift+tab': '\x1b[Z', 'ctrl+shift+f': '\x1b[102;6u',
  pageup: '\x1b[5~', pagedown: '\x1b[6~',
  f2: '\x1b[1;1:1Q', f3: '\x1b[1;1:1R', f4: '\x1b[1;1:1S',
  'f2-release': '\x1b[1;1:3Q',
  'ctrl+left': '\x1b[1;5D', 'ctrl+right': '\x1b[1;5C', 'alt+d': '\x1b[100;3u', 'shift+enter': '\x1b[13;2u',
  '?': '?', m: 'm', p: 'p', y: 'y', n: 'n', s: 's', l: 'l', e: 'e', u: 'u', r: 'r',
}
KEYS['ctrl+b'] = '\x02'
const SUBMIT_KEYS = new Set(['ctrl+s', 'ctrl+enter', 'alt+enter'])
const options = process.argv.slice(2)
const ALLOWED = new Set(['--launcher', '--scenario', '--paid', '--home', '--provider', '--model', '--effort', '--list'])
for (let i = 0; i < options.length; i++) {
  if (!ALLOWED.has(options[i])) throw new Error(`dogfood: unknown option ${options[i]}`)
  if (!['--paid', '--list'].includes(options[i])) {
    if (!options[i + 1] || options[i + 1].startsWith('--')) throw new Error(`dogfood: ${options[i]} needs a value`)
    i++
  }
}
const option = name => options[options.indexOf(name) + 1]
const supplied = name => options.includes(name)
const paid = supplied('--paid')
if (!paid && ['--home', '--provider', '--model', '--effort'].some(supplied)) throw new Error('dogfood: model credentials and cloned homes require explicit --paid')
const selected = (paid ? SCENARIOS.paid : SCENARIOS.free).filter(row => !supplied('--scenario') || row.id === option('--scenario'))
if (selected.length === 0) throw new Error('dogfood: no matching scenarios')
if (supplied('--list')) { console.log(selected.map(row => row.id).join('\n')); process.exit(0) }
if (paid && !['--home', '--provider', '--model', '--scenario'].every(supplied)) throw new Error('dogfood: --paid requires --home, --provider, --model, and --scenario to bound billed work')
if (paid && ![option('--provider'), option('--model')].every(value => /^[A-Za-z0-9_./:-]+$/u.test(value))) throw new Error('dogfood: invalid paid provider/model identifier')

if (supplied('--effort') && !/^[A-Za-z0-9_-]+$/u.test(option('--effort'))) throw new Error('dogfood: invalid paid effort identifier')

// node-pty's macOS prebuild can lose its execute bit without needing a dependency reinstall.
if (process.platform === 'darwin') {
  const require = createRequire(import.meta.url)
  const helper = join(dirname(require.resolve('node-pty/package.json')), 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
  if (existsSync(helper)) chmodSync(helper, statSync(helper).mode | 0o755)
}
const evidence = realpathSync(mkdtempSync(join(tmpdir(), EVIDENCE_PREFIX)))
chmodSync(evidence, PRIVATE_DIR_MODE)
const INPUT_FIELDS = new Set(['command', 'key', 'type', 'prompt', 'paste', 'outerZoom', 'resize', 'signal'])
const observations = new Map()
const results = []
let herdr = { status: paid ? 'paid-not-run' : 'environment-not-run', reason: paid ? 'Paid verification runs only the explicitly selected scenario.' : 'Requires HERDR_ENV=1 and the installed Herdr CLI.' }
const featureCoverage = () => INVENTORY.features.map(feature => ({
  id: feature.id, cost: feature.cost,
  scope: feature.description,
  scenarios: feature.scenarios.map(id => ({ id, status: results.find(row => row.id === id)?.status ?? herdr.scenarios?.find(row => row.id === id)?.status ?? (SCENARIOS.paid.some(row => row.id === id) ? 'paid-not-run' : SCENARIOS.manual.some(row => row.id === id) || SCENARIOS.herdr?.some(row => row.id === id) ? 'environment-not-run' : 'not-run'), transports: { pty: results.find(row => row.id === id)?.status ?? 'not-run', herdr: herdr.scenarios?.find(row => row.id === id)?.status ?? (herdr.status === 'passed' ? 'not-selected-on-herdr' : herdr.status) } })),
}))
const report = () => writeFileSync(join(evidence, 'report.json'), JSON.stringify({
  revision: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim(),
  dirty: spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim() !== '',
  paid, runtime: { node: process.version, platform: process.platform, arch: process.arch }, transports: { pty: 'real-installed-profile', herdr }, featureCoverage: featureCoverage(), note: 'Scenario success is not exhaustive permutation or physical-device proof. Catalog visibility is not dispatch proof.', scenarios: results.map(row => ({ ...row, steps: observations.get(row.id) ?? [] })), deferredPaid: paid ? [] : SCENARIOS.paid.map(row => row.id),
}, null, 2) + '\n', { mode: PRIVATE_FILE_MODE })

/** Only paths exclusively allocated by this run are eligible for recursive cleanup. */
function clean(home) {
  const canonical = realpathSync(home)
  if (!canonical.startsWith(evidence + sep) || canonical === evidence) throw new Error('dogfood: refusing unsafe scratch cleanup')
  rmSync(canonical, { recursive: true, force: true })
}

/** A fresh base-backed profile avoids copying live credentials, sessions, or configuration. */
function prepareHome(id) {
  const home = join(evidence, id, 'home')
  const profile = join(home, 'profiles', PROFILE)
  mkdirSync(join(profile, 'node_modules', '@sagmans'), { recursive: true, mode: PRIVATE_DIR_MODE })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-tui-dogfood-profile', private: true, type: 'module',
    dependencies: { [PACKAGE]: 'link:' + ROOT }, dsh: { profile: { bundles: [BASE, PACKAGE] } },
  }), { mode: PRIVATE_FILE_MODE })
  symlinkSync(ROOT, join(profile, 'node_modules', '@sagmans', 'dsh-tui'), 'dir')
  return home
}

/** A scenario passes only after its visible or durable postconditions and terminal restoration pass. */
async function run(scenario, reused) {
  const steps = []
  observations.set(scenario.id, steps)
  const folder = join(evidence, scenario.id)
  mkdirSync(folder, { recursive: true, mode: PRIVATE_DIR_MODE })
  const home = reused?.home ?? (paid ? realpathSync(option('--home')) : prepareHome(scenario.id))
  if (scenario.config) {
    if (paid || reused) throw new Error('dogfood: configuration overrides require a fresh free profile')
    // The released patch replaces config wholesale, so preference scenarios must preserve live launch identity.
    const startup = STARTUP_FIELDS.map(key => `    ${key}: !!js ctx.tuiStartup.${key}`).join('\n')
    const preferences = yaml.dump(scenario.config).trimEnd().split('\n').map(line => '    ' + line).join('\n')
    writeFileSync(join(home, 'profiles', PROFILE, 'cordis.patch.yml'), `- id: tui\n  config:\n${startup}\n${preferences}\n`, { mode: PRIVATE_FILE_MODE })
  }
  for (const link of scenario.homeLinks ?? []) {
    const path = resolve(home, link.path)
    const target = resolve(home, link.target)
    if (![path, target].every(value => value.startsWith(home + sep))) throw new Error('dogfood: invalid private home link')
    mkdirSync(target, { mode: PRIVATE_DIR_MODE })
    symlinkSync(target, path)
  }
  const workspace = reused?.workspace ?? join(folder, 'workspace')
  const osHome = join(folder, 'os-home')
  mkdirSync(workspace, { recursive: true, mode: PRIVATE_DIR_MODE })
  mkdirSync(osHome, { mode: PRIVATE_DIR_MODE })
  const scratchTemp = join(folder, 'tmp')
  mkdirSync(scratchTemp, { mode: PRIVATE_DIR_MODE })
  const safeFile = (name, ownedParent = false) => {
    // Approval effects may cross the workspace boundary, but never the runner's own private allocation.
    if (ownedParent && (!paid || ownedParent !== true)) throw new Error('dogfood: owned parent assertions require paid approval verification')
    const scope = ownedParent ? folder : workspace
    const path = resolve(workspace, name)
    if (!path.startsWith(scope + sep) || isAbsolute(name)) throw new Error('dogfood: file escaped scratch scope')
    return path
  }
  for (const file of scenario.files ?? []) {
    const path = safeFile(file.path)
    if (file.symlink) symlinkSync(safeFile(file.symlink), path)
    else if (file.hardlink) linkSync(safeFile(file.hardlink), path)
    else writeFileSync(path, file.content, { mode: file.mode ?? PRIVATE_FILE_MODE })
  }
  // A paid clone owns its one credential; unrelated inherited provider keys must not authorize fallback billing.
  const env = Object.fromEntries(FREE_ENV.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]))
  const launch = preparePtyLaunch({ home, launcher: supplied('--launcher') ? option('--launcher') : '', env })
  const childEnv = { ...env, HOME: osHome, DSH_HOME: home, TMPDIR: scratchTemp, TMP: scratchTemp, TEMP: scratchTemp, DSH_PERMISSION_MODE: PERMISSION_MODE, DSH_TELEMETRY_DISABLED: ENABLED_ENV_VALUE, TERM: TERMINAL_NAME }
  if (scenario.editor) childEnv.VISUAL = scenario.editor === 'missing'
    ? join(workspace, 'missing-editor')
    : `${JSON.stringify(process.execPath)} ${JSON.stringify(join(ROOT, 'tools/dogfood-editor.mjs'))}`
  if (scenario.invocation) {
    let result
    if (scenario.tool === 'clone-helper') {
      const helper = join(ROOT, '.agents/skills/dsh-tui-dogfood/scripts/run-plugin-from-worktree.sh')
      const clone = join(folder, 'clone')
      const args = [helper, '--source-home', home, '--home', clone]
      const options = { cwd: workspace, env: { ...childEnv, DSH_DOGFOOD_DEFAULT_REPO: ROOT, DSH_DOGFOOD_REQUIRE_LISTED: ENABLED_ENV_VALUE, DSH_TUI_MOSHI_TOKEN: ISOLATION_SENTINEL, HERDR_DOGFOOD_SENTINEL: ISOLATION_SENTINEL }, encoding: 'utf8', timeout: DEADLINE_MS * 3 }
      const setup = spawnSync('bash', ['-x', ...args, '--no-launch'], options)
      writeFileSync(join(folder, 'setup.txt'), (setup.stdout ?? '') + (setup.stderr ?? ''), { mode: PRIVATE_FILE_MODE })
      const status = setup.status === 0 ? spawnSync('bash', [...args, '--status'], options) : setup
      const cleanup = spawnSync('bash', [...args, '--clean'], options)
      if (cleanup.error || cleanup.status !== 0) throw new Error(`dogfood: clone cleanup failed: ${cleanup.stderr}`)
      if (!setup.stderr?.includes('unset DSH_TUI_MOSHI_TOKEN') || !setup.stderr.includes('unset HERDR_DOGFOOD_SENTINEL')) throw new Error('dogfood: helper retained notification or pane authority')
      result = status
    } else result = scenario.tool === 'native-terminal'
      ? spawnSync(process.execPath, [join(ROOT, 'tools/terminal-behavior.mjs')], { cwd: workspace, env: childEnv, encoding: 'utf8', timeout: DEADLINE_MS * 3 })
      : scenario.tool === 'release'
      ? spawnSync('python3', [join(ROOT, 'scripts/npm/release.py'), ...scenario.invocation], { cwd: workspace, env: { ...childEnv, DRY_RUN: ENABLED_ENV_VALUE }, encoding: 'utf8', timeout: DEADLINE_MS })
      : spawnSync(launch.command, [...launch.argsPrefix, '--profile', PROFILE, ...scenario.invocation], { cwd: workspace, env: childEnv, encoding: 'utf8', timeout: DEADLINE_MS })
    const output = (result.stdout ?? '') + (result.stderr ?? '')
    writeFileSync(join(folder, 'cli.txt'), output, { mode: PRIVATE_FILE_MODE })
    if (!paid && !reused) clean(home)
    if (result.error || result.status !== (scenario.expectExit ?? 0) || !output.includes(scenario.expect)) throw new Error(`dogfood: ${scenario.id}: CLI failed: ${result.error?.message ?? output}`)
    return
  }
  const screen = new PtyScreen(COLS, ROWS)
  const child = pty.spawn(launch.command, [...launch.argsPrefix, '--profile', PROFILE, ...(scenario.args ?? [])], {
    name: TERMINAL_NAME, cols: COLS, rows: ROWS, cwd: workspace,
    env: childEnv,
  })
  let raw = ''
  let rawBytes = 0
  let generation = 0
  let status
  let pending
  let decodeFailure
  const exit = Promise.withResolvers()
  child.onData(chunk => {
    rawBytes += Buffer.byteLength(chunk)
    generation++
    if (rawBytes > MAX_RAW_BYTES) decodeFailure ??= new Error('dogfood: terminal output exceeded 64 MiB budget')
    if (!decodeFailure) {
      raw += chunk
      try { screen.write(chunk) } catch (error) { decodeFailure = error }
    }
    pending?.()
  })
  child.onExit(info => { status = info; exit.resolve(info); pending?.() })

  /** Wait on output events, then require a settled current frame rather than a prior redraw. */
  const wait = (predicate, label, after = -1) => new Promise((resolveWait, rejectWait) => {
    let settle
    const stop = error => {
      clearTimeout(deadline); clearTimeout(settle); pending = undefined
      if (error) rejectWait(error); else resolveWait()
    }
    const deadline = setTimeout(() => stop(new Error(`dogfood: ${scenario.id}: timed out waiting for ${label}`)), DEADLINE_MS)
    const check = () => {
      clearTimeout(settle)
      if (decodeFailure) { stop(decodeFailure); return }
      if (status && !predicate()) { stop(new Error(`dogfood: ${scenario.id}: exited ${status.exitCode} before ${label}`)); return }
      if (generation > after && !screen.synchronized && predicate()) settle = setTimeout(() => {
        if (!screen.synchronized && predicate()) stop(); else check()
      }, FRAME_SETTLE_MS)
    }
    pending = check
    check()
  })
  const snapshot = index => writeFileSync(join(folder, `${String(index).padStart(3, '0')}.txt`), screen.text() + '\n', { mode: PRIVATE_FILE_MODE })
  let priorScreen
  const checkStep = step => {
    const text = step.scope === 'editor' ? editorText(screen.text()) : screen.text()
    if (text === undefined) return false
    const visible = text.replace(/\s+/gu, ' ')
    return (step.expect === undefined || visible.includes(step.expect.replace(/\s+/gu, ' '))) && (step.absent === undefined || !visible.includes(step.absent.replace(/\s+/gu, ' ')))
      && (!step.changed || screen.text() !== priorScreen)
      && (!step.settled || screen.cells.slice(-4).some(row => row.join('').includes(READY)))
  }
  let failed
  try {
    await wait(() => screen.text().includes(READY) && screen.text().includes('tui-session-'), 'ready session')
    // A ready footer precedes late settings application; a status receipt proves the command plane settled before chords.
    const bootstrapGeneration = generation
    child.write(`/status${KEYS['ctrl+s']}`)
    await wait(() => screen.text().includes('tokens in 0 out 0'), 'initial status receipt', bootstrapGeneration)
    snapshot(0)
    if (paid) {
      const route = `${option('--provider')}/${option('--model')}`
      const effort = supplied('--effort') ? option('--effort') : undefined
      child.write(`/model ${route}${effort ? `/${effort}` : ''}${KEYS['ctrl+s']}`)
      await wait(() => screen.text().includes(`model set to ${route}`), 'explicit paid model route', generation - 1)
      child.write(`/status${KEYS['ctrl+s']}`)
      await wait(() => screen.text().replace(/\s+/gu, ' ').includes(`model ${route}${effort ? ` (${effort})` : ''}`), 'paid model and effort readback', generation - 1)
    }
    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i]
      // Retain attempts as distinct from postconditions so a transport receipt cannot inflate behavior proof.
      const observation = { index: i + 1, status: 'attempted', input: Object.fromEntries(Object.entries(step).filter(([name]) => INPUT_FIELDS.has(name))), postconditions: Object.fromEntries(Object.entries(step).filter(([name]) => !INPUT_FIELDS.has(name))), artifact: scenario.id + '/' + String(i + 1).padStart(3, '0') + '.txt' }
      steps.push(observation)
      const before = generation
      priorScreen = screen.text()
      const rawBefore = raw.length
      if (step.command !== undefined) {
        if (/[\x00-\x1f\x7f]/u.test(step.command)) throw new Error('dogfood: command contained terminal control input')
        if (!LOCAL_COMMANDS.includes(step.command.split(' ')[0])) throw new Error(`dogfood: nonlocal free command ${step.command}`)
        const submit = step.submit ?? 'ctrl+s'
        if (!SUBMIT_KEYS.has(submit)) throw new Error(`dogfood: invalid submit key ${submit}`)
        child.write(KEYS['ctrl+u'] + step.command + KEYS[submit])
      } else if (step.prompt !== undefined) {
        if (!paid) throw new Error('dogfood: model prompt refused without --paid')
        if (/[\x00-\x08\x0b-\x1f\x7f]/u.test(step.prompt)) throw new Error('dogfood: model prompt contained terminal control input')
        child.write('\x1b[200~' + step.prompt + '\x1b[201~' + KEYS['ctrl+s'])
      } else if (step.key !== undefined) {
        if (KEYS[step.key] === undefined || SUBMIT_KEYS.has(step.key)) throw new Error(`dogfood: invalid standalone key ${step.key}`)
        child.write(KEYS[step.key])
      } else if (step.type !== undefined) {
        if (/[\x00-\x08\x0b-\x1f\x7f]/u.test(step.type)) throw new Error('dogfood: control characters are not permitted in typed text')
        child.write(step.paste ? '\x1b[200~' + step.type + '\x1b[201~' : step.type)
      } else if (step.resize !== undefined) {
        screen.resize(...step.resize)
        child.resize(...step.resize)
      } else if (step.signal !== undefined) {
        if (!['SIGTERM', 'SIGINT'].includes(step.signal)) throw new Error('dogfood: unsupported shutdown signal')
        process.kill(-child.pid, step.signal)
      } else if (step.file !== undefined) {
        const path = safeFile(step.file, step.ownedParent)
        const scope = step.ownedParent ? folder : workspace
        // Absence counts only in a proven private parent; missing or redirected search domains do not establish rejection.
        const parent = realpathSync(dirname(path))
        if (parent !== scope && !parent.startsWith(scope + sep)) throw new Error('dogfood: file assertion followed an unsafe parent')
        if (step.missing === true) {
          try {
            lstatSync(path)
            throw new Error(`dogfood: unexpected file ${step.file}`)
          } catch (error) { if (error.code !== 'ENOENT') throw error }
        } else {
          // Model-created paths must not turn verification into a read of unrelated user data.
          if (!realpathSync(path).startsWith(scope + sep) || lstatSync(path).isSymbolicLink()) throw new Error('dogfood: file assertion followed an unsafe link')
          const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
          try {
            const stat = fstatSync(fd)
            if (!stat.isFile() || stat.nlink !== 1) throw new Error('dogfood: file assertion requires an unshared regular file')
            const content = readFileSync(fd, 'utf8')
            const proof = step.unquoted ? content.split('\n').filter(line => !line.startsWith('>') && !line.startsWith('<!--')).join('\n') : content
            if (step.contains !== undefined && !proof.includes(step.contains)) throw new Error(`dogfood: missing file content ${step.contains}`)
            if (step.mode !== undefined && (stat.mode & 0o777) !== step.mode) throw new Error(`dogfood: wrong mode for ${step.file}`)
          } finally { closeSync(fd) }
        }
      }
      if (step.exit) await wait(() => status !== undefined, 'clean exit', before)
      else if (step.expect !== undefined || step.absent !== undefined || step.changed) {
        await wait(() => checkStep(step), JSON.stringify(step.expect ?? (step.absent === undefined ? 'changed current frame' : `absence of ${step.absent}`)),
          step.file === undefined && (step.command || step.key || step.type || step.resize) ? before : -1)
      } else if (step.file === undefined) throw new Error(`dogfood: step ${i + 1} has no postcondition`)
      if (step.osc52 && !raw.slice(rawBefore).includes(OSC52_PREFIX)) throw new Error('dogfood: no OSC52 transport after copy')
      snapshot(i + 1)
      Object.assign(observation, { status: 'postconditions-satisfied', frameChanged: screen.text() !== priorScreen })
    }
    if (status === undefined) {
      child.write(KEYS['ctrl+c'] + KEYS['ctrl+u'] + '/quit' + KEYS['ctrl+s'])
      await wait(() => status !== undefined, 'clean shutdown')
    }
    if (status.exitCode !== (scenario.expectExit ?? 0)) throw new Error(`dogfood: exit code ${status.exitCode}`)
    const enteredAt = raw.lastIndexOf('\x1b[?1049h')
    for (const sequence of RESTORE) if (raw.lastIndexOf(sequence) <= enteredAt) throw new Error(`dogfood: missing terminal restoration ${JSON.stringify(sequence)}`)
    for (const escape of scenario.absentAnsi ?? []) if (raw.includes(escape)) throw new Error(`dogfood: forbidden styling ${JSON.stringify(escape)}`)
    if (scenario.continuation) {
      const id = screen.text().match(/tui-session-[a-f0-9-]+/u)?.[0]
      if (!id) throw new Error('dogfood: no resume identity after shutdown')
      await run({ ...scenario.continuation, id: scenario.id + '-restart', args: ['--resume', id] }, { home, workspace })
    }
    if (!paid && /tokens in [1-9]|out [1-9]/u.test(screen.text())) throw new Error('dogfood: free run unexpectedly used model tokens')
  } catch (error) {
    writeFileSync(join(folder, 'failed.txt'), screen.text() + '\n', { mode: PRIVATE_FILE_MODE })
    failed = error
  } finally {
    if (status === undefined) {
      child.kill('SIGTERM')
      let watchdog
      await Promise.race([exit.promise, new Promise(resolveExit => { watchdog = setTimeout(() => { child.kill('SIGKILL'); resolveExit() }, EXIT_GRACE_MS) })])
      clearTimeout(watchdog)
    }
    writeFileSync(join(folder, 'terminal.ansi'), raw, { mode: PRIVATE_FILE_MODE })
    writeFileSync(join(folder, 'final.txt'), screen.text() + '\n', { mode: PRIVATE_FILE_MODE })
    if (!paid && !reused) clean(home)
  }
  if (failed) throw failed
}

console.log(`dogfood: ${paid ? 'PAID (explicit demand)' : 'free, credential-free'}; evidence ${evidence}`)
for (const scenario of selected) {
  try {
    await run(scenario)
    results.push({ id: scenario.id, status: 'passed', assertions: scenario.steps?.length ?? 1 })
    console.log(`dogfood: PASS ${scenario.id}`)
  } catch (error) {
    results.push({ id: scenario.id, status: 'failed', error: error.message })
    console.error(error.message)
    process.exitCode = 1
  }
  report()
}
// The portable gate always runs; native Herdr checks add independent evidence only in a managed caller.
if (!paid && !process.exitCode && process.env.HERDR_ENV === ENABLED_ENV_VALUE) {
  try {
    const list = spawnSync(process.execPath, [HERDR_RUNNER, '--list'], { encoding: 'utf8', timeout: HERDR_GATE_TIMEOUT_MS, maxBuffer: MAX_RAW_BYTES })
    if (list.error || list.status !== 0) throw new Error('dogfood: Herdr scenario discovery failed')
    const available = list.stdout.trim().split('\n')
    if (!supplied('--scenario') || available.includes(option('--scenario'))) {
      const args = [HERDR_RUNNER]
      for (const name of ['--scenario', '--launcher']) if (supplied(name)) args.push(name, option(name))
      const native = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: HERDR_GATE_TIMEOUT_MS, maxBuffer: MAX_RAW_BYTES })
      process.stdout.write(native.stdout ?? '')
      process.stderr.write(native.stderr ?? '')
      const path = HERDR_EVIDENCE.exec(native.stdout ?? '')?.[1]
      if (path === undefined) throw new Error('dogfood: Herdr evidence path missing')
      const nativeReport = JSON.parse(readFileSync(join(path, 'report.json'), 'utf8'))
      herdr = { status: native.status === 0 && !native.error ? 'passed' : 'failed', evidence: path, ...nativeReport }
      if (native.error || native.status !== 0 || nativeReport.cleanup !== 'verified') throw new Error('dogfood: Herdr gate failed')
    } else herdr = { status: 'not-selected-on-herdr', reason: 'Selected scenario belongs to the portable transport.' }
  } catch (error) {
    herdr = { ...herdr, status: 'failed', error: error.message }
    console.error(error.message)
    process.exitCode = 1
  }
} else if (!paid && process.exitCode) herdr = { status: 'not-run', reason: 'Portable profile verification failed first.' }
report()
console.log('dogfood: Herdr ' + herdr.status + (herdr.reason ? '; ' + herdr.reason : ''))
console.log(`dogfood: ${results.filter(row => row.status === 'passed').length}/${selected.length} scenarios passed; paid scenarios ${paid ? 'requested' : 'not run'}`)
