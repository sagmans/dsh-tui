import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { createTheme } from '@/theme.ts'
import { DOCK_TODO_LIMIT, WorkDock } from '@/ui/dock.ts'
import type { WorkState } from '@/work.ts'

const theme = createTheme(false)
const dockOf = (state: WorkState): WorkDock => new WorkDock(() => state, theme)

const EMPTY: WorkState = { planMode: false, todos: undefined, goal: undefined }

describe('WorkDock', () => {
  it('takes no rows when there is nothing to say', () => {
    expect(dockOf(EMPTY).render(60)).toEqual([])
  })

  it('states the goal with its round budget', () => {
    const lines = dockOf({ ...EMPTY, goal: { objective: 'complete the plan', roundsStarted: 3, maxRounds: 256 } }).render(80)
    expect(lines).toEqual(['◎ goal round 3/256 · complete the plan'])
  })

  it('marks where a goal was cut off', () => {
    const lines = dockOf({ ...EMPTY, goal: { objective: 'x'.repeat(400), roundsStarted: 1, maxRounds: undefined } }).render(80)
    expect(visibleWidth(lines[0] ?? '')).toBeLessThanOrEqual(80)
    expect(lines[0]).toContain('…')
  })

  it('announces plan mode', () => {
    expect(dockOf({ ...EMPTY, planMode: true }).render(80)).toEqual(['⏸ plan mode · answer the plan before edits happen'])
  })

  it('orders the todos by what needs attention and counts the done ones', () => {
    const todos = [
      { content: 'done thing', status: 'completed' as const },
      { content: 'next thing', status: 'pending' as const },
      { content: 'now thing', status: 'in_progress' as const },
    ]
    const lines = dockOf({ ...EMPTY, todos }).render(80)
    expect(lines).toEqual([
      '☰ todos 1/3 done',
      '  ▸ now thing',
      '  ☐ next thing',
      '  ☑ done thing',
    ])
  })

  it('bounds a long list and counts what it left out', () => {
    const todos = Array.from({ length: DOCK_TODO_LIMIT + 3 }, (_, index) => ({ content: `task ${index}`, status: 'pending' as const }))
    const lines = dockOf({ ...EMPTY, todos }).render(80)
    expect(lines).toHaveLength(DOCK_TODO_LIMIT + 2)
    expect(lines.at(-1)).toBe('  … 3 more')
  })

  it('never overflows its row', () => {
    const state: WorkState = { ...EMPTY, todos: [{ content: 'y'.repeat(200), status: 'pending' }] }
    for (const line of dockOf(state).render(30)) expect(visibleWidth(line)).toBeLessThanOrEqual(30)
  })
})
