import assert from 'node:assert/strict'
import { test } from 'vitest'
import { DEFAULT_RENDERER_CONFIG } from '../../src/kernel/renderer.js'

test('owns full-screen mouse input and terminal restoration policy', () => {
  assert.deepEqual(DEFAULT_RENDERER_CONFIG, {
    autoFocus: true,
    clearOnShutdown: true,
    consoleMode: 'disabled',
    enableMouseMovement: true,
    exitOnCtrlC: false,
    screenMode: 'alternate-screen',
    useMouse: true,
  })
})
