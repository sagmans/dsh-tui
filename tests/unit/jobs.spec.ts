import { describe, expect, it } from 'vitest'
import { describeDuration, describeJob, describeJobs, isLive, parseJobsArgument, type JobSummary } from '@/jobs.ts'

const job = (overrides: Partial<JobSummary> = {}): JobSummary => ({
  id: 'bash-1',
  kind: 'bash',
  label: 'sleep 60',
  status: 'running',
  startedAt: 1_000_000,
  finishedAt: undefined,
  ...overrides,
})

describe('describeDuration', () => {
  it('reads in the units a reader thinks in', () => {
    expect(describeDuration(4_000)).toBe('4s')
    expect(describeDuration(125_000)).toBe('2m05s')
    expect(describeDuration(3_700_000)).toBe('1h01m')
    expect(describeDuration(-5)).toBe('1s')
  })
})

describe('isLive', () => {
  it('counts only states that still hold resources', () => {
    expect(isLive('running')).toBe(true)
    expect(isLive('stopping')).toBe(true)
    expect(isLive('completed')).toBe(false)
    expect(isLive('killed')).toBe(false)
    expect(isLive('failed')).toBe(false)
  })
})

describe('describeJob', () => {
  it('counts up while a job runs and dates it once it settles', () => {
    expect(describeJob(job(), 1_012_000)).toBe('bash-1 · running 12s — sleep 60')
    expect(describeJob(job({ status: 'completed', finishedAt: 1_030_000 }), 1_040_000)).toBe('bash-1 · completed 10s ago — sleep 60')
  })

  it('falls back to the kind when the producer supplied no label', () => {
    expect(describeJob(job({ label: '  ' }), 1_001_000)).toBe('bash-1 · running 1s — bash')
  })
})

describe('describeJobs', () => {
  it('says so when there is nothing running', () => {
    expect(describeJobs([], 1_000_000)).toBe('no background jobs')
  })

  it('counts the live ones and lists the newest first', () => {
    const board = describeJobs([
      job({ id: 'bash-1', startedAt: 1_000 }),
      job({ id: 'bash-2', startedAt: 5_000, status: 'completed', finishedAt: 6_000 }),
    ], 1_010_000)
    expect(board.split('\n')[0]).toBe('jobs · 2 (1 running)')
    expect(board.split('\n')[1]).toContain('bash-2')
    expect(board.split('\n')[2]).toContain('bash-1')
  })
})

describe('parseJobsArgument', () => {
  it('lists when nothing is asked', () => {
    expect(parseJobsArgument('   ')).toEqual({ kind: 'list' })
  })

  it('reads and kills by explicit verb', () => {
    expect(parseJobsArgument('read bash-2')).toEqual({ kind: 'read', id: 'bash-2' })
    expect(parseJobsArgument('kill bash-2')).toEqual({ kind: 'kill', id: 'bash-2' })
  })

  it('refuses an unknown verb instead of guessing', () => {
    const command = parseJobsArgument('bash-2')
    expect(command.kind).toBe('invalid')
    expect('reason' in command && command.reason).toContain('bash-2')
  })

  it('refuses a verb with no id', () => {
    const command = parseJobsArgument('kill')
    expect(command.kind).toBe('invalid')
    expect('reason' in command && command.reason).toContain('job id')
  })
})
