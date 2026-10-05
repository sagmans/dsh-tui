#!/usr/bin/env node
/** Credential-free native PTY proof protects input and terminal ownership without host-dependent timing budgets. */
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pty from 'node-pty'
import { PtyScreen } from './pty-screen.mjs'
import { barePaneEnv } from './pty-launch.mjs'
import { CURSOR_MODES, NATIVE_CURSOR_MODE, SOFTWARE_CURSOR_MODE } from '../lib/terminal/cursor.js'
import { CARD_DETAIL_MAX } from '../lib/cards.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CHILD = join(ROOT, 'tests/fixtures/terminal-behavior.mjs')
const READY = 'terminal-behavior-ready'
const RECEIPT = 'terminal-behavior-receipt:'
const TERM = 'xterm-256color'
const COLS = 100
const ROWS = 30
// Pace input and redraws to allow asynchronous work; bound hangs with a watchdog.
// These waits are synchronization allowances, not calibrated latency acceptance budgets.
const TIMEOUT_MS = 30_000
const KEY_INTERVAL_MS = 10
const DRAIN_MS = 100
const ASCII_COUNT = 100
const ASCII_KEY = 'a'
const UNICODE_TEXT = '中😀a\u0308'
const PASTE_TEXT = 'paste中😀'
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
const PICKER_BYTES = '\x10'
const BORROW_BYTES = '\x02'
const HANDOFF_BYTES = '\x05'
const LEFT_BYTES = '\x1b[D'
const REPLACE_DRAFT_BYTES = '\x04'
const SUSPENDED = 'terminal-behavior-suspended'
const RESUMED = 'terminal-behavior-resumed'
const QUIT_BYTES = '\x03'
const CRASH_BYTES = '\x07'
const CRASH_MESSAGE = 'terminal-behavior-forced-crash'
const EXIT_FAILURE = 1
const KITTY_PRESS = '\x1b[97;1u'
const KITTY_REPEAT = '\x1b[97;1:2u'
const KITTY_RELEASE = '\x1b[97;1:3u'
const KITTY_COMMAND = '\x1b[97;5u'
const ACCEPTED_KITTY_EVENTS = 2
const ERASE_DISPLAY = /\x1b\[(?:2|3)J/g
const ENTER_SCREEN = '\x1b[?1049h'
const EXIT_SCREEN = '\x1b[?1049l'
const FOCUS_IN = '\x1b[I'
const FOCUS_OUT = '\x1b[O'
const CURSOR_SHOW = '\x1b[?25h'
const CURSOR_HIDE = '\x1b[?25l'
const BLINK_ENABLED = '\x1b[?12h'
const CURSOR_MODES_RESTORED = '\x1b[?1004r\x1b[?12r'
// Stress row allocation when normal prompt/footer floors cannot all fit;
// these small heights check survival, not a distinct layout guarantee per height.
const TINY_HEIGHTS = [1, 2, 3]
// Exercise extreme narrowing and restoration before checking retained native input.
const RESIZE_WIDTHS = [1, COLS]
const DIAGNOSTIC_TAIL_CHARACTERS = 2000
const EXIT_SUCCESS = 0
const CURSOR_PROBE_TIMEOUT_MS = TIMEOUT_MS
const REQUIRED_CURSOR_PHASES = 3
const REQUIRED_STREAM_UPDATES = 2
/** Current-cell faults need stable ownership diagnostics, not historical terminal dumps. */
const CURSOR_ERRORS = {
  "blink": "terminal-behavior: software cursor did not blink during continuous streaming",
  "hardware": "software mode exposed the hardware cursor",
  "returnedHardware": "software mode exposed hardware cursor after focus return",
  "blurred": "blurred editor retained a software cursor",
  "pickerHardware": "picker retained the hardware cursor",
  "pickerEditing": "picker retained an editing cursor",
  "handoff": "terminal handoff did not suspend",
  "stopped": "stopped owner wrote while terminal was borrowed"
}

/** Both modes must retain native input and terminal ownership under the same workload. */
async function verifyMode(cursorMode) {
  const screen = new PtyScreen(COLS, ROWS)
  let cursorProbe
  let frameWaiter
  let cursorChecks = 0
  let output = ''
  let readyOffset
  let restoreOffset
  let exited = false
  const ready = Promise.withResolvers()
  const restored = Promise.withResolvers()
  const exit = Promise.withResolvers()
  const deadline = Promise.withResolvers()
  const child = pty.spawn(process.execPath, [CHILD, cursorMode], {
    name: TERM, cols: COLS, rows: ROWS, cwd: ROOT, env: barePaneEnv(),
  })
  const watchdog = setTimeout(() => {
    if (!exited) child.kill()
    deadline.reject(new Error('terminal-behavior: ready/exit deadline exceeded'))
  }, TIMEOUT_MS)
  child.onData(data => {
    output += data
    screen.write(data)
    if (frameWaiter && !screen.synchronized && frameWaiter.predicate()) frameWaiter.resolve()
    if (cursorProbe && !screen.synchronized) {
      const visible = screen.inverseAt(screen.x, screen.y)
      const text = screen.text()
      const phases = cursorProbe.phases
      if (phases.length > 0 || visible) {
        if (phases.at(-1)?.visible !== visible) phases.push({ visible, updates: 0 })
        if (text !== cursorProbe.text) phases.at(-1).updates++
        cursorProbe.text = text
        if (phases.length >= REQUIRED_CURSOR_PHASES && phases.every(phase => phase.updates >= REQUIRED_STREAM_UPDATES)) cursorProbe.resolve()
      }
    }
    if (restoreOffset !== undefined && output.includes(READY, restoreOffset)) restored.resolve()
    if (readyOffset === undefined && output.includes(READY)) {
      readyOffset = output.length
      ready.resolve()
    }
  })
  child.onExit(status => {
    exited = true
    restored.resolve()
    exit.resolve(status)
    if (readyOffset === undefined) ready.reject(new Error(`terminal-behavior: child exited before readiness (${status.exitCode})`))
  })

  /** Await observable output rather than guessing when a focus or input event reached the renderer. */
  async function waitForFrame(predicate) {
    const wait = Promise.withResolvers()
    frameWaiter = { predicate, resolve: wait.resolve }
    try { await Promise.race([wait.promise, deadline.promise]) } finally { frameWaiter = undefined }
  }

  /** Reuse current-cell evidence after each change of editing ownership. */
  async function expectBlink() {
    const probe = Promise.withResolvers()
    cursorProbe = { phases: [], text: screen.text(), resolve: probe.resolve }
    const probeDeadline = setTimeout(() => probe.reject(new Error(CURSOR_ERRORS.blink)), CURSOR_PROBE_TIMEOUT_MS)
    try { await Promise.race([probe.promise, deadline.promise]); cursorChecks++ } finally { clearTimeout(probeDeadline); cursorProbe = undefined }
  }

  try {
    await Promise.race([ready.promise, deadline.promise])
    // An empty editor isolates transcript overflow from the dependency's narrow wide-grapheme wrapping.
    for (const width of RESIZE_WIDTHS) {
      assert.equal(exited, false, output.slice(-DIAGNOSTIC_TAIL_CHARACTERS))
      if (width === COLS) restoreOffset = output.length
      screen.resize(width, ROWS)
      child.resize(width, ROWS)
      await delay(DRAIN_MS)
    }
    // Linux resize delivery is asynchronous; visible wide-frame output must precede Unicode typing.
    await Promise.race([restored.promise, deadline.promise])
    assert.equal(exited, false, output.slice(-DIAGNOSTIC_TAIL_CHARACTERS))
    const typingOffset = output.length
    for (let index = 0; index < ASCII_COUNT; index++) {
      child.write(ASCII_KEY)
      await delay(KEY_INTERVAL_MS)
    }
    child.write(UNICODE_TEXT)
    await delay(DRAIN_MS)
    child.write(PASTE_START + PASTE_TEXT + PASTE_END)
    await delay(DRAIN_MS)
    // Streaming continues while focus changes, so subsequent frames must respect terminal focus.
    if (cursorMode === NATIVE_CURSOR_MODE) assert.ok(output.includes(BLINK_ENABLED), 'native cursor blinking was not requested')
    else assert.equal(screen.hardwareCursorVisible(), false, CURSOR_ERRORS.hardware)
    child.write(FOCUS_OUT)
    await delay(DRAIN_MS)
    assert.ok(output.lastIndexOf(CURSOR_HIDE) > output.lastIndexOf(CURSOR_SHOW), 'background redraw showed the cursor')
    assert.equal(screen.inverseAt(screen.x, screen.y), false, CURSOR_ERRORS.blurred)
    child.write(FOCUS_IN)
    await delay(DRAIN_MS)
    if (cursorMode === NATIVE_CURSOR_MODE) assert.ok(output.lastIndexOf(CURSOR_SHOW) > output.lastIndexOf(CURSOR_HIDE), 'focus return did not restore the cursor')
    else assert.equal(screen.hardwareCursorVisible(), false, CURSOR_ERRORS.returnedHardware)
    if (cursorMode === SOFTWARE_CURSOR_MODE) await expectBlink()
    child.write(BORROW_BYTES)
    await waitForFrame(() => cursorMode === SOFTWARE_CURSOR_MODE ? screen.inverseAt(screen.x, screen.y) : screen.hardwareCursorVisible())
    if (cursorMode === SOFTWARE_CURSOR_MODE) {
      await expectBlink()
      await waitForFrame(() => !screen.inverseAt(screen.x, screen.y))
      child.write(LEFT_BYTES)
      await waitForFrame(() => screen.inverseAt(screen.x, screen.y))
      await waitForFrame(() => !screen.inverseAt(screen.x, screen.y))
      child.write(REPLACE_DRAFT_BYTES)
      await waitForFrame(() => screen.inverseAt(screen.x, screen.y))
    }
    child.write(BORROW_BYTES)
    await delay(DRAIN_MS)

    child.write(PICKER_BYTES)
    await delay(DRAIN_MS)
    for (const data of [KITTY_PRESS, KITTY_REPEAT, KITTY_RELEASE, KITTY_COMMAND, UNICODE_TEXT, PASTE_START + PASTE_TEXT + PASTE_END]) {
      child.write(data)
      await delay(DRAIN_MS)
    }
    // Byte encoding replaces lone surrogates; component tests, not a fabricated PTY claim, prove malformed scalar behavior.
    assert.equal(output.slice(typingOffset).match(ERASE_DISPLAY)?.length ?? 0, 0, 'typing must not clear the whole screen')
    assert.equal(screen.hardwareCursorVisible(), false, CURSOR_ERRORS.pickerHardware)
    assert.equal(screen.inverseAt(screen.x, screen.y), false, CURSOR_ERRORS.pickerEditing)
    child.write(PICKER_BYTES)
    await delay(DRAIN_MS)
    // Focus reports cannot be read while stdin belongs to another terminal owner.
    child.write(FOCUS_OUT)
    await waitForFrame(() => !screen.hardwareCursorVisible() && !screen.inverseAt(screen.x, screen.y))
    const handoffOffset = output.length
    child.write(HANDOFF_BYTES)
    await waitForFrame(() => output.includes(RESUMED, handoffOffset))
    const suspendedOffset = output.indexOf(SUSPENDED, handoffOffset)
    const resumedOffset = output.indexOf(RESUMED, handoffOffset)
    assert.notEqual(suspendedOffset, -1, CURSOR_ERRORS.handoff)
    assert.equal(output.slice(suspendedOffset + SUSPENDED.length, resumedOffset).trim(), '', CURSOR_ERRORS.stopped)
    if (cursorMode === SOFTWARE_CURSOR_MODE) await expectBlink()
    for (const height of TINY_HEIGHTS) {
      screen.resize(COLS, height)
      child.resize(COLS, height)
      await delay(DRAIN_MS)
    }
    child.write(QUIT_BYTES)
    const status = await Promise.race([exit.promise, deadline.promise])
    assert.equal(status.exitCode, EXIT_SUCCESS, output.slice(-DIAGNOSTIC_TAIL_CHARACTERS))
    const receiptOffset = output.lastIndexOf(RECEIPT)
    assert.notEqual(receiptOffset, -1, 'terminal receipt missing')
    const receipt = JSON.parse(output.slice(receiptOffset + RECEIPT.length).split(/\r?\n/)[0])
    assert.equal(receipt.draft, ASCII_KEY.repeat(ASCII_COUNT) + UNICODE_TEXT + PASTE_TEXT, 'draft lost native input')
    assert.equal(receipt.filter, ASCII_KEY.repeat(ACCEPTED_KITTY_EVENTS) + UNICODE_TEXT + PASTE_TEXT, 'Kitty release/command leaked into the filter')
    assert.equal(receipt.enteredRawMode, true, 'native TTY never entered raw mode')
    assert.equal(receipt.rawMode, false, 'terminal stayed in raw mode')
    assert.deepEqual(receipt.failures, [], 'native frame failed')
    assert.equal(receipt.foldedNotice, true, 'large injected message did not reach the transcript')
    assert.equal(receipt.toolFoldLines, receipt.foldLineCount, 'large tool result lost its full line count')
    assert.equal(receipt.toolFoldRows, CARD_DETAIL_MAX, 'large tool result exceeded its retained row budget')
    for (const width of RESIZE_WIDTHS) assert.ok(receipt.renderedWidths.includes(width), `native frame width ${width} was not rendered`)
    assert.ok(output.slice(0, readyOffset).includes(ENTER_SCREEN), 'alternate screen was not entered')
    assert.ok(output.slice(0, receiptOffset).includes(EXIT_SCREEN), 'alternate screen was not restored')
    assert.ok(output.slice(0, receiptOffset).includes(CURSOR_MODES_RESTORED), 'cursor modes were not restored')
    // Require dispatch-to-native-write instrumentation, not a timing threshold;
    // samples do not measure hardware input or visible pixels.
    assert.ok(receipt.outputSamples > 0, 'no native output latency samples')
    console.log(JSON.stringify({ cursorMode, cursorChecks, platform: process.platform, node: process.version, cols: COLS, rows: ROWS, tinyHeights: TINY_HEIGHTS, resizeWidths: RESIZE_WIDTHS, ...receipt }, null, 2))
  } finally {
    clearTimeout(watchdog)
    if (!exited) child.kill()
  }
}

/** Fatal-monitor restoration needs a real process failure, not a manually invoked cleanup callback. */
async function verifyCrash(cursorMode) {
  const screen = new PtyScreen(COLS, ROWS)
  const exit = Promise.withResolvers()
  const child = pty.spawn(process.execPath, [CHILD, cursorMode], {
    name: TERM, cols: COLS, rows: ROWS, cwd: ROOT, env: barePaneEnv(),
  })
  let output = ''
  let triggered = false
  let exited = false
  const watchdog = setTimeout(() => {
    child.kill()
    exit.reject(new Error(CRASH_MESSAGE))
  }, TIMEOUT_MS)
  child.onData(data => {
    output += data
    screen.write(data)
    if (!triggered && !screen.synchronized && screen.text().includes(READY)) {
      triggered = true
      child.write(CRASH_BYTES)
    }
  })
  child.onExit(status => { exited = true; exit.resolve(status) })
  try {
    const status = await exit.promise
    assert.equal(status.exitCode, EXIT_FAILURE, output.slice(-DIAGNOSTIC_TAIL_CHARACTERS))
    assert.ok(triggered && output.includes(CRASH_MESSAGE), output.slice(-DIAGNOSTIC_TAIL_CHARACTERS))
    assert.ok(output.includes(EXIT_SCREEN) && output.includes(CURSOR_MODES_RESTORED), CURSOR_ERRORS.stopped)
    assert.equal(screen.hardwareCursorVisible(), true, CURSOR_ERRORS.hardware)
    console.log(JSON.stringify({ cursorMode, fatalRestoration: true }))
  } finally {
    clearTimeout(watchdog)
    if (!exited) child.kill()
  }
}

for (const cursorMode of CURSOR_MODES) {
  await verifyMode(cursorMode)
  await verifyCrash(cursorMode)
}
