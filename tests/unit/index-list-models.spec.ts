import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply } from '@/index.ts'
import { LIST_MODELS_SERVICE } from '@/startup.ts'

const inputTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
const outputTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')

/**
 * A context answering only the services the listing path may read.
 *
 * Every other read throws: the surface composes through dozens of services, so
 * a listing that reached the composition would fail here instead of half
 * mounting a terminal this command must never own.
 */
function contextFor(services: Record<string, unknown>): Context {
  return {
    get(key: string) {
      if (!Object.hasOwn(services, key)) throw new Error(`unexpected service read: ${key}`)
      return services[key]
    },
    provide: vi.fn(),
  } as unknown as Context
}

/** The launcher's readiness signal: a listener runs only when startup commits. */
function readiness(): { service: { onReady: (listener: () => void) => () => void }; commit: () => void } {
  const listeners: (() => void)[] = []
  return {
    service: { onReady: (listener) => { listeners.push(listener); return () => {} } },
    commit: () => { for (const listener of listeners.splice(0)) listener() },
  }
}

/** The gate reads each stream on its own, so a case can pipe only one of them. */
function setTTY(stdinIsTTY: boolean, stdoutIsTTY = stdinIsTTY): void {
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: stdinIsTTY })
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: stdoutIsTTY })
}

beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})

afterEach(() => {
  for (const [stream, descriptor] of [[process.stdin, inputTTY], [process.stdout, outputTTY]] as const) {
    if (descriptor === undefined) delete (stream as { isTTY?: boolean }).isTTY
    else Object.defineProperty(stream, 'isTTY', descriptor)
  }
  vi.restoreAllMocks()
})

describe('list-models in the tui row', () => {
  it('prints one picker-ordered line per route and exits 0 on a piped stdout', async () => {
    setTTY(false)
    const exit = vi.fn()
    const llm = {
      listProviders: () => [{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }],
      listModels: async (provider: string) => provider === 'alpha'
        ? [{ id: 'a1', name: 'Alpha One' }]
        : [{ id: 'b1', name: 'Beta One' }],
    }
    const ready = readiness()
    const ctx = contextFor({ appExit: exit, appReady: ready.service, [LIST_MODELS_SERVICE]: true, llm })
    expect(() => apply(ctx, undefined)).not.toThrow()
    // A listing printed before the launcher commits startup would report an empty catalog.
    expect(process.stdout.write).not.toHaveBeenCalled()
    ready.commit()
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
    expect(process.stdout.write).toHaveBeenCalledTimes(1)
    expect(process.stdout.write).toHaveBeenCalledWith('alpha/a1\tAlpha One\nbeta/b1\tBeta One\n')
    expect(process.stdout.write).not.toHaveBeenCalledWith(expect.stringContaining('\u001b'))
    expect(process.stderr.write).not.toHaveBeenCalled()
  })

  // The two causes of an absent catalog ask for opposite fixes, so the refusal
  // names the one this composition met instead of always naming a missing service.
  it('exits 1 asking to mount an llm service when the profile has none', async () => {
    setTTY(false)
    const exit = vi.fn()
    const ready = readiness()
    const ctx = contextFor({ appExit: exit, appReady: ready.service, [LIST_MODELS_SERVICE]: true, llm: undefined })
    apply(ctx, undefined)
    ready.commit()
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining('no llm service'))
    expect(process.stdout.write).not.toHaveBeenCalled()
  })

  it('exits 1 naming the mounted service, not a missing one, when it cannot list providers', async () => {
    setTTY(false)
    const exit = vi.fn()
    const ready = readiness()
    const ctx = contextFor({ appExit: exit, appReady: ready.service, [LIST_MODELS_SERVICE]: true, llm: {} })
    apply(ctx, undefined)
    ready.commit()
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining('cannot list providers'))
    // Nothing is absent from this profile, so the line must not read as an install.
    expect(process.stderr.write).not.toHaveBeenCalledWith(expect.stringContaining('no llm service'))
    expect(process.stdout.write).not.toHaveBeenCalled()
  })

  it('refuses to dump when the launcher provides no readiness signal', () => {
    setTTY(false)
    const ctx = contextFor({ appExit: vi.fn(), [LIST_MODELS_SERVICE]: true, llm: {} })
    expect(() => apply(ctx, undefined)).toThrow(/appReady/)
    expect(process.stdout.write).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'no provider advertises a model', providers: [{ id: 'alpha', name: 'Alpha' }] },
    { label: 'the deployment declares no providers at all', providers: [] },
  ])('exits 1 when $label', async ({ providers }) => {
    setTTY(false)
    const exit = vi.fn()
    const llm = { listProviders: () => providers, listModels: async () => [] }
    const ready = readiness()
    const ctx = contextFor({ appExit: exit, appReady: ready.service, [LIST_MODELS_SERVICE]: true, llm })
    apply(ctx, undefined)
    ready.commit()
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining('no configured provider advertises a model'))
    expect(process.stdout.write).not.toHaveBeenCalled()
  })
})

/**
 * The TTY gate belongs to the interactive row, not to the listing: a listing is a
 * pipeable dump that answers without a terminal, while an interactive launch that
 * cannot read a real one fails loud instead of degrading to line mode.
 */
describe('the interactive row', () => {
  it('accepts a real terminal on both streams', () => {
    setTTY(true)
    const ctx = contextFor({ appExit: vi.fn(), [LIST_MODELS_SERVICE]: false })
    // Passing the gate means failing later, in composition, never on the TTY check.
    expect(() => apply(ctx, { sessionId: 'interactive' })).not.toThrow(/must be TTYs/)
  })

  it('refuses a piped stream instead of degrading to line mode', () => {
    const ctx = contextFor({ appExit: vi.fn(), [LIST_MODELS_SERVICE]: false })
    setTTY(false, true)
    expect(() => apply(ctx, { sessionId: 'interactive' })).toThrow(/must be TTYs/)
    setTTY(true, false)
    expect(() => apply(ctx, { sessionId: 'interactive' })).toThrow(/must be TTYs/)
  })
})
