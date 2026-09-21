import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { createTheme } from '@/theme.ts'
import { DEFAULT_PALETTE } from '@/theme-tokens.ts'
import { cacheRate, usageTotals } from '@/agent/status.ts'
import { formatTokens } from '@/tokens.ts'
import { formatStatus, shortPath, type StatusFacts } from '@/ui/status.ts'

const theme = createTheme('none')

const facts = (overrides: Partial<StatusFacts> = {}): StatusFacts => ({
  chord: undefined,
  back: undefined,
  activity: 'idle',
  elapsedMs: undefined,
  provider: 'deepseek-official',
  model: 'deepseek-chat',
  effort: 'max',
  agentPreset: 'standard',
  preset: 'workspace-write',
  contextTokens: 12_400,
  contextWindow: 128_000,
  cacheRate: 0.87,
  uncachedInputTokens: 1_600,
  outputTokens: 3_100,
  cwd: '/Users/dev/source/opensource/deepseek-harness/master',
  home: '/Users/dev',
  ...overrides,
})

describe('an armed chord', () => {
  it('leads the row, so a narrow terminal cuts the tail and not the chord', () => {
    expect(formatStatus(facts({ chord: 'ctrl+x' }), 200, theme))
      .toMatch(/^ctrl\+x/)
    expect(formatStatus(facts({ chord: 'ctrl+x' }), 20, theme)).toContain('ctrl+x')
  })

  it('is absent until a prefix is pressed', () => {
    expect(formatStatus(facts(), 200, theme)).not.toContain('ctrl+x')
  })
})

describe('the parked-draft count', () => {
  it('is absent while nothing is parked, so the ordinary state stays quiet', () => {
    expect(formatStatus(facts(), 200, theme)).not.toContain('stash ')
    expect(formatStatus(facts({ stashed: 0 }), 200, theme)).not.toContain('stash ')
  })

  it('says how many drafts are waiting, before the directory they belong to', () => {
    const line = formatStatus(facts({ stashed: 3 }), 200, theme)
    expect(line).toContain('stash 3')
    expect(line.indexOf('stash 3')).toBeLessThan(line.indexOf('~/source/opensource'))
  })

  /**
   * A row cut to width keeps its head, and the count is what tells a reader work
   * is waiting; the context and cache numbers are recoverable by looking again.
   * So the count has to survive every cut the numbers beside it survive.
   */
  it('never appears later than the running numbers it outranks', () => {
    const parked = facts({ stashed: 3 })
    const widths = Array.from({ length: 180 }, (_, index) => index + 20)
    const firstWithCount = widths.find(width => formatStatus(parked, width, theme).includes('stash 3'))
    expect(firstWithCount).toBeDefined()
    const line = formatStatus(parked, firstWithCount as number, theme)
    expect(visibleWidth(line)).toBeLessThanOrEqual(firstWithCount as number)
    expect(line).not.toContain('cache 87%')
    expect(line).not.toContain('ctx 12.4k')
  })
})

describe('formatTokens', () => {
  it('keeps small counts exact and compacts large ones', () => {
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(12_400)).toBe('12.4k')
    expect(formatTokens(128_000)).toBe('128k')
    expect(formatTokens(2_500_000)).toBe('2.5M')
  })
})

describe('shortPath', () => {
  it('abbreviates the reader home without inventing a shallower path', () => {
    expect(shortPath('/Users/dev/src/app', '/Users/dev')).toBe('~/src/app')
    expect(shortPath('/Users/dev/source/me/dsh-tui/main', '/Users/dev')).toBe('~/source/me/dsh-tui/main')
    expect(shortPath('/Users/dev/source/opensource/deepseek-harness/master', '/Users/dev')).toBe('~/source/opensource/deepseek-harness/master')
    expect(shortPath('/Users/dev', '/Users/dev')).toBe('~/')
  })

  it('keeps the tail of a deep path outside the home and marks the cut', () => {
    expect(shortPath('/tmp/x', '/Users/dev')).toBe('/tmp/x')
    expect(shortPath('/tmp/a/b/c/d', '/Users/dev')).toBe('…/c/d')
    expect(shortPath('/tmp/a/b/c/d', undefined)).toBe('…/c/d')
  })
})

describe('usageTotals', () => {
  it('reads the totals the token meter projects', () => {
    const state = {
      totals: { uncachedInputTokens: 1_600, outputTokens: 3_100, cacheReadTokens: 8_700, cacheWriteTokens: 0 },
      last: { turn: 1, step: 1, buckets: {} },
    }
    expect(usageTotals(state)).toEqual({
      uncachedInputTokens: 1_600,
      outputTokens: 3_100,
      cacheReadTokens: 8_700,
      cacheWriteTokens: 0,
    })
  })

  it('refuses a state that is not the projected shape', () => {
    expect(usageTotals({ uncachedInputTokens: 1 })).toBeUndefined()
    expect(usageTotals(undefined)).toBeUndefined()
    expect(usageTotals({ totals: 'nope' })).toBeUndefined()
  })
})

describe('cacheRate', () => {
  it('reads as the share of prompt tokens the provider cached', () => {
    expect(cacheRate({ cacheReadTokens: 87, uncachedInputTokens: 13 })).toBeCloseTo(0.87)
  })

  it('has no opinion without both counts, or without any tokens at all', () => {
    expect(cacheRate({ cacheReadTokens: 87 })).toBeUndefined()
    expect(cacheRate({})).toBeUndefined()
    expect(cacheRate({ cacheReadTokens: 0, uncachedInputTokens: 0 })).toBeUndefined()
    expect(cacheRate(undefined)).toBeUndefined()
  })

  it('states the way back while another session is on screen', () => {
    // The hint has to follow the map the reader has now rather than the one the
    // session was opened under, so it is a fact of the row and not of the text.
    expect(formatStatus(facts({ back: 'ctrl+g returns to this session' }), 200, theme)).toContain('ctrl+g returns to this session')
    expect(formatStatus(facts(), 200, theme)).not.toContain('returns to this session')
    // It leads the row with the chord, so a narrow terminal cuts the facts first.
    expect(formatStatus(facts({ back: 'ctrl+g returns to this session' }), 30, theme)).toContain('ctrl+g returns')
  })

  it('ignores counts a backend reported as something other than a number', () => {
    expect(cacheRate({ cacheReadTokens: '87', uncachedInputTokens: 13 })).toBeUndefined()
  })
})

describe('formatStatus', () => {
  it('reads as a sentence about the session', () => {
    expect(formatStatus(facts(), 200, theme)).toBe(
      '● ready · standard · deepseek-official/deepseek-chat (max) · workspace-write · ctx 12.4k/128k · cache 87% · ~/source/opensource/deepseek-harness/master',
    )
  })

  it('shows how long the turn has been running', () => {
    expect(formatStatus(facts({ activity: 'working', elapsedMs: 3_400 }), 200, theme)).toContain('▶ working 3s')
    expect(formatStatus(facts({ activity: 'working', elapsedMs: 125_000 }), 200, theme)).toContain('▶ working 2m05s')
  })

  it('omits what the composition does not provide', () => {
    const line = formatStatus(
      facts({
        provider: undefined,
        model: undefined,
        effort: undefined,
        agentPreset: undefined,
        preset: undefined,
        contextTokens: undefined,
        contextWindow: undefined,
        cacheRate: undefined,
      }),
      200,
      theme,
    )
    expect(line).toBe('● ready · ~/source/opensource/deepseek-harness/master')
  })

  it('states the mode before the model it applies to', () => {
    const line = formatStatus(facts({ agentPreset: 'minimal' }), 200, theme)
    expect(line.startsWith('● ready · minimal · deepseek-official/deepseek-chat')).toBe(true)
  })

  it('never overflows the row it was given', () => {
    // Escape sequences are not columns, so the row is measured, not counted.
    expect(visibleWidth(formatStatus(facts(), 20, theme))).toBeLessThanOrEqual(20)
  })

  /**
   * The footer styles segments and then joins them, so it is the one renderer
   * that could hand its own generated escapes to the escaper that exists for
   * untrusted text. A `\x1B` on screen is exactly that mistake.
   */
  describe('with colour on', () => {
    const colourTheme = createTheme('truecolor')
    const working = (): StatusFacts => facts({ activity: 'working', elapsedMs: 22_000 })

    it('never prints an escape as literal text', () => {
      const line = formatStatus(working(), 200, colourTheme)
      expect(line).not.toContain('\\x1B')
      expect(line).not.toContain('\\u001B')
    })

    it('opens one styled run per element and closes it again', () => {
      const line = formatStatus(working(), 200, colourTheme)
      // The reset is itself a sequence beginning with `ESC[`, so opens are
      // counted as sequences that are not the reset.
      const sequences = line.match(/\u001B\[[0-9;]*m/gu) ?? []
      const opens = sequences.filter(sequence => sequence !== '\u001B[0m').length
      const resets = sequences.filter(sequence => sequence === '\u001B[0m').length
      expect(opens).toBeGreaterThan(0)
      expect(resets).toBe(opens)
    })

    it('leaves no styling open when it truncates', () => {
      const line = formatStatus(working(), 24, colourTheme)
      // A row cut mid-style bleeds colour into whatever the surface draws next.
      expect(line.endsWith('\u001B[0m')).toBe(true)
    })

    it('styles the elapsed time as its own element without nesting it', () => {
      const line = formatStatus(working(), 200, colourTheme)
      // Elapsed must stay separately addressable, so it is its own styled run
      // rather than text folded into the activity's. Nesting two runs is what
      // produced a doubled reset and an escape printed as text.
      expect(line).toContain('\u001B[38;2;138;138;138m▶ working\u001B[0m')
      expect(line).toContain('\u001B[38;2;138;138;138m 22s\u001B[0m')
      expect(line).not.toContain('\u001B[0m\u001B[0m')
    })

    it('reads the same with colour on as it does with colour off', () => {
      // Styling may not change the words, only how they are drawn.
      const coloured = formatStatus(working(), 200, colourTheme)
      const plain = formatStatus(working(), 200, theme)
      expect(coloured.replace(/\u001B\[[0-9;]*m/gu, '')).toBe(plain)
    })

    it('keeps the row the width it was given once escapes are discounted', () => {
      expect(visibleWidth(formatStatus(working(), 40, colourTheme))).toBeLessThanOrEqual(40)
    })
  })
})

describe('formatStatus theming', () => {
  it('draws no separator when the separator element is hidden', () => {
    // Hiding the separator used to fall back to a plain one, which is the
    // opposite of what hidden promises.
    const hidden = createTheme('truecolor', { palette: DEFAULT_PALETTE, tokens: new Map([['status.separator', { hidden: true }]]) })
    const line = formatStatus(facts(), 200, hidden)
    expect(line).not.toContain('·')
    expect(line).toContain('deepseek-chat')
  })

  it('omits a hidden fact entirely', () => {
    const hidden = createTheme('truecolor', { palette: DEFAULT_PALETTE, tokens: new Map([['status.cwd', { hidden: true }]]) })
    expect(formatStatus(facts(), 200, hidden)).not.toContain('source/opensource')
  })
})
