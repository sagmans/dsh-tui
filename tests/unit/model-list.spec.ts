import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { createModelCatalog } from '@/agent/model.ts'
import { modelListLines, type ModelListCatalog } from '@/model-list.ts'

/** A catalog answering from a table, so a spec states only the order it asserts. */
function catalogOf(
  entries: readonly (readonly [string, readonly { readonly id: string; readonly name?: string }[]])[],
): ModelListCatalog {
  const table = new Map(entries)
  return {
    providers: () => [...table.keys()].map(id => ({ id, name: id })),
    models: async provider => table.get(provider) ?? [],
  }
}

describe('modelListLines', () => {
  it('keeps the picker order: registered providers, then each provider\u2019s models', async () => {
    const catalog = catalogOf([
      ['alpha', [{ id: 'a2', name: 'Alpha Two' }, { id: 'a1', name: 'Alpha One' }]],
      ['beta', [{ id: 'b1', name: 'Beta One' }]],
    ])
    await expect(modelListLines(catalog)).resolves.toEqual([
      'alpha/a2\tAlpha Two',
      'alpha/a1\tAlpha One',
      'beta/b1\tBeta One',
    ])
  })

  it('falls back to the model id when the adapter advertises no name', async () => {
    // Driven through the real catalog: an adapter's entry is normalized before
    // the listing ever formats it, so a hand-built shape would prove nothing.
    const catalog = createModelCatalog({
      get: () => ({ listProviders: () => [{ id: 'alpha', name: 'Alpha' }], listModels: async () => [{ id: 'a1' }] }),
    } as unknown as Context) as ModelListCatalog
    await expect(modelListLines(catalog)).resolves.toEqual(['alpha/a1\ta1'])
  })
})
