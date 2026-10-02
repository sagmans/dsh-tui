/** Fatal exits must hand the real terminal back without replacing Node's original failure. */
import { writeSync } from 'node:fs'
import { ProcessTerminal } from '@earendil-works/pi-tui'
import { WarningSafeTui } from '../../src/terminal/warning-screen.ts'

const MODE = process.argv[2]
const FRAME = 'terminal-crash-frame'
const FAILURE = 'terminal-crash-proof'
const CLEANUP_FAILURE = 'terminal-crash-cleanup-failure'
const RECEIPT = 'terminal-crash-receipt:'
const STDOUT_FD = 1
const FORCED_EXIT_CODE = 2
const RESTORE_MODES = '\x1b[?1004r\x1b[?12r'
const FATAL_EVENT = 'uncaughtExceptionMonitor'
const EXIT_EVENT = 'exit'
const EXIT_OBSERVER_COUNT = 1
const originalFatalListeners = process.listenerCount(FATAL_EVENT)
const originalExitListeners = process.listenerCount(EXIT_EVENT)
const originalEmit = process.emit
const originalStdout = process.stdout.write
const originalStderr = process.stderr.write
const terminal = new ProcessTerminal()
const write = terminal.write.bind(terminal)
let armed = false
let enteredRawMode = false
let cleanupFailureObserved = false
const tui = new WarningSafeTui(terminal)
tui.addChild({ render: () => [FRAME], invalidate() {} })
terminal.write = data => {
  if (MODE === 'cleanup-failure' && data === RESTORE_MODES) {
    cleanupFailureObserved = true
    throw new Error(CLEANUP_FAILURE)
  }
  write(data)
  if (armed || !data.includes(FRAME)) return
  armed = true
  setImmediate(() => {
    if (MODE === 'clean') {
      tui.stop({ preserveScreen: true })
    } else if (MODE === 'exit') {
      process.exit(FORCED_EXIT_CODE)
    } else if (MODE === 'rejection') {
      void Promise.reject(new Error(FAILURE))
    } else {
      throw new Error(FAILURE)
    }
  })
}
tui.start()
enteredRawMode = process.stdin.isRaw
// A direct native receipt remains observable even if the failed owner still holds host writes.
process.on(EXIT_EVENT, code => {
  writeSync(STDOUT_FD, '\n' + RECEIPT + JSON.stringify({
    code, enteredRawMode, rawMode: process.stdin.isRaw, cleanupFailureObserved,
    warningOwnershipRestored: process.emit === originalEmit,
    stdoutOwnershipRestored: process.stdout.write === originalStdout,
    stderrOwnershipRestored: process.stderr.write === originalStderr,
    fatalHooksRestored: process.listenerCount(FATAL_EVENT) === originalFatalListeners,
    exitHooksRestored: process.listenerCount(EXIT_EVENT) === originalExitListeners + EXIT_OBSERVER_COUNT,
  }) + '\n')
})
