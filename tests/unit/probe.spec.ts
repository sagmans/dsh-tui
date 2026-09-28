import { describe, expect, it } from 'vitest'
import {
  REQUIRED_CAPABILITIES,
  describeMissingOptional,
  describeMissingRequired,
  probeComposition,
} from '@/compat/probe.ts'

describe('probeComposition', () => {
  it('requires the roster, because it owns the tools every session runs', () => {
    expect(probeComposition(service => service !== 'agentPresets').missingRequired
      .map(capability => capability.service)).toEqual(['agentPresets'])
  })

  it('separates what stops the surface from what only degrades it', () => {
    const report = probeComposition(service => service !== 'agents' && service !== 'commands')
    expect(report.missingRequired.map(capability => capability.service)).toEqual(['agents'])
    expect(report.missingOptional.map(capability => capability.service)).toEqual(['commands'])
  })

  it('names the capability, its use, and the row that fixes it', () => {
    const message = describeMissingRequired(probeComposition(service => service !== 'appExit'))
    // The reader gets one line per missing row, spelled as the row to mount: a blob
    // of substrings is what an escape written as literal text would still pass.
    expect(message).toBe(
      'dsh-tui: this profile is missing what the terminal surface needs\n'
      + '  appExit: needed for leaving with the exit code the launcher owns — start this surface with dsh --profile tui',
    )
  })

  it('lists every missing requirement at once, so one boot explains them all', () => {
    const message = describeMissingRequired(probeComposition(() => false))
    const lines = message.split('\n')
    expect(lines).toHaveLength(REQUIRED_CAPABILITIES.length + 1)
    expect(lines[0]).toBe('dsh-tui: this profile is missing what the terminal surface needs')
    for (const capability of REQUIRED_CAPABILITIES) expect(message).toContain(capability.service)
  })

  it('summarizes a degraded run in one line', () => {
    const line = describeMissingOptional(probeComposition(service => service !== 'sessionPersistence'))
    expect(line).toContain('sessionPersistence')
    expect(line?.includes('\n')).toBe(false)
    // Nothing switched off means nothing to say, so no row stands on a clean boot.
    expect(describeMissingOptional(probeComposition(() => true))).toBeUndefined()
  })
})
