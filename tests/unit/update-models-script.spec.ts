import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { REPO_ROOT } from './dogfood-fixture.js'

/**
 * The model dump answers what a profile will actually serve.
 *
 * It reads two inputs: the owned catalog in the profile patch, and the installed
 * pi-ai data an entry inherits from when it names no metadata of its own. A
 * catalog can spell a model out completely, and that entry must resolve on a
 * machine with no harness install at all - the reading is what an agent uses to
 * check a catalog it is about to edit, so it cannot depend on what it inspects.
 */

const SCRIPT = join(REPO_ROOT, '.agents', 'skills', 'dsh-tui-update-models', 'scripts', 'dump-model-catalog.mjs')
/** A directory no provider data lives in, so inheritance has nothing to read. */
const NO_DATA = join(tmpdir(), 'dsh-model-dump-no-data')
const HOMES: string[] = []

function scratchHome(patch: string): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-model-dump-'))
  HOMES.push(home)
  mkdirSync(join(home, 'profiles', 'tui'), { recursive: true })
  writeFileSync(join(home, 'profiles', 'tui', 'cordis.patch.yml'), patch)
  return home
}

/**
 * An installed provider catalog, in the shape pi-ai ships: one JSON file per
 * source, keyed by protocol, then by model id.
 *
 * The dump inherits from this exactly as the resolver does, so a spec that
 * names its own directory tests inheritance without depending on whichever
 * harness happens to be installed.
 */
function scratchData(source: string, models: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-model-data-'))
  HOMES.push(dir)
  writeFileSync(join(dir, source + '.json'), JSON.stringify({ 'openai-completions': models }))
  return dir
}

/** An installed entry carrying every fact a model can inherit. */
function installed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Installed Sibling',
    reasoning: true,
    input: ['text'],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
    ...overrides,
  }
}

/** Metadata complete enough for a model no installed catalog describes. */
function declaredMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    api: 'openai-completions',
    reasoning: true,
    input: ['text'],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
    ...overrides,
  }
}

function patchWith(catalog: unknown): string {
  return '- ' + JSON.stringify({ id: 'dsh-provider-extra', config: { catalog } }) + '\n'
}

function run(home: string, ...args: string[]) {
  return spawnSync('node', [SCRIPT, '--home', home, '--data', NO_DATA, ...args], { cwd: REPO_ROOT, encoding: 'utf8' })
}

afterEach(() => {
  for (const home of HOMES.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('model catalog dump', () => {
  it('reads a model the catalog describes entirely in metadata', () => {
    const home = scratchHome(patchWith({
      version: 1,
      default: { provider: 'route', model: 'ghost-1', reasoningEffort: 'high' },
      providers: [{
        id: 'route',
        name: 'Route',
        source: 'no-such-provider',
        auth: { apiKeyRef: 'ROUTE_API_KEY' },
        models: [{
          id: 'ghost-1',
          name: 'Ghost 1',
          metadata: {
            api: 'openai-responses',
            reasoning: true,
            input: ['text'],
            cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 42,
            maxTokens: 7,
          },
        }],
      }],
    }))

    const result = run(home)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('ctx 42')
    expect(result.stdout).toContain('max 7')
    expect(result.stdout).toContain('$1/2/0/0 per 1M')
    expect(result.stdout).toContain('efforts off,minimal,low,medium,high')
    expect(result.stdout).toContain('contextWindow=metadata maxTokens=metadata')
  })

  it('refuses an entry that names neither a template nor metadata', () => {
    const home = scratchHome(patchWith({
      version: 1,
      default: null,
      providers: [{ id: 'route', name: 'Route', source: 'openai', models: [{ id: 'nowhere-1' }] }],
    }))

    const result = run(home)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('UNRESOLVED: no source entry for nowhere-1; declare a template or metadata')
  })

  it('reports a profile that wires models another way', () => {
    const home = scratchHome('- id: llm-pi-ai\n  config: {}\n')

    const result = run(home)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('no owned catalog in')
  })

  it('prints the same reading as JSON', () => {
    const home = scratchHome(patchWith({
      version: 1,
      default: { provider: 'route', model: 'ghost-2' },
      providers: [{
        id: 'route',
        name: 'Route',
        source: 'no-such-provider',
        models: [{
          id: 'ghost-2',
          name: 'Ghost 2',
          metadata: declaredMetadata({ contextWindow: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
        }],
      }],
    }))

    const result = run(home, '--json')
    expect(result.status).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(parsed.default).toEqual({ provider: 'route', model: 'ghost-2' })
    expect(parsed.rows).toHaveLength(1)
    expect(parsed.rows[0]).toMatchObject({
      route: 'route/ghost-2',
      api: 'openai-completions',
      contextWindow: 100,
      origins: 'contextWindow=metadata maxTokens=metadata cost=metadata input=metadata reasoning=metadata thinkingLevelMap=none api=metadata',
    })
  })

  it('names the metadata an unknown model still owes', () => {
    const home = scratchHome(patchWith({
      version: 1,
      default: null,
      providers: [{
        id: 'route',
        name: 'Route',
        source: 'no-such-provider',
        models: [{ id: 'ghost-3', name: 'Ghost 3', metadata: { contextWindow: 100 } }],
      }],
    }))

    const result = run(home)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('UNRESOLVED: unknown model requires complete metadata: missing api, reasoning, input, cost, maxTokens')
  })

  it('expands a filter route against the installed catalog', () => {
    const data = scratchData('fake-source', {
      'glm-5': installed({ name: 'GLM 5', contextWindow: 9000 }),
      'glm-4-legacy': installed({ name: 'GLM 4' }),
      'other-model': installed({ name: 'Other' }),
    })
    const home = scratchHome(patchWith({
      version: 1,
      default: { provider: 'route', model: 'glm-5' },
      providers: [{ id: 'route', name: 'Route', source: 'fake-source', filter: { include: ['glm-*'], exclude: ['glm-4*'] } }],
    }))

    const result = run(home, '--data', data)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('route/glm-5')
    expect(result.stdout).toContain('ctx 9000')
    expect(result.stdout).toContain('filter:glm-* all installed')
    expect(result.stdout).not.toContain('glm-4-legacy')
    expect(result.stdout).not.toContain('other-model')
  })

  it('refuses a filter route whose installed catalog it cannot read', () => {
    const home = scratchHome(patchWith({
      version: 1,
      default: null,
      providers: [{ id: 'route', name: 'Route', source: 'fake-source', filter: { include: ['*'] } }],
    }))

    const result = run(home)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('UNRESOLVED: filter expands the installed catalog of source "fake-source"; no harness install found')
  })

  it('refuses a route that declares both membership styles', () => {
    const home = scratchHome(patchWith({
      version: 1,
      default: null,
      providers: [{
        id: 'route',
        name: 'Route',
        source: 'fake-source',
        filter: { include: ['*'] },
        models: [{ id: 'ghost-4', name: 'Ghost 4', metadata: declaredMetadata() }],
      }],
    }))

    const result = run(home)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('UNRESOLVED: declare exactly one of models or filter')
  })

  it('keeps model capacity apart from the request default', () => {
    const data = scratchData('fake-source', { 'sibling-1': installed({ maxTokens: 100 }) })
    const home = scratchHome(patchWith({
      version: 1,
      default: { provider: 'route', model: 'cloned' },
      providers: [{
        id: 'route',
        name: 'Route',
        source: 'fake-source',
        models: [
          { id: 'cloned', name: 'Cloned', template: 'sibling-1', defaultMaxTokens: 40 },
          { id: 'declared', name: 'Declared', metadata: declaredMetadata({ maxTokens: 100 }), defaultMaxTokens: 40 },
        ],
      }],
    }))

    const result = run(home, '--data', data)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('route/cloned\n  Cloned | openai-completions | ctx 1000 | max 100 | req 40')
    expect(result.stdout).toContain('maxTokens=template:sibling-1')
    expect(result.stdout).toContain('route/declared\n  Declared | openai-completions | ctx 1000 | max 100 | req 40')
    expect(result.stdout).toContain('maxTokens=metadata')
  })

  it('refuses a request default above the model capacity', () => {
    const home = scratchHome(patchWith({
      version: 1,
      default: null,
      providers: [{
        id: 'route',
        name: 'Route',
        source: 'no-such-provider',
        models: [{ id: 'ghost-5', name: 'Ghost 5', defaultMaxTokens: 400, metadata: declaredMetadata({ maxTokens: 100 }) }],
      }],
    }))

    const result = run(home)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('UNRESOLVED: defaultMaxTokens 400 exceeds model maxTokens 100')
  })

  it('prints the aliases a selection may name', () => {
    const home = scratchHome(patchWith({
      version: 1,
      default: { provider: 'route', model: 'ghost-six' },
      providers: [{
        id: 'route',
        name: 'Route',
        source: 'no-such-provider',
        models: [{ id: 'ghost-6', name: 'Ghost 6', aliases: ['ghost-six', 'g6'], metadata: declaredMetadata() }],
      }],
    }))

    const result = run(home)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('aliases ghost-six,g6')
  })

  it('reads a route that declares its own protocol and endpoint', () => {
    const home = scratchHome(patchWith({
      version: 1,
      default: { provider: 'local', model: 'local-model' },
      providers: [{
        id: 'local',
        name: 'Local',
        api: 'openai-completions',
        baseURL: 'http://127.0.0.1:8080/v1',
        models: [{
          id: 'local-model',
          name: 'Local Model',
          metadata: declaredMetadata({ api: undefined, contextWindow: 10, maxTokens: 5 }),
        }],
      }],
    }))

    const result = run(home)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('local/local-model\n  Local Model | openai-completions | ctx 10 | max 5')
    expect(result.stdout).toContain('api=route')
  })

  it('refuses a default the served selection does not contain', () => {
    const home = scratchHome(patchWith({
      version: 1,
      default: { provider: 'route', model: 'ghost-typo' },
      providers: [{
        id: 'route',
        name: 'Route',
        source: 'no-such-provider',
        models: [{ id: 'ghost-7', name: 'Ghost 7', metadata: declaredMetadata() }],
      }],
    }))

    const result = run(home)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('UNRESOLVED: provider/model is outside the managed selection: route/ghost-typo')
  })

  it('resolves a default named by an alias', () => {
    const home = scratchHome(patchWith({
      version: 1,
      default: { provider: 'route', model: 'g8' },
      providers: [{
        id: 'route',
        name: 'Route',
        source: 'no-such-provider',
        models: [{ id: 'ghost-8', name: 'Ghost 8', aliases: ['g8'], metadata: declaredMetadata() }],
      }],
    }))

    const result = run(home)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('default: {"provider":"route","model":"g8"}')
  })

  it('refuses an effort the selected model does not offer', () => {
    const home = scratchHome(patchWith({
      version: 1,
      default: { provider: 'route', model: 'ghost-9', reasoningEffort: 'max' },
      providers: [{
        id: 'route',
        name: 'Route',
        source: 'no-such-provider',
        models: [{ id: 'ghost-9', name: 'Ghost 9', metadata: declaredMetadata() }],
      }],
    }))

    const result = run(home)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('UNRESOLVED: effort is not supported by the selected model: max')
  })

  it('refuses a default on a catalog that serves nothing', () => {
    const home = scratchHome(patchWith({
      version: 1,
      default: { provider: 'route', model: 'ghost-10' },
      providers: [{ id: 'route', name: 'Route', source: 'no-such-provider', models: [] }],
    }))

    const result = run(home)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('UNRESOLVED: an empty catalog requires default null')
  })

  it('refuses a served catalog that selects no default', () => {
    const home = scratchHome(patchWith({
      version: 1,
      default: null,
      providers: [{
        id: 'route',
        name: 'Route',
        source: 'no-such-provider',
        models: [{ id: 'ghost-11', name: 'Ghost 11', metadata: declaredMetadata() }],
      }],
    }))

    const result = run(home)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('UNRESOLVED: a served catalog requires a default selection')
  })
})
