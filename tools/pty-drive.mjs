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
 *   node tools/pty-drive.mjs --home DIR --prompt "Reply with exactly: pong" [--seconds 30]
 *   node tools/pty-drive.mjs --home DIR --prompt "Run: echo hi" --approve 20 [--permission-mode danger-full-access]
 *   node tools/pty-drive.mjs --home DIR --prelude "/permission workspace-write" --prompt "Run: echo hi" --approve 15
 *   node tools/pty-drive.mjs --home DIR --prompt "Ask which colour" --answer "20:1,22:enter"
 *   node tools/pty-drive.mjs --home DIR --prelude "/preset " --prompt "" --answer "2:down-press,3:down-release" \
 *     --expect-last-pattern "❯ ([a-z]+)" --expect-last ptc
 *   node tools/pty-drive.mjs --home DIR --args "--resume" --prompt "" --answer "4:enter"
 *   node tools/pty-drive.mjs --home DIR --cols 40 --prompt "Ask which colour" --answer "20:0,22:teal,24:enter"
 *   node tools/pty-drive.mjs --home DIR --prompt "" --answer "8:0,9:eu-central,11:left,12:left,13:X,15:enter" \
 *     --args "--patch /tmp/ask.patch.yml"   # edit a typed answer mid-text
 *   node tools/pty-drive.mjs --home DIR --prompt "say hi" --signal TERM
 *   node tools/pty-drive.mjs --home DIR --prompt "say hi" --submit ctrl+enter
 *   node tools/pty-drive.mjs --home DIR --prompt "say hi" --submit alt-enter   # legacy ESC CR
 *   node tools/pty-drive.mjs --home DIR --launcher /path/to/dsh/lib/bin.js --prompt "say hi"
 *
 * Every run ends by reporting the child's exit code and whether the terminal
 * was handed back, because a surface that exits cleanly but leaves the shell in
 * raw mode has failed the reader.
 *
 * --launcher selects an installed release binary when PATH points elsewhere.
 * The driver rejects source-host versions before it builds or opens a PTY.
 *
 * --approve N answers the approval gate N seconds after the prompt; without it
 * a turn that needs a gated tool waits for a decision the harness never makes.
 *
 * --click "SECONDS:ROW[:COL]" presses and releases the left button at a screen
 * cell, in the SGR coordinates the surface asks the terminal to report. A row a
 * reader reaches by pointing at it has no key, so the only way to prove the
 * click is to send the bytes a terminal would.
 *
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pty from 'node-pty'
import { preparePtyLaunch } from './pty-launch.mjs'

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

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const prompt = option('prompt', 'Reply with exactly: pong')
/** Launcher arguments for the child, for reaching a mode the default run does not. */
const extraArgs = option('args', '').split(' ').filter(argument => argument !== '')
const home = option('home', undefined)
/** An installed dsh binary to reproduce a specific released host. */
const launcher = option('launcher', '')
const seconds = Number.parseInt(option('seconds', '45'), 10)
const approve = Number.parseInt(option('approve', '0'), 10)
/** The terminal size the child sees, so a report can pin a surface a laptop screen would not show. */
const cols = Number.parseInt(option('cols', '100'), 10)
const rows = Number.parseInt(option('rows', '30'), 10)
/** A slash command sent before the prompt, for reaching a state the prompt assumes. */
const prelude = option('prelude', '')
/**
 * Gate answers as "seconds:value" pairs, where a value is literal text or one
 * of the named keys. A question gate needs a pick and a confirm, which one
 * hardcoded approval key cannot express. An arrow key is a press and a release
 * under the keyboard protocol the surface enables, so both forms are nameable:
 * a handler that acts on the release would step twice per key.
 */
const NAMED_KEYS = {
  enter: '\r',
  // Sending a prompt is a chord in this bar, because Enter breaks the line: the
  // byte a terminal sends for the letter, and the two spellings of the chord a
  // terminal that reports modifiers can send for it.
  submit: '\u0013',
  'ctrl+enter': '\u001b[13;5u',
  'alt-enter': '\u001b\r',
  space: ' ',
  up: '\u001b[A',
  down: '\u001b[B',
  // Movement keys decide whether an answer is edited where the cursor is or
  // only at its end, which is the difference between a field and a text buffer.
  left: '\u001b[D',
  right: '\u001b[C',
  esc: '\u001b',
  // The delete byte a terminal sends for Backspace, which is not Ctrl+B: that is
  // cursor-left, and a run that meant to erase would silently walk instead.
  back: '\u007f',
  'ctrl+t': '\u0014',
  'ctrl+y': '\u0019',
  // The two control keys the surface answers itself: Ctrl+C cancels one state
  // and never leaves, so a run can reach a state without ending the session;
  // Ctrl+D is the only key that leaves, which is what a run proves when it
  // expects exit 0 without the harness's own quit sequence.
  'ctrl+c': '\u0003',
  'ctrl+d': '\u0004',
  // A key a reader may move submit to, which is the point of driving the
  // surface with a settings document: the chord has to arrive as the byte the
  // terminal sends for it, not as the name the map spells.
  'ctrl+g': '\u0007',
  // The navigation aliases, which arrive as the control bytes a terminal sends
  // for the letters rather than as the names the map spells.
  'ctrl+n': '\u000e',
  'ctrl+p': '\u0010',
  'alt+d': '\u001bd',
  // A terminal that speaks the keyboard protocol reports alt+letter as a
  // codepoint with a modifier rather than as an escape followed by the letter.
  // Both spellings are listed, but neither reaches the surface through a pty
  // driven this way — the shipped alt+d binding does not react to either — so
  // no run here can prove an alt+letter binding; only the unit specs can.
  'alt+d-kitty': '\u001b[100;3u',
  'alt+z-kitty': '\u001b[122;3u',
  // The chord prefix has no printable byte: it arrives as the control the
  // terminal sends for the letter, which is what makes a two-key run drivable.
  'ctrl+x': '\u0018',
  // The map's second keys that are printable bytes are sent as themselves; they
  // are named here because this table is the account of what a run can press,
  // and a second key with no row would read as one the harness cannot reach.
  '?': '?',
  n: 'n',
  // The undo pair's second keys, printable bytes like n, named here because this
  // table is the account of what a run can press.
  u: 'u',
  r: 'r',
  // Shift+Tab is CBT (CSI Z), distinct from the plain Tab an editor completes on.
  'shift+tab': '\u001b[Z',
  // The transcript search opens on shift+ctrl+f, a chord no single byte carries,
  // so only the keyboard protocol's codepoint spelling reaches it in a run.
  'ctrl+shift+f': '\u001b[102;6u',
  // The surface asks the terminal to report key events, so a real arrow press
  // arrives as a press followed by a release. A run that only sends the legacy
  // sequence above cannot see a handler that acts on both.
  'down-press': '\u001b[1;1B',
  'down-release': '\u001b[1;1:3B',
  'up-press': '\u001b[1;1A',
  'up-release': '\u001b[1;1:3A',
}
/**
 * Marker that wraps the rest of an answer in a bracketed paste, so a run can
 * prove a pasted block arrives whole instead of as the characters a reader
 * would have typed one at a time.
 */
const PASTE_PREFIX = 'paste:'
/**
 * The chord that sends the prompt, named from the table a gate answer uses.
 *
 * A run that says nothing sends with Ctrl+S, which reaches the surface in every
 * terminal; naming a chord drives the path a real keyboard would instead.
 */
const submitName = option('submit', 'submit')
const submit = NAMED_KEYS[submitName] ?? submitName
/**
 * Point-and-click gestures as "seconds:row[:col]" triples, 1-based like the
 * coordinates a terminal reports.
 *
 * The press and the release are sent as one gesture a frame apart, because a
 * surface that answers on the release would otherwise never see the pair a
 * real mouse produces.
 */
const clicks = option('click', '')
  .split(',')
  .filter(entry => entry !== '')
  .map(entry => {
    const [seconds, row, col] = entry.split(':')
    return {
      at: Number.parseInt(seconds, 10),
      row: Number.parseInt(row ?? '1', 10),
      col: Number.parseInt(col ?? '1', 10),
    }
  })
const answers = option('answer', '')
  .split(',')
  .filter(entry => entry !== '')
  .map(entry => {
    const [seconds, ...rest] = entry.split(':')
    const text = rest.join(':')
    const value = text.startsWith(PASTE_PREFIX)
      ? `\u001b[200~${text.slice(PASTE_PREFIX.length)}\u001b[201~`
      : NAMED_KEYS[text] ?? text
    return { at: Number.parseInt(seconds, 10), value }
  })
/**
 * Drive the child at the policy a user gets, not the one this harness inherits:
 * an agent session running with approvals off would silently auto-allow the very
 * gate the run is meant to exercise.
 */
const permissionMode = option('permission-mode', 'workspace-write')
/**
 * End the run with a signal instead of the quit sequence, to exercise the
 * launcher's shutdown path rather than the surface's own.
 */
const signalOption = option('signal', '')
// process.kill takes POSIX names, so accept the short form a reader would type.
const signal = signalOption === '' || signalOption.startsWith('SIG') ? signalOption : `SIG${signalOption.toUpperCase()}`
const keep = option('log', join(tmpdir(), `dsh-tui-pty-${Date.now()}.log`))
/** Exit code the run is expected to end with, so a broken boot fails the harness. */
const expectExit = Number.parseInt(option('expect-exit', '0'), 10)
/**
 * A regex whose last match on the final screen must equal `--expect-last`.
 *
 * A frame is repainted many times, so searching the whole screen cannot tell a
 * state from a state the surface has left; the last match is where it settled.
 * That is how a cursor row is asserted without a screenshot.
 */
const expectLastPattern = option('expect-last-pattern', '')
const expectLast = option('expect-last', '')

const launch = preparePtyLaunch({ home, launcher })
build()
ensureSpawnHelper()

const child = pty.spawn(launch.command, [...launch.argsPrefix, '--profile', 'tui', ...extraArgs], {
  name: 'xterm-256color',
  cols,
  rows,
  cwd: launch.cwd,
  env: {
    ...process.env,
    TERM: 'xterm-256color',
    DSH_PERMISSION_MODE: permissionMode,
    DSH_HOME: launch.home,
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
/** The gap between a click's press and its release, short enough to be one gesture. */
const CLICK_RELEASE_MS = 60
const PRELUDE_LEAD_MS = 1500
const promptAt = PRELUDE_AT_MS + (prelude === '' ? 0 : PRELUDE_LEAD_MS)
if (prelude !== '') at(PRELUDE_AT_MS, () => child.write(`${prelude}${submit}`))
// An empty prompt drives a surface that asks its own question first, such as
// the session picker a bare --resume opens. A prompt that is sent ends with the
// submit chord rather than Enter, which writes a line instead.
if (prompt !== '') at(promptAt, () => child.write(`${prompt}${submit}`))
if (approve > 0) at(promptAt + approve * 1000, () => child.write('y'))
for (const answer of answers) at(promptAt + answer.at * 1000, () => child.write(answer.value))
for (const click of clicks) {
  // The press and the release are one gesture a frame apart, as a real mouse
  // sends them: a surface that answered on the release would never see a press
  // alone.
  const cell = `\u001b[<0;${click.col};${click.row}`
  at(promptAt + click.at * 1000, () => child.write(`${cell}M`))
  at(promptAt + click.at * 1000 + CLICK_RELEASE_MS, () => child.write(`${cell}m`))
}
/** Sequences a terminal must see before the shell is usable again. */
const RESTORE_SEQUENCES = {
  'alt screen': '\u001b[?1049l',
  'cursor shown': '\u001b[?25h',
  'mouse released': '\u001b[?1006l',
}

if (signal === '') {
  at(promptAt + seconds * 1000, () => child.write('\u0003'))
  // Kill the line first: a stray key left in the editor would turn the quit
  // sequence into an ordinary prompt and leave the session running.
  at(promptAt + seconds * 1000 + 500, () => child.write(`\u0015/quit${submit}`))
} else {
  at(promptAt + seconds * 1000, () => {
    // The pty child is a session leader whose own child is the harness's real
    // target: signalling only the launcher shim leaves the surface running with
    // a dead terminal, which proves nothing about its shutdown path.
    try {
      process.kill(-child.pid, signal)
    } catch {
      try {
        process.kill(child.pid, signal)
      } catch (error) {
        console.error(`pty-drive: could not send ${signal}: ${error.message}`)
      }
    }
  })
}

/** How long the child is given to exit before the harness stops waiting. */
const EXIT_GRACE_MS = 12_000
let exitInfo
let reported = false

function finish() {
  if (reported) return
  reported = true
  mkdirSync(join(keep, '..'), { recursive: true })
  writeFileSync(keep, raw)
  const screen = strip(raw).split('\n').map(line => line.trimEnd()).filter((line, index, all) => line !== '' || all[index - 1] !== '')
  console.log(screen.join('\n').slice(-6000))
  const missing = Object.entries(RESTORE_SEQUENCES).filter(([, sequence]) => !raw.includes(sequence)).map(([name]) => name)
  console.log(`\n--- exit: code=${exitInfo?.exitCode ?? 'none'} signal=${exitInfo?.signal ?? 'none'}`)
  console.log(`--- terminal restored: ${missing.length === 0 ? 'yes' : `no (missing ${missing.join(', ')})`}`)
  console.log(`--- raw log: ${keep} (${raw.length} bytes) ---`)
  // A run that fails the application must fail the harness: a screen that looks
  // right is not the contract, a clean exit is part of it.
  const problems = []
  const code = exitInfo?.exitCode
  if (code !== expectExit) {
    problems.push(`expected exit ${expectExit}, got ${code ?? 'no exit before the grace deadline'}`)
  }
  if (expectLastPattern !== '') {
    const matches = [...strip(raw).matchAll(new RegExp(expectLastPattern, 'gu'))]
    const last = matches.at(-1)
    const seen = last === undefined ? 'no match' : (last[1] ?? last[0])
    if (seen !== expectLast) {
      problems.push(`expected the last /${expectLastPattern}/ on screen to be ${JSON.stringify(expectLast)}, saw ${JSON.stringify(seen)}`)
    }
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`pty-drive: ${problem}`)
    process.exit(1)
  }
  process.exit(0)
}

child.onExit(info => {
  exitInfo = info
  finish()
})

at(promptAt + seconds * 1000 + EXIT_GRACE_MS, () => {
  child.kill()
  finish()
})
