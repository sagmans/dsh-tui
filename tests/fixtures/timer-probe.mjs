/** Credential-free mounted-session evidence protects clocks and job ownership without model billing. */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describeDuration } from '../../lib/jobs.js'

const START_DELAY_MS = 2000
const TURN = 1
const STEP = 1
const POLL_MS = 100
const READY_TIMEOUT_MS = 10000
const CANCEL_WAIT_TIMEOUT_MS = 1000
const TOOL_MS = 4000
const RECEIPT_MS = 7000
const PRIVATE_MODE = 0o600
const CALL_ID = 'timer-probe-call'
const RESULT_ID = 'timer-probe-result'
const SUB_CALL_ID = 'timer-probe-dispatch'
const CHILD_ID = 'timer-probe-child'
const CHILD_RUN = 'timer-probe-run'
const TOOL_LABEL = 'timer-probe-tool'
const CHILD_TOOL_LABEL = 'timer-probe-child-tool'
const CHILD_CALL = 'timer-probe-child-call'
const CHILD_RESULT = 'timer-probe-child-result'
// Native assistant rows require model attribution even for test-owned event production.
const SOURCE_KIND = 'model'
const SOURCE_PROVIDER = 'timer-probe'
const SOURCE_MODEL = 'timer-probe'
const SOURCE_STREAM = []
const JOB_LABEL = 'timer-probe-job'
const OUTPUT = 'timer-probe-output'
const RECEIPT = 'timer-probe-check-complete'
const RECEIPT_FILE = 'timer-probe.json'
const BOUNDARIES = [0, 119500, 3599500]

/** The installed registry and session publish real lifecycle effects; only their workload is deterministic. */
export function apply(ctx) {
  const timers = new Set()
  const deadline = Date.now() + READY_TIMEOUT_MS
  const later = (work, ms) => {
    const timer = setTimeout(() => { timers.delete(timer); work() }, ms)
    timers.add(timer)
  }
  ctx.on('dispose', () => { for (const timer of timers) clearTimeout(timer) })
  const begin = () => {
    const sessionId = ctx.get('tuiStartup')?.sessionId
    const session = ctx.get('sessions')?.get(sessionId)
    const agent = ctx.get('agents')?.get(sessionId)
    const registry = ctx.get('jobs')
    if (!session || !agent || !registry) {
      if (Date.now() >= deadline) throw new Error('timer-probe: session services did not become ready')
      later(begin, POLL_MS)
      return
    }
    const append = (type, data, surface) => session.append(type, data, surface ? { surfaceOp: 'append' } : undefined)
    append('turn/start', { turn: TURN })
    append('step/start', { turn: TURN, step: STEP })
    const argumentsText = JSON.stringify({ code: 'return await tools.bash({ command: "timer-probe" })', description: TOOL_LABEL })
    append('assistant/message', { turn: TURN, step: STEP, stream: SOURCE_STREAM, message: { id: CALL_ID, role: 'assistant', source: { kind: SOURCE_KIND, provider: SOURCE_PROVIDER, model: SOURCE_MODEL }, content: [{ type: 'tool-call', id: CALL_ID, name: 'run_code', arguments: argumentsText }] } }, true)
    append('tool/call', { turn: TURN, step: STEP, callId: CALL_ID, name: 'run_code', arguments: argumentsText })
    append('tool/ptc-dispatch-start', { rootCallId: CALL_ID, parentCallId: CALL_ID, subCallId: SUB_CALL_ID, name: 'bash', arguments: { command: 'timer-probe' } })
    // A stored child supplies real view-switch replay without requesting inference.
    const child = ctx.get('sessions').create(CHILD_ID, { meta: { cwd: process.cwd() } })
    child.append('turn/start', { turn: TURN })
    child.append('step/start', { turn: TURN, step: STEP })
    const childArguments = JSON.stringify({ code: 'return null', description: CHILD_TOOL_LABEL })
    child.append('assistant/message', { turn: TURN, step: STEP, stream: SOURCE_STREAM, message: { id: CHILD_CALL, role: 'assistant', source: { kind: SOURCE_KIND, provider: SOURCE_PROVIDER, model: SOURCE_MODEL }, content: [{ type: 'tool-call', id: CHILD_CALL, name: 'run_code', arguments: childArguments }] } }, { surfaceOp: 'append' })
    child.append('tool/call', { turn: TURN, step: STEP, callId: CHILD_CALL, name: 'run_code', arguments: childArguments })
    ctx.emit('subagent/start', { runId: CHILD_RUN, id: CHILD_ID, provider: 'timer-probe' })
    const done = Promise.withResolvers()
    const jobId = registry.start({
      kind: 'bash', label: JOB_LABEL, owner: sessionId,
      run: job => {
        job.append(OUTPUT)
        return {
          cancel: () => {
            // Awaited fixture completion must not wake a credential-free model.
            void registry.wait(job.id, CANCEL_WAIT_TIMEOUT_MS, sessionId).catch(error => {
              // A broken waiter must fail the gate instead of hiding an inference attempt.
              setImmediate(() => { throw error })
            })
            done.resolve({ status: 'killed' })
          },
          done: done.promise,
        }
      },
    })
    later(() => {
      // Duplicate service delivery must not replace the start time of an existing run.
      ctx.emit('subagent/start', { runId: CHILD_RUN, id: CHILD_ID, provider: 'timer-probe' })
      append('tool/ptc-dispatch', { rootCallId: CALL_ID, parentCallId: CALL_ID, subCallId: SUB_CALL_ID, name: 'bash', arguments: { command: 'timer-probe' }, content: [{ type: 'text', text: OUTPUT }], isError: false })
      append('tool/result', { turn: TURN, step: STEP, message: { id: RESULT_ID, role: 'tool', source: { kind: 'tool', callId: CALL_ID }, toolCallId: CALL_ID, content: [{ type: 'text', text: OUTPUT }], isError: false } }, true)
      append('step/end', { turn: TURN, step: STEP })
      append('turn/end', { turn: TURN, reason: { type: 'completed' } })
    }, TOOL_MS)
    later(() => {
      child.append('tool/result', { turn: TURN, step: STEP, message: { id: CHILD_RESULT, role: 'tool', source: { kind: 'tool', callId: CHILD_CALL }, toolCallId: CHILD_CALL, content: [{ type: 'text', text: OUTPUT }], isError: false } }, { surfaceOp: 'append' })
      child.append('step/end', { turn: TURN, step: STEP })
      child.append('turn/end', { turn: TURN, reason: { type: 'completed' } })
      // UI reads cannot consume the model's independent output cursor.
      const read = registry.read(jobId, sessionId)
      const retainedOutput = read.chunks.map(chunk => chunk.text).join('')
      let rejectsOtherOwner = false
      try { registry.get(jobId, 'timer-probe-other-session') } catch { rejectsOtherOwner = true }
      writeFileSync(join(process.cwd(), RECEIPT_FILE), JSON.stringify({ jobId, retainedOutput, rejectsOtherOwner, durations: BOUNDARIES.map(ms => describeDuration(ms)) }), { mode: PRIVATE_MODE })
      ctx.emit('subagent/end', { runId: CHILD_RUN, id: CHILD_ID, provider: 'timer-probe', stopReason: 'completed' })
      ctx.emit('subagent/end', { runId: RECEIPT, id: RECEIPT, provider: RECEIPT, stopReason: 'completed' })
    }, RECEIPT_MS)
  }
  later(begin, START_DELAY_MS)
}
