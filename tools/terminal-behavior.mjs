#!/usr/bin/env node
/** Credential-free native PTY proof protects input and terminal ownership without host-dependent timing budgets. */
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pty from 'node-pty'
import { barePaneEnv } from './pty-launch.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CHILD = join(ROOT, 'tests/fixtures/terminal-behavior.mjs')
const READY = 'terminal-behavior-ready'
const RECEIPT = 'terminal-behavior-receipt:'
const TERM = 'xterm-256color'
const COLS = 100
const ROWS = 30
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
const QUIT_BYTES = '\x03'
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
const TINY_HEIGHTS = [1, 2, 3]
const DIAGNOSTIC_TAIL_CHARACTERS = 2000
const EXIT_SUCCESS = 0

let output = ''
let readyOffset
let exited = false
const ready = Promise.withResolvers()
const exit = Promise.withResolvers()
const deadline = Promise.withResolvers()
const child = pty.spawn(process.execPath, [CHILD], {
  name: TERM, cols: COLS, rows: ROWS, cwd: ROOT, env: barePaneEnv(),
})
const watchdog = setTimeout(() => {
  if (!exited) child.kill()
  deadline.reject(new Error('terminal-behavior: ready/exit deadline exceeded'))
}, TIMEOUT_MS)
child.onData(data => {
  output += data
  if (readyOffset === undefined && output.includes(READY)) {
    readyOffset = output.length
    ready.resolve()
  }
})
child.onExit(status => {
  exited = true
  exit.resolve(status)
  if (readyOffset === undefined) ready.reject(new Error(`terminal-behavior: child exited before readiness (${status.exitCode})`))
})

try {
  await Promise.race([ready.promise, deadline.promise])
  for (let index = 0; index < ASCII_COUNT; index++) {
    child.write(ASCII_KEY)
    await delay(KEY_INTERVAL_MS)
  }
  child.write(UNICODE_TEXT)
  await delay(DRAIN_MS)
  child.write(PASTE_START + PASTE_TEXT + PASTE_END)
  await delay(DRAIN_MS)
  // Streaming continues while focus changes, so subsequent frames must respect terminal focus.
  assert.ok(output.includes(BLINK_ENABLED), 'native cursor blinking was not requested')
  child.write(FOCUS_OUT)
  await delay(DRAIN_MS)
  assert.ok(output.lastIndexOf(CURSOR_HIDE) > output.lastIndexOf(CURSOR_SHOW), 'background redraw showed the cursor')
  child.write(FOCUS_IN)
  await delay(DRAIN_MS)
  assert.ok(output.lastIndexOf(CURSOR_SHOW) > output.lastIndexOf(CURSOR_HIDE), 'focus return did not restore the cursor')
  child.write(PICKER_BYTES)
  await delay(DRAIN_MS)
  for (const data of [KITTY_PRESS, KITTY_REPEAT, KITTY_RELEASE, KITTY_COMMAND, UNICODE_TEXT, PASTE_START + PASTE_TEXT + PASTE_END]) {
    child.write(data)
    await delay(DRAIN_MS)
  }
  // Byte encoding replaces lone surrogates; component tests, not a fabricated PTY claim, prove malformed scalar behavior.
  assert.equal(output.slice(readyOffset).match(ERASE_DISPLAY)?.length ?? 0, 0, 'typing must not clear the whole screen')
  for (const height of TINY_HEIGHTS) {
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
  assert.ok(output.slice(0, readyOffset).includes(ENTER_SCREEN), 'alternate screen was not entered')
  assert.ok(output.slice(0, receiptOffset).includes(EXIT_SCREEN), 'alternate screen was not restored')
  assert.ok(output.slice(0, receiptOffset).includes(CURSOR_MODES_RESTORED), 'cursor modes were not restored')
  assert.ok(receipt.outputSamples > 0, 'no native output latency samples')
  console.log(JSON.stringify({ platform: process.platform, node: process.version, cols: COLS, rows: ROWS, tinyHeights: TINY_HEIGHTS, ...receipt }, null, 2))
} finally {
  clearTimeout(watchdog)
  if (!exited) child.kill()
}
