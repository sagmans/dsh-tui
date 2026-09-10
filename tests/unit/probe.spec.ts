import { describe, expect, it } from 'vitest'
import {
  OPTIONAL_CAPABILITIES,
  REQUIRED_CAPABILITIES,
  describeMissingOptional,
  describeMissingRequired,
  probeComposition,
} from '@/compat/probe.ts'

const everything = (service: string): boolean =>
  [...REQUIRED_CAPABILITIES, ...OPTIONAL_CAPABILITIES].some(capability => capability.service === service)

describe('probeComposition', () => {
  it('finds nothing missing in a complete composition', () => {
    const report = probeComposition(everything)
    expect(report.missingRequired).toEqual([])
    expect(report.missingOptional).toEqual([])
    expect(describeMissingOptional(report)).toBeUndefined()
  })

  it('separates what stops the surface from what only degrades it', () => {
    const report = probeComposition(service => service !== 'agents' && service !== 'commands')
    expect(report.missingRequired.map(capability => capability.service)).toEqual(['agents'])
    expect(report.missingOptional.map(capability => capability.service)).toEqual(['commands'])
  })

  it('names the capability, its use, and the row that fixes it', () => {
    const message = describeMissingRequired(probeComposition(service => service !== 'appExit'))
    expect(message).toContain('dsh-tui:')
    expect(message).toContain('appExit')
    expect(message).toContain('start this surface with dsh --profile tui')
  })

  it('lists every missing requirement at once, so one boot explains them all', () => {
    const message = describeMissingRequired(probeComposition(() => false))
    for (const capability of REQUIRED_CAPABILITIES) expect(message).toContain(capability.service)
  })

  it('summarizes a degraded run in one line', () => {
    const line = describeMissingOptional(probeComposition(service => service !== 'sessionPersistence'))
    expect(line).toContain('sessionPersistence')
    expect(line?.includes('\n')).toBe(false)
  })
})
