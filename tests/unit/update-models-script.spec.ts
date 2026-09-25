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
const HOMES: string[] = []

function scratchHome(patch: string): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-model-dump-'))
  HOMES.push(home)
  mkdirSync(join(home, 'profiles', 'tui'), { recursive: true })
  writeFileSync(join(home, 'profiles', 'tui', 'cordis.patch.yml'), patch)
  return home
}

function patchWith(catalog: unknown): string {
  return '- ' + JSON.stringify({ id: 'dsh-provider-extra', config: { catalog } }) + '\n'
}

function run(home: string, ...args: string[]) {
  return spawnSync('node', [SCRIPT, '--home', home, ...args], { cwd: REPO_ROOT, encoding: 'utf8' })
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
        auth: { apiKeyEnv: 'ROUTE_API_KEY' },
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
      default: null,
      providers: [{
        id: 'route',
        name: 'Route',
        source: 'no-such-provider',
        models: [{ id: 'ghost-2', metadata: { contextWindow: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } }],
      }],
    }))

    const result = run(home, '--json')
    expect(result.status).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(parsed.default).toBeNull()
    expect(parsed.rows).toHaveLength(1)
    expect(parsed.rows[0]).toMatchObject({ route: 'route/ghost-2', contextWindow: 100 })
  })
})
