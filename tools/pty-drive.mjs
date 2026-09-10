#!/usr/bin/env node
/**
 * Drive the terminal surface inside a real PTY.
 *
 * The surface refuses to start without a TTY, so an automated check has to
 * allocate one. This harness answers the questions a unit test cannot: does the
 * profile boot, does submitted text reach the agent, and what does the human
 * actually see on screen.
 *
 * Usage:
 *   node tools/pty-drive.mjs --prompt "Reply with exactly: pong" [--home DIR] [--seconds 30]
 *   node tools/pty-drive.mjs --prompt "Run: echo hi" --approve 20 [--permission-mode danger-full-access]
 *   node tools/pty-drive.mjs --prelude "/permission workspace-write" --prompt "Run: echo hi" --approve 15
 *   node tools/pty-drive.mjs --prompt "Ask which colour" --answer "20:1,22:enter"
 *   node tools/pty-drive.mjs --args "--resume" --prompt "" --answer "4:enter"
 *
 * --approve N answers the approval gate N seconds after the prompt; without it
 * a turn that needs a gated tool waits for a decision the harness never makes.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pty from 'node-pty'

/**
 * Rebuild before driving.
 *
 * A linked profile loads the package's built entry point, so edits under src/
 * are invisible until the build runs: without this step the harness would
 * happily verify the previous release of the surface.
 */
function build() {
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  const result = spawnSync('pnpm', ['build'], { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) {
    console.error('pty-drive: build failed; refusing to drive a stale surface')
    process.exit(1)
  }
}

build()

/**
 * node-pty ships its macOS spawn helper without the executable bit, and a PTY
 * cannot be allocated without it. Repairing the packaged file here keeps the
 * harness runnable without patching a dependency for a dev-only tool.
 */
function ensureSpawnHelper() {
  if (process.platform !== 'darwin') return
  const require = createRequire(import.meta.url)
  const root = dirname(require.resolve('node-pty/package.json'))
  const helper = join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
  try {
    const mode = statSync(helper).mode
    if ((mode & 0o111) === 0) chmodSync(helper, mode | 0o755)
  } catch {
    // A missing prebuild means node-pty built from source; nothing to repair.
  }
}

ensureSpawnHelper()

const DSH_CHECKOUT = '/Users/dev/source/opensource/deepseek-harness/master'
const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const prompt = option('prompt', 'Reply with exactly: pong')
/** Launcher arguments for the child, for reaching a mode the default run does not. */
const extraArgs = option('args', '').split(' ').filter(argument => argument !== '')
const home = option('home', undefined)
const seconds = Number.parseInt(option('seconds', '45'), 10)
const approve = Number.parseInt(option('approve', '0'), 10)
/** A slash command sent before the prompt, for reaching a state the prompt assumes. */
const prelude = option('prelude', '')
/**
 * Gate answers as "seconds:value" pairs, where a value is literal text or one
 * of the named keys. A question gate needs a pick and a confirm, which one
 * hardcoded approval key cannot express.
 */
const NAMED_KEYS = { enter: '\r', space: ' ', up: '\u001b[A', down: '\u001b[B', esc: '\u001b' }
const answers = option('answer', '')
  .split(',')
  .filter(entry => entry !== '')
  .map(entry => {
    const [seconds, ...rest] = entry.split(':')
    const value = rest.join(':')
    return { at: Number.parseInt(seconds, 10), value: NAMED_KEYS[value] ?? value }
  })
/**
 * Drive the child at the policy a user gets, not the one this harness inherits:
 * an agent session running with approvals off would silently auto-allow the very
 * gate the run is meant to exercise.
 */
const permissionMode = option('permission-mode', 'workspace-write')
const keep = option('log', join(tmpdir(), `dsh-tui-pty-${Date.now()}.log`))

const child = pty.spawn('pnpm', ['dsh', '--profile', 'tui', ...extraArgs], {
  name: 'xterm-256color',
  cols: 100,
  rows: 30,
  cwd: DSH_CHECKOUT,
  env: {
    ...process.env,
    TERM: 'xterm-256color',
    DSH_PERMISSION_MODE: permissionMode,
    ...(home === undefined ? {} : { DSH_HOME: home }),
  },
})

let raw = ''
child.onData(chunk => {
  raw += chunk
})

const strip = text => text
  .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/gu, '')
  .replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/gu, '')
  .replace(/\u001B[@-Z\\-_]/gu, '')

const at = (ms, action) => setTimeout(action, ms)
const PRELUDE_AT_MS = 6000
const PRELUDE_LEAD_MS = 1500
const promptAt = PRELUDE_AT_MS + (prelude === '' ? 0 : PRELUDE_LEAD_MS)
if (prelude !== '') at(PRELUDE_AT_MS, () => child.write(`${prelude}\r`))
// An empty prompt drives a surface that asks its own question first, such as
// the session picker a bare --resume opens.
if (prompt !== '') at(promptAt, () => child.write(`${prompt}\r`))
if (approve > 0) at(promptAt + approve * 1000, () => child.write('y'))
for (const answer of answers) at(promptAt + answer.at * 1000, () => child.write(answer.value))
at(promptAt + seconds * 1000, () => child.write('\u0003'))
// Kill the line first: a stray key left in the editor would turn the quit
// sequence into an ordinary prompt and leave the session running.
at(promptAt + seconds * 1000 + 500, () => child.write('\u0015/quit\r'))
at(9000 + seconds * 1000, () => {
  child.kill()
  mkdirSync(join(keep, '..'), { recursive: true })
  writeFileSync(keep, raw)
  const screen = strip(raw).split('\n').map(line => line.trimEnd()).filter((line, index, all) => line !== '' || all[index - 1] !== '')
  console.log(screen.join('\n').slice(-6000))
  console.log(`\n--- raw log: ${keep} (${raw.length} bytes) ---`)
  process.exit(0)
})