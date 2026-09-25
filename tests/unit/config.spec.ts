import { describe, expect, it } from 'vitest'
import { Config, TuiConfigError, hasLiveRowSettings, readRowSettings, resolveConfig } from '@/config.ts'
import { TuiSettingsSchema } from '@/theme-settings.ts'

describe('resolveConfig', () => {
  it('does not mistake source metadata for native live Config references', () => {
    const parsed = Config({ sessionId: 'abc', history: { enabled: false, ghost: false } })
    expect(hasLiveRowSettings(parsed)).toBe(false)
    expect(Object.values(Config.dict!).some(field => Reflect.get(field.meta, 'volatile') === true)).toBe(false)
    expect(readRowSettings(parsed)).toMatchObject({ history: { enabled: false, ghost: false } })
  })

  it('reads the native reference protocol at fixed preference fields only', () => {
    const values: Record<string, unknown> = { theme: 'violet-orbit', history: { enabled: false, ghost: false } }
    const row = Object.fromEntries(Object.keys(TuiSettingsSchema.dict!).map(key => [key, {
      [Symbol.for('cosmokit.volatile.write')]: () => {},
      get: () => values[key],
    }]))
    expect(hasLiveRowSettings(row)).toBe(true)
    expect(readRowSettings(row)).toEqual(values)
    expect(resolveConfig({ sessionId: 'abc', ...row }).theme).toBe('violet-orbit')
    values.theme = 'deepseek-blue'
    expect(readRowSettings(row)).toMatchObject({ theme: 'deepseek-blue' })
  })

  it('preserves malformed raw preferences without treating arbitrary get methods as native references', () => {
    const history = { get: () => { throw new Error('must not call data') }, enabled: false }
    expect(readRowSettings({ history })).toEqual({ history })
    expect(hasLiveRowSettings({ history })).toBe(false)
  })

  it('resolves a launch-provided configuration with defaults', () => {
    expect(resolveConfig({ sessionId: 'abc' })).toEqual({
      sessionId: 'abc',
      resume: false,
      resumePicker: false,
      model: undefined,
      provider: undefined,
      preset: undefined,
      theme: undefined,
      stashScope: 'path',
      color: true,
      bell: true,
    })
  })

  it('keeps explicit values', () => {
    expect(resolveConfig({ sessionId: 'abc', resume: true, resumePicker: true, model: 'm', provider: 'p', preset: 'ptc', theme: 'violet-orbit', stash: { scope: 'session' }, color: false, bell: false }))
      .toEqual({ sessionId: 'abc', resume: true, resumePicker: true, model: 'm', provider: 'p', preset: 'ptc', theme: 'violet-orbit', stashScope: 'session', color: false, bell: false })
  })

  it('reads a theme pinned in the row config, and blank as absent', () => {
    // A profile patch is the durable store once the harness keeps settings per
    // row, so a pinned name has to survive resolution; an empty one means the
    // default theme rather than a theme named nothing.
    expect(resolveConfig({ sessionId: 'abc', theme: 'violet-orbit' }).theme).toBe('violet-orbit')
    expect(resolveConfig({ sessionId: 'abc', theme: '  ' }).theme).toBeUndefined()
  })

  it('rejects invalid stash scopes instead of silently sharing a different bank', () => {
    expect(() => resolveConfig({ sessionId: 'abc', stash: { scope: 'worktree' } })).toThrow(TuiConfigError)
    expect(() => resolveConfig({ sessionId: 'abc', stash: { scope: 1 } })).toThrow(TuiConfigError)
    expect(() => resolveConfig({ sessionId: 'abc', stash: 'session' })).toThrow(TuiConfigError)
    expect(() => resolveConfig({ sessionId: 'abc', stash: { scpoe: 'session' } })).toThrow(TuiConfigError)
    expect(() => resolveConfig(Config({ sessionId: 'abc', stash: { scpoe: 'session' } }))).toThrow(TuiConfigError)
    expect(() => resolveConfig({ sessionId: 'abc', stash: null })).toThrow(TuiConfigError)
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
