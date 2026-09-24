import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { createTheme } from '@/theme.ts'
import { DEFAULT_PALETTE } from '@/theme-tokens.ts'
import { SubagentRoster } from '@/subagents.ts'
import { DOCK_TODO_LIMIT, WorkDock } from '@/ui/dock.ts'
import type { WorkState } from '@/work.ts'

const theme = createTheme('none')
const dockOf = (state: WorkState): WorkDock => new WorkDock(() => state, theme)

const EMPTY: WorkState = { planMode: false, todos: undefined, goal: undefined }

/**
 * The rule a section opens on, so a spec pins the shape rather than a dash count.
 *
 * The name rides the rule, two dashes lead it, and the dashes run to the edge:
 * that is the whole contract, and every section is held to it here.
 */
const rule = (heading: string, width: number): string => {
  const head = `┄┄ ${heading} `
  return `${head}${'┄'.repeat(width - visibleWidth(head))}`
}

describe('WorkDock', () => {
  it('takes no rows when there is nothing to say', () => {
    expect(dockOf(EMPTY).render(60)).toEqual([])
  })

  it('states the goal with its round budget', () => {
    const lines = dockOf({ ...EMPTY, goal: { objective: 'complete the plan', roundsStarted: 3, maxRounds: 256, phase: 'active' } }).render(80)
    expect(lines).toEqual(['◎ goal round 3/256 · complete the plan'])
  })

  it('names a stalled goal so it never reads as running', () => {
    const paused = dockOf({ ...EMPTY, goal: { objective: 'complete the plan', roundsStarted: 3, maxRounds: 256, phase: 'paused' } }).render(80)
    expect(paused).toEqual(['◎ goal paused · round 3/256 · complete the plan'])
    const blocked = dockOf({ ...EMPTY, goal: { objective: 'complete the plan', roundsStarted: 3, maxRounds: 256, phase: 'blocked' } }).render(80)
    expect(blocked).toEqual(['◎ goal blocked · round 3/256 · complete the plan'])
  })

  it('marks where a goal was cut off', () => {
    const lines = dockOf({ ...EMPTY, goal: { objective: 'x'.repeat(400), roundsStarted: 1, maxRounds: undefined, phase: 'active' } }).render(80)
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
      rule('☰ todos · 2 left', 80),
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
    expect(lines[0]).toBe(rule('⛭ jobs · 1 running', 80))
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
    expect(lines[0]).toBe(rule('⚇ subagents · 1 running', 80))
    expect(lines[1]).toContain('▸ child-ab · spawn · running')
  })

  it('shows the task from a parent catalog on the running child row', () => {
    const roster = new SubagentRoster(() => 1_000)
    roster.catalog({ childId: 'child-abcdef', label: 'Review terminal rendering' })
    roster.start({ runId: 'r1', provider: 'spawn', id: 'child-abcdef' })
    const lines = new WorkDock(() => EMPTY, theme, () => [], () => roster.list(), () => 2_000).render(80)
    expect(stripTerminalSequences(lines[1]!)).toContain('child-ab · Review terminal rendering · spawn · running 1s')
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

  it('names a section on the edge of its list instead of on a row above it', () => {
    // The rule replaces the heading rather than joining it, which is what keeps
    // the dock as tall and as wide as it was before the sections were edged.
    const todos = [{ content: 'write the dock', status: 'pending' as const }]
    const lines = dockOf({ ...EMPTY, todos }).render(40)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe(rule('☰ todos · 1 left', 40))
    expect(lines.every(line => visibleWidth(line) <= 40)).toBe(true)
  })

  it('draws the heading where a name and a dash no longer both fit', () => {
    // An edge a reader cannot tell from a name is not an edge, so a row with no
    // room left for a dash after the name is the heading it would have been.
    const todos = [{ content: 'write the dock', status: 'pending' as const }]
    expect(dockOf({ ...EMPTY, todos }).render(8)[0]).toBe('☰ todo…')
  })

  it('never overflows its row', () => {
    const state: WorkState = { ...EMPTY, todos: [{ content: 'y'.repeat(200), status: 'pending' }] }
    for (const line of dockOf(state).render(30)) expect(visibleWidth(line)).toBeLessThanOrEqual(30)
  })

  it('keeps a job label that carries a break on one row', () => {
    // A label is the registry's own text, and a command written across lines is
    // a break the row must not carry: a line feed would put the rest of the dock
    // over the row below it instead of wrapping.
    const jobs = [{ id: 'bash-1', kind: 'bash', label: 'line one\nline two', status: 'running' as const, startedAt: Date.now(), finishedAt: undefined }]
    const lines = new WorkDock(() => EMPTY, theme, () => jobs).render(80)
    expect(lines).toHaveLength(2)
    for (const line of lines) expect(line).not.toContain('\n')
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
    // The name is what spends the section's heading row: with the name hidden the
    // section keeps the rows it had before the sections were edged, and no rule
    // without a name stands where the heading was.
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('▸ bash-1')
  })

  it("draws each section's rule in that section's own hue", () => {
    const styled = createTheme('truecolor')
    const runs = [{ runId: 'r1', provider: 'spawn', id: 'child-abcdef', startedAt: Date.now() - 4_000, status: 'running' as const }]
    const lines = new WorkDock(() => ({ ...EMPTY, todos: [{ content: 'x', status: 'pending' }] }), styled, () => job('running'), () => runs).render(80)
    // accent, user and warn: the three shades the shipped table gives the rules,
    // so a reader tells the boards apart without reading a row of either.
    expect(lines[0]).toContain('38;2;39;245;200m')
    expect(lines[2]).toContain('38;2;215;175;95m')
    expect(lines[4]).toContain('38;2;95;175;215m')
  })

  it('falls back to the heading row when the rule is hidden', () => {
    // The dock a reader had before the sections were edged is still reachable,
    // by hiding the one element that draws the edge.
    const bare = createTheme('truecolor', { palette: DEFAULT_PALETTE, tokens: new Map([['dock.jobs.border', { hidden: true }]]) })
    const lines = new WorkDock(() => EMPTY, bare, () => job('running')).render(80)
    expect(stripTerminalSequences(lines[0] ?? '')).toBe('⛭ jobs · 1 running')
    expect(lines[1]).toContain('▸ bash-1 · running')
  })

  it('keeps a settled job off screen however the live job element is styled', () => {
    // A settled job has no element of its own any more, because no element can
    // reach a row the dock refuses to draw; styling the live one must not
    // resurrect it either.
    const styled = createTheme('truecolor', { palette: DEFAULT_PALETTE, tokens: new Map([['dock.jobs.running', { fg: '#ff0000' }]]) })
    expect(new WorkDock(() => EMPTY, styled, () => job('completed')).render(80)).toEqual([])
    expect(new WorkDock(() => EMPTY, styled, () => job('running')).render(80)[1]).toContain('38;2;255;0;0')
  })
})
