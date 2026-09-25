import { describe, expect, it } from 'vitest'
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

  it('separates the route from the display name with one tab', async () => {
    const lines = await modelListLines(catalogOf([['alpha', [{ id: 'a1', name: 'Alpha One' }]]]))
    expect(lines).toEqual(['alpha/a1\tAlpha One'])
    expect(lines[0]?.split('\t')).toEqual(['alpha/a1', 'Alpha One'])
  })

  it('falls back to the model id when the adapter advertises no name', async () => {
    await expect(modelListLines(catalogOf([['alpha', [{ id: 'a1' }]]]))).resolves.toEqual(['alpha/a1\ta1'])
  })

  it('prints no line for a deployment with no providers', async () => {
    await expect(modelListLines(catalogOf([]))).resolves.toEqual([])
  })
})
