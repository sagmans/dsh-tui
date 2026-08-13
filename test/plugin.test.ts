import assert from 'node:assert/strict'
import { test } from 'vitest'

import * as plugin from '../src/index.js'

const EXPECTED_PLUGIN_NAME = 'dsh-tui'
const SUPPORTED_NODE_VERSION = '26.4.0'
const UNSUPPORTED_NODE_VERSION = '26.3.0'
const NODE_VERSION_ERROR = /Node\.js 26\.4\.0 or newer/u
const FFI_ERROR = /--experimental-ffi/u

test('exports the Cordis plugin contract', () => {
  assert.equal(plugin.name, EXPECTED_PLUGIN_NAME)
  assert.deepEqual(plugin.inject, ['tuiStartup'])
  assert.equal(typeof plugin.apply, 'function')
})

test('accepts the minimum Node runtime with FFI available', () => {
  assert.doesNotThrow(() => {
    plugin.assertSupportedRuntime({ nodeVersion: SUPPORTED_NODE_VERSION, hasFfi: true })
  })
})

test('rejects Node runtimes below the supported floor', () => {
  assert.throws(
    () => {
      plugin.assertSupportedRuntime({ nodeVersion: UNSUPPORTED_NODE_VERSION, hasFfi: true })
    },
    NODE_VERSION_ERROR,
  )
})

test('rejects runtimes without experimental FFI', () => {
  assert.throws(
    () => {
      plugin.assertSupportedRuntime({ nodeVersion: SUPPORTED_NODE_VERSION, hasFfi: false })
    },
    FFI_ERROR,
  )
})
