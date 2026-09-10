import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { createTheme } from '@/theme.ts'
import { formatStatus, formatTokens, shortPath, type StatusFacts } from '@/ui/status.ts'

const theme = createTheme(false)

const facts = (overrides: Partial<StatusFacts> = {}): StatusFacts => ({
  activity: 'idle',
  elapsedMs: undefined,
  model: 'deepseek-chat',
  effort: 'max',
  preset: 'workspace-write',
  contextTokens: 12_400,
  contextWindow: 128_000,
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

describe('formatStatus', () => {
  it('reads as a sentence about the session', () => {
    expect(formatStatus(facts(), 200, theme)).toBe(
      '● ready · deepseek-chat (max) · workspace-write · ctx 12.4k/128k · ~/deepseek-harness/master',
    )
  })

  it('shows how long the turn has been running', () => {
    expect(formatStatus(facts({ activity: 'working', elapsedMs: 3_400 }), 200, theme)).toContain('▶ working 3s')
    expect(formatStatus(facts({ activity: 'working', elapsedMs: 125_000 }), 200, theme)).toContain('▶ working 2m05s')
  })

  it('omits what the composition does not provide', () => {
    const line = formatStatus(
      facts({ model: undefined, effort: undefined, preset: undefined, contextTokens: undefined, contextWindow: undefined }),
      200,
      theme,
    )
    expect(line).toBe('● ready · ~/deepseek-harness/master')
  })

  it('never overflows the row it was given', () => {
    // Escape sequences are not columns, so the row is measured, not counted.
    expect(visibleWidth(formatStatus(facts(), 20, theme))).toBeLessThanOrEqual(20)
  })
})
