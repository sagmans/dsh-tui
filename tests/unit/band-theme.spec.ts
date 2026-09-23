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
const MARK = { user: '\u001b[38;2;39;245;200m', assistant: '\u001b[38;2;214;194;154m' } as const
/** A rule is its own speaker's corner hue at about a quarter of the lightness. */
const RULE = { user: '\u001b[38;2;11;81;66m', assistant: '\u001b[38;2;70;58;32m' } as const
/** What those two shades degrade to, so a 16-colour terminal keeps both apart. */
const RULE_SLOT = { user: '\u001b[36m', assistant: '\u001b[33m' } as const
const BLACK_SLOT = '\u001b[30m'
const RED = '\u001b[38;2;255;0;0m'
const RESET = '\u001b[0m'
const PLAIN_ROWS = ['⠄──────────⠠', '', TEXT, '', '⠁──────────⠈']

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
    ['user', MARK.user, RULE.user],
    ['assistant', MARK.assistant, RULE.assistant],
  ] as const)('keeps %s colour on its corners and its own dim hue on the rule', (role, accent, rule) => {
    const rows = render(role)
    expect(rows[0]).toBe(accent + '⠄' + RESET + rule + '──────────' + RESET + accent + '⠠' + RESET)
    expect(rows.at(-1)).toBe(accent + '⠁' + RESET + rule + '──────────' + RESET + accent + '⠈' + RESET)
    expect(rows[2]).toBe(role === 'user' ? MARK.user + TEXT + RESET : TEXT)
  })

  it('tints each rule to its own speaker rather than one shade for both', () => {
    // A block is read at a glance, and its corners are two columns at the far
    // edges: the rule has to say whose turn it closes on its own.
    const [user] = render('user')
    const [assistant] = render('assistant')
    expect(user).not.toBe(assistant)
    expect(user).toContain(RULE.user + '─')
    expect(assistant).toContain(RULE.assistant + '─')
  })

  it.each(['deepseek-blue', 'violet-orbit'])('keeps quiet rules and speaker accents under %s', themeName => {
    for (const role of ['user', 'assistant'] as const) {
      const rows = render(role, 'truecolor', new Map(), themeName)
      expect(rows[0]).toBe(MARK[role] + '⠄' + RESET + RULE[role] + '──────────' + RESET + MARK[role] + '⠠' + RESET)
      expect(rows.at(-1)).toBe(MARK[role] + '⠁' + RESET + RULE[role] + '──────────' + RESET + MARK[role] + '⠈' + RESET)
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

  it.each(['user', 'assistant'] as const)('keeps the %s rule out of the black slot on a 16-colour terminal', role => {
    // The rule must stay dim rather than vanish: a shade below the degraded
    // palette's floor folds into black, which on a dark terminal leaves the
    // message with no rule under its corners at all.
    const [top] = render(role, '16')
    expect(top).toContain(RULE_SLOT[role] + '─')
    expect(top).not.toContain(BLACK_SLOT + '─')
  })

  it('keeps submitted-prompt rules independent of the boxed editor colour', () => {
    const tokens = new Map<TuiToken, StyleSpec>([['editor.border', { fg: '#ff0000' }]])
    const theme = createTheme('truecolor', { palette: DEFAULT_PALETTE, tokens })
    expect(theme.editor.borderColor('╭──────────╮')).toBe(RED + '╭──────────╮' + RESET)
    expect(render('user', 'truecolor', tokens)[0]).toBe(MARK.user + '⠄' + RESET + RULE.user + '──────────' + RESET + MARK.user + '⠠' + RESET)
  })

  it.each(['user', 'assistant'] as const)('lets the %s mark override leave the rule and body alone', role => {
    const tokens = new Map<TuiToken, StyleSpec>([[
      role === 'user' ? 'transcript.user.mark' : 'transcript.assistant.mark', { fg: '#ff0000' },
    ]])
    const rows = render(role, 'truecolor', tokens)
    expect(rows[0]).toBe(RED + '⠄' + RESET + RULE[role] + '──────────' + RESET + RED + '⠠' + RESET)
    expect(rows[2]).toBe(role === 'user' ? MARK.user + TEXT + RESET : TEXT)
  })

  it.each([
    ['user', 'transcript.user.border'],
    ['user', 'editor.border'],
    ['assistant', 'transcript.assistant.border'],
  ] as const)('removes corners and air when %s hides %s', (role, token) => {
    expect(render(role, 'truecolor', new Map<TuiToken, StyleSpec>([[token, { hidden: true }]]))
      .map(stripTerminalSequences)).toEqual([TEXT])
  })

  it('reserves the mark columns when the mark element is hidden', () => {
    const rows = render('assistant', 'truecolor', new Map<TuiToken, StyleSpec>([['transcript.assistant.mark', { hidden: true }]]))
    expect(rows[0]).toBe(' ' + RULE.assistant + '──────────' + RESET + ' ')
    expect(rows.map(stripTerminalSequences)).toEqual([' ────────── ', '', TEXT, '', ' ────────── '])
  })
})
