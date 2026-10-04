/** Publish valid scratch-session events so live subscription and durable resume—not imported handlers—prove pruning behavior. */
import { randomUUID } from 'node:crypto'

const TITLE_EVENT = 'session/title'
const SESSION_EVENT = 'session/event'
const SEED_TITLE = 'dogfood-pruning-seed'
const PRUNE_TITLE = 'dogfood-pruning-apply'
const FINISH_TITLE = 'dogfood-pruning-finish'
/** End-only metadata exposes an inactive persisted session without creating a child agent. */
const VIEW_TITLE_PREFIX = 'dogfood-pruning-view:'
const STORED_SESSION_PATTERN = /^tui-session-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
const SUBAGENT_END_EVENT = 'subagent/end'
const COMPLETED_STOP = 'completed'
const TURN = 1
const FIRST_STEP = 1
const NEXT_STEP = 2
const REPLACEMENTS = 13
const PRUNING_TOKEN_COUNT = 1
const ROOT_TOOL = 'run_code'
const PROGRAM_CODE = 'return undefined'
const CHILD_TOOL = 'read'
const OLD_CALL = 'pruning-old'
const LIVE_CALL = 'pruning-live'
const CHILD_CALL = 'pruning-old:ptc:1'
const OLD_TITLE = 'retained PTC result'
const LIVE_TITLE = 'active PTC result'
const OLD_OUTPUT = 'retained-program-output'
const LIVE_OUTPUT = 'active-program-output'
const CHILD_OUTPUT = 'retained-child-output'
const PRUNED_OUTPUT = '[pruned-context-only]'
const FILE_PATH = 'marker.txt'
const PROVIDER = 'dogfood'
const MODEL = 'event-fixture'
const TEXT_BLOCK = 'text'
const TOOL_BLOCK = 'tool-call'
const REPLACE_OPERATION = 'replace'
const APPEND_OPERATION = 'append'
const MODEL_ROLE = 'assistant'
const TOOL_ROLE = 'tool'
const MODEL_SOURCE = 'model'
const TOOL_SOURCE = 'tool'
const EVENTS = {
  turnStart: 'turn/start', turnEnd: 'turn/end', stepStart: 'step/start', stepEnd: 'step/end',
  assistant: 'assistant/message', call: 'tool/call', result: 'tool/result',
  childStart: 'tool/ptc-dispatch-start', childEnd: 'tool/ptc-dispatch', prune: 'compaction/prune',
}
const COMPLETED = { kind: 'completed' }
const ASSISTANT_STREAM = []
const FIXTURE_ERRORS = {
  seeded: 'dogfood-pruning: session already seeded',
  unseeded: 'dogfood-pruning: session was not seeded',
  pruned: 'dogfood-pruning: session already pruned',
  unfinished: 'dogfood-pruning: finish preceded pruning',
  invalidStoredSession: 'dogfood-pruning: invalid stored session identity',
  activeStoredSession: 'dogfood-pruning: stored session is already active',
}

/** Ordinary completions need stable identities so later rewrites can change content without impersonating another result. */
function resultMessage(callId, text) {
  return { id: randomUUID(), role: TOOL_ROLE, source: { kind: TOOL_SOURCE, callId }, toolCallId: callId, content: [{ type: TEXT_BLOCK, text }], isError: false }
}

/** Advertise each call before its execution event so native storage accepts the same lifecycle the real loop writes. */
function startCall(session, callId, description, step) {
  const argumentsJson = JSON.stringify({ description, code: PROGRAM_CODE })
  session.append(EVENTS.assistant, {
    turn: TURN, step, stream: ASSISTANT_STREAM, message: {
      id: randomUUID(), role: MODEL_ROLE, source: { kind: MODEL_SOURCE, provider: PROVIDER, model: MODEL },
      content: [{ type: TOOL_BLOCK, id: callId, name: ROOT_TOOL, arguments: argumentsJson }],
    },
  }, { surfaceOp: APPEND_OPERATION })
  return session.append(EVENTS.call, { turn: TURN, step, callId, name: ROOT_TOOL, arguments: argumentsJson }).seq
}

/** Only the runner's fresh credential-free profile mounts this plugin; local rename commands provide deterministic live boundaries. */
export function apply(ctx) {
  const states = new Map()
  ctx.on(SESSION_EVENT, (session, event) => {
    if (event.type !== TITLE_EVENT) return
    const title = event.data.title
    const storedId = typeof title === 'string' && title.startsWith(VIEW_TITLE_PREFIX) ? title.slice(VIEW_TITLE_PREFIX.length) : undefined
    if (storedId === undefined && ![SEED_TITLE, PRUNE_TITLE, FINISH_TITLE].includes(title)) return
    // Session append refuses reentrant publication, so the fixture waits until the rename event finishes notifying subscribers.
    queueMicrotask(() => {
      if (storedId !== undefined) {
        if (!STORED_SESSION_PATTERN.test(storedId)) throw new Error(FIXTURE_ERRORS.invalidStoredSession)
        if (storedId === session.id || ctx.get('sessions')?.get(storedId) !== undefined) throw new Error(FIXTURE_ERRORS.activeStoredSession)
        // The public child-navigation command needs roster metadata, not a live child or model dispatch.
        void ctx.emit(SUBAGENT_END_EVENT, { runId: randomUUID(), id: storedId, provider: PROVIDER, local: false, stopReason: COMPLETED_STOP })
        return
      }
      if (event.data.title === SEED_TITLE) {
        if (states.has(session.id)) throw new Error(FIXTURE_ERRORS.seeded)
        session.append(EVENTS.turnStart, { turn: TURN })
        session.append(EVENTS.stepStart, { turn: TURN, step: FIRST_STEP })
        const oldSeq = startCall(session, OLD_CALL, OLD_TITLE, FIRST_STEP)
        const child = { rootCallId: OLD_CALL, parentCallId: OLD_CALL, subCallId: CHILD_CALL, name: CHILD_TOOL, arguments: { file_path: FILE_PATH } }
        session.append(EVENTS.childStart, child)
        session.append(EVENTS.childEnd, { ...child, isError: false, content: [{ type: TEXT_BLOCK, text: CHILD_OUTPUT }] })
        const result = session.append(EVENTS.result, { turn: TURN, step: FIRST_STEP, message: resultMessage(OLD_CALL, OLD_OUTPUT) }, { surfaceOp: APPEND_OPERATION, sourceEventSeqs: [oldSeq] })
        session.append(EVENTS.stepEnd, { turn: TURN, step: FIRST_STEP })
        session.append(EVENTS.stepStart, { turn: TURN, step: NEXT_STEP })
        const liveSeq = startCall(session, LIVE_CALL, LIVE_TITLE, NEXT_STEP)
        states.set(session.id, { resultSeq: result.seq, resultData: result.data, liveSeq, pruned: false })
      } else {
        const state = states.get(session.id)
        if (state === undefined) throw new Error(FIXTURE_ERRORS.unseeded)
        if (event.data.title === PRUNE_TITLE) {
          if (state.pruned) throw new Error(FIXTURE_ERRORS.pruned)
          for (let index = 0; index < REPLACEMENTS; index++) {
            const seq = state.resultSeq
            session.append(EVENTS.prune, { shadowedRange: { start: seq, end: seq }, shadowedSeqs: [seq], shadowedTokenCount: PRUNING_TOKEN_COUNT })
            // Native replacement preserves every result field except content, including the original message identity.
            const data = { ...state.resultData, message: { ...state.resultData.message, content: [{ type: TEXT_BLOCK, text: PRUNED_OUTPUT }] } }
            state.resultSeq = session.append(EVENTS.result, data, { surfaceOp: { op: REPLACE_OPERATION, startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] }).seq
          }
          state.pruned = true
        } else {
          if (!state.pruned) throw new Error(FIXTURE_ERRORS.unfinished)
          session.append(EVENTS.result, { turn: TURN, step: NEXT_STEP, message: resultMessage(LIVE_CALL, LIVE_OUTPUT) }, { surfaceOp: APPEND_OPERATION, sourceEventSeqs: [state.liveSeq] })
          session.append(EVENTS.stepEnd, { turn: TURN, step: NEXT_STEP })
          session.append(EVENTS.turnEnd, { turn: TURN, reason: COMPLETED })
          states.delete(session.id)
        }
      }
    })
  })
}
