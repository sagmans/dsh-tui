import assert from 'node:assert/strict'
import { stripTypeScriptTypes } from 'node:module'
import { setImmediate } from 'node:timers/promises'
import { ProcessTerminal } from '@earendil-works/pi-tui'
import { WarningSafeTui } from '../../src/terminal/warning-screen.ts'

const WARNING_EVENT = 'warning'
const BEFORE = 'warning-before-screen'
const DURING = 'warning-during-screen'
const AFTER = 'warning-after-screen'
const DIRECT_ERROR = 'ordinary-stderr-still-visible'
const CUSTOM_EVENT = 'dsh-warning-test'
const DETAILS = 'warning-detail-preserved'
const MODE = process.argv[2]
const SECOND = 'warning-second-screen'
const WARNING_CODE = 'DSH_TEST_WARNING'
const seen = []
let onceCount = 0
const observe = warning => seen.push(warning)
const originalEmit = process.emit
const listeners = process.rawListeners(WARNING_EVENT)

// One stream makes ordering observable even without a PTY.
process.stdout.write = process.stderr.write.bind(process.stderr)
process.emitWarning(BEFORE)
await setImmediate()
const terminal = new ProcessTerminal()
const tui = new WarningSafeTui(terminal)
tui.addChild({ render: () => ['Warning test screen'], invalidate() {} })
if (MODE === 'start-failure') {
  terminal.start = () => {
    process.emit(WARNING_EVENT, new Error(DURING))
    throw new Error('terminal-start-failed')
  }
  assert.throws(() => tui.start(), /terminal-start-failed/)
} else {
  process.on(WARNING_EVENT, observe)
  process.once(WARNING_EVENT, () => { onceCount++ })
  tui.start()
  let customEventSeen = false
  process.once(CUSTOM_EVENT, () => { customEventSeen = true })
  assert.equal(process.emit(CUSTOM_EVENT), true)
  assert.equal(customEventSeen, true)
  stripTypeScriptTypes('const value: number = 1')
  process.emitWarning(DURING, { code: WARNING_CODE, detail: DETAILS })
  await setImmediate()
  if (MODE === 'frame-failure') {
    // A component that cannot draw must not take the process with it: the frame
    // is reported through the surface and the screen it left stays up.
    tui.addChild({ render: () => { throw new Error('frame-failed') }, invalidate() {} })
    tui.onFrameError = error => { process.stderr.write(`frame-error-reported:${error.message}\n`) }
    assert.doesNotThrow(() => tui.renderNow())
  }
  process.stderr.write(DIRECT_ERROR + '\n')
  if (MODE === 'stop-failure') {
    tui.render = () => { throw new Error('render-failed-at-exit') }
    assert.throws(() => tui.stop(), /render-failed-at-exit/)
  } else if (MODE === 'frame-failure') {
    // The failing child cannot draw the exit transcript either, so the screen is
    // handed back without one.
    tui.stop({ preserveScreen: true })
  } else {
    tui.stop()
    tui.stop()
  }
  assert.equal(onceCount, 1)
  assert.equal(seen.length, 2)
  assert.equal(seen[1].code, WARNING_CODE)
  assert.equal(seen[1].detail, DETAILS)
  process.removeListener(WARNING_EVENT, observe)
  if (MODE === 'restart') {
    tui.start()
    process.emitWarning(SECOND)
    await setImmediate()
    tui.stop()
  }
}
assert.equal(process.emit, originalEmit)
assert.deepEqual(process.rawListeners(WARNING_EVENT), listeners)
process.emitWarning(AFTER)
await setImmediate()
