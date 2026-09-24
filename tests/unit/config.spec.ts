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
      preset: undefined,
      theme: undefined,
      color: true,
      bell: true,
    })
  })

  it('keeps explicit values', () => {
    expect(resolveConfig({ sessionId: 'abc', resume: true, resumePicker: true, model: 'm', provider: 'p', preset: 'ptc', theme: 'violet-orbit', color: false, bell: false }))
      .toEqual({ sessionId: 'abc', resume: true, resumePicker: true, model: 'm', provider: 'p', preset: 'ptc', theme: 'violet-orbit', color: false, bell: false })
  })

  it('reads a theme pinned in the row config, and blank as absent', () => {
    // A profile patch is the durable store once the harness keeps settings per
    // row, so a pinned name has to survive resolution; an empty one means the
    // default theme rather than a theme named nothing.
    expect(resolveConfig({ sessionId: 'abc', theme: 'violet-orbit' }).theme).toBe('violet-orbit')
    expect(resolveConfig({ sessionId: 'abc', theme: '  ' }).theme).toBeUndefined()
  })

  it('treats blank optional strings as absent', () => {
    expect(resolveConfig({ sessionId: 'abc', model: '   ' }).model).toBeUndefined()
    expect(resolveConfig({ sessionId: 'abc', preset: '  ' }).preset).toBeUndefined()
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
    expect(() => resolveConfig({ sessionId: 'abc', preset: 7 })).toThrow(TuiConfigError)
    expect(() => resolveConfig({ sessionId: 'abc', theme: 7 })).toThrow(TuiConfigError)
    expect(() => resolveConfig({ sessionId: 'abc', bell: 'no' })).toThrow(TuiConfigError)
  })
})
