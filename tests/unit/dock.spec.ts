import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { createTheme } from '@/theme.ts'
import { DEFAULT_PALETTE } from '@/theme-tokens.ts'
import { DOCK_TODO_LIMIT, WorkDock } from '@/ui/dock.ts'
import type { WorkState } from '@/work.ts'

const theme = createTheme('none')
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

  it('shows only the todos still to do, most urgent first', () => {
    const todos = [
      { content: 'done thing', status: 'completed' as const },
      { content: 'next thing', status: 'pending' as const },
      { content: 'now thing', status: 'in_progress' as const },
    ]
    const lines = dockOf({ ...EMPTY, todos }).render(80)
    expect(lines).toEqual([
      '☰ todos · 2 left',
      '  ▸ now thing',
      '  ☐ next thing',
    ])
  })

  it('drops the todo list once every item is done', () => {
    const todos = [{ content: 'done thing', status: 'completed' as const }]
    expect(dockOf({ ...EMPTY, todos }).render(80)).toEqual([])
  })

  it('bounds a long list and counts what it left out', () => {
    const todos = Array.from({ length: DOCK_TODO_LIMIT + 3 }, (_, index) => ({ content: `task ${index}`, status: 'pending' as const }))
    const lines = dockOf({ ...EMPTY, todos }).render(80)
    expect(lines).toHaveLength(DOCK_TODO_LIMIT + 2)
    expect(lines.at(-1)).toBe('  … 3 more')
  })

  it('shows only the jobs still running', () => {
    const jobs = [
      { id: 'bash-1', kind: 'bash', label: 'build', status: 'completed' as const, startedAt: 1_000, finishedAt: 2_000 },
      { id: 'bash-2', kind: 'bash', label: 'test', status: 'running' as const, startedAt: Date.now(), finishedAt: undefined },
    ]
    const lines = new WorkDock(() => EMPTY, theme, () => jobs).render(80)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe('⛭ jobs · 1 running')
    expect(lines[1]).toContain('▸ bash-2 · running')
  })

  it('drops the job board once every job has settled', () => {
    const jobs = [
      { id: 'bash-1', kind: 'bash', label: 'build', status: 'completed' as const, startedAt: 1_000, finishedAt: 2_000 },
      { id: 'bash-3', kind: 'bash', label: 'deploy', status: 'failed' as const, startedAt: 1_000, finishedAt: 2_000 },
    ]
    expect(new WorkDock(() => EMPTY, theme, () => jobs).render(80)).toEqual([])
  })

  it('lists only the delegations still running', () => {
    const runs = [
      { runId: 'r1', provider: 'spawn', id: 'child-abcdef', startedAt: Date.now() - 4_000, status: 'running' as const },
      { runId: 'r2', provider: 'fork', id: 'child-2', startedAt: 1_000, status: 'failed' as const, finishedAt: 2_000 },
    ]
    const lines = new WorkDock(() => EMPTY, theme, () => [], () => runs).render(80)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe('⚇ subagents · 1 running')
    expect(lines[1]).toContain('▸ child-ab · spawn · running')
  })

  it('drops the subagent board once every delegation has settled', () => {
    const runs = [
      { runId: 'r2', provider: 'fork', id: 'child-2', startedAt: 1_000, status: 'failed' as const, finishedAt: 2_000 },
    ]
    expect(new WorkDock(() => EMPTY, theme, () => [], () => runs).render(80)).toEqual([])
  })

  it('takes no rows when no job is running', () => {
    expect(new WorkDock(() => EMPTY, theme, () => []).render(80)).toEqual([])
  })

  it('never overflows its row', () => {
    const state: WorkState = { ...EMPTY, todos: [{ content: 'y'.repeat(200), status: 'pending' }] }
    for (const line of dockOf(state).render(30)) expect(visibleWidth(line)).toBeLessThanOrEqual(30)
  })
})

describe('WorkDock theming', () => {
  const job = (status: 'running' | 'completed' | 'failed') => [
    { id: 'bash-1', kind: 'bash', label: 'build', status, startedAt: 1_000, finishedAt: status === 'running' ? undefined : 2_000 },
  ]

  it('draws nothing for a hidden section', () => {
    // The jobs heading is the example the README uses, and it used to render
    // anyway because the dock never asked whether the element was visible.
    const hidden = createTheme('truecolor', { palette: DEFAULT_PALETTE, tokens: new Map([['dock.jobs.heading', { hidden: true }]]) })
    const lines = new WorkDock(() => EMPTY, hidden, () => job('running')).render(80)
    expect(lines.some(line => line.includes('jobs ·'))).toBe(false)
  })

  it('keeps a settled job off screen however its element is styled', () => {
    // The row is gone once the job settles, so no styling of its element can
    // bring it back.
    const finished = createTheme('truecolor', { palette: DEFAULT_PALETTE, tokens: new Map([['dock.jobs.completed', { fg: '#ff0000' }]]) })
    expect(new WorkDock(() => EMPTY, finished, () => job('completed')).render(80)).toEqual([])
  })
})
