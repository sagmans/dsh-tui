#!/usr/bin/env node
/** A private tmux server proves multiplexed input and restoration without borrowing the operator's session. */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { preparePtyLaunch } from './pty-launch.mjs'
import { editorText } from './dogfood-observation.mjs'
import { LOCAL_COMMANDS } from '../lib/input/submission.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCENARIOS = JSON.parse(readFileSync(join(ROOT, 'tools/dogfood-scenarios.json'), 'utf8')).tmux
const PRIVATE_DIR_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const COLS = 100
const ROWS = 30
const DEADLINE_MS = 30_000
const CLI_TIMEOUT_MS = 10_000
const INTERVAL_MS = 100
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 }
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024
const FREE_ENV = ['PATH', 'LANG', 'LC_ALL', 'SystemRoot']
const SHELL = '/bin/sh'
const PROFILE = 'tui'
const PACKAGE = '@sagmans/dsh-tui'
const BASE = '@deepseek-ai/dsh-base'
const TERMINAL = 'xterm-256color'
const EXIT_MARKER = 'TMUX_DOGFOOD_EXIT'
const RESTORED_MARKER = 'TMUX_DOGFOOD_SHELL_RESTORED'
const KEY_NAMES = { left: 'Left', backspace: 'BSpace', escape: 'Escape', enter: 'Enter', 'ctrl+x': 'C-x', 'ctrl+c': 'C-c' }
const LAUNCHER_OPTION = '--launcher'
const options = process.argv.slice(2)
if (options.length !== 0 && (options.length !== 2 || options[0] !== LAUNCHER_OPTION || !options[1] || options[1].startsWith('--'))) throw new Error('tmux dogfood: only --launcher PATH is supported')
const launcher = options[1] ?? ''
const version = spawnSync('tmux', ['-V'], { encoding: 'utf8', timeout: CLI_TIMEOUT_MS })
if (version.error || version.status !== 0) throw new Error('tmux dogfood: tmux unavailable: ' + (version.error?.message ?? version.stderr))
const evidence = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-tui-tmux-')))
chmodSync(evidence, PRIVATE_DIR_MODE)
const socket = join(evidence, 'tmux.sock')
const home = join(evidence, 'home')
const osHome = join(evidence, 'os-home')
const workspace = join(evidence, 'workspace')
const temp = join(evidence, 'tmp')
const profile = join(home, 'profiles', PROFILE)
const env = Object.fromEntries(FREE_ENV.flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]]]))
Object.assign(env, { HOME: osHome, DSH_HOME: home, SHELL, TERM: TERMINAL, TMPDIR: temp, TMP: temp, TEMP: temp, DSH_PERMISSION_MODE: 'workspace-write', DSH_TELEMETRY_DISABLED: '1' })
const quote = value => "'" + String(value).replaceAll("'", "'\"'\"'") + "'"
const save = (name, value) => writeFileSync(join(evidence, name), value, { mode: PRIVATE_FILE_MODE })
const observations = []
let pane
let serverPid
let started = false
let status = 'failed'
let error
const cleanupErrors = []
let cancelled
let cleaning = false
const signalHandlers = Object.fromEntries(Object.keys(SIGNAL_EXIT_CODES).map(signal => [signal, () => { cancelled ??= signal }]))
for (const [signal, handler] of Object.entries(signalHandlers)) process.on(signal, handler)

/** Every command binds the private socket; a missing selector must never fall back to the user's server. */
function tmux(args) {
  const result = spawnSync('tmux', ['-S', socket, '-f', '/dev/null', ...args], { env, cwd: evidence, encoding: 'utf8', timeout: CLI_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES })
  if (result.error || result.status !== 0) throw new Error('tmux dogfood: ' + args.join(' ') + ': ' + (result.error?.message ?? result.stderr.trim()))
  return result.stdout
}
const capture = () => tmux(['capture-pane', '-p', '-t', pane])

/** Stable current cells prevent a previous redraw or history line from satisfying a new interaction. */
async function wait(predicate, label, read = capture) {
  const deadline = Date.now() + DEADLINE_MS
  let text = ''
  while (Date.now() < deadline) {
    if (cancelled && !cleaning) throw new Error('tmux dogfood: cancelled by ' + cancelled)
    text = read()
    if (predicate(text)) {
      await delay(INTERVAL_MS)
      const next = read()
      if (predicate(next)) return next
    }
    await delay(INTERVAL_MS)
  }
  throw new Error('tmux dogfood: timed out waiting for ' + label + '; current cells: ' + text)
}

console.log('tmux dogfood: free, credential-free; evidence ' + evidence)
try {
  for (const path of [osHome, workspace, temp, join(profile, 'node_modules', '@sagmans')]) mkdirSync(path, { recursive: true, mode: PRIVATE_DIR_MODE })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-tmux-dogfood-profile', private: true, type: 'module', dependencies: { [PACKAGE]: 'link:' + ROOT }, dsh: { profile: { bundles: [BASE, PACKAGE] } } }), { mode: PRIVATE_FILE_MODE })
  symlinkSync(ROOT, join(profile, 'node_modules', '@sagmans', 'dsh-tui'), 'dir')
  const launch = preparePtyLaunch({ home, env, launcher })
  const command = ['env', '-i', ...Object.entries(env).map(([name, value]) => name + '=' + value), launch.command, ...launch.argsPrefix, '--profile', PROFILE].map(quote).join(' ')
  const script = join(evidence, 'launch.sh')
  save('launch.sh', '#!/bin/sh\ncd ' + quote(workspace) + ' || exit 1\n' + command + '\ncode=$?\nprintf "%s" "$code" > ' + quote(join(evidence, 'exit-code')) + '\nprintf "\\n' + EXIT_MARKER + ' %s\\n" "$code"\nexec ' + SHELL + '\n')
  pane = tmux(['new-session', '-d', '-P', '-F', '#{pane_id}', '-x', String(COLS), '-y', String(ROWS), SHELL + ' ' + quote(script)]).trim()
  started = true
  serverPid = Number(tmux(['display-message', '-p', '-t', pane, '#{pid}']).trim())
  if (!Number.isSafeInteger(serverPid) || serverPid <= 0) throw new Error('tmux dogfood: invalid owned server pid')
  if (!/^%[0-9]+$/u.test(pane)) throw new Error('tmux dogfood: missing owned pane selector')
  save('000.txt', await wait(text => text.includes('ready'), 'surface readiness'))
  if (tmux(['display-message', '-p', '-t', pane, '#{alternate_on}']).trim() !== '1') throw new Error('tmux dogfood: alternate screen did not activate')
  for (const scenario of SCENARIOS) {
    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i]
      const before = capture()
      const observation = { index: i + 1, status: 'attempted', input: { command: step.command, type: step.type, keys: step.keys }, postconditions: { expect: step.expect, absent: step.absent, scope: step.scope, exit: step.exit }, artifact: String(i + 1).padStart(3, '0') + '.txt' }
      observations.push(observation)
      if (step.command !== undefined) {
        if (!LOCAL_COMMANDS.includes(step.command.split(' ')[0]) || /[\x00-\x1f\x7f]/u.test(step.command)) throw new Error('tmux dogfood: nonlocal command refused')
        tmux(['send-keys', '-t', pane, 'C-e', 'C-u'])
        tmux(['send-keys', '-l', '-t', pane, step.command])
        tmux(['send-keys', '-t', pane, 'C-s'])
      } else if (step.type !== undefined) {
        if (/[\x00-\x1f\x7f]/u.test(step.type)) throw new Error('tmux dogfood: control characters refused')
        tmux(['send-keys', '-l', '-t', pane, step.type])
      } else if (step.keys) {
        for (const name of step.keys) {
          if (!Object.hasOwn(KEY_NAMES, name)) throw new Error('tmux dogfood: unsupported key')
          tmux(['send-keys', '-t', pane, KEY_NAMES[name]])
        }
      }
      const text = await wait(text => {
        if (step.exit) return text.includes(EXIT_MARKER)
        const scope = step.scope === 'editor' ? editorText(text) : text
        return scope !== undefined && (step.expect === undefined || scope.includes(step.expect)) && (step.absent === undefined || !scope.includes(step.absent))
      }, step.expect ?? 'normal-screen exit receipt')
      if (!step.exit && step.expect === undefined && step.absent === undefined) throw new Error('tmux dogfood: missing postcondition')
      save(observation.artifact, text)
      Object.assign(observation, { status: 'postconditions-satisfied', frameChanged: text !== before })
    }
  }
  if (readFileSync(join(evidence, 'exit-code'), 'utf8') !== '0' || tmux(['display-message', '-p', '-t', pane, '#{alternate_on}']).trim() !== '0') throw new Error('tmux dogfood: terminal restoration failed')
  tmux(['send-keys', '-l', '-t', pane, 'printf ' + quote('%s\\n') + ' ' + quote(RESTORED_MARKER)]); tmux(['send-keys', '-t', pane, 'Enter'])
  save('shell.txt', await wait(text => text.split('\n').some(line => line.trim() === RESTORED_MARKER), 'usable restored shell'))
  status = 'passed'
} catch (failure) {
  error = failure.message
  console.error(error)
  process.exitCode = 1
} finally {
  cleaning = true
  if (started) {
    try { tmux(['kill-server']) } catch (failure) { cleanupErrors.push(failure.message) }
    try {
      // A stale Unix socket does not prove a server lives; its manager-attested process must exit first.
      await wait(text => text === 'exited', 'owned server exit', () => {
        try { process.kill(serverPid, 0); return 'running' }
        catch (failure) { if (failure.code === 'ESRCH') return 'exited'; throw failure }
      })
      if (existsSync(socket)) {
        if (realpathSync(dirname(socket)) !== evidence || !lstatSync(socket).isSocket()) throw new Error('tmux dogfood: refusing unsafe socket cleanup')
        rmSync(socket)
      }
    } catch (failure) { cleanupErrors.push(failure.message) }
  }
  if (existsSync(home)) {
    const canonical = realpathSync(home)
    if (canonical.startsWith(evidence + sep)) rmSync(canonical, { recursive: true })
    else cleanupErrors.push('tmux dogfood: refusing unsafe home cleanup')
  }
  if (cleanupErrors.length) process.exitCode = 1
  save('report.json', JSON.stringify({ transport: 'tmux', cost: 'free', version: version.stdout.trim(), runtime: { node: process.version, platform: process.platform, arch: process.arch }, status, error, cleanup: cleanupErrors.length ? 'failed' : 'verified', cleanupErrors, resources: { pane, socket, serverPid }, scenarios: SCENARIOS.map(row => ({ id: row.id, status })), observations }, null, 2) + '\n')
  for (const [signal, handler] of Object.entries(signalHandlers)) process.off(signal, handler)
  if (cancelled) process.exitCode = SIGNAL_EXIT_CODES[cancelled]
  console.log('tmux dogfood: ' + status + '; cleanup ' + (cleanupErrors.length ? 'failed' : 'verified'))
}
