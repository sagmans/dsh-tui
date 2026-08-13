import assert from 'node:assert/strict'
import { test } from 'vitest'
import { loadSharedClientPlugins, type SharedClientPlugins } from '../../src/client/bundles.js'

const WINDOW_PROPERTY = 'window'

test('captures published client factories once without leaking browser globals', async () => {
  const previousWindow: unknown = Reflect.get(globalThis, WINDOW_PROPERTY)
  const [first, second] = await Promise.all([
    loadSharedClientPlugins(),
    loadSharedClientPlugins(),
  ])

  assert.equal(first, second)
  const plugins: SharedClientPlugins = first
  assert.equal(typeof plugins.typert.apply, 'function')
  assert.equal(typeof plugins.gateway.apply, 'function')
  assert.equal(typeof plugins.remotes.apply, 'function')
  assert.equal(typeof plugins.runtime.apply, 'function')
  assert.equal(Reflect.get(globalThis, WINDOW_PROPERTY), previousWindow)
})
