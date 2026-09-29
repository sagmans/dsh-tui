import { describe, expect, it } from 'vitest'
import { MAX_BLOCKED_MESSAGE_CHARS, SESSION_START_REASONS, SEQ_TIME_SCALE } from '@/herdr/constants.ts'
import { boundedMessage, createReportSequence, driverReportFor, sessionStartReason } from '@/herdr/state.ts'

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

  it('anchors each number at the moment its report goes out', () => {
    // A number tied to the moment the process started loses the row to every
    // report a later process made, which is how a pane that stayed up across a
    // multiplexer restart goes missing for good.
    let now = 5
    const next = createReportSequence(() => now)
    next()

    now = 9
    expect(next()).toBe(9 * SEQ_TIME_SCALE)
  })
})
