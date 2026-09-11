import { describe, expect, it } from 'vitest'
import type { StoredSession } from '@/agent/history.ts'
import { PICKER_WINDOW, SessionPicker, describeAge } from '@/ui/picker.ts'

const session = (id: string, overrides: Partial<StoredSession> = {}): StoredSession => ({
  id,
  cwd: '/work',
  createdAt: 1_000_000,
  eventCount: 12,
  ...overrides,
})

const pickerOf = (sessions: StoredSession[], titles: Record<string, string> = {}): SessionPicker =>
  new SessionPicker(sessions, () => new Map(Object.entries(titles)), () => 1_000_000)

describe('describeAge', () => {
  it('reads as a moment rather than a timestamp', () => {
    expect(describeAge(1_000_000, 1_000_000)).toBe('just now')
    expect(describeAge(0, 5 * 60_000)).toBe('5m ago')
    expect(describeAge(0, 3 * 3_600_000)).toBe('3h ago')
    expect(describeAge(0, 2 * 86_400_000)).toBe('2d ago')
  })
})

describe('SessionPicker', () => {
  it('picks the highlighted session on enter', () => {
    const picker = pickerOf([session('a'), session('b')])
    expect(picker.handleKey('\u001b[B')).toBeUndefined()
    expect(picker.handleKey('\r')).toEqual({ kind: 'pick', id: 'b' })
  })

  it('cancels on escape', () => {
    expect(pickerOf([session('a')]).handleKey('\u001b')).toEqual({ kind: 'cancel' })
  })

  it('filters by title, id, and directory', () => {
    const picker = pickerOf([session('a', { cwd: '/one' }), session('b', { cwd: '/two' })], { a: 'fix the parser' })
    picker.handleKey('p')
    picker.handleKey('a')
    expect(picker.visible().map(entry => entry.id)).toEqual(['a'])
    picker.handleKey('\u007f')
    picker.handleKey('\u007f')
    picker.handleKey('t')
    picker.handleKey('w')
    picker.handleKey('o')
    expect(picker.visible().map(entry => entry.id)).toEqual(['b'])
  })

  it('never highlights a row that does not exist', () => {
    const picker = pickerOf([session('a')])
    picker.handleKey('\u001b[B')
    picker.handleKey('\u001b[B')
    expect(picker.card().rows[0]?.current).toBe(true)
    expect(picker.handleKey('\r')).toEqual({ kind: 'pick', id: 'a' })
  })

  it('says how to widen an empty result instead of picking nothing', () => {
    const picker = pickerOf([session('a')])
    picker.handleKey('z')
    expect(picker.visible()).toEqual([])
    expect(picker.handleKey('\r')).toBeUndefined()
    expect(picker.card().hint).toContain('nothing matches')
  })

  it('keeps the cursor inside the window it draws', () => {
    const many = Array.from({ length: 40 }, (_, index) => session(`s${index}`))
    const picker = pickerOf(many)
    const first = picker.card()
    expect(first.rows).toHaveLength(PICKER_WINDOW)
    expect(first.rows[0]?.current).toBe(true)
    expect(first.above).toBe(0)
    expect(first.below).toBe(40 - PICKER_WINDOW)
    for (let step = 0; step < 30; step += 1) picker.handleKey('\u001b[B')
    const moved = picker.card()
    expect(moved.rows.some(row => row.current)).toBe(true)
    expect(moved.above).toBeGreaterThan(0)
    expect(moved.above + moved.rows.length + moved.below).toBe(40)
  })

  it('carries a refusal note until the reader does something else', () => {
    const picker = pickerOf([session('a'), session('b')])
    expect(picker.card().note).toBeUndefined()
    picker.setNote('session a runs mode "cordis", so --preset standard does not apply')
    expect(picker.card().note).toContain('does not apply')
    picker.handleKey('\u001b[B')
    expect(picker.card().note).toBeUndefined()
  })

  it('offers the newest session first and titles it when known', () => {
    const picker = pickerOf([session('new', { createdAt: 999_500 }), session('old', { createdAt: 1_000 })], { new: 'latest work' })
    const card = picker.card()
    expect(card.rows[0]?.label).toBe('latest work')
    expect(card.rows[0]?.description).toBe('/work · just now · 12 events')
    expect(card.title).toBe('resume a session · 2 stored')
  })
})
