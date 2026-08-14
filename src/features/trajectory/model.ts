import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type {
  AssistantBlock,
  AssistantMessageNode,
  ConversationNode,
  ConversationPromptSnapshot,
  ConversationSnapshot,
  RequestView,
  ToolCallBlock,
  ToolResultNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {
  TuiTrajectoryPromptHeader,
  TuiTrajectoryRuntimeSnapshot,
} from '../../client/trajectory.js'
import { sanitizeConversationText } from '../conversation/projection.js'
import { sanitizeText } from '../sessions/projection.js'
import type {
  TrajectoryAggregateView,
  TrajectoryController,
  TrajectoryControllerOptions,
  TrajectoryDetailTab,
  TrajectoryDetailsView,
  TrajectoryRecordKind,
  TrajectoryRecordView,
  TrajectoryRowView,
  TrajectorySessionBinding,
  TrajectorySnapshotView,
  TrajectoryTimelineMode,
  TrajectoryTimelineSpanView,
  TrajectoryTokenTotals,
} from './contracts.js'

export type * from './contracts.js'

const OVERLAY_ID = 'trajectory'
const FIRST_INDEX = 0
const ROW_WINDOW_SIZE = 200
const ROW_WINDOW_HALF = Math.floor(ROW_WINDOW_SIZE / 2)
const RECORD_ORDER_SCALE = 1_000
const RUNTIME_VIEW_TARGET = 'tui-trajectory'
const NO_DETAIL = 'No record selected.'
const EMPTY_INPUT = '(no recorded input)'
const EMPTY_OUTPUT = '(no recorded output)'
const UNKNOWN_TIMING = 'No recorded timing.'
const SEARCH_EMPTY = ''
const AUTH_FAILURE_CODE = 'AUTH'
const AUTH_FAILURE_MESSAGE = 'API key is invalid'
const REDACTED_VALUE = '[REDACTED]'
const SENSITIVE_FIELD = /^(?:api[-_]?key|authorization|credentials?|password|secret|access[-_]?token|refresh[-_]?token)$/iu
const DETAIL_TABS = Object.freeze([
  'input',
  'output',
  'timing',
  'raw',
] as const satisfies readonly TrajectoryDetailTab[])
const EMPTY_TOKENS: TrajectoryTokenTotals = Object.freeze({
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
})
const EMPTY_AGGREGATE: TrajectoryAggregateView = Object.freeze({
  ...EMPTY_TOKENS,
  durationMs: 0,
  records: 0,
  steps: 0,
  turns: 0,
})
const EMPTY_DETAILS: TrajectoryDetailsView = Object.freeze({
  input: NO_DETAIL,
  output: NO_DETAIL,
  raw: NO_DETAIL,
  timing: NO_DETAIL,
})

type AssistantRequest = Extract<RequestView, { purpose: 'assistant' }>
type CompactionRequest = Extract<RequestView, { purpose: 'compaction' }>

interface RecordLocation {
  readonly step: number | undefined
  readonly turn: number | undefined
}

interface InternalRecord {
  readonly assistantOwner: string | undefined
  readonly details: TrajectoryDetailsView
  readonly order: number
  readonly search: string
  readonly view: TrajectoryRecordView
}

interface Projection {
  readonly aggregate: TrajectoryAggregateView
  readonly detailsByKey: ReadonlyMap<string, TrajectoryDetailsView>
  readonly rows: readonly TrajectoryRowView[]
  readonly timeline: readonly TrajectoryTimelineSpanView[]
}

interface ProjectContext {
  readonly collapsedAssistants: ReadonlySet<string>
  readonly collapsedSteps: ReadonlySet<string>
  readonly collapsedTurns: ReadonlySet<number>
  readonly query: string
  readonly snapshot: ConversationSnapshot | undefined
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null
}

function runtimeSnapshot(snapshot: ConversationSnapshot): TuiTrajectoryRuntimeSnapshot | undefined {
  // Target registration owns this value; the runtime's generic store cannot express private target keys without global merges.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const store = snapshot.views as unknown as { get(target: string): unknown }
  const value = store.get(RUNTIME_VIEW_TARGET)
  if (!record(value) || !Array.isArray(value.headers) || !Array.isArray(value.requests)) return undefined
  // Arrays passed the target-owned snapshot boundary and remain immutable to this consumer.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as unknown as TuiTrajectoryRuntimeSnapshot
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function nonNegative(value: unknown): number {
  return finite(value) && value > 0 ? value : 0
}

function diagnosticJsonReplacer(this: unknown, key: string, value: unknown): unknown {
  if (SENSITIVE_FIELD.test(key)) return REDACTED_VALUE
  if (key === 'message' && record(this) && this.code === AUTH_FAILURE_CODE) return AUTH_FAILURE_MESSAGE
  return value
}

function fullJson(value: unknown): string {
  let serialized: string
  try {
    serialized = JSON.stringify(value, diagnosticJsonReplacer, 2) ?? String(value)
  } catch {
    serialized = String(value)
  }
  return sanitizeText(serialized)
}

function failureText(value: unknown): string {
  if (record(value)) {
    if (value.code === AUTH_FAILURE_CODE) return AUTH_FAILURE_MESSAGE
    if (typeof value.message === 'string') return sanitizeConversationText(value.message)
  }
  return fullJson(value)
}

function oneLine(value: string): string {
  return sanitizeConversationText(value).replaceAll(/\s+/gu, ' ').trim()
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return fullJson(content)
  return sanitizeConversationText(content.map((block): string => {
    if (!record(block)) return fullJson(block)
    switch (block.type) {
      case 'text':
      case 'reasoning': return typeof block.text === 'string' ? block.text : ''
      case 'image': return '[image]'
      case 'tool-call': {
        const name = typeof block.name === 'string' ? block.name : 'tool'
        return `${name} ${typeof block.arguments === 'string' ? block.arguments : fullJson(block.arguments)}`
      }
      case 'tool-result': return contentText(block.content)
      default: return fullJson(block)
    }
  }).filter(Boolean).join('\n'))
}

function assistantBlockText(block: AssistantBlock): string {
  switch (block.kind) {
    case 'text': return block.text
    case 'reasoning': return `thinking: ${block.text}`
    case 'tool-call': return `tool ${block.name}: ${block.argsRaw}`
    case 'image': return '[image]'
    case 'other': return fullJson(block.block)
    default: {
      const exhaustive: never = block
      return exhaustive
    }
  }
}

function assistantText(node: AssistantMessageNode): string {
  return sanitizeConversationText(node.blocks.map(assistantBlockText).filter(Boolean).join('\n'))
}

function tokenTotals(usage: unknown): TrajectoryTokenTotals {
  if (!record(usage)) return EMPTY_TOKENS
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let reasoningTokens = 0
  for (const [key, raw] of Object.entries(usage)) {
    if (!finite(raw)) continue
    const normalized = key.replaceAll(/[^a-z]/giu, '').toLocaleLowerCase()
    switch (normalized) {
      case 'inputtokens':
      case 'prompttokens': inputTokens += nonNegative(raw); break
      case 'outputtokens':
      case 'completiontokens': outputTokens += nonNegative(raw); break
      case 'cachereadtokens':
      case 'cachedinputtokens': cacheReadTokens += nonNegative(raw); break
      case 'cachewritetokens': cacheWriteTokens += nonNegative(raw); break
      case 'reasoningtokens':
      case 'thinkingtokens': reasoningTokens += nonNegative(raw); break
      default: break
    }
  }
  return { cacheReadTokens, cacheWriteTokens, inputTokens, outputTokens, reasoningTokens }
}

function addTokens(left: TrajectoryTokenTotals, right: TrajectoryTokenTotals): TrajectoryTokenTotals {
  return {
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
  }
}

function durationLabel(milliseconds: number | undefined): string {
  return milliseconds === undefined ? '—' : `${String(Math.round(milliseconds))} ms`
}

function assistantTiming(node: AssistantMessageNode): {
  readonly durationMs: number | undefined
  readonly startedAt: number
  readonly text: string
} {
  const timing = node.timing
  const startedAt = timing?.stepStartTime ?? node.time
  if (timing === undefined) return { durationMs: undefined, startedAt, text: UNKNOWN_TIMING }
  const durationMs = timing.stepStartTime === null
    ? undefined
    : Math.max(0, timing.completedTime - timing.stepStartTime)
  const ttft = timing.stepStartTime === null || timing.firstTokenTime === null
    ? undefined
    : Math.max(0, timing.firstTokenTime - timing.stepStartTime)
  const decode = timing.firstTokenTime === null
    ? undefined
    : Math.max(0, timing.completedTime - timing.firstTokenTime)
  return {
    durationMs,
    startedAt,
    text: `Start ${String(startedAt)}\nDuration ${durationLabel(durationMs)}\nTTFT ${durationLabel(ttft)}\nDecode ${durationLabel(decode)}`,
  }
}

function promptDetail(prompt: ConversationPromptSnapshot): string {
  return [
    `CONFIG\n${fullJson(prompt.config)}`,
    `SYSTEM\n${prompt.system}`,
    `TOOLS\n${fullJson(prompt.tools)}`,
  ].join('\n\n')
}

function assistantInput(node: AssistantMessageNode, request: AssistantRequest | undefined): string {
  const fields: string[] = []
  if (request?.prompt !== undefined) fields.push(promptDetail(request.prompt))
  if (request?.promptChange?.previous !== undefined) {
    fields.push(`PREVIOUS PROMPT\n${promptDetail(request.promptChange.previous)}`)
  }
  if (node.provenance !== undefined) fields.push(`provider ${node.provenance.provider}\nmodel ${node.provenance.model}`)
  if (node.requestConfig !== undefined && request?.prompt === undefined) fields.push(fullJson(node.requestConfig))
  const calls = node.blocks.filter((block): block is Extract<AssistantBlock, { kind: 'tool-call' }> => block.kind === 'tool-call')
  if (calls.length > 0) fields.push(calls.map(call => `${call.name}\n${call.argsRaw}`).join('\n\n'))
  return fields.join('\n\n') || EMPTY_INPUT
}

function nodeKey(node: ConversationNode): string {
  switch (node.kind) {
    case 'assistant': return `record:assistant:${String(node.seq)}`
    case 'command': return `record:command:${String(node.seq)}`
    case 'compaction': return `record:compaction:${String(node.seq)}`
    case 'context': return `record:context:${String(node.seq)}`
    case 'model-retry': return `record:model-retry:${String(node.seq)}`
    case 'steering': return `record:steering:${String(node.seq)}`
    case 'tool-result': return `record:tool:${node.callId}`
    case 'turn-error': return `record:turn-error:${String(node.seq)}`
    case 'turn-max-tokens': return `record:turn-max-tokens:${String(node.seq)}`
    case 'unknown': return `record:unknown:${String(node.seq)}`
    case 'user': return `record:user:${String(node.seq)}`
    default: {
      const exhaustive: never = node
      return String(exhaustive)
    }
  }
}

function explicitLocation(node: ConversationNode): RecordLocation | undefined {
  switch (node.kind) {
    case 'assistant':
    case 'turn-error':
    case 'turn-max-tokens': return { step: node.step, turn: node.turn }
    case 'command':
    case 'compaction':
    case 'context':
    case 'model-retry':
    case 'steering':
    case 'tool-result':
    case 'unknown':
    case 'user': return undefined
    default: {
      const exhaustive: never = node
      return exhaustive
    }
  }
}

function recordKind(node: ConversationNode): TrajectoryRecordKind {
  switch (node.kind) {
    case 'assistant': return 'assistant'
    case 'command': return 'command'
    case 'compaction': return 'compacted'
    case 'context': return 'context'
    case 'model-retry': return 'retry'
    case 'steering': return 'user'
    case 'tool-result': return 'tool'
    case 'turn-error':
    case 'turn-max-tokens': return 'error'
    case 'unknown': return 'system'
    case 'user': return 'user'
    default: {
      const exhaustive: never = node
      return exhaustive
    }
  }
}

function nodeLabel(node: ConversationNode): string {
  switch (node.kind) {
    case 'assistant': return `Assistant · step ${String(node.step)}`
    case 'command': return node.name === null ? 'Command' : `Command · /${node.name}`
    case 'compaction': return 'History compacted'
    case 'context': return `Context · ${node.provenance.label ?? node.provenance.role}`
    case 'model-retry': return `Model retry ${String(node.retry)}`
    case 'steering': return 'Steering'
    case 'tool-result': return node.call?.name ?? node.callId
    case 'turn-error': return node.code === undefined ? 'Turn error' : `Turn error · ${node.code}`
    case 'turn-max-tokens': return 'Maximum output tokens'
    case 'unknown': return node.type
    case 'user': return 'User'
    default: {
      const exhaustive: never = node
      return String(exhaustive)
    }
  }
}

function nodeOutput(node: ConversationNode, request: RequestView | undefined): string {
  switch (node.kind) {
    case 'assistant': return assistantText(node)
    case 'command': return node.outcome?.text ?? (node.outcome === null ? 'Running.' : node.outcome.kind)
    case 'compaction': {
      const compaction = request?.purpose === 'compaction' ? request : undefined
      return compaction?.rawOutput === undefined
        ? node.summary ?? 'Summary is outside loaded history.'
        : contentText(compaction.rawOutput)
    }
    case 'context':
    case 'steering':
    case 'user': return contentText(node.content)
    case 'model-retry': return failureText(node.failure)
    case 'tool-result': return contentText(node.content)
    case 'turn-error': return node.message
    case 'turn-max-tokens': return 'Maximum output tokens reached.'
    case 'unknown': return fullJson(node.data)
    default: {
      const exhaustive: never = node
      return String(exhaustive)
    }
  }
}

function nodeInput(node: ConversationNode, request: RequestView | undefined): string {
  switch (node.kind) {
    case 'assistant': return assistantInput(node, request?.purpose === 'assistant' ? request : undefined)
    case 'command': return node.args ?? EMPTY_INPUT
    case 'context':
    case 'steering':
    case 'user': return contentText(node.content)
    case 'tool-result': return node.call?.argsRaw ?? EMPTY_INPUT
    case 'compaction': return request?.purpose === 'compaction'
      ? fullJson({ requestConfig: request.requestConfig, summary: request.summary })
      : EMPTY_INPUT
    case 'model-retry':
    case 'turn-error':
    case 'turn-max-tokens':
    case 'unknown': return EMPTY_INPUT
    default: {
      const exhaustive: never = node
      return String(exhaustive)
    }
  }
}

function nodeTiming(node: ConversationNode, request: RequestView | undefined): {
  readonly durationMs: number | undefined
  readonly startedAt: number
  readonly text: string
} {
  if (node.kind === 'assistant') {
    const recorded = assistantTiming(node)
    if (recorded.durationMs !== undefined || request === undefined) return recorded
    const durationMs = request.completedAt === null ? undefined : Math.max(0, request.completedAt - request.startedAt)
    return {
      durationMs,
      startedAt: request.startedAt,
      text: `Start ${String(request.startedAt)}\nDuration ${durationLabel(durationMs)}`,
    }
  }
  if (node.kind === 'tool-result') {
    const durationMs = node.callTime === null ? undefined : Math.max(0, node.time - node.callTime)
    const startedAt = node.callTime ?? node.time
    return {
      durationMs,
      startedAt,
      text: `Start ${String(startedAt)}\nDuration ${durationLabel(durationMs)}`,
    }
  }
  return { durationMs: 0, startedAt: node.time, text: `Start ${String(node.time)}\nDuration 0 ms` }
}

function internalRecord(
  node: ConversationNode,
  location: RecordLocation,
  order: number,
  assistantOwner: string | undefined,
  request: RequestView | undefined,
): InternalRecord {
  const key = nodeKey(node)
  const output = nodeOutput(node, request) || EMPTY_OUTPUT
  const input = nodeInput(node, request)
  const timing = nodeTiming(node, request)
  const raw = fullJson(request === undefined ? node : { node, request })
  const tokens = node.kind === 'assistant'
    ? tokenTotals(request?.usage ?? node.usage)
    : node.kind === 'compaction'
      ? tokenTotals(request?.usage)
      : EMPTY_TOKENS
  const view: TrajectoryRecordView = {
    depth: 0,
    durationMs: timing.durationMs,
    error: node.kind === 'turn-error' || node.kind === 'turn-max-tokens' || (node.kind === 'tool-result' && node.isError),
    key,
    kind: recordKind(node),
    label: sanitizeConversationText(nodeLabel(node)),
    preview: oneLine(output),
    seq: node.seq,
    startedAt: timing.startedAt,
    step: location.step,
    tokens,
    turn: location.turn,
  }
  const details = Object.freeze({ input, output, raw, timing: timing.text })
  return {
    assistantOwner,
    details,
    order,
    search: `${view.label}\n${view.preview}\n${input}\n${output}\n${timing.text}\n${raw}`.toLocaleLowerCase(),
    view,
  }
}

function callSettled(call: ToolCallBlock): call is ToolResultNode {
  return record(call) && call.kind === 'tool-result'
}

function toolRecord(
  call: ToolCallBlock,
  location: RecordLocation,
  kind: 'subtool' | 'tool',
  depth: number,
  order: number,
  assistantOwner: string | undefined,
  schemas: ReadonlyMap<string, ConversationPromptSnapshot['tools'][number]>,
): InternalRecord {
  const settled = callSettled(call)
  const callId = call.callId
  const name = settled ? call.call?.name ?? callId : call.name
  const args = settled ? call.call?.argsRaw ?? EMPTY_INPUT : call.argsRaw
  const schema = schemas.get(name)
  const output = settled ? contentText(call.content) || EMPTY_OUTPUT : 'Running.'
  const startedAt = settled ? call.callTime ?? call.time : call.time
  const durationMs = settled && call.callTime !== null ? Math.max(0, call.time - call.callTime) : undefined
  const key = `record:${kind}:${callId}`
  const raw = fullJson(call)
  const timing = `Start ${String(startedAt)}\nDuration ${durationLabel(durationMs)}`
  const view: TrajectoryRecordView = {
    depth,
    durationMs,
    error: settled && call.isError,
    key,
    kind,
    label: sanitizeConversationText(name),
    preview: oneLine(output),
    seq: settled ? call.seq : Number.MAX_SAFE_INTEGER,
    startedAt,
    step: location.step,
    tokens: EMPTY_TOKENS,
    turn: location.turn,
  }
  const details = Object.freeze({
    input: schema === undefined ? args : `${args}\n\nSCHEMA\n${fullJson(schema)}`,
    output,
    raw: schema === undefined ? raw : fullJson({ call, schema }),
    timing,
  })
  return {
    assistantOwner,
    details,
    order,
    search: `${view.label}\n${view.preview}\n${details.input}\n${output}\n${timing}\n${details.raw}`.toLocaleLowerCase(),
    view,
  }
}

function appendToolTree(
  output: InternalRecord[],
  call: ToolCallBlock,
  location: RecordLocation,
  kind: 'subtool' | 'tool',
  depth: number,
  order: { value: number },
  assistantOwner: string | undefined,
  schemas: ReadonlyMap<string, ConversationPromptSnapshot['tools'][number]>,
  seen: Set<string>,
): void {
  if (seen.has(call.callId)) return
  seen.add(call.callId)
  output.push(toolRecord(call, location, kind, depth, order.value++, assistantOwner, schemas))
  for (const child of call.subCalls) {
    appendToolTree(output, child, location, 'subtool', depth + 1, order, assistantOwner, schemas, seen)
  }
}

function headerLocation(header: TuiTrajectoryPromptHeader): RecordLocation {
  if (header.location.kind === 'step') {
    return { step: header.location.step.step, turn: header.location.turn.turn }
  }
  if (header.location.kind === 'turn') return { step: undefined, turn: header.location.turn.turn }
  return { step: undefined, turn: undefined }
}

function systemRecord(header: TuiTrajectoryPromptHeader): InternalRecord {
  const location = headerLocation(header)
  const change = header.change?.kind ?? 'header'
  const key = `record:system:${String(header.seq)}`
  const input = promptDetail(header.prompt)
  const output = header.change?.previous === undefined
    ? `Prompt ${change}`
    : `Prompt ${change}\n\nPREVIOUS\n${promptDetail(header.change.previous)}`
  const raw = fullJson(header)
  const timing = `Start ${String(header.time)}\nDuration 0 ms`
  const view: TrajectoryRecordView = {
    depth: 0,
    durationMs: 0,
    error: false,
    key,
    kind: 'system',
    label: `System · ${change}`,
    preview: oneLine(output),
    seq: header.seq,
    startedAt: header.time,
    step: location.step,
    tokens: EMPTY_TOKENS,
    turn: location.turn,
  }
  const details = Object.freeze({ input, output, raw, timing })
  return {
    assistantOwner: undefined,
    details,
    order: header.seq * RECORD_ORDER_SCALE,
    search: `${view.label}\n${input}\n${output}\n${raw}`.toLocaleLowerCase(),
    view,
  }
}

function requestOnlyRecord(
  request: RequestView,
  partial: ConversationSnapshot['partial'],
): InternalRecord {
  const assistant = request.purpose === 'assistant'
  const key = `record:${assistant ? 'assistant' : 'compaction'}-request:${String(request.startSeq)}`
  const partialOutput = assistant && partial?.turn === request.turn && partial.step === request.step
    ? partial.blocks.map(assistantBlockText).join('\n')
    : undefined
  const output = request.error
    ?? (assistant ? partialOutput : contentText(request.rawOutput ?? request.summary ?? []))
    ?? request.status
  const input = assistant
    ? request.prompt === undefined ? fullJson(request.requestConfig) : promptDetail(request.prompt)
    : fullJson({ requestConfig: request.requestConfig, summary: request.summary })
  const durationMs = request.completedAt === null ? undefined : Math.max(0, request.completedAt - request.startedAt)
  const timing = `Start ${String(request.startedAt)}\nDuration ${durationLabel(durationMs)}`
  const raw = fullJson(request)
  const view: TrajectoryRecordView = {
    depth: 0,
    durationMs,
    error: request.status === 'error',
    key,
    kind: assistant ? 'assistant' : 'compacted',
    label: assistant ? `Assistant request · step ${String(request.step)}` : 'Compaction request',
    preview: oneLine(output),
    seq: request.startSeq,
    startedAt: request.startedAt,
    step: assistant ? request.step : undefined,
    tokens: tokenTotals(request.usage),
    turn: request.turn ?? undefined,
  }
  const details = Object.freeze({ input, output, raw, timing })
  return {
    assistantOwner: undefined,
    details,
    order: request.startSeq * RECORD_ORDER_SCALE,
    search: `${view.label}\n${input}\n${output}\n${raw}`.toLocaleLowerCase(),
    view,
  }
}

function toolsByName(request: AssistantRequest | undefined): ReadonlyMap<string, ConversationPromptSnapshot['tools'][number]> {
  return new Map((request?.prompt?.tools ?? []).map(tool => [tool.name, tool]))
}

function recordsOf(snapshot: ConversationSnapshot): readonly InternalRecord[] {
  const runtime = runtimeSnapshot(snapshot)
  const requests = runtime?.requests ?? []
  const requestByResult = new Map<number, RequestView>()
  const assistantByStep = new Map<string, AssistantRequest>()
  const compactionByRecord = new Map<number, CompactionRequest>()
  for (const request of requests) {
    if (request.resultSeq !== undefined) requestByResult.set(request.resultSeq, request)
    if (request.purpose === 'assistant') assistantByStep.set(stepKey(request.turn, request.step), request)
    else {
      if (request.replacementSeq !== undefined) compactionByRecord.set(request.replacementSeq, request)
      if (request.resultSeq !== undefined) compactionByRecord.set(request.resultSeq, request)
    }
  }
  const nodes = snapshot.nodes.toSorted((left, right) => left.seq - right.seq)
  const callLocations = new Map<string, RecordLocation>()
  const callOwners = new Map<string, string>()
  const requestByOwner = new Map<string, AssistantRequest>()
  let nextLocation: RecordLocation | undefined
  const nextLocations = nodes.map((): RecordLocation | undefined => nextLocation)
  for (let index = nodes.length - 1; index >= FIRST_INDEX; index--) {
    nextLocations[index] = nextLocation
    const node = nodes[index]
    if (node === undefined) continue
    nextLocation = explicitLocation(node) ?? nextLocation
  }
  for (const node of nodes) {
    if (node.kind !== 'assistant') continue
    const owner = nodeKey(node)
    const request = requestByResult.get(node.seq) ?? assistantByStep.get(stepKey(node.turn, node.step))
    if (request?.purpose === 'assistant') requestByOwner.set(owner, request)
    for (const block of node.blocks) {
      if (block.kind !== 'tool-call') continue
      callLocations.set(block.callId, { step: node.step, turn: node.turn })
      callOwners.set(block.callId, owner)
    }
  }
  if (snapshot.partial !== null) {
    const owner = `record:assistant-request:${String(assistantByStep.get(stepKey(snapshot.partial.turn, snapshot.partial.step))?.startSeq ?? 0)}`
    for (const block of snapshot.partial.blocks) {
      if (block.kind !== 'tool-call') continue
      callLocations.set(block.callId, { step: snapshot.partial.step, turn: snapshot.partial.turn })
      callOwners.set(block.callId, owner)
    }
  }
  const output: InternalRecord[] = (runtime?.headers ?? [])
    .filter(header => header.change !== undefined)
    .map(header => systemRecord(header))
  const consumedRequests = new Set<number>()
  let current: RecordLocation = { step: undefined, turn: undefined }
  const settledCalls = new Set<string>()
  for (const [index, node] of nodes.entries()) {
    const explicit = explicitLocation(node)
    let location = explicit ?? current
    if (node.kind === 'tool-result') location = callLocations.get(node.callId) ?? location
    else if (node.kind === 'user' || node.kind === 'steering' || node.kind === 'context') {
      location = nextLocations[index] ?? current
      location = { step: undefined, turn: location.turn }
    }
    if (explicit !== undefined) current = explicit
    else if (location.turn !== undefined) current = location
    const request = node.kind === 'assistant'
      ? requestByResult.get(node.seq) ?? assistantByStep.get(stepKey(node.turn, node.step))
      : node.kind === 'compaction'
        ? compactionByRecord.get(node.seq)
        : undefined
    if (request !== undefined) consumedRequests.add(request.startSeq)
    const order = { value: node.seq * RECORD_ORDER_SCALE }
    if (node.kind === 'tool-result') {
      settledCalls.add(node.callId)
      const owner = callOwners.get(node.callId)
      appendToolTree(
        output,
        node,
        location,
        'tool',
        0,
        order,
        owner,
        toolsByName(owner === undefined ? undefined : requestByOwner.get(owner)),
        new Set<string>(),
      )
      continue
    }
    output.push(internalRecord(node, location, order.value, undefined, request))
  }
  for (const request of requests) {
    if (!consumedRequests.has(request.startSeq)) output.push(requestOnlyRecord(request, snapshot.partial))
  }
  const runningOrder = {
    value: Math.max(FIRST_INDEX, ...output.map(recordValue => recordValue.order)) + RECORD_ORDER_SCALE,
  }
  for (const call of snapshot.runningCalls.toSorted((left, right) => left.time - right.time)) {
    if (settledCalls.has(call.callId)) continue
    const location = { step: call.step, turn: call.turn }
    const owner = callOwners.get(call.callId)
    const request = owner === undefined
      ? assistantByStep.get(stepKey(call.turn, call.step))
      : requestByOwner.get(owner)
    appendToolTree(
      output,
      call,
      location,
      'tool',
      0,
      runningOrder,
      owner,
      toolsByName(request),
      new Set<string>(),
    )
  }
  return output.toSorted((left, right) => left.order - right.order || left.view.key.localeCompare(right.view.key))
}

function terms(query: string): readonly string[] {
  return query.trim().toLocaleLowerCase().split(/\s+/gu).filter(Boolean)
}

function matches(recordValue: InternalRecord, queryTerms: readonly string[]): boolean {
  return queryTerms.every(term => recordValue.search.includes(term))
}

function turnKey(turn: number): string {
  return `turn:${String(turn)}`
}

function stepKey(turn: number, step: number): string {
  return `step:${String(turn)}:${String(step)}`
}

function headerRow(
  kind: 'step' | 'turn',
  turn: number,
  step: number | undefined,
  collapsed: boolean,
): TrajectoryRowView {
  return {
    collapsed,
    depth: kind === 'turn' ? 0 : 1,
    error: false,
    foldable: true,
    key: kind === 'turn' ? turnKey(turn) : stepKey(turn, step ?? FIRST_INDEX),
    kind,
    label: kind === 'turn' ? `Turn ${String(turn)}` : `Step ${String(step)}`,
    preview: collapsed ? 'collapsed' : '',
    record: undefined,
    step,
    turn,
  }
}

function rowsOf(records: readonly InternalRecord[], context: ProjectContext): readonly TrajectoryRowView[] {
  const queryTerms = terms(context.query)
  const searching = queryTerms.length > 0
  const selected = records.filter(candidate => matches(candidate, queryTerms))
  const ownedAssistants = new Set(records.flatMap(candidate => candidate.assistantOwner === undefined
    ? []
    : [candidate.assistantOwner]))
  const rows: TrajectoryRowView[] = []
  let priorTurn: number | undefined
  let priorStep: string | undefined
  for (const internal of selected) {
    const recordView = internal.view
    const turn = recordView.turn
    const step = recordView.step
    if (turn !== undefined && turn !== priorTurn) {
      rows.push(headerRow('turn', turn, undefined, context.collapsedTurns.has(turn)))
      priorTurn = turn
      priorStep = undefined
    }
    if (!searching && turn !== undefined && context.collapsedTurns.has(turn)) continue
    const currentStep = turn === undefined || step === undefined ? undefined : stepKey(turn, step)
    if (currentStep !== undefined && currentStep !== priorStep) {
      rows.push(headerRow('step', turn ?? FIRST_INDEX, step, context.collapsedSteps.has(currentStep)))
      priorStep = currentStep
    }
    if (!searching && currentStep !== undefined && context.collapsedSteps.has(currentStep)) continue
    if (!searching
      && internal.assistantOwner !== undefined
      && context.collapsedAssistants.has(internal.assistantOwner)) continue
    const ownsTools = ownedAssistants.has(recordView.key)
    rows.push({
      collapsed: ownsTools && context.collapsedAssistants.has(recordView.key),
      depth: 2 + recordView.depth,
      error: recordView.error,
      foldable: recordView.kind === 'assistant' && ownsTools,
      key: recordView.key,
      kind: 'record',
      label: recordView.label,
      preview: recordView.preview,
      record: recordView,
      step,
      turn,
    })
  }
  return rows
}

function aggregateOf(snapshot: ConversationSnapshot, records: readonly InternalRecord[]): TrajectoryAggregateView {
  let tokens = EMPTY_TOKENS
  for (const recordValue of records) tokens = addTokens(tokens, recordValue.view.tokens)
  let durationMs = 0
  for (const timing of snapshot.turnTimings.values()) {
    if (timing.endTime !== undefined) durationMs += Math.max(0, timing.endTime - timing.startTime)
  }
  const turns = new Set(records.flatMap(item => item.view.turn === undefined ? [] : [item.view.turn]))
  const steps = new Set(records.flatMap(item => item.view.turn === undefined || item.view.step === undefined
    ? []
    : [stepKey(item.view.turn, item.view.step)]))
  return {
    ...tokens,
    durationMs,
    records: records.length,
    steps: steps.size,
    turns: turns.size,
  }
}

function timelineOf(records: readonly InternalRecord[]): readonly TrajectoryTimelineSpanView[] {
  return records.flatMap((recordValue): TrajectoryTimelineSpanView[] => {
    const item = recordValue.view
    if (item.startedAt === undefined) return []
    const lane: 0 | 1 | 2 = item.kind === 'tool' || item.kind === 'subtool'
      ? 2
      : item.kind === 'assistant' || item.kind === 'compacted'
        ? 1
        : 0
    return [{
      ...item.durationMs === undefined ? {} : {
        durationMs: item.durationMs,
        endTime: item.startedAt + item.durationMs,
      },
      key: item.key,
      kind: item.kind,
      lane,
      sequence: recordValue.order,
      startTime: item.startedAt,
    }]
  }).toSorted((left, right) => left.startTime - right.startTime || left.lane - right.lane)
}

function project(context: ProjectContext): Projection {
  const snapshot = context.snapshot
  if (snapshot === undefined) {
    return { aggregate: EMPTY_AGGREGATE, detailsByKey: new Map(), rows: [], timeline: [] }
  }
  const records = recordsOf(snapshot)
  return {
    aggregate: aggregateOf(snapshot, records),
    detailsByKey: new Map(records.map(recordValue => [recordValue.view.key, recordValue.details])),
    rows: rowsOf(records, context),
    timeline: timelineOf(records),
  }
}

function errorText(error: unknown): string {
  return sanitizeText(error instanceof Error ? error.message : String(error))
}

class TrajectoryControllerService implements TrajectoryController {
  private readonly collapsedAssistants = new Set<string>()
  private readonly collapsedSteps = new Set<string>()
  private readonly collapsedTurns = new Set<number>()
  private readonly listeners = new Set<() => void>()
  private readonly navigation: TrajectoryControllerOptions['navigation']
  private readonly sessions: TrajectoryControllerOptions['sessions']
  private binding: TrajectorySessionBinding | undefined
  private bindingDispose: (() => void) | undefined
  private busy = false
  private current: SessionId | undefined
  private detailTab: TrajectoryDetailTab = DETAIL_TABS[FIRST_INDEX] ?? 'input'
  private disposed = false
  private error: string | undefined
  private overlayOpen = false
  private projectionCache: {
    readonly revision: number
    readonly snapshot: ConversationSnapshot | undefined
    readonly value: Projection
  } | undefined
  private projectionRevision = 0
  private query = SEARCH_EMPTY
  private readonly resources: Array<() => void>
  private searchInput: string | undefined
  private selectedKey: string | undefined
  private timelineMode: TrajectoryTimelineMode = 'sequence'

  constructor(options: TrajectoryControllerOptions) {
    this.navigation = options.navigation
    this.sessions = options.sessions
    this.resources = [this.sessions.list.subscribe(() => { this.rebind() })]
    this.rebind(false)
  }

  cancelSearch(): void {
    if (this.searchInput === undefined) return
    this.searchInput = undefined
    this.publish()
  }

  clearSearch(): void {
    if (this.query === SEARCH_EMPTY && this.searchInput === undefined) return
    this.query = SEARCH_EMPTY
    this.searchInput = undefined
    this.invalidateProjection()
    this.reconcileSelection()
    this.publish()
  }

  close(): void {
    if (!this.overlayOpen) return
    this.navigation.dismissOverlay(OVERLAY_ID)
    this.overlayOpen = false
    this.searchInput = undefined
    this.publish()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.bindingDispose?.()
    this.bindingDispose = undefined
    for (const dispose of this.resources.splice(0).toReversed()) dispose()
    this.navigation.dismissOverlay(OVERLAY_ID)
    this.overlayOpen = false
    this.listeners.clear()
  }

  getSnapshot(): TrajectorySnapshotView {
    const projection = this.projection()
    const globalIndex = this.selectedGlobalIndex(projection.rows)
    const windowStart = Math.max(
      FIRST_INDEX,
      Math.min(globalIndex - ROW_WINDOW_HALF, Math.max(FIRST_INDEX, projection.rows.length - ROW_WINDOW_SIZE)),
    )
    const rows = projection.rows.slice(windowStart, windowStart + ROW_WINDOW_SIZE)
    const rowIndex = Math.max(FIRST_INDEX, globalIndex - windowStart)
    const selected = projection.rows[globalIndex]
    const source = this.binding?.getSnapshot()
    return Object.freeze({
      active: this.active(),
      aggregate: projection.aggregate,
      busy: this.busy,
      detailTab: this.detailTab,
      details: selected === undefined ? EMPTY_DETAILS : projection.detailsByKey.get(selected.key) ?? EMPTY_DETAILS,
      error: this.error,
      hasMore: source?.hasMore ?? false,
      loadingOlder: source?.loadingOlder ?? false,
      overlayId: this.overlayOpen ? OVERLAY_ID : undefined,
      query: this.query,
      rowIndex,
      rows: Object.freeze(rows),
      searchInput: this.searchInput,
      selectedKey: selected?.key,
      sessionId: this.current,
      status: this.status(projection.rows.length, globalIndex),
      timeline: Object.freeze({ mode: this.timelineMode, spans: Object.freeze(projection.timeline) }),
      totalRows: projection.rows.length,
      windowStart,
    })
  }

  async loadOlder(): Promise<boolean> {
    const binding = this.binding
    if (binding === undefined || this.busy) return false
    this.busy = true
    this.error = undefined
    this.publish()
    try {
      await binding.loadOlder()
      return true
    } catch (error) {
      this.error = errorText(error)
      return false
    } finally {
      this.busy = false
      this.reconcileSelection()
      this.publish()
    }
  }

  move(delta: number): void {
    const rows = this.projection().rows
    if (!this.active() || rows.length === 0 || !Number.isFinite(delta) || delta === 0) return
    const current = this.selectedGlobalIndex(rows)
    const direction = delta < 0 ? -1 : 1
    const next = (current + direction + rows.length) % rows.length
    this.selectedKey = rows[next]?.key
    this.publish()
  }

  moveDetailTab(delta: number): void {
    if (!Number.isFinite(delta) || delta === 0) return
    const current = DETAIL_TABS.indexOf(this.detailTab)
    const direction = delta < 0 ? -1 : 1
    this.detailTab = DETAIL_TABS[(current + direction + DETAIL_TABS.length) % DETAIL_TABS.length] ?? this.detailTab
    this.publish()
  }

  open(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    this.overlayOpen = true
    if (!this.navigation.getSnapshot().overlays.some(overlay => overlay.id === OVERLAY_ID)) {
      this.navigation.openOverlay({ id: OVERLAY_ID })
    }
    this.reconcileSelection()
    this.publish()
    return Promise.resolve()
  }

  openSearch(): void {
    if (!this.active()) return
    this.searchInput = this.query
    this.publish()
  }

  selectDetailTab(tab: TrajectoryDetailTab): void {
    if (!DETAIL_TABS.includes(tab) || tab === this.detailTab) return
    this.detailTab = tab
    this.publish()
  }

  selectRow(index: number): void {
    const snapshot = this.getSnapshot()
    if (!Number.isSafeInteger(index) || index < FIRST_INDEX || index >= snapshot.rows.length) return
    this.selectedKey = snapshot.rows[index]?.key
    this.publish()
  }

  setSearchInput(value: string): void {
    if (this.searchInput === undefined) return
    this.searchInput = sanitizeConversationText(value)
  }

  submitSearch(): void {
    if (this.searchInput === undefined) return
    this.query = this.searchInput.trim()
    this.searchInput = undefined
    this.invalidateProjection()
    this.reconcileSelection()
    this.publish()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  toggleFold(): void {
    const rows = this.projection().rows
    const row = rows[this.selectedGlobalIndex(rows)]
    if (row === undefined || !row.foldable) return
    if (row.kind === 'turn' && row.turn !== undefined) this.toggle(this.collapsedTurns, row.turn)
    else if (row.kind === 'step') this.toggle(this.collapsedSteps, row.key)
    else if (row.kind === 'record' && row.record?.kind === 'assistant') this.toggle(this.collapsedAssistants, row.key)
    else return
    this.invalidateProjection()
    this.reconcileSelection()
    this.publish()
  }

  toggleTimelineMode(): void {
    this.timelineMode = this.timelineMode === 'sequence' ? 'time' : 'sequence'
    this.publish()
  }

  private active(): boolean {
    return this.overlayOpen && this.navigation.getSnapshot().overlays.at(-1)?.id === OVERLAY_ID
  }

  private context(): ProjectContext {
    return {
      collapsedAssistants: this.collapsedAssistants,
      collapsedSteps: this.collapsedSteps,
      collapsedTurns: this.collapsedTurns,
      query: this.query,
      snapshot: this.binding?.getSnapshot(),
    }
  }

  private projection(): Projection {
    const snapshot = this.binding?.getSnapshot()
    if (this.projectionCache?.revision === this.projectionRevision
      && this.projectionCache.snapshot === snapshot) return this.projectionCache.value
    const value = project(this.context())
    this.projectionCache = { revision: this.projectionRevision, snapshot, value }
    return value
  }

  private invalidateProjection(): void {
    this.projectionRevision++
    this.projectionCache = undefined
  }

  private publish(): void {
    if (this.disposed) return
    for (const listener of this.listeners) listener()
  }

  private rebind(publish = true): void {
    const next = this.sessions.list.getSnapshot().current
    if (next === this.current) {
      if (publish) this.publish()
      return
    }
    this.bindingDispose?.()
    this.bindingDispose = undefined
    this.current = next
    this.binding = next === undefined ? undefined : this.sessions.binding(next)
    this.bindingDispose = this.binding?.subscribe(() => {
      this.invalidateProjection()
      this.reconcileSelection()
      this.publish()
    })
    this.collapsedAssistants.clear()
    this.collapsedSteps.clear()
    this.collapsedTurns.clear()
    this.query = SEARCH_EMPTY
    this.searchInput = undefined
    this.selectedKey = undefined
    this.invalidateProjection()
    this.error = undefined
    if (this.overlayOpen) {
      this.navigation.dismissOverlay(OVERLAY_ID)
      this.overlayOpen = false
    }
    this.reconcileSelection()
    if (publish) this.publish()
  }

  private reconcileSelection(): void {
    const rows = this.projection().rows
    if (rows.some(row => row.key === this.selectedKey)) return
    this.selectedKey = rows[FIRST_INDEX]?.key
  }

  private selectedGlobalIndex(rows: readonly TrajectoryRowView[]): number {
    const index = rows.findIndex(row => row.key === this.selectedKey)
    return index < FIRST_INDEX ? FIRST_INDEX : index
  }

  private status(totalRows: number, globalIndex: number): string {
    if (this.current === undefined) return 'No active session.'
    if (this.busy || this.binding?.getSnapshot().loadingOlder === true) return 'Loading earlier history…'
    if (this.error !== undefined) return `Error: ${this.error}`
    if (totalRows === 0) return this.query === SEARCH_EMPTY ? 'No trajectory records.' : 'No matching records.'
    const query = this.query === SEARCH_EMPTY ? '' : ` · search ${this.query}`
    return `${String(globalIndex + 1)}/${String(totalRows)}${query}`
  }

  private toggle<T>(set: Set<T>, value: T): void {
    if (set.has(value)) set.delete(value)
    else set.add(value)
  }
}

export function createTrajectoryController(options: TrajectoryControllerOptions): TrajectoryController {
  return new TrajectoryControllerService(options)
}
