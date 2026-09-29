import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import * as codeRuntime from '@/host/code-runtime.ts'
import { runsOnNewLine } from '@/host/generation.ts'
import { PRESET_FILES, loadPresetDefinitions } from '@/host/preset-files.ts'
import * as roster from '@/host/roster.ts'
import * as runner from '@/host/runner.ts'

/**
 * The host shims are what lets one bundle serve two harness lines.
 *
 * The bundle patch cannot choose between the lines — the loader mounts its rows
 * before any service exists, and a row that waits for one is mounted after the
 * surface that needs the roster — so the choice is made in these modules, read
 * from the composed tree. These specs hold both branches to the package each must
 * mount, because mounting the wrong build fails at composition time in a user's
 * profile and nowhere in this repository.
 */

const retiredRoster = { name: 'retired-roster' }
const registry = { name: 'preset-registry' }
const presetRow = { name: 'preset-row' }
const newRunner = { name: 'runner-for-0.1.7' }
const oldRunner = { name: 'runner-for-0.1.5' }
const oldRuntime = { name: 'worker-thread-runtime' }

vi.mock('@deepseek-ai/dsh-agent-presets', () => ({ default: retiredRoster }))
vi.mock('@deepseek-ai/dsh-agent-preset-registry', () => ({ default: registry }))
vi.mock('@deepseek-ai/dsh-agent-preset', () => ({ default: presetRow }))
vi.mock('@sagmans/dsh-cordis-host-runner-017', () => ({ default: newRunner }))
vi.mock('@deepseek-ai/dsh-cordis-host-runner', () => ({ default: oldRunner }))
vi.mock('@deepseek-ai/dsh-code-runtime-worker-thread', () => ({ default: oldRuntime }))

/** The base row only the newer line composes, named as a profile's namespace does. */
const NEW_LINE_ROW = 'include:ptc-runtime'

/** The base row the older line composes instead. */
const OLD_LINE_ROW = 'include:workflow-worker-thread'

interface FakeContext {
  readonly plugin: ReturnType<typeof vi.fn>
  readonly inject: ReturnType<typeof vi.fn>
}

/**
 * The composed tree is all a shim reads, so that is all a context needs to be.
 *
 * `get` answers nothing on purpose: a shim that asked a service would be mounted
 * after the surface, which is the failure these modules exist to avoid.
 */
function fakeContext(ids: readonly string[]): Context & FakeContext {
  const plugin = vi.fn()
  const loader = { entries: () => ids.map(id => ({ id })) }
  // A service the harness does publish: the injected callback is what a roster
  // shim waits on before its own row can settle.
  const inject = vi.fn((_deps: readonly string[], callback: () => void) => {
    callback()
    return () => undefined
  })
  return { get: () => undefined, plugin, loader, inject } as unknown as Context & FakeContext
}

const newLine = () => fakeContext([NEW_LINE_ROW, 'include:settings'])
const oldLine = () => fakeContext([OLD_LINE_ROW, 'include:settings'])

describe('runsOnNewLine', () => {
  it('reads the line from the base row the newer release composes', () => {
    expect(runsOnNewLine(newLine())).toBe(true)
    expect(runsOnNewLine(oldLine())).toBe(false)
  })

  it('answers the older line when the tree cannot be walked at all', () => {
    expect(runsOnNewLine({} as Context)).toBe(false)
    expect(runsOnNewLine({ loader: { entries: () => { throw new Error('no tree') } } } as unknown as Context)).toBe(
      false,
    )
  })
})

describe('the host shims', () => {
  it('declares no dependency, so it is mounted at its place in the patch', () => {
    for (const shim of [roster, runner, codeRuntime]) {
      expect('inject' in shim).toBe(false)
    }
  })

  it('mounts the retired roster on the older line and the registry on the newer', async () => {
    const older = oldLine()
    await roster.apply(older)
    expect(older.plugin).toHaveBeenCalledTimes(1)
    // The fallback mode travels as config: the retired roster publishes nothing
    // without it, and a mode this bundle does not ship would start a session.
    expect(older.plugin).toHaveBeenCalledWith(retiredRoster, { default: roster.DEFAULT_PRESET })

    const newer = newLine()
    await roster.apply(newer)
    expect(newer.plugin).toHaveBeenNthCalledWith(1, registry, { default: roster.DEFAULT_PRESET })
    expect(newer.plugin).toHaveBeenNthCalledWith(2, presetRow, loadPresetDefinitions()[0])
    // One row per mode, which is how the newer line keeps modes apart: the retired
    // package discovered its own, and the newer one only knows what rows declare.
    expect(newer.plugin).toHaveBeenCalledTimes(1 + PRESET_FILES.length)
  })

  it('resolves a row config through the plugin schema, the way the loader does', async () => {
    // A row config carries only overrides; the schema is what completes it, and a
    // package mounted with the partial config unresolved never publishes anything.
    const schema = { '~standard': { validate: (input: unknown) => ({ value: { ...(input as object), roots: ['/x'] } }) } }
    const validated = { name: 'validated-roster', Config: schema }
    vi.doMock('@deepseek-ai/dsh-agent-presets', () => ({ default: validated }))
    vi.resetModules()
    const fresh = (await import('@/host/roster.ts')) as typeof roster
    const older = oldLine()
    await fresh.apply(older)
    expect(older.plugin).toHaveBeenCalledWith(validated, { default: fresh.DEFAULT_PRESET, roots: ['/x'] })
    vi.doUnmock('@deepseek-ai/dsh-agent-presets')
    vi.resetModules()
  })

  it('follows the roster service it mounts, so the surface builds behind it', async () => {
    const older = oldLine()
    await roster.apply(older)
    expect(older.inject).toHaveBeenCalledWith(['agentPresets'], expect.any(Function))
  })

  it('mounts the runner build that speaks the protocol of the running line', async () => {
    const older = oldLine()
    await runner.apply(older)
    expect(older.plugin).toHaveBeenCalledWith(oldRunner)

    const newer = newLine()
    await runner.apply(newer)
    expect(newer.plugin).toHaveBeenCalledWith(newRunner)
  })

  it('mounts the code runtime only where the base does not', async () => {
    const newer = newLine()
    await codeRuntime.apply(newer)
    expect(newer.plugin).not.toHaveBeenCalled()

    const older = oldLine()
    await codeRuntime.apply(older)
    expect(older.plugin).toHaveBeenCalledWith(oldRuntime)
  })
})

describe('the shipped modes', () => {
  it('reads every mode out of a packed file, in picker order', () => {
    const definitions = loadPresetDefinitions()
    expect(definitions.map(definition => definition.id)).toEqual([...PRESET_FILES])
    expect(definitions.map(definition => definition.order)).toEqual([1, 2, 3, 4])
  })

  it('keeps a loader expression as the marker the loader evaluates', () => {
    expect(JSON.stringify(loadPresetDefinitions())).toContain('"__jsExpr"')
  })
})
