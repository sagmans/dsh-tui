/** Native failure exits must preserve shell state and Node's failure status together. */
import { fileURLToPath } from 'node:url'
import { spawn } from 'node-pty'
import { describe, expect, it } from 'vitest'

const FIXTURE = fileURLToPath(new URL('../fixtures/terminal-crash.mjs', import.meta.url))
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const TERM = 'xterm-256color'
const COLS = 80
const ROWS = 24
const TIMEOUT_MS = 10_000
const EXIT_GRACE_MS = 1000
const CASE_TIMEOUT_MS = TIMEOUT_MS + EXIT_GRACE_MS
const FRAME = 'terminal-crash-frame'
const FAILURE = 'terminal-crash-proof'
const RECEIPT = 'terminal-crash-receipt:'
const EXIT_ALT = '\x1b[?1049l'
const CURSOR_SHOW = '\x1b[?25h'
const MOUSE_OFF = '\x1b[?1003l'
const PASTE_OFF = '\x1b[?2004l'
const KEYBOARD_RESET = '\x1b[<u'
const CLEANUP_FAILURE = 'Error: terminal-crash-cleanup-failure'
const RESTORE_MODES = '\x1b[?1004r\x1b[?12r'
const FAILED_STATUS = 1
const FORCED_STATUS = 2
const OUTPUT_TAIL = 3000

/** A real PTY exposes raw-mode ownership that captured terminal writes alone cannot prove. */
function run(mode: string): Promise<{ output: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    let output = ''
    const child = spawn(process.execPath, [FIXTURE, mode], { name: TERM, cols: COLS, rows: ROWS, cwd: ROOT, env: { TERM } })
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error('terminal-crash: exit deadline exceeded\n' + output.slice(-OUTPUT_TAIL)))
    }, TIMEOUT_MS)
    child.onData(data => { output += data })
    child.onExit(({ exitCode }) => {
      clearTimeout(timeout)
      resolve({ output, exitCode })
    })
  })
}

describe('native fatal terminal handoff', () => {
  it.each(['clean', 'exception', 'rejection', 'exit', 'cleanup-failure'])('restores shell ownership on %s', async mode => {
    const { output, exitCode } = await run(mode)
    expect(exitCode, output.slice(-OUTPUT_TAIL)).toBe(mode === 'clean' ? 0 : mode === 'exit' ? FORCED_STATUS : FAILED_STATUS)
    const frame = output.indexOf(FRAME)
    expect(frame).toBeGreaterThanOrEqual(0)
    for (const sequence of [EXIT_ALT, CURSOR_SHOW, MOUSE_OFF, PASTE_OFF, KEYBOARD_RESET, RESTORE_MODES]) {
      if (mode === 'cleanup-failure' && sequence === RESTORE_MODES) continue
      expect(output.lastIndexOf(sequence), sequence).toBeGreaterThan(frame)
    }
    const at = output.lastIndexOf(RECEIPT)
    expect(at).toBeGreaterThan(frame)
    const receipt = JSON.parse(output.slice(at + RECEIPT.length).split(/\r?\n/u)[0]!)
    expect(receipt).toMatchObject({
      enteredRawMode: true, rawMode: false, cleanupFailureObserved: mode === 'cleanup-failure',
      warningOwnershipRestored: true, stdoutOwnershipRestored: true, stderrOwnershipRestored: true,
      fatalHooksRestored: true, exitHooksRestored: true,
    })
    if (mode !== 'clean' && mode !== 'exit') expect(output).toContain(FAILURE)
    if (mode === 'cleanup-failure') expect(output).not.toContain(CLEANUP_FAILURE)
  }, CASE_TIMEOUT_MS)
})
