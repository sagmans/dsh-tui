import { describe, expect, it } from 'vitest'
import { defaultKeymap, resolveKeymap } from '@/input/actions.ts'
import { ACTION_CATALOG } from '@/input/action-catalog.ts'
import { KeymapPicker } from '@/ui/keymap-picker.ts'

/** A reader typing into the filter, one key press at a time. */
const typed = (picker: KeymapPicker, text: string): KeymapPicker => {
  for (const character of text) picker.handleKey(character)
  return picker
}

const ids = (picker: KeymapPicker): readonly string[] => picker.visible().map(row => row.id)

describe('KeymapPicker', () => {
  it('counts the whole map and the part of it the reader wrote', () => {
    expect(new KeymapPicker(defaultKeymap, undefined).card().title)
      .toBe(`keys · ${ACTION_CATALOG.length} actions · 0 of them yours`)
  })

  it('names the layer it was narrowed to, and counts only that layer', () => {
    const gate = ACTION_CATALOG.filter(action => action.layer === 'gate').length
    expect(new KeymapPicker(defaultKeymap, 'gate').card().title)
      .toBe(`keys · gate · an approval · ${gate} actions · 0 of them yours`)
  })

  it('filters on the action id, the layer, and the keys in force', () => {
    // The layer's name is part of every row in it, so the whole layer answers to
    // the word the heading uses for it.
    const gate = typed(new KeymapPicker(defaultKeymap, undefined), 'gate').visible()
    expect(gate.filter(row => row.group === 'gate')).toHaveLength(ACTION_CATALOG.filter(action => action.layer === 'gate').length)
    expect(ids(typed(new KeymapPicker(defaultKeymap, undefined), 'surface.toolDetail'))).toEqual(['surface.toolDetail'])
    expect(ids(typed(new KeymapPicker(defaultKeymap, undefined), 'ctrl+o'))).toContain('surface.toolDetail')
    expect(ids(typed(new KeymapPicker(defaultKeymap, undefined), 'stash'))).toContain('chord.stash')
  })

  it('lists the keys the reader took from the library where the map can find them', () => {
    const map = resolveKeymap({ 'surface.effort': 'alt+d' })
    const taken = new KeymapPicker(() => map, undefined).visible().filter(row => !row.action)
    expect(taken.map(row => row.label)).toEqual(['alt+d: surface.effort over tui.editor.deleteWordForward'])
    // Its own name is a contiguous hit, so it outranks every scattered reading.
    expect(ids(typed(new KeymapPicker(() => map, undefined), 'shadow'))[0]).toBe('shadow:alt+d:surface.effort')
  })

  it('reads the map again on every paint, so an edit made while it is open lands', () => {
    const picker = new KeymapPicker(() => resolveKeymap({ 'surface.effort': 'alt+d' }), undefined)
    expect(picker.visible().find(row => row.id === 'surface.effort')?.label).toContain('= alt+d')
    expect(picker.card().title).toContain('1 of them yours')
  })

  it('says the keys close it, because there is no row to take', () => {
    const picker = new KeymapPicker(defaultKeymap, undefined)
    expect(picker.card().hint).toBe('↑/ctrl+p or ↓/ctrl+n move · enter close · esc/ctrl+c close · type to filter')
    expect(picker.handleKey('\u001b')).toEqual({ kind: 'cancel' })
  })
})
