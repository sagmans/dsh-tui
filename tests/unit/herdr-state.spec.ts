import { describe, expect, it } from 'vitest'
import { HERDR_STATES, MAX_BLOCKED_MESSAGE_CHARS, MAX_STATE_LABEL_CHARS, SESSION_START_REASONS } from '@/herdr/constants.ts'
import {
  boundedMessage,
  createReportSequence,
  driverReportFor,
  isReportChange,
  lifecycleReport,
  sessionStartReason,
  stateLabelFor,
  type LifecycleFacts,
} from '@/herdr/state.ts'

const NOTHING_PENDING: LifecycleFacts = { blockedCount: 0, blockedMessage: undefined, driverRunning: false, backgroundRunning: false }

describe('lifecycleReport', () => {
  it('is working while the driver runs', () => {
    expect(lifecycleReport({ ...NOTHING_PENDING, driverRunning: true })).toEqual({ state: HERDR_STATES.working, message: undefined })
  })

  it('is blocked while a decision waits, and the wait outranks the driver', () => {
    // A wait is the only thing a reader glancing at a wall of panes can act on,
    // so an agent that is both running and waiting is reported as blocked.
    expect(lifecycleReport({ blockedCount: 2, blockedMessage: 'approval needed', driverRunning: true }))
      .toEqual({ state: HERDR_STATES.blocked, message: 'approval needed' })
  })

  it('is idle with nothing pending and no driver running', () => {
    expect(lifecycleReport(NOTHING_PENDING)).toEqual({ state: HERDR_STATES.idle, message: undefined })
  })
})

describe('isReportChange', () => {
  const working = { state: HERDR_STATES.working, message: undefined } as const

  it('reports a first report and every later change', () => {
    expect(isReportChange(undefined, working)).toBe(true)
    expect(isReportChange(working, { state: HERDR_STATES.blocked, message: 'approval needed' })).toBe(true)
    expect(isReportChange({ state: HERDR_STATES.blocked, message: 'one' }, { state: HERDR_STATES.blocked, message: 'two' })).toBe(true)
  })

  it('stays quiet for a report that says what Herdr already shows', () => {
    expect(isReportChange(working, { state: HERDR_STATES.working, message: undefined })).toBe(false)
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

describe('boundedMessage', () => {
  it('collapses the whitespace a card title carries', () => {
    expect(boundedMessage('  approval\n  needed · Bash  ')).toBe('approval needed · Bash')
  })

  it('cuts a title too long to read, keeping its start', () => {
    const bounded = boundedMessage('x'.repeat(MAX_BLOCKED_MESSAGE_CHARS * 2))
    expect(bounded.length).toBe(MAX_BLOCKED_MESSAGE_CHARS)
    expect(bounded.endsWith('…')).toBe(true)
  })
})

describe('stateLabelFor', () => {
  it('names the wait a blocked row holds', () => {
    expect(stateLabelFor({ state: HERDR_STATES.blocked, message: 'approval\n  needed · bash' }))
      .toBe('approval needed · bash')
  })

  it('leaves a blocked row unlabelled when its report carried no message', () => {
    // Herdr draws this label in place of the state word, so a row with no
    // decision to name must fall back to the state rather than a blank label.
    expect(stateLabelFor({ state: HERDR_STATES.blocked, message: undefined })).toBeUndefined()
  })

  it('leaves a row that is not blocked unlabelled', () => {
    expect(stateLabelFor({ state: HERDR_STATES.working, message: 'approval needed · bash' })).toBeUndefined()
    expect(stateLabelFor({ state: HERDR_STATES.idle, message: undefined })).toBeUndefined()
  })

  it('cuts a label too long for the sidebar, keeping its start', () => {
    const label = stateLabelFor({
      state: HERDR_STATES.blocked,
      message: 'x'.repeat(MAX_STATE_LABEL_CHARS * 2),
    })
    expect(label?.length).toBe(MAX_STATE_LABEL_CHARS)
    expect(label?.endsWith('…')).toBe(true)
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
  it('only moves forward', () => {
    let now = 5
    const next = createReportSequence(() => now)
    const first = next()
    now = 1
    expect(next()).toBeGreaterThan(first)
  })
})
