import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { createTheme } from '@/theme.ts'
import { cacheRate, usageTotals } from '@/agent/status.ts'
import { formatStatus, formatTokens, shortPath, type StatusFacts } from '@/ui/status.ts'

const theme = createTheme(false)

const facts = (overrides: Partial<StatusFacts> = {}): StatusFacts => ({
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

describe('formatTokens', () => {
  it('keeps small counts exact and compacts large ones', () => {
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(12_400)).toBe('12.4k')
    expect(formatTokens(128_000)).toBe('128k')
    expect(formatTokens(2_500_000)).toBe('2.5M')
  })
})

describe('shortPath', () => {
  it('keeps the tail of a deep path and abbreviates the reader home', () => {
    expect(shortPath('/Users/dev/src/app', '/Users/dev')).toBe('~/src/app')
    expect(shortPath('/Users/dev/source/opensource/deepseek-harness/master', '/Users/dev')).toBe('~/deepseek-harness/master')
    expect(shortPath('/Users/dev', '/Users/dev')).toBe('~/')
    expect(shortPath('/tmp/x', '/Users/dev')).toBe('/tmp/x')
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

  it('ignores counts a backend reported as something other than a number', () => {
    expect(cacheRate({ cacheReadTokens: '87', uncachedInputTokens: 13 })).toBeUndefined()
  })
})

describe('formatStatus', () => {
  it('reads as a sentence about the session', () => {
    expect(formatStatus(facts(), 200, theme)).toBe(
      '● ready · standard · deepseek-official/deepseek-chat (max) · workspace-write · ctx 12.4k/128k · cache 87% · ~/deepseek-harness/master',
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
    expect(line).toBe('● ready · ~/deepseek-harness/master')
  })

  it('states the mode before the model it applies to', () => {
    const line = formatStatus(facts({ agentPreset: 'minimal' }), 200, theme)
    expect(line.startsWith('● ready · minimal · deepseek-official/deepseek-chat')).toBe(true)
  })

  it('never overflows the row it was given', () => {
    // Escape sequences are not columns, so the row is measured, not counted.
    expect(visibleWidth(formatStatus(facts(), 20, theme))).toBeLessThanOrEqual(20)
  })
})
