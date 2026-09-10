import { describe, expect, it } from 'vitest'
import { TuiConfigError, resolveConfig } from '@/config.ts'

describe('resolveConfig', () => {
  it('resolves a launch-provided configuration with defaults', () => {
    expect(resolveConfig({ sessionId: 'abc' })).toEqual({
      sessionId: 'abc',
      resume: false,
      resumePicker: false,
      model: undefined,
      provider: undefined,
      color: true,
      bell: true,
    })
  })

  it('keeps explicit values', () => {
    expect(resolveConfig({ sessionId: 'abc', resume: true, resumePicker: true, model: 'm', provider: 'p', color: false, bell: false }))
      .toEqual({ sessionId: 'abc', resume: true, resumePicker: true, model: 'm', provider: 'p', color: false, bell: false })
  })

  it('treats blank optional strings as absent', () => {
    expect(resolveConfig({ sessionId: 'abc', model: '   ' }).model).toBeUndefined()
  })

  it('rejects a missing or blank session id', () => {
    expect(() => resolveConfig({})).toThrow(TuiConfigError)
    expect(() => resolveConfig({ sessionId: '  ' })).toThrow(TuiConfigError)
  })

  it('rejects a non-mapping configuration', () => {
    expect(() => resolveConfig('nope')).toThrow(TuiConfigError)
    expect(() => resolveConfig(undefined)).toThrow(TuiConfigError)
  })

  it('rejects a wrongly typed field instead of coercing it', () => {
    expect(() => resolveConfig({ sessionId: 'abc', resume: 'yes' })).toThrow(TuiConfigError)
    expect(() => resolveConfig({ sessionId: 'abc', color: 1 })).toThrow(TuiConfigError)
    expect(() => resolveConfig({ sessionId: 'abc', model: 7 })).toThrow(TuiConfigError)
    expect(() => resolveConfig({ sessionId: 'abc', bell: 'no' })).toThrow(TuiConfigError)
  })
})
