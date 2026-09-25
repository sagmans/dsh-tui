import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { openSection, type SectionRequest } from '@/compat/section.ts'

/** The seam only forwards the context to the service, so no fake here ever reads one. */
const owner = {} as Context

/** One ownership request, with the field a test varies named at the call. */
function requestWith(onChange: () => void): SectionRequest<object> {
  return { owner, ns: 'dsh-tui', schema: { schema: true }, entry: {}, onChange }
}

/**
 * The installing provider, as the newer release behaves: it reports the source
 * through the hooks it is handed and persists a patch through the service.
 */
function installingService(read: () => unknown) {
  const reported: { hooks?: { setSource(current: () => unknown): void; onChange(): void } } = {}
  const service = {
    installSection: vi.fn((
      forwardedOwner: Context,
      _ns: string,
      _schema: unknown,
      _entry: unknown,
      hooks: { setSource(current: () => unknown): void; onChange(): void },
    ) => {
      reported.hooks = hooks
      hooks.setSource(read)
    }),
    update: vi.fn(async () => {}),
  }
  return { service, reported }
}

describe('the settings section seam', () => {
  it('reads and writes through the scope a register-shaped service hands back', async () => {
    const scope = { get: vi.fn((): unknown => ({ theme: 'violet-orbit' })), update: vi.fn(async () => {}) }
    const register = vi.fn(() => scope)
    const opened = openSection({ register }, requestWith(() => {}))
    expect(register).toHaveBeenCalledWith('dsh-tui', { schema: true }, { base: {} })
    expect(opened?.get()).toEqual({ theme: 'violet-orbit' })
    await opened?.update({ theme: 'lagoon' })
    expect(scope.update).toHaveBeenCalledWith({ theme: 'lagoon' })
  })

  it('reads and writes through the hooks an installing service reports', async () => {
    const { service } = installingService(() => ({ theme: 'violet-orbit' }))
    const opened = openSection(service, requestWith(() => {}))
    const call = service.installSection.mock.calls[0]!
    expect(call[0]).toBe(owner)
    expect(call[1]).toBe('dsh-tui')
    expect(call[2]).toEqual({ schema: true })
    expect(call[3]).toEqual({})
    expect(opened?.get()).toEqual({ theme: 'violet-orbit' })
    await opened?.update({ theme: 'lagoon' })
    expect(service.update).toHaveBeenCalledWith('dsh-tui', { theme: 'lagoon' })
  })

  it('follows the source the provider swaps in when the namespace detaches', () => {
    const { service, reported } = installingService(() => ({ theme: 'violet-orbit' }))
    const opened = openSection(service, requestWith(() => {}))
    reported.hooks?.setSource(() => ({}))
    expect(opened?.get()).toEqual({})
  })

  it('prefers the installing shape when a service carries both', () => {
    const installSection = vi.fn()
    const register = vi.fn()
    openSection({ installSection, register, update: vi.fn(async () => {}) }, requestWith(() => {}))
    expect(installSection).toHaveBeenCalledTimes(1)
    expect(register).not.toHaveBeenCalled()
  })

  it('stays quiet through the attach-time report and forwards later changes', () => {
    const { service, reported } = installingService(() => ({}))
    const onChange = vi.fn()
    openSection(service, requestWith(onChange))
    // The provider reports the attach before the caller holds the scope it reads
    // through, so forwarding that report would re-read a half-wired surface.
    expect(onChange).not.toHaveBeenCalled()
    reported.hooks?.onChange()
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('refuses a write the installing service cannot take', async () => {
    const installSection = vi.fn((
      _owner: Context,
      _ns: string,
      _schema: unknown,
      _entry: unknown,
      hooks: { setSource(current: () => unknown): void },
    ) => {
      hooks.setSource(() => ({}))
    })
    const opened = openSection({ installSection }, requestWith(() => {}))
    // A theme the reader chose must not look written when nothing accepted it.
    await expect(opened!.update({ theme: 'lagoon' })).rejects.toThrow(/cannot write/)
  })

  it.each([undefined, null, {}])('refuses unreadable settings and unsupported writes: %s', async service => {
    const opened = openSection(service, requestWith(() => {}))!
    expect(() => opened.get()).toThrow(/cannot read/)
    await expect(opened.update({ theme: 'lagoon' })).rejects.toThrow(/cannot write/)
  })

  it('rejects source writes when schema metadata has no native live references', async () => {
    const update = vi.fn(async () => {})
    const forms = { describe: () => [{ ns: 'terminal', value: {}, revision: 0 }], update }
    const opened = openSection(forms, {
      ...requestWith(() => {}), config: { ns: 'terminal', get: () => ({}), live: false },
    })
    await expect(opened.update({ theme: 'lagoon' })).rejects.toThrow(/cannot write live Config/)
    expect(update).not.toHaveBeenCalled()
  })

  it('uses the actual Config entry identity and revision, never the legacy namespace', async () => {
    const value = { theme: 'violet-orbit', history: { enabled: false, ghost: false } }
    const update = vi.fn(async () => {})
    const forms = { describe: () => [{ ns: 'terminal-custom', value, revision: 7 }], update }
    const opened = openSection(forms, {
      ...requestWith(() => {}), config: { ns: 'terminal-custom', get: () => ({}), live: true },
    })!
    expect(opened.get()).toEqual(value)
    await opened.update({ theme: 'lagoon' })
    expect(update).toHaveBeenCalledWith('terminal-custom', { theme: 'lagoon' }, 7)
  })

  it('rejects missing Config ownership instead of writing a similarly named entry', async () => {
    const update = vi.fn(async () => {})
    const forms = { describe: () => [{ ns: 'dsh-tui', value: {}, revision: 0 }], update }
    const opened = openSection(forms, {
      ...requestWith(() => {}), config: { ns: 'other', get: () => ({ history: { enabled: false } }), live: true },
    })!
    expect(opened.get()).toEqual({ history: { enabled: false } })
    await expect(opened.update({ theme: 'lagoon' })).rejects.toThrow(/cannot write/)
    expect(update).not.toHaveBeenCalled()
  })

  it('rejects a read-only Config service even when it exposes update', async () => {
    const update = vi.fn(async () => {})
    const forms = { writable: false, describe: () => [{ ns: 'terminal', value: {}, revision: 0 }], update }
    const opened = openSection(forms, {
      ...requestWith(() => {}), config: { ns: 'terminal', get: () => ({}), live: true },
    })!
    await expect(opened.update({ theme: 'lagoon' })).rejects.toThrow(/cannot write/)
    expect(update).not.toHaveBeenCalled()
  })
})
