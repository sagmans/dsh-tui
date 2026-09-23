import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { createTheme } from '@/theme.ts'
import type { ColourMode } from '@/theme-capability.ts'
import { parseSettings, toOverrides } from '@/theme-settings.ts'
import { builtinLibrary } from '../support/themes.ts'
import { DEFAULT_PALETTE, type StyleSpec, type TuiToken } from '@/theme-tokens.ts'
import { TranscriptModel } from '@/transcript.ts'
import { MarkdownRenderer } from '@/ui/markdown.ts'
import { TranscriptView } from '@/ui/view.ts'

const LIBRARY = builtinLibrary()
const WIDTH = 12
const TEXT = 'hello'
const STATE = { expandCards: false, expandReasoning: false, expandSubCalls: false }
const MODES: readonly ColourMode[] = ['truecolor', '256', '16', 'none']
const GREY = '\u001b[38;2;64;64;64m'
// Bright black is the only dim grey a 16-colour terminal can address.
const DIM_SLOT = '\u001b[90m'
const BLACK_SLOT = '\u001b[30m'
const GOLD = '\u001b[38;2;214;194;154m'
const MINT = '\u001b[38;2;39;245;200m'
const RED = '\u001b[38;2;255;0;0m'
const RESET = '\u001b[0m'
const PLAIN_ROWS = ['╭──────────╮', '', TEXT, '', '╰──────────╯']

/** Real transcript rows catch tint leaking across style resets or into message text. */
function render(role: 'user' | 'assistant', mode: ColourMode = 'truecolor', tokens = new Map<TuiToken, StyleSpec>(), themeName?: string): string[] {
  const overrides = themeName === undefined
    ? { palette: DEFAULT_PALETTE, tokens }
    : toOverrides(parseSettings({ theme: themeName, tokens: Object.fromEntries(tokens) }), LIBRARY)
  const theme = createTheme(mode, overrides)
  const model = new TranscriptModel()
  const content = [{ type: 'text', text: TEXT }]
  model.apply(role === 'user'
    ? { type: 'user/message', data: { content, source: { kind: 'user' } } }
    : { type: 'assistant/message', data: { message: { content } } })
  return new TranscriptView(model, theme, new MarkdownRenderer(theme.markdown), { state: () => STATE }).render(WIDTH)
}

describe('transcript band accents', () => {
  it.each([
    ['user', MINT],
    ['assistant', GOLD],
  ] as const)('keeps %s colour on both corners rather than across the rule', (role, accent) => {
    const rows = render(role)
    expect(rows[0]).toBe(accent + '╭' + RESET + GREY + '──────────' + RESET + accent + '╮' + RESET)
    expect(rows.at(-1)).toBe(accent + '╰' + RESET + GREY + '──────────' + RESET + accent + '╯' + RESET)
    expect(rows[2]).toBe(role === 'user' ? MINT + TEXT + RESET : TEXT)
  })

  it.each(['deepseek-blue', 'violet-orbit'])('keeps quiet rules and speaker accents under %s', themeName => {
    for (const [role, accent] of [['user', MINT], ['assistant', GOLD]] as const) {
      const rows = render(role, 'truecolor', new Map(), themeName)
      expect(rows[0]).toBe(accent + '╭' + RESET + GREY + '──────────' + RESET + accent + '╮' + RESET)
      expect(rows.at(-1)).toBe(accent + '╰' + RESET + GREY + '──────────' + RESET + accent + '╯' + RESET)
      for (const mode of MODES) {
        expect(render(role, mode, new Map(), themeName).map(stripTerminalSequences)).toEqual(PLAIN_ROWS)
      }
    }
  })

  it.each(MODES)('preserves full-width geometry and air in %s', mode => {
    for (const role of ['user', 'assistant'] as const) {
      const rows = render(role, mode)
      expect(rows.map(stripTerminalSequences)).toEqual(PLAIN_ROWS)
      expect(rows.every(row => visibleWidth(row) <= WIDTH)).toBe(true)
      if (mode === 'none') expect(rows).toEqual(PLAIN_ROWS)
    }
  })

  it('keeps the rule out of the black slot on a 16-colour terminal', () => {
    // The rule must stay dim rather than vanish: a grey darker than the floor
    // degrades to black, which on a dark terminal leaves the message with no
    // rule at all and the corners floating on nothing.
    const rows = render('assistant', '16')
    expect(rows[0]).toContain(DIM_SLOT + '─')
    expect(rows[0]).not.toContain(BLACK_SLOT + '─')
    expect(rows.map(stripTerminalSequences)).toEqual(PLAIN_ROWS)
  })

  it('keeps submitted-prompt rules independent of the boxed editor colour', () => {
    const tokens = new Map<TuiToken, StyleSpec>([['editor.border', { fg: '#ff0000' }]])
    const theme = createTheme('truecolor', { palette: DEFAULT_PALETTE, tokens })
    expect(theme.editor.borderColor('╭──────────╮')).toBe(RED + '╭──────────╮' + RESET)
    expect(render('user', 'truecolor', tokens)[0]).toBe(MINT + '╭' + RESET + GREY + '──────────' + RESET + MINT + '╮' + RESET)
  })

  it.each(['user', 'assistant'] as const)('lets the %s corner override leave the rule and body alone', role => {
    const tokens = new Map<TuiToken, StyleSpec>([[
      role === 'user' ? 'transcript.user.corner' : 'transcript.assistant.corner', { fg: '#ff0000' },
    ]])
    const rows = render(role, 'truecolor', tokens)
    expect(rows[0]).toBe(RED + '╭' + RESET + GREY + '──────────' + RESET + RED + '╮' + RESET)
    expect(rows[2]).toBe(role === 'user' ? MINT + TEXT + RESET : TEXT)
  })

  it.each([
    ['user', 'transcript.user.border'],
    ['user', 'editor.border'],
    ['assistant', 'transcript.assistant.border'],
  ] as const)('removes corners and air when %s hides %s', (role, token) => {
    expect(render(role, 'truecolor', new Map<TuiToken, StyleSpec>([[token, { hidden: true }]]))
      .map(stripTerminalSequences)).toEqual([TEXT])
  })

  it('reserves corner columns when a corner element is hidden', () => {
    const rows = render('assistant', 'truecolor', new Map<TuiToken, StyleSpec>([['transcript.assistant.corner', { hidden: true }]]))
    expect(rows[0]).toBe(' ' + GREY + '──────────' + RESET + ' ')
    expect(rows.map(stripTerminalSequences)).toEqual([' ────────── ', '', TEXT, '', ' ────────── '])
  })
})
