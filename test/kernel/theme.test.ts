import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createTuiTheme } from '../../src/services/theme.js'

test('exposes immutable semantic colors with a no-color fallback', () => {
  const theme = createTuiTheme({ color: true })
  const plain = createTuiTheme({ color: false })

  assert.equal(Object.isFrozen(theme), true)
  assert.equal(Object.isFrozen(theme.colors), true)
  assert.notEqual(theme.colors.accent, theme.colors.text)
  assert.equal(plain.colors.accent, plain.colors.text)
  assert.equal(plain.colors.danger, plain.colors.text)
  assert.equal(plain.color, false)
})
