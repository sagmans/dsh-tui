/** Tier UI must preserve effort choices and never claim an uncommitted paid policy. */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createServiceTierPicker } from '@/surface/service-tier.ts'
import { defaultKeymap } from '@/input/actions.ts'
import { chordBindings } from '@/input/keymap.ts'

const PROVIDER = 'openai-codex'
const MODEL = 'gpt-5.6-luna'
const PRIORITY = 'priority'
const CHOICES = [{ id: PRIORITY, name: 'Fast', description: 'Higher usage cost' }]

const harness = (picked: string | undefined, available = true) => {
  const select = vi.fn().mockResolvedValue(undefined)
  const service = { choices: () => available ? CHOICES : [], current: () => undefined, select }
  const notices: string[] = []
  const openPicker = vi.fn().mockResolvedValue(picked)
  const open = createServiceTierPicker({ get: () => service } as unknown as Context, {
    keymap: defaultKeymap, openPicker, notice: message => notices.push(message), render: () => {},
  })
  return { open, select, notices, openPicker }
}

describe('service tier picker', () => {
  it('saves the selected tier and reports committed policy', async () => {
    const test = harness(PRIORITY)
    await test.open({ provider: PROVIDER, model: MODEL })
    expect(test.select).toHaveBeenCalledWith(PROVIDER, MODEL, PRIORITY)
    expect(test.notices.at(-1)).toContain(PRIORITY)
  })
  it('clears explicit policy and leaves cancellation untouched', async () => {
    const cleared = harness('')
    await cleared.open({ provider: PROVIDER, model: MODEL })
    expect(cleared.select).toHaveBeenCalledWith(PROVIDER, MODEL, undefined)
    const cancelled = harness(undefined)
    await cancelled.open({ provider: PROVIDER, model: MODEL })
    expect(cancelled.select).not.toHaveBeenCalled()
  })
  it('skips unsupported routes silently when chained, but explains direct requests', async () => {
    const test = harness(PRIORITY, false)
    await test.open({ provider: PROVIDER, model: MODEL }, true)
    expect(test.openPicker).not.toHaveBeenCalled()
    expect(test.notices).toEqual([])
    await test.open({ provider: PROVIDER, model: MODEL })
    expect(test.notices.at(-1)).toContain('no service tiers')
  })
  it('reports persistence failures without exposing adapter errors', async () => {
    const test = harness(PRIORITY)
    test.select.mockRejectedValue(new Error('secret fixture'))
    await test.open({ provider: PROVIDER, model: MODEL })
    expect(test.notices.at(-1)).toContain('could not save')
    expect(test.notices.join(' ')).not.toContain('secret fixture')
  })
  it('binds prefix+t independently', () => {
    expect(chordBindings(defaultKeymap()).find(binding => binding.key === 't')?.submission).toEqual({ kind: 'service-tier' })
  })
})
