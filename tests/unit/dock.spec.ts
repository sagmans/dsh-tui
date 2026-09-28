import { stripTerminalSequences, visibleWidth, type TuiMouseEvent } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { createTheme } from '@/theme.ts'
import { DEFAULT_PALETTE } from '@/theme-defaults.ts'
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

/**
 * The blank row the panel itself opens on, which every section is drawn below.
 *
 * It is the panel's break rather than a section's: it carries no name and no
 * glyph, and it is the reason a section row sits one row lower than it would on a
 * dock drawn without one.
 */
const LEAD = ''

describe('WorkDock', () => {
  it('takes no rows when there is nothing to say', () => {
    expect(dockOf(EMPTY).render(60)).toEqual([])
  })

  it('opens the work panel on a blank row under the conversation', () => {
    const lines = dockOf({ ...EMPTY, planMode: true }).render(40)
    expect(lines[0]).toBe(LEAD)
    expect(lines.slice(1).join('\n')).toContain('plan mode')
  })

  it('states the goal with its round budget', () => {
    const lines = dockOf({ ...EMPTY, goal: { objective: 'complete the plan', roundsStarted: 3, maxRounds: 256, phase: 'active' } }).render(80)
    expect(lines).toEqual([LEAD, '◎ goal round 3/256 · complete the plan'])
  })

  it('names a stalled goal so it never reads as running', () => {
    const paused = dockOf({ ...EMPTY, goal: { objective: 'complete the plan', roundsStarted: 3, maxRounds: 256, phase: 'paused' } }).render(80)
    expect(paused).toEqual([LEAD, '◎ goal paused · round 3/256 · complete the plan'])
    const blocked = dockOf({ ...EMPTY, goal: { objective: 'complete the plan', roundsStarted: 3, maxRounds: 256, phase: 'blocked' } }).render(80)
    expect(blocked).toEqual([LEAD, '◎ goal blocked · round 3/256 · complete the plan'])
  })

  it('marks where a goal was cut off', () => {
    const lines = dockOf({ ...EMPTY, goal: { objective: 'x'.repeat(400), roundsStarted: 1, maxRounds: undefined, phase: 'active' } }).render(80)
    expect(visibleWidth(lines[1] ?? '')).toBeLessThanOrEqual(80)
    expect(lines[1]).toContain('…')
  })

  it('announces plan mode', () => {
    expect(dockOf({ ...EMPTY, planMode: true }).render(80)).toEqual([LEAD, '⏸ plan mode · answer the plan before edits happen'])
  })

  it('shows only the todos still to do, most urgent first', () => {
    const todos = [
      { content: 'done thing', status: 'completed' as const },
      { content: 'next thing', status: 'pending' as const },
      { content: 'now thing', status: 'in_progress' as const },
    ]
    const lines = dockOf({ ...EMPTY, todos }).render(80)
    expect(lines).toEqual([
      LEAD,
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
    expect(lines).toHaveLength(DOCK_TODO_LIMIT + 3)
    expect(lines.at(-1)).toBe('  … 3 more')
  })

  it('shows only the jobs still running', () => {
    const jobs = [
      { id: 'bash-1', kind: 'bash', label: 'build', status: 'completed' as const, startedAt: 1_000, finishedAt: 2_000 },
      { id: 'bash-2', kind: 'bash', label: 'test', status: 'running' as const, startedAt: Date.now(), finishedAt: undefined },
    ]
    const lines = new WorkDock(() => EMPTY, theme, () => jobs).render(80)
    expect(lines).toHaveLength(3)
    expect(lines[1]).toBe(rule('⛭ jobs · 1 running', 80))
    expect(lines[2]).toContain('▸ bash-2 · running')
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
    expect(lines).toHaveLength(3)
    expect(lines[1]).toBe(rule('⚇ subagents · 1 running', 80))
    expect(lines[2]).toContain('▸ child-ab · spawn · running')
  })

  it('previews three running children and reveals the rest on a heading click', () => {
    const runs = Array.from({ length: 5 }, (_, index) => ({
      runId: `r${index}`, provider: 'spawn', id: `child-${index}`, startedAt: 1_000, status: 'running' as const,
    }))
    const dock = new WorkDock(() => EMPTY, theme, () => [], () => runs, () => 2_000)
    // The heading sits under the panel's own blank row, so a click on the section
    // comes one row below the window's first.
    const click: TuiMouseEvent = {
      type: 'click', button: 'left', x: 5, y: 1, screenX: 5, screenY: 1, width: 80, height: 6,
      shift: false, alt: false, ctrl: false,
    }
    expect(dock.render(80)).toEqual([
      LEAD,
      rule('⚇ subagents ▸ · 5 running', 80),
      '  ▸ child-0 · spawn · running 1s',
      '  ▸ child-1 · spawn · running 1s',
      '  ▸ child-2 · spawn · running 1s',
      '  … 2 more',
    ])
    expect(dock.handleMouse(click)).toEqual({ handled: true, render: true })
    expect(dock.render(80)).toEqual([
      LEAD,
      rule('⚇ subagents ▾ · 5 running', 80),
      ...runs.map(run => `  ▸ ${run.id} · spawn · running 1s`),
    ])
    expect(dock.handleMouse(click)).toEqual({ handled: true, render: true })
    expect(dock.render(80)).toHaveLength(6)
    // The blank columns before a child's own row are inside the section too, so a
    // click there has to do what the same click on the heading did.
    expect(dock.handleMouse({ ...click, x: 0, y: 2 })).toEqual({ handled: true, render: true })
    expect(dock.render(80)[1]).toBe(rule('⚇ subagents ▾ · 5 running', 80))
  })

  it('toggles from a child row’s empty cells, but not from goal or job rows', () => {
    const runs = Array.from({ length: 4 }, (_, index) => ({
      runId: `r${index}`, provider: 'spawn', id: `child-${index}`, startedAt: 1_000, status: 'running' as const,
    }))
    const jobs = [{ id: 'bash-1', kind: 'bash', label: 'build', status: 'running' as const, startedAt: 1_000, finishedAt: undefined }]
    const dock = new WorkDock(() => ({ ...EMPTY, goal: { objective: 'Inspect dock', roundsStarted: 1, maxRounds: 2, phase: 'active' } }), theme, () => jobs, () => runs)
    const click: TuiMouseEvent = {
      type: 'click', button: 'left', x: 5, y: 2, screenX: 5, screenY: 2, width: 80, height: 9,
      shift: false, alt: false, ctrl: false,
    }
    expect(dock.render(80)[2]).toBe(rule('⚇ subagents ▸ · 4 running', 80))
    expect(dock.handleMouse({ ...click, y: 1 })).toBeUndefined()
    expect(dock.handleMouse({ ...click, y: 3, x: 70 })).toEqual({ handled: true, render: true })
    expect(dock.render(80)[2]).toBe(rule('⚇ subagents ▾ · 4 running', 80))
    expect(dock.handleMouse({ ...click, y: 7 })).toBeUndefined()
    expect(dock.handleMouse({ ...click, button: 'right' })).toBeUndefined()
    expect(dock.handleMouse({ ...click, type: 'press' })).toBeUndefined()
    expect(dock.render(80)[2]).toBe(rule('⚇ subagents ▾ · 4 running', 80))
    expect(dock.handleMouse(click)).toEqual({ handled: true, render: true })
    expect(dock.render(80)[2]).toBe(rule('⚇ subagents ▸ · 4 running', 80))
  })

  it('opens a child by its full id only from its visible text', () => {
    const id = 'child-abcdef123456'
    const runs = Array.from({ length: 4 }, (_, index) => ({
      runId: `r${index}`, provider: 'spawn', id: index === 0 ? id : `child-${index}`, startedAt: 1_000, status: 'running' as const,
    }))
    let opened: string | undefined
    const dock = new WorkDock(() => EMPTY, theme, () => [], () => runs, () => 2_000, childId => { opened = childId })
    const lines = dock.render(80)
    const click: TuiMouseEvent = {
      type: 'click', button: 'left', x: visibleWidth(lines[2]!) - 1, y: 2, screenX: 5, screenY: 2, width: 80, height: 6,
      shift: false, alt: false, ctrl: false,
    }
    expect(dock.handleMouse(click)).toEqual({ handled: true, render: true })
    expect(opened).toBe(id)
    expect(dock.render(80)[1]).toBe(rule('⚇ subagents ▸ · 4 running', 80))
    expect(dock.handleMouse({ ...click, x: visibleWidth(lines[2]!) })).toEqual({ handled: true, render: true })
    expect(dock.render(80)[1]).toBe(rule('⚇ subagents ▾ · 4 running', 80))
    expect(opened).toBe(id)
  })

  it('drops the subagent board once every delegation has settled', () => {
    const runs = [
      { runId: 'r2', provider: 'fork', id: 'child-2', startedAt: 1_000, status: 'failed' as const, finishedAt: 2_000 },
    ]
    expect(new WorkDock(() => EMPTY, theme, () => [], () => runs).render(80)).toEqual([])
  })

  it('names a section on the edge of its list instead of on a row above it', () => {
    // The rule replaces the heading rather than joining it, which is what keeps
    // the dock as tall and as wide as it was before the sections were edged.
    const todos = [{ content: 'write the dock', status: 'pending' as const }]
    const lines = dockOf({ ...EMPTY, todos }).render(40)
    expect(lines).toHaveLength(3)
    expect(lines[1]).toBe(rule('☰ todos · 1 left', 40))
    expect(lines.every(line => visibleWidth(line) <= 40)).toBe(true)
  })

  it('draws the heading where a name and a dash no longer both fit', () => {
    // An edge a reader cannot tell from a name is not an edge, so a row with no
    // room left for a dash after the name is the heading it would have been.
    const todos = [{ content: 'write the dock', status: 'pending' as const }]
    expect(dockOf({ ...EMPTY, todos }).render(8)[1]).toBe('☰ todo…')
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
    expect(lines).toHaveLength(3)
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
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('▸ bash-1')
  })

  it("draws each section's rule in that section's own hue", () => {
    const styled = createTheme('truecolor')
    const runs = [{ runId: 'r1', provider: 'spawn', id: 'child-abcdef', startedAt: Date.now() - 4_000, status: 'running' as const }]
    const lines = new WorkDock(() => ({ ...EMPTY, todos: [{ content: 'x', status: 'pending' }] }), styled, () => job('running'), () => runs).render(80)
    // accent, user and warn: the three shades the shipped table gives the rules,
    // so a reader tells the boards apart without reading a row of either.
    expect(lines[1]).toContain('38;2;39;245;200m')
    expect(lines[3]).toContain('38;2;215;175;95m')
    expect(lines[5]).toContain('38;2;95;175;215m')
    // A section rule is not the only element a row answers to: the job row carries
    // the running element's own colour wherever the row is drawn.
    const red = createTheme('truecolor', { palette: DEFAULT_PALETTE, tokens: new Map([['dock.jobs.running', { fg: '#ff0000' }]]) })
    expect(new WorkDock(() => EMPTY, red, () => job('running')).render(80)[2]).toContain('38;2;255;0;0')
  })

  it('falls back to the heading row when the rule is hidden', () => {
    // The dock a reader had before the sections were edged is still reachable,
    // by hiding the one element that draws the edge.
    const bare = createTheme('truecolor', { palette: DEFAULT_PALETTE, tokens: new Map([['dock.jobs.border', { hidden: true }]]) })
    const lines = new WorkDock(() => EMPTY, bare, () => job('running')).render(80)
    expect(stripTerminalSequences(lines[1] ?? '')).toBe('⛭ jobs · 1 running')
    expect(lines[2]).toContain('▸ bash-1 · running')
  })
})
