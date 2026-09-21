import { describe, expect, it } from 'vitest'
import { HERDR_STATES, MAX_BLOCKED_MESSAGE_CHARS, SEQ_TIME_SCALE, SESSION_START_REASONS } from '@/herdr/constants.ts'
import {
  boundedMessage,
  createReportSequence,
  isReportChange,
  lifecycleReport,
  sessionStartReason,
  type LifecycleFacts,
} from '@/herdr/state.ts'

const NOTHING_PENDING: LifecycleFacts = { blockedCount: 0, blockedMessage: undefined, turnOpen: false }

describe('lifecycleReport', () => {
  it('is idle when nothing is running and nothing is waiting', () => {
    expect(lifecycleReport(NOTHING_PENDING)).toEqual({ state: HERDR_STATES.idle, message: undefined })
  })

  it('is working while a turn is open', () => {
    expect(lifecycleReport({ ...NOTHING_PENDING, turnOpen: true })).toEqual({ state: HERDR_STATES.working, message: undefined })
  })

  it('outranks a running turn with a wait, and names it', () => {
    const report = lifecycleReport({ blockedCount: 1, blockedMessage: 'approval needed · Bash', turnOpen: true })
    expect(report).toEqual({ state: HERDR_STATES.blocked, message: 'approval needed · Bash' })
  })

  it('keeps the newest wait while waits stack', () => {
    const report = lifecycleReport({ blockedCount: 2, blockedMessage: 'question · continue?', turnOpen: false })
    expect(report.state).toBe(HERDR_STATES.blocked)
    expect(report.message).toBe('question · continue?')
  })
})

describe('boundedMessage', () => {
  it('collapses the whitespace a card title carries', () => {
    expect(boundedMessage('  approval\n  needed · Bash  ')).toBe('approval needed · Bash')
  })

  it('cuts a title too long to read, keeping its start', () => {
    const bounded = boundedMessage('x'.repeat(MAX_BLOCKED_MESSAGE_CHARS * 2))
    expect(bounded.length).toBe(MAX_BLOCKED_MESSAGE_CHARS)
    expect(bounded.endsWith('…')).toBe(true)
  })

  it('leaves a title that fits alone', () => {
    expect(boundedMessage('approval needed · Bash')).toBe('approval needed · Bash')
  })
})

describe('isReportChange', () => {
  const idle = { state: HERDR_STATES.idle, message: undefined }

  it('reports the first state it sees', () => {
    expect(isReportChange(undefined, idle)).toBe(true)
  })

  it('skips a state Herdr is already showing', () => {
    expect(isReportChange(idle, idle)).toBe(false)
  })

  it('reports a message that changed under the same state', () => {
    expect(isReportChange({ state: HERDR_STATES.blocked, message: 'a' }, { state: HERDR_STATES.blocked, message: 'b' })).toBe(true)
  })
})

describe('sessionStartReason', () => {
  it('names a branch as a fork', () => {
    expect(sessionStartReason({ forked: true, resumed: true })).toBe(SESSION_START_REASONS.fork)
  })

  it('names a returned-to session as a resume', () => {
    expect(sessionStartReason({ forked: false, resumed: true })).toBe(SESSION_START_REASONS.resume)
  })

  it('names a fresh run as a startup', () => {
    expect(sessionStartReason({ forked: false, resumed: false })).toBe(SESSION_START_REASONS.startup)
  })
})

describe('createReportSequence', () => {
  it('starts from the clock so a restart cannot replay numbers', () => {
    const next = createReportSequence(() => 1000)
    expect(next()).toBe(1000 * SEQ_TIME_SCALE + 1)
  })

  it('only moves forward', () => {
    let now = 5
    const next = createReportSequence(() => now)
    const first = next()
    now = 1
    expect(next()).toBeGreaterThan(first)
  })
})
