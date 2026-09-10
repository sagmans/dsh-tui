import { describe, expect, it } from 'vitest'
import { colorEnabled, createTheme } from '@/theme.ts'

describe('colorEnabled', () => {
  it('keeps styling when neither the flag nor the environment objects', () => {
    expect(colorEnabled(true, {})).toBe(true)
    expect(colorEnabled(true, { NO_COLOR: undefined })).toBe(true)
  })

  it('obeys --no-color', () => {
    expect(colorEnabled(false, {})).toBe(false)
  })

  it('obeys NO_COLOR, whatever it holds', () => {
    expect(colorEnabled(true, { NO_COLOR: '1' })).toBe(false)
    expect(colorEnabled(true, { NO_COLOR: 'anything' })).toBe(false)
    expect(colorEnabled(true, { NO_COLOR: ' ' })).toBe(false)
  })

  it('treats an empty NO_COLOR as unset, as the convention says', () => {
    expect(colorEnabled(true, { NO_COLOR: '' })).toBe(true)
  })
})

describe('createTheme', () => {
  it('styles nothing when color is off', () => {
    const theme = createTheme(false)
    expect(theme.bold('x')).toBe('x')
    expect(theme.dim('x')).toBe('x')
    expect(theme.markdown.heading('x')).toBe('x')
  })

  it('styles with the standard 16 ANSI colors when color is on', () => {
    const theme = createTheme(true)
    expect(theme.bold('x')).toContain('\u001b[1m')
    expect(theme.added('x')).toContain('\u001b[32m')
    expect(theme.removed('x')).toContain('\u001b[31m')
  })
})
