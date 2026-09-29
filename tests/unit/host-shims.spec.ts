import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { PRESET_FILES, loadPresetDefinitions } from '@/host/preset-files.ts'
import * as roster from '@/host/roster.ts'
import * as runner from '@/host/runner.ts'

/**
 * The host shims mount the harness packages a patch row cannot.
 *
 * The bundle patch is applied before any service exists, and the roster arrives
 * only after settings, so a patch row that waited on it would be applied after the
 * surface that needs it. These specs hold each shim to the package it mounts,
 * because mounting the wrong build fails at composition time in a user's profile
 * and nowhere in this repository.
 */

const registry = { name: 'preset-registry' }
const presetRow = { name: 'preset-row' }
const runnerRow = { name: 'runner-row' }

/**
 * The plain names are mocked, and that is the assertion.
 *
 * One supported line means one copy of each mounted package, so a shim has to
 * import the plain name: an aliased import would mount a second copy beside the
 * base's own row, which is the resolution the consumer install smoke counts.
 */
vi.mock('@deepseek-ai/dsh-agent-preset-registry', () => ({ default: registry }))
vi.mock('@deepseek-ai/dsh-agent-preset', () => ({ default: presetRow }))
vi.mock('@deepseek-ai/dsh-cordis-host-runner', () => ({ default: runnerRow }))

interface FakeContext {
  readonly plugin: ReturnType<typeof vi.fn>
  readonly inject: ReturnType<typeof vi.fn>
}

/**
 * A context carries the two calls a shim makes, and nothing else.
 *
 * `get` answers nothing on purpose: a shim that asked a service would be applied
 * after the surface, which is the failure these modules exist to avoid.
 */
function fakeContext(): Context & FakeContext {
  const plugin = vi.fn()
  // A service the harness does publish: the injected callback is what the roster
  // shim waits on before its own row can settle.
  const inject = vi.fn((_deps: readonly string[], callback: () => void) => {
    callback()
    return () => undefined
  })
  return { get: () => undefined, plugin, inject } as unknown as Context & FakeContext
}

describe('the host shims', () => {
  it('declares no dependency, so it is mounted at its place in the patch', () => {
    for (const shim of [roster, runner]) {
      expect('inject' in shim).toBe(false)
    }
  })

  it('publishes the roster through the registry row and one row per mode', async () => {
    const ctx = fakeContext()
    await roster.apply(ctx)
    expect(ctx.plugin).toHaveBeenNthCalledWith(1, registry, { default: roster.DEFAULT_PRESET })
    expect(ctx.plugin).toHaveBeenNthCalledWith(2, presetRow, loadPresetDefinitions()[0])
    expect(ctx.plugin).toHaveBeenCalledTimes(1 + PRESET_FILES.length)
  })

  it('follows the roster service it mounts, so the surface builds behind it', async () => {
    const ctx = fakeContext()
    await roster.apply(ctx)
    expect(ctx.inject).toHaveBeenCalledWith(['agentPresets'], expect.any(Function))
  })

  it('mounts one runner build, the one the supported line speaks', async () => {
    const ctx = fakeContext()
    await runner.apply(ctx)
    expect(ctx.plugin).toHaveBeenCalledWith(runnerRow)
  })
})

describe('the shipped modes', () => {
  it('reads every mode out of a packed file, in picker order', () => {
    const definitions = loadPresetDefinitions()
    expect(definitions.map(definition => definition.id)).toEqual([...PRESET_FILES])
    expect(definitions.map(definition => definition.order)).toEqual([1, 2, 3, 4])
  })

  it('mounts no plugin of another bundle', () => {
    // A mode that listed the agent plane would register a package this bundle
    // does not own, on top of the copy the profile's own layers composed.
    for (const definition of loadPresetDefinitions()) {
      expect(definition.plugins).toEqual([])
    }
  })
})
