import { describe, expect, it } from 'vitest'
import { ACTION_CATALOG, defaultKeymap, resolveKeymap } from '@/input/actions.ts'
import { KEYMAP_LAYERS, keymapLayer, renderKeymap } from '@/keys-command.ts'

const text = (lines: readonly string[]): string => lines.join('\n')

describe('renderKeymap', () => {
  it('lists every action with the keys in force and what it does', () => {
    const rendered = text(renderKeymap(defaultKeymap()))
    for (const action of ACTION_CATALOG) expect(rendered).toContain(`${action.id} = `)
    expect(rendered).toContain('prompt.submit = ctrl+enter · alt+enter · ctrl+s · submit the prompt')
    expect(rendered).toContain('tui.editor.yank = ctrl+y · ')
    expect(rendered).toContain('keys · 68 actions · 0 of them yours')
  })

  it('marks the rows the reader wrote, and the shadows they cast', () => {
    const rendered = text(renderKeymap(resolveKeymap({ 'surface.effort': 'alt+d' })))
    expect(rendered).toContain('surface.effort = alt+d · reasoning effort  (yours)')
    expect(rendered).toContain('keys · 68 actions · 1 of them yours')
    expect(rendered).toContain('keys you took from the library:')
    expect(rendered).toContain('alt+d: surface.effort over tui.editor.deleteWordForward')
  })

  it('does not repeat the shadows the surface ships with', () => {
    // ctrl+y is the nested-calls key out of the box, so naming it every time
    // would teach the reader to skip the line that matters.
    expect(text(renderKeymap(defaultKeymap()))).not.toContain('keys you took from the library:')
  })

  it('narrows to one layer when the reader names it', () => {
    const rendered = text(renderKeymap(defaultKeymap(), 'gate'))
    expect(rendered).toContain('gate.allow = y · allow once')
    expect(rendered).toContain('gate · an approval:')
    expect(rendered).not.toContain('picker.confirm')
    expect(rendered).toContain('keys · 3 actions')
  })

  it('shows the document that would say the same thing', () => {
    const rendered = text(renderKeymap(defaultKeymap()))
    expect(rendered).toContain('keys:')
    expect(rendered).toContain('prompt.submit: ctrl+enter')
    expect(rendered).toContain('settings.yaml')
  })

  it('names a layer only when the reader spelled one', () => {
    for (const layer of KEYMAP_LAYERS) expect(keymapLayer(layer)).toBe(layer)
    expect(keymapLayer('libary')).toBeUndefined()
  })
})
