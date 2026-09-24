import { describe, expect, it } from 'vitest'
import { defaultKeymap, resolveKeymap } from '@/input/actions.ts'
import { ACTION_CATALOG } from '@/input/action-catalog.ts'
import { KEYMAP_LAYERS, keymapLayer, keymapRows, layerNote } from '@/keys-command.ts'

const row = (map: ReturnType<typeof defaultKeymap>, id: string, only?: (typeof KEYMAP_LAYERS)[number]) =>
  keymapRows(map, only).find(entry => entry.id === id)

describe('keymapRows', () => {
  it('lists every action, in catalog order, with the keys in force and what it does', () => {
    const rows = keymapRows(defaultKeymap())
    expect(rows.map(entry => entry.id)).toEqual(ACTION_CATALOG.map(action => action.id))
    expect(row(defaultKeymap(), 'prompt.submit')?.label).toBe('prompt.submit = ctrl+enter · alt+enter · ctrl+s · submit the prompt')
    expect(row(defaultKeymap(), 'tui.editor.yank')?.label).toContain('tui.editor.yank = ctrl+y · ')
    expect(row(defaultKeymap(), 'gate.allow')?.group).toBe('gate')
  })

  it('reads a row with no keys left as unbound rather than as nothing', () => {
    // The library ships this one unbound, which is exactly the row a reader may
    // put a key on; an empty label would read as a row with no name.
    expect(row(defaultKeymap(), 'tui.editor.historyPrevious')?.label).toContain('tui.editor.historyPrevious = unbound · ')
  })

  it('marks the rows the reader wrote, and the keys they took from the library', () => {
    const map = resolveKeymap({ 'surface.effort': 'alt+d' })
    expect(row(map, 'surface.effort')?.label).toBe('surface.effort = alt+d · reasoning effort  (yours)')
    expect(row(map, 'surface.effort')?.written).toBe(true)
    const taken = keymapRows(map).find(entry => !entry.action)
    expect(taken?.label).toBe('alt+d: surface.effort over tui.editor.deleteWordForward')
    expect(taken?.group).toBe('from the library')
    expect(taken?.written).toBe(false)
  })

  it('does not repeat the keys the surface already takes from the library', () => {
    // ctrl+y is the nested-calls key out of the box, so naming it every time
    // would teach the reader to skip the row that matters.
    expect(keymapRows(defaultKeymap()).some(entry => !entry.action)).toBe(false)
  })

  it('narrows to one layer when the reader names it', () => {
    const rows = keymapRows(defaultKeymap(), 'gate')
    expect(rows.map(entry => entry.id)).toEqual(ACTION_CATALOG.filter(action => action.layer === 'gate').map(action => action.id))
    expect(rows.every(entry => entry.action && entry.group === 'gate')).toBe(true)
  })

  it('names a layer only when the reader spelled one', () => {
    for (const layer of KEYMAP_LAYERS) {
      expect(keymapLayer(layer)).toBe(layer)
      expect(layerNote(layer)).not.toBe('')
    }
    expect(keymapLayer('libary')).toBeUndefined()
  })
})
