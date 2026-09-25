/**
 * The rows a transcript frame appends last: the picker, and the pending gate
 * with its cursor, its windowed options, and its free-text answer row.
 */

import { describe, expect, it } from 'vitest'
import { visibleWidth } from '@earendil-works/pi-tui'
import { type GateCard } from '@/gates.ts'
import { TranscriptModel } from '@/transcript.ts'
import { MarkdownRenderer } from '@/ui/markdown.ts'
import { type PickerCard } from '@/ui/picker.ts'
import { TranscriptView } from '@/ui/view.ts'
import { theme, answerBar, COLLAPSED, viewOf } from './fixtures/transcript-view.ts'

describe('TranscriptView picker', () => {
  it('lists stored sessions with a cursor, a filter, and the keys that drive it', () => {
      const picker: PickerCard = {
        title: 'resume a session · 2 stored',
        note: undefined,
        rows: [
          { label: 'fix the parser', description: '/work · 3m ago · 12 events', current: true },
          { label: 'tui-session-b', description: '/tmp · 1d ago', current: false },
        ],
        filter: 'fix',
        hint: '↑/ctrl+p or ↓/ctrl+n move · enter open · esc cancel · type to filter',
        above: 2,
        below: 3,
      }
      const view = new TranscriptView(new TranscriptModel(), theme, new MarkdownRenderer(theme.markdown), {
        picker: () => picker,
      })
      const lines = view.render(80)
      // No glyph by default: the picker's mark is a token now, and the shipped
      // table ships none, so the heading is its words.
      expect(lines).toContain('resume a session · 2 stored')
      expect(lines).toContain('    filter: fix')
      expect(lines).toContain('   ❯ fix the parser — /work · 3m ago · 12 events')
      expect(lines).toContain('     tui-session-b — /tmp · 1d ago')
      expect(lines).toContain('   … 2 newer')
      expect(lines).toContain('   … 3 older')
      expect(lines.some(line => line.includes('enter open'))).toBe(true)
    })
  it('folds the picker keys under a narrow screen instead of cutting the way out off', () => {
      const picker: PickerCard = {
        title: 'resume a session · 2 stored',
        note: undefined,
        rows: [{ label: 'fix the parser', description: '/work · 3m ago', current: true }],
        filter: '',
        hint: '↑/ctrl+p or ↓/ctrl+n move · enter open · esc/ctrl+c cancel · type to filter',
        above: 0,
        below: 0,
      }
      const view = new TranscriptView(new TranscriptModel(), theme, new MarkdownRenderer(theme.markdown), {
        picker: () => picker,
      })
      const lines = view.render(40)
      // The hint is how a reader learns to leave the list, so a narrow screen
      // folds it rather than dropping the keys a press still answers.
      const hint = lines.join(' ').replace(/\s+/gu, ' ')
      expect(hint).toContain('esc/ctrl+c cancel')
      expect(hint).toContain('type to filter')
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40)
    })
  it('wraps the reason a pick was refused under the heading', () => {
      const picker: PickerCard = {
        title: 'resume a session · 1 stored',
        note: 'session tui-session-a runs mode "cordis", so --preset standard does not apply; /preset standard switches it before its first turn',
        rows: [{ label: 'tui-session-a', description: '/work · 3m ago', current: true }],
        filter: '',
        hint: '↑/ctrl+p or ↓/ctrl+n move · enter open · esc cancel · type to filter',
        above: 0,
        below: 0,
      }
      const view = new TranscriptView(new TranscriptModel(), theme, new MarkdownRenderer(theme.markdown), {
        picker: () => picker,
      })
      const lines = view.render(60)
      const heading = lines.findIndex(line => line.includes('resume a session'))
      const row = lines.findIndex(line => line.includes('❯ tui-session-a'))
      // A reason that does not fit has to keep going rather than be cut off.
      const note = lines.slice(heading + 1, row).join(' ').replace(/\s+/gu, ' ')
      expect(note).toContain('session tui-session-a runs mode "cordis"')
      expect(note).toContain('switches it before its first turn')
      expect(lines[heading + 1]?.length).toBeLessThanOrEqual(60)
    })
})

describe('TranscriptView gate', () => {
  it('renders an approval gate with its decision keys', () => {
      const gate: GateCard = {
        kind: 'approval',
        title: 'approval needed · bash',
        detail: ['write outside the workspace'],
        optionOffset: 0,
        options: [],
        custom: undefined,
        answerInput: undefined,
        hint: 'y allow once · n reject · esc cancel',
      }
      const lines = viewOf(new TranscriptModel(), COLLAPSED, gate).render(60)
      expect(lines).toContain('⚠ approval needed · bash')
      expect(lines.some(line => line.includes('write outside the workspace'))).toBe(true)
      expect(lines.some(line => line.includes('y allow once'))).toBe(true)
    })
  it('numbers a windowed row by where it sits in the list, not by where it landed on screen', () => {
      const gate: GateCard = {
        kind: 'question',
        title: 'which target?  (1/2)',
        detail: [],
        optionOffset: 4,
        options: [
          { label: 'staging', description: 'safe', current: true, selected: true },
          { label: 'production', description: undefined, current: false, selected: false },
        ],
        custom: undefined,
        answerInput: undefined,
        hint: 'space select · digits pick · enter confirm · esc skip',
      }
      const lines = viewOf(new TranscriptModel(), COLLAPSED, gate).render(60)
      expect(lines).toContain('? which target?  (1/2)')
      expect(lines).toContain('   ❯ [x] 5. staging — safe')
      expect(lines).toContain('     [ ] 6. production')
    })
  it('keeps a gate answer row inside a surface too narrow for its indent', () => {
      const gate: GateCard = {
        kind: 'question',
        title: 'which target?',
        detail: [],
        optionOffset: 0,
        options: [],
        custom: undefined,
        answerInput: answerBar('answer'),
        hint: '',
      }
      const lines = viewOf(new TranscriptModel(), COLLAPSED, gate).render(4)
      // The indent alone can be as wide as the surface; the answer still has to
      // arrive as rows the surface can draw rather than as rows it must cut.
      expect(lines.every(line => visibleWidth(line) <= 4)).toBe(true)
    })
  it('wraps an option that runs past the screen instead of cutting it', () => {
      const gate: GateCard = {
        kind: 'question',
        title: 'which target?',
        detail: [],
        optionOffset: 0,
        options: [
          { label: 'staging-eu-west-1', description: 'the full canary rollout behind an audit window', current: true, selected: false },
        ],
        custom: undefined,
        answerInput: undefined,
        hint: 'space select · digits pick · enter confirm · esc skip',
      }
      const lines = viewOf(new TranscriptModel(), COLLAPSED, gate).render(40)
      const first = lines.findIndex(line => line.includes('1. staging-eu-west-1'))
      expect(first).toBeGreaterThan(-1)
      // The tail has to stay readable, because the description is what tells two
      // targets apart when their labels look alike.
      const wrapped = lines.slice(first, first + 3)
      expect(wrapped.join(' ')).toContain('audit window')
      // The continuation aligns under the label, not under the cursor mark: a
      // wrap that lands in the marker column reads as another row.
      expect(wrapped[1]).toMatch(/^ {12}\S/u)
      expect(lines.every(line => visibleWidth(line) <= 40)).toBe(true)
    })
  it('draws row 0 under the windowed options, marked while the cursor is on it', () => {
      const gate: GateCard = {
        kind: 'question',
        title: 'which target?  (1/2)',
        detail: [],
        optionOffset: 4,
        options: [{ label: 'staging', description: undefined, current: false, selected: false }],
        custom: { label: 'other', description: 'type your own answer', current: true, selected: true },
        answerInput: undefined,
        hint: 'space select · digits pick · 0 answer freely · type to filter · enter confirm · esc skip',
      }
      const lines = viewOf(new TranscriptModel(), COLLAPSED, gate).render(60)
      const row = lines.findIndex(line => line.includes('0. other'))
      expect(lines[row]).toBe('   ❯ [x] 0. other — type your own answer')
      // Row 0 sits under the window, so the window's own numbering is never interrupted.
      expect(lines.findIndex(line => line.includes('5. staging'))).toBeLessThan(row)
    })
  it('draws the typed answer under row 0, above the keys that name it', () => {
      const gate: GateCard = {
        kind: 'question',
        title: 'which target?',
        detail: ['showing 1–2 of 9'],
        optionOffset: 0,
        options: [{ label: 'staging', description: undefined, current: false, selected: false }],
        custom: { label: 'other', description: 'type your own answer', current: true, selected: true },
        answerInput: answerBar('the eu-central cluster'),
        hint: 'type or paste an answer · enter confirm · ↑↓/ctrl+p/ctrl+n or esc back to options',
      }
      const lines = viewOf(new TranscriptModel(), COLLAPSED, gate).render(60)
      const row = lines.findIndex(line => line.includes('0. other'))
      const answer = lines.findIndex(line => line.includes('the eu-central cluster'))
      // The bar belongs to the row it fills: above the options it reads as
      // something the question says rather than something the reader is typing.
      expect(answer).toBeGreaterThan(row)
      expect(lines.findIndex(line => line.includes('1. staging'))).toBeLessThan(answer)
      expect(lines.findIndex(line => line.includes('type or paste'))).toBeGreaterThan(answer)
    })
  it('draws the answer line of a question that has only text to collect', () => {
      const gate: GateCard = {
        kind: 'question',
        title: 'why?',
        detail: [],
        optionOffset: 0,
        options: [],
        custom: undefined,
        answerInput: answerBar(''),
        hint: 'type or paste an answer · enter confirm · esc skip',
      }
      const lines = viewOf(new TranscriptModel(), COLLAPSED, gate).render(60)
      expect(lines).toContain('? why?')
      // A question with nothing but text to collect still opens the bar, because
      // an empty bar is where the first character of an answer lands.
      expect(lines.some(line => line.startsWith('   │'))).toBe(true)
      expect(lines.findIndex(line => line.startsWith('   │'))).toBeGreaterThan(lines.indexOf('? why?'))
    })
  it('wraps the question and the keys it names rather than cutting them', () => {
      const gate: GateCard = {
        kind: 'question',
        title: 'which deployment target should the release candidate use?',
        detail: [],
        optionOffset: 0,
        options: [],
        custom: undefined,
        answerInput: undefined,
        hint: 'space select · digits pick · 0 answer freely · type to filter · enter confirm · esc skip',
      }
      const lines = viewOf(new TranscriptModel(), COLLAPSED, gate).render(40)
      expect(lines.every(line => visibleWidth(line) <= 40)).toBe(true)
      // The question's own words and the last key it names both survive the edge.
      expect(lines.join(' ')).toContain('release candidate use?')
      expect(lines.join(' ')).toContain('esc skip')
    })
})
