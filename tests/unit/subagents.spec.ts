import { describe, expect, it } from 'vitest'
import {
  SubagentRoster,
  describeSubagent,
  describeSubagents,
  parseSubagentsArgument,
  resolveRun,
  shortId,
} from '@/subagents.ts'

const START = { runId: 'run-1', provider: 'spawn', id: 'child-abcdef123456', local: true }

describe('shortId', () => {
  it('keeps enough of an id to tell two children apart', () => {
    expect(shortId('child-abcdef123456')).toBe('child-ab')
    expect(shortId('short')).toBe('short')
  })
})

describe('SubagentRoster', () => {
  it('tracks a run from start to end', () => {
    let now = 1_000
    const roster = new SubagentRoster(() => now)
    roster.start(START)
    expect(roster.list()).toEqual([
      { runId: 'run-1', provider: 'spawn', id: 'child-abcdef123456', startedAt: 1_000, status: 'running' },
    ])
    now = 5_000
    roster.end({ ...START, stopReason: 'completed' })
    expect(roster.list()[0]).toMatchObject({ status: 'completed', stopReason: 'completed', finishedAt: 5_000 })
    expect(roster.running()).toEqual([])
  })

  it('marks a run that ended badly', () => {
    const roster = new SubagentRoster(() => 1_000)
    roster.start(START)
    roster.end({ ...START, stopReason: 'error' })
    expect(roster.list()[0]?.status).toBe('failed')
    expect(describeSubagent(roster.list()[0]!, 2_000)).toContain('(error)')
  })

  it('still reports an end whose start was never seen', () => {
    const roster = new SubagentRoster(() => 7_000)
    roster.end({ runId: 'run-9', provider: 'fork', id: 'child-9' })
    expect(roster.list()[0]).toMatchObject({ runId: 'run-9', id: 'child-9', provider: 'fork', status: 'completed' })
  })

  it('shows a cataloged task on a child that starts later', () => {
    const roster = new SubagentRoster(() => 1_000)
    roster.catalog({ childId: START.id, label: 'Inspect the dock renderer' })
    roster.start(START)
    expect(describeSubagent(roster.list()[0]!, 2_000)).toContain('Inspect the dock renderer')
  })

  it('updates a running child when its task arrives later', () => {
    const roster = new SubagentRoster(() => 1_000)
    roster.start(START)
    roster.catalog({ childId: START.id, label: 'Write regression tests' })
    expect(describeSubagent(roster.list()[0]!, 2_000)).toContain('Write regression tests')
  })

  it('keeps labels on settled children and clears them for a new session', () => {
    const roster = new SubagentRoster(() => 1_000)
    roster.catalog({ childId: START.id, label: 'Review session events' })
    roster.start(START)
    roster.end({ ...START, stopReason: 'completed' })
    expect(describeSubagent(roster.list()[0]!, 2_000)).toContain('Review session events')
    roster.reset()
    roster.start(START)
    expect(describeSubagent(roster.list()[0]!, 2_000)).not.toContain('Review session events')
  })

  it('limits tasks to ten words and removes terminal controls', () => {
    const roster = new SubagentRoster(() => 1_000)
    roster.catalog({ childId: START.id, label: 'one two three four five six seven eight nine ten eleven\n\x1b[31m' })
    roster.start(START)
    expect(describeSubagent(roster.list()[0]!, 2_000)).toContain('one two three four five six seven eight nine ten · spawn · running')
    expect(describeSubagent(roster.list()[0]!, 2_000)).not.toContain('eleven')
    expect(describeSubagent(roster.list()[0]!, 2_000)).not.toContain('\x1b')
  })

  it('ignores a payload it cannot identify', () => {
    const roster = new SubagentRoster()
    roster.start({ provider: 'spawn' })
    roster.start(undefined)
    expect(roster.list()).toEqual([])
  })

  it('forgets everything on reset, because a resumed run starts empty', () => {
    const roster = new SubagentRoster()
    roster.start(START)
    roster.reset()
    expect(roster.list()).toEqual([])
  })
})

describe('describeSubagents', () => {
  const run = (overrides: Record<string, unknown> = {}) => ({
    runId: 'run-1', provider: 'spawn', id: 'child-abcdef', startedAt: 1_000, status: 'running' as const, ...overrides,
  })

  it('says so when nothing has been delegated', () => {
    expect(describeSubagents([], 1_000)).toBe('no subagents have run in this session')
  })

  it('counts the live ones', () => {
    const board = describeSubagents([run(), run({ runId: 'run-2', status: 'completed', finishedAt: 3_000 })], 5_000)
    expect(board.split('\n')[0]).toBe('subagents · 2 (1 running)')
    expect(board.split('\n')[1]).toContain('child-ab · spawn · running 4s')
  })

  it('reports how long a settled child took', () => {
    expect(describeSubagent(run({ status: 'completed', finishedAt: 4_000 }) as never, 9_000)).toContain('completed 3s')
  })
})

describe('parseSubagentsArgument', () => {
  it('lists when nothing is asked', () => {
    expect(parseSubagentsArgument('  ')).toEqual({ kind: 'list' })
  })

  it('opens and stops a named child', () => {
    expect(parseSubagentsArgument('open child-1')).toEqual({ kind: 'open', id: 'child-1' })
    expect(parseSubagentsArgument('kill child-1')).toEqual({ kind: 'kill', id: 'child-1' })
  })

  it('refuses an unknown action and a missing id', () => {
    expect(parseSubagentsArgument('stop child-1').kind).toBe('invalid')
    const missing = parseSubagentsArgument('kill')
    expect(missing.kind === 'invalid' && missing.reason).toContain('child id')
  })
})

describe('resolveRun', () => {
  const runs = [
    { runId: 'r1', provider: 'spawn', id: 'c000cfa3-1111', startedAt: 1, status: 'running' as const },
    { runId: 'r2', provider: 'fork', id: 'c000cfa3-2222', startedAt: 2, status: 'completed' as const },
    { runId: 'r3', provider: 'spawn', id: 'deadbeef-3333', startedAt: 3, status: 'completed' as const },
  ]

  it('finds a run by its whole id', () => {
    expect(resolveRun(runs, 'deadbeef-3333')?.runId).toBe('r3')
  })

  it('finds a run by the short id the roster shows', () => {
    expect(resolveRun(runs, 'deadbeef')?.runId).toBe('r3')
  })

  it('names the newest run as "last", whatever order it is handed', () => {
    expect(resolveRun(runs, 'last')?.runId).toBe('r3')
    expect(resolveRun([...runs].reverse(), 'last')?.runId).toBe('r3')
    expect(resolveRun([], 'last')).toBeUndefined()
  })

  it('refuses a prefix that matches more than one child', () => {
    expect(resolveRun(runs, 'c000cfa3')).toBeUndefined()
  })

  it('answers nothing for an id nobody started', () => {
    expect(resolveRun(runs, 'nope')).toBeUndefined()
  })
})
