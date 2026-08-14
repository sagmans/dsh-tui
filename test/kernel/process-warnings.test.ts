import assert from 'node:assert/strict'
import { test } from 'vitest'
import { installExpectedRuntimeWarningFilter } from '../../src/kernel/renderer.js'

const EXPECTED_WARNING = 'stripTypeScriptTypes is an experimental feature and might change at any time'
const EXPECTED_WARNING_TYPE = 'ExperimentalWarning'
const OTHER_WARNING = 'other runtime warning'

test('filters only the expected type-strip warning and restores warning delivery', () => {
  const delivered: unknown[][] = []
  const emitter = {
    emitWarning: ((...args: unknown[]) => { delivered.push(args) }) as NodeJS.Process['emitWarning'],
  }
  const restore = installExpectedRuntimeWarningFilter(emitter)

  emitter.emitWarning(EXPECTED_WARNING, EXPECTED_WARNING_TYPE)
  emitter.emitWarning(OTHER_WARNING, EXPECTED_WARNING_TYPE)
  assert.deepEqual(delivered, [[OTHER_WARNING, EXPECTED_WARNING_TYPE]])

  restore()
  emitter.emitWarning(EXPECTED_WARNING, EXPECTED_WARNING_TYPE)
  assert.deepEqual(delivered, [
    [OTHER_WARNING, EXPECTED_WARNING_TYPE],
    [EXPECTED_WARNING, EXPECTED_WARNING_TYPE],
  ])
})
