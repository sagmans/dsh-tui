import { describe, expect, it } from 'vitest'
import type { PromptEntry } from '@/agent/prompt-history.ts'
import { defaultKeymap } from '@/input/actions.ts'
import { HistoryPicker } from '@/ui/history-picker.ts'

const entry = (text: string, useCount = 1): PromptEntry => ({
  text,
  updatedAt: '2026-01-01T00:00:00.000Z',
  useCount,
})

const picker = (entries: readonly PromptEntry[], draft = ''): HistoryPicker =>
  new HistoryPicker(() => entries, draft, defaultKeymap)

describe('HistoryPicker', () => {
  it('opens filtered by the draft and picks the whole prompt', () => {
    const instance = picker([entry('fix the parser'), entry('run tests')], 'fix')
    expect(instance.visible().map(item => item.text)).toEqual(['fix the parser'])
    expect(instance.handleKey('\r')).toEqual({ kind: 'pick', id: 'fix the parser' })
  })

  it('folds a multiline prompt onto one row so a label cannot break the card', () => {
    const card = picker([entry('first line\nsecond line')]).card()
    expect(card.rows[0]?.label).toBe('first line second line')
  })

  it('folds a multiline draft on the card without losing the match', () => {
    const instance = picker([entry('one\ntwo')], 'one\ntwo')
    expect(instance.visible().map(item => item.text)).toEqual(['one\ntwo'])
    expect(instance.card().filter).toBe('one two')
  })

  it('counts how often a prompt was reused', () => {
    expect(picker([entry('repeat', 3)]).card().rows[0]?.description).toBe('3 uses')
  })

  it('leaves a prompt used once undescribed', () => {
    expect(picker([entry('once')]).card().rows[0]?.description).toBeUndefined()
  })

  it('offers the recorded count in the heading', () => {
    expect(picker([entry('a'), entry('b')]).card().title).toBe('prompt history · 2 recorded')
  })

  it('cancels on escape and on the interrupt key', () => {
    expect(picker([entry('a')]).handleKey('\u001b')).toEqual({ kind: 'cancel' })
    expect(picker([entry('a')]).handleKey('\u0003')).toEqual({ kind: 'cancel' })
  })
})
