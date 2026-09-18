import { describe, expect, it } from 'vitest'
import {
  ARGUMENT_BLUE,
  DEFAULT_PALETTE,
  USER_PROMPT_ROSE,
  DEFAULT_TOKENS,
  PALETTE_NAMES,
  TUI_TOKENS,
  type StyleSpec,
  type TuiToken,
  resolveToken,
} from '@/theme-tokens.ts'

const overrides = (entries: Partial<Record<TuiToken, StyleSpec>>) =>
  new Map(Object.entries(entries) as [TuiToken, StyleSpec][])

describe('the token table', () => {
  it('gives every token a shipped default', () => {
    for (const token of TUI_TOKENS) {
      expect(DEFAULT_TOKENS[token], `missing default for ${token}`).toBeDefined()
    }
  })

  it('names a palette entry for every missing colour', () => {
    for (const name of PALETTE_NAMES) {
      expect(DEFAULT_PALETTE[name], `missing palette entry ${name}`).toBeDefined()
    }
  })

  it('keeps muted text off a terminal palette slot', () => {
    // The bug this feature exists for: the palette slot is whatever the
    // reader's terminal says, which on their phone was indistinguishable from
    // ordinary text. Muted names the palette entry, and that entry is a hex
    // shade rather than an index, so the surface owns the contrast.
    expect(DEFAULT_PALETTE.muted).toMatch(/^#/u)
    for (const token of ['transcript.reasoning.body', 'transcript.reasoning.summary', 'tool.detail'] as const) {
      expect(DEFAULT_TOKENS[token].fg, `${token} does not follow the muted entry`).toBe('muted')
    }
  })

  it('ships no glyphs by default', () => {
    for (const token of TUI_TOKENS) {
      expect(DEFAULT_TOKENS[token].glyph ?? '', `${token} ships a glyph`).toBe('')
    }
  })

  it('ships nothing hidden by default', () => {
    for (const token of TUI_TOKENS) {
      expect(DEFAULT_TOKENS[token].hidden ?? false, `${token} ships hidden`).toBe(false)
    }
  })
})

describe('resolveToken', () => {
  it('resolves a muted token to an explicit grey', () => {
    const style = resolveToken('transcript.reasoning.body', overrides({}), DEFAULT_PALETTE, 'truecolor')
    expect(style.prefix).toBe('\u001B[38;2;138;138;138m')
    expect(style.suffix).toBe('\u001B[0m')
  })

  it('lets an override win over the shipped default', () => {
    const style = resolveToken(
      'transcript.reasoning.body',
      overrides({ 'transcript.reasoning.body': { fg: '#ff0000' } }),
      DEFAULT_PALETTE,
      'truecolor',
    )
    expect(style.prefix).toContain('38;2;255;0;0')
  })

  it('emits one well-formed SGR sequence with attributes and colour', () => {
    const style = resolveToken(
      'markdown.heading',
      overrides({ 'markdown.heading': { fg: '#00ff00', bold: true, italic: true } }),
      DEFAULT_PALETTE,
      'truecolor',
    )
    expect(style.prefix).toBe('\u001B[1;3;38;2;0;255;0m')
    expect(style.prefix.match(/\u001B\[/gu)).toHaveLength(1)
  })

  it('resolves a palette name through the palette', () => {
    const style = resolveToken('markdown.heading', overrides({}), DEFAULT_PALETTE, 'truecolor')
    expect(style.prefix).toContain('38;2;')
  })

  it('gives tool arguments their own pale-blue shade', () => {
    expect(DEFAULT_PALETTE.arg).toBe(ARGUMENT_BLUE)
    const style = resolveToken('tool.args', overrides({}), DEFAULT_PALETTE, 'truecolor')
    expect(style.prefix).toBe('\u001B[38;2;141;179;217m')
  })

  it('gives a submitted prompt its own rose shade', () => {
    expect(DEFAULT_PALETTE.user).toBe(USER_PROMPT_ROSE)
    const style = resolveToken('transcript.user', overrides({}), DEFAULT_PALETTE, 'truecolor')
    expect(style.prefix).toBe('\u001B[1;38;2;252;202;240m')
  })

  it('resolves an inherit chain', () => {
    const style = resolveToken(
      'tool.title',
      overrides({ 'tool.title': { inherit: 'transcript.marker', bold: true } }),
      DEFAULT_PALETTE,
      'truecolor',
    )
    expect(style.prefix).toContain('1')
  })

  it('takes the inherited fields instead of the token default', () => {
    // tool.title's own default is warn; the inherited token is the muted grey,
    // and inheriting means that field wins over the token's default.
    const style = resolveToken(
      'tool.title',
      overrides({ 'tool.title': { inherit: 'transcript.marker', bold: true } }),
      DEFAULT_PALETTE,
      'truecolor',
    )
    expect(style.prefix).toBe('\u001B[1;38;2;138;138;138m')
  })

  it('emits a background colour beside the foreground', () => {
    const style = resolveToken(
      'transcript.user',
      overrides({ 'transcript.user': { fg: '#00ff00', bg: '#ff0000' } }),
      DEFAULT_PALETTE,
      'truecolor',
    )
    expect(style.prefix).toContain('38;2;0;255;0')
    expect(style.prefix).toContain('48;2;255;0;0')
  })

  it('stops on an inherit cycle instead of hanging', () => {
    const cyclic = overrides({
      'tool.title': { inherit: 'tool.detail' },
      'tool.detail': { inherit: 'tool.title' },
    })
    expect(() => resolveToken('tool.title', cyclic, DEFAULT_PALETTE, 'truecolor')).not.toThrow()
  })

  it('drops the dim attribute when an explicit colour is chosen', () => {
    const style = resolveToken(
      'transcript.reasoning.body',
      overrides({ 'transcript.reasoning.body': { fg: '#808080', dim: true } }),
      DEFAULT_PALETTE,
      'truecolor',
    )
    // Faint is the attribute terminals ignore; the colour is the reliable half,
    // so carrying both would only reintroduce the ambiguity.
    expect(style.prefix).toBe('\u001B[38;2;128;128;128m')
  })

  it('hides an element completely when asked', () => {
    const style = resolveToken('status.cwd', overrides({ 'status.cwd': { hidden: true } }), DEFAULT_PALETTE, 'truecolor')
    expect(style.hidden).toBe(true)
    expect(style.prefix).toBe('')
    expect(style.suffix).toBe('')
  })

  it('emits nothing at all when colour is off', () => {
    const style = resolveToken('transcript.reasoning.body', overrides({}), DEFAULT_PALETTE, 'none')
    expect(style.prefix).toBe('')
    expect(style.suffix).toBe('')
  })

  it('keeps attributes but no colour when the colour cannot be parsed', () => {
    const style = resolveToken(
      'tool.title',
      overrides({ 'tool.title': { fg: 'chartreuse', bold: true } }),
      DEFAULT_PALETTE,
      'truecolor',
    )
    expect(style.prefix).toBe('\u001B[1m')
  })
})
