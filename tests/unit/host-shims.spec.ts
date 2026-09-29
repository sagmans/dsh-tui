import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import * as codeRuntime from '@/host/code-runtime.ts'
import { harnessLine, lineForRelease } from '@/host/generation.ts'
import { PRESET_FILES, loadPresetDefinitions } from '@/host/preset-files.ts'
import * as roster from '@/host/roster.ts'
import * as runner from '@/host/runner.ts'

/**
 * The host shims are what lets one bundle serve three harness lines.
 *
 * The bundle patch cannot choose between the lines — the loader mounts its rows
 * before any service exists, and a row that waits for one is mounted after the
 * surface that needs the roster — so the choice is made in these modules, from
 * the hosting base release, with the composed tree as the fallback. These specs
 * hold each branch to the package it must mount, because mounting the wrong build
 * fails at composition time in a user's profile and nowhere in this repository.
 *
 * The base release is what separates 0.1.7 from 0.2.0: those two compose the same
 * base rows, so nothing in the tree can tell them apart. The release probe is
 * exercised through `lineForRelease`, its pure half, because a spec tree installs
 * no base beside this package; the newest line's runner mount is proven against a
 * real 0.2.0 profile instead, which is the only place it can be.
 */

const retiredRoster = { name: 'retired-roster' }
const registry = { name: 'preset-registry' }
const presetRow = { name: 'preset-row' }
const newestRunner = { name: 'runner-for-0.2.0' }
const newRunner = { name: 'runner-for-0.1.7' }
const oldRunner = { name: 'runner-for-0.1.5' }
const oldRuntime = { name: 'worker-thread-runtime' }

/**
 * The plain names are deliberately not mocked: nothing may import them.
 *
 * Every harness package this bundle mounts is an alias of its own, one build per
 * line, because a plain name resolves to one release for a whole profile and the
 * harness reads its own version as the runtime version. A shim that imported a
 * plain name would resolve the alias's copy instead and fail here.
 */

vi.mock('@sagmans/dsh-agent-presets-015', () => ({ default: retiredRoster }))
vi.mock('@sagmans/dsh-agent-preset-registry-017', () => ({ default: registry }))
vi.mock('@sagmans/dsh-agent-preset-registry-020', () => ({ default: registry }))
vi.mock('@sagmans/dsh-agent-preset-017', () => ({ default: presetRow }))
vi.mock('@sagmans/dsh-agent-preset-020', () => ({ default: presetRow }))
vi.mock('@sagmans/dsh-cordis-host-runner-020', () => ({ default: newestRunner }))
vi.mock('@sagmans/dsh-cordis-host-runner-017', () => ({ default: newRunner }))
vi.mock('@sagmans/dsh-cordis-host-runner-015', () => ({ default: oldRunner }))
vi.mock('@sagmans/dsh-code-runtime-worker-thread-015', () => ({ default: oldRuntime }))

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

describe('harnessLine', () => {
  it('reads the line from the base row the newer releases compose', () => {
    expect(harnessLine(newLine())).toBe('0.1.7')
    expect(harnessLine(oldLine())).toBe('0.1.5')
  })

  it('answers the oldest line when the tree cannot be walked at all', () => {
    expect(harnessLine({} as Context)).toBe('0.1.5')
    expect(harnessLine({ loader: { entries: () => { throw new Error('no tree') } } } as unknown as Context)).toBe(
      '0.1.5',
    )
  })
})

describe('lineForRelease', () => {
  it('names the line a base release belongs to', () => {
    expect(lineForRelease('0.1.5-rc.3')).toBe('0.1.5')
    expect(lineForRelease('0.1.7-rc.2')).toBe('0.1.7')
    expect(lineForRelease('0.2.0-rc.2')).toBe('0.2.0')
  })

  it('mounts the newest build on a release past the last one named', () => {
    // Refusing to answer would mount machinery the host has already replaced,
    // and answering the oldest line would mount a runner that lies about the
    // runtime version, which is what makes a host disable its own rows.
    expect(lineForRelease('0.3.0-rc.1')).toBe('0.2.0')
    expect(lineForRelease('1.0.0')).toBe('0.2.0')
  })

  it('answers nothing for a version that names no line', () => {
    expect(lineForRelease('')).toBeUndefined()
    expect(lineForRelease('next')).toBeUndefined()
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
    expect(newer.plugin).toHaveBeenNthCalledWith(2, presetRow, loadPresetDefinitions('0.1.7')[0])
    // The mode's own rows follow the hosting line for the same reason the runner
    // does: a plain name resolves to one release for a whole profile.
    const newest = loadPresetDefinitions('0.2.0')
    expect(newest[0]?.plugins.map(row => row.name).filter(name => name.startsWith('@sagmans/'))).not.toEqual([])
    expect(JSON.stringify(newest)).not.toContain('@deepseek-ai/dsh-persona"')
    // One row per mode, which is how the newer line keeps modes apart: the retired
    // package discovered its own, and the newer one only knows what rows declare.
    expect(newer.plugin).toHaveBeenCalledTimes(1 + PRESET_FILES.length)
  })

  it('resolves a row config through the plugin schema, the way the loader does', async () => {
    // A row config carries only overrides; the schema is what completes it, and a
    // package mounted with the partial config unresolved never publishes anything.
    const schema = { '~standard': { validate: (input: unknown) => ({ value: { ...(input as object), roots: ['/x'] } }) } }
    const validated = { name: 'validated-roster', Config: schema }
    vi.doMock('@sagmans/dsh-agent-presets-015', () => ({ default: validated }))
    vi.resetModules()
    const fresh = (await import('@/host/roster.ts')) as typeof roster
    const older = oldLine()
    await fresh.apply(older)
    expect(older.plugin).toHaveBeenCalledWith(validated, { default: fresh.DEFAULT_PRESET, roots: ['/x'] })
    // The alias is mocked again rather than unmocked: the other shims import it,
    // and the real package pulls its own tree into this spec's module graph.
    vi.doMock('@sagmans/dsh-agent-presets-015', () => ({ default: retiredRoster }))
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

  it('names an aliased runner build for every line, the oldest included', () => {
    // A plain dependency on any one build is what a profile resolves the base's
    // own runner row to, and the host reads its runtime version off that runner,
    // so a missing or shared entry shows up as a host that cannot run its rows.
    expect(Object.keys(runner.RUNNER_BY_LINE).sort()).toEqual(['0.1.5', '0.1.7', '0.2.0'])
    for (const alias of Object.values(runner.RUNNER_BY_LINE)) expect(alias).toMatch(/^@sagmans\//)
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
    const definitions = loadPresetDefinitions('0.1.7')
    expect(definitions.map(definition => definition.id)).toEqual([...PRESET_FILES])
    expect(definitions.map(definition => definition.order)).toEqual([1, 2, 3, 4])
  })

  it('keeps a loader expression as the marker the loader evaluates', () => {
    expect(JSON.stringify(loadPresetDefinitions('0.1.7'))).toContain('"__jsExpr"')
  })
})
