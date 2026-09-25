import { describe, expect, it } from 'vitest'
import { HERDR_STATES, MAX_BLOCKED_MESSAGE_CHARS, MAX_STATE_LABEL_CHARS, SEQ_TIME_SCALE, SESSION_START_REASONS } from '@/herdr/constants.ts'
import {
  asDriverStatus,
  boundedMessage,
  createReportSequence,
  driverReportFor,
  isReportChange,
  lifecycleReport,
  sessionStartReason,
  stateLabelFor,
  type LifecycleFacts,
} from '@/herdr/state.ts'

const NOTHING_PENDING: LifecycleFacts = { blockedCount: 0, blockedMessage: undefined, driverRunning: false }

describe('lifecycleReport', () => {
  it('is idle when nothing is running and nothing is waiting', () => {
    expect(lifecycleReport(NOTHING_PENDING)).toEqual({ state: HERDR_STATES.idle, message: undefined })
  })

  it('is working while the driver runs', () => {
    expect(lifecycleReport({ ...NOTHING_PENDING, driverRunning: true })).toEqual({ state: HERDR_STATES.working, message: undefined })
  })

  it('has no turn-shaped input that could read as idle between chained turns', () => {
    // One driver run spans every turn it chains through the inbox; a fact with
    // no turn boundary in it cannot flap to idle between two of them.
    expect(lifecycleReport({ ...NOTHING_PENDING, driverRunning: true }).state).toBe(HERDR_STATES.working)
  })

  it('outranks a running driver with a wait, and names it', () => {
    const report = lifecycleReport({ blockedCount: 1, blockedMessage: 'approval needed · Bash', driverRunning: true })
    expect(report).toEqual({ state: HERDR_STATES.blocked, message: 'approval needed · Bash' })
  })

  it('keeps the newest wait while waits stack', () => {
    const report = lifecycleReport({ blockedCount: 2, blockedMessage: 'question · continue?', driverRunning: false })
    expect(report.state).toBe(HERDR_STATES.blocked)
    expect(report.message).toBe('question · continue?')
  })
})

describe('driverReportFor', () => {
  const DRIVEN = 'session-a'
  /** The shape the harness dispatches: the payload is fused with its own agent. */
  const payload = (agentId: string, status: unknown): unknown => ({ agent: { id: agentId }, status })

  it('reports the transition of the agent this pane drives', () => {
    expect(driverReportFor(payload(DRIVEN, 'running'), DRIVEN)).toBe('running')
    expect(driverReportFor(payload(DRIVEN, 'idle'), DRIVEN)).toBe('idle')
  })

  it('drops a subagent that shares this process', () => {
    // A subagent's run is not this pane's work, so its status must not move
    // the row the pane claimed.
    expect(driverReportFor(payload('subagent-b', 'running'), DRIVEN)).toBeUndefined()
  })

  it('drops an unknown status rather than guessing at it', () => {
    expect(driverReportFor(payload(DRIVEN, 'paused'), DRIVEN)).toBeUndefined()
  })

  it('reads a turn boundary as nothing to report', () => {
    // The regression this guards: a chained turn inside one driver run emits
    // no agent/status at all, so a payload with no status must never be read
    // as the run having stopped.
    expect(driverReportFor({ agent: { id: DRIVEN }, type: 'turn/end' }, DRIVEN)).toBeUndefined()
  })

  it('survives a payload that is not an object', () => {
    expect(driverReportFor(undefined, DRIVEN)).toBeUndefined()
    expect(driverReportFor('running', DRIVEN)).toBeUndefined()
  })
})

describe('asDriverStatus', () => {
  it('keeps the two phases the harness defines', () => {
    expect(asDriverStatus('idle')).toBe('idle')
    expect(asDriverStatus('running')).toBe('running')
  })

  it('drops anything outside that vocabulary', () => {
    expect(asDriverStatus('blocked')).toBeUndefined()
    expect(asDriverStatus(undefined)).toBeUndefined()
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

describe('stateLabelFor', () => {
  it('names a wait in the words Herdr draws', () => {
    expect(stateLabelFor({ state: HERDR_STATES.blocked, message: 'approval needed · Bash' })).toBe('approval needed · Bash')
  })

  it('has nothing to say about a row that owes no decision', () => {
    expect(stateLabelFor({ state: HERDR_STATES.idle, message: undefined })).toBeUndefined()
    expect(stateLabelFor({ state: HERDR_STATES.working, message: undefined })).toBeUndefined()
  })

  it('keeps the label inside the shorter limit Herdr holds it to', () => {
    // A title that fits the message does not necessarily fit the label, and a
    // label Herdr shortened itself would be a cut this surface never decided on.
    const label = stateLabelFor({
      state: HERDR_STATES.blocked,
      message: boundedMessage('x'.repeat(MAX_BLOCKED_MESSAGE_CHARS)),
    })
    expect(label?.length).toBe(MAX_STATE_LABEL_CHARS)
    expect(label?.endsWith('…')).toBe(true)
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
