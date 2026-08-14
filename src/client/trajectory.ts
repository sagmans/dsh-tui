import type { Context } from '@deepseek-ai/cordis'
import type {
  AssistantProvenanceView,
  ConversationLocation,
  ConversationMatch,
  ConversationNodeContext,
  ConversationNodeDefinition,
  ConversationPromptSnapshot,
  ConversationViewBuilder,
  ConversationViewDefinition,
  ConversationViewNode,
  RequestPromptChange,
  RequestView,
} from '@deepseek-ai/dsh-client-runtime/client'
const VIEW_TARGET = 'tui-trajectory'
const INITIAL_PROMPT_REASON = 'initial'
const COMPACTION_PLUGIN = 'compact'
const AUTH_FAILURE_CODE = 'AUTH'
const AUTH_FAILURE_MESSAGE = 'API key is invalid'
const COMPACTION_INTERRUPTED_MESSAGE = 'Compaction was interrupted before completion.'
const EMPTY_LIST: readonly never[] = Object.freeze([])
const TOKEN_DELTA_TYPES = new Set(['text-delta', 'reasoning-delta', 'tool-call-delta'])

type AssistantRequest = Extract<RequestView, { purpose: 'assistant' }>
type CompactionRequest = Extract<RequestView, { purpose: 'compaction' }>

export interface TuiTrajectoryPromptHeader {
  readonly change: RequestPromptChange | undefined
  readonly location: ConversationLocation
  readonly prompt: ConversationPromptSnapshot
  readonly seq: number
  readonly time: number
}

export interface TuiTrajectoryRuntimeSnapshot {
  readonly headers: readonly TuiTrajectoryPromptHeader[]
  readonly requests: readonly RequestView[]
}

type RuntimeContribution =
  | { readonly kind: 'header'; readonly value: TuiTrajectoryPromptHeader }
  | { readonly kind: 'request'; readonly value: RequestView }
  | { readonly kind: 'session-end'; readonly seq: number; readonly time: number }
  | { readonly error?: string | undefined; readonly kind: 'turn-end'; readonly time: number; readonly turn: number }

interface RuntimeViewNode extends ConversationViewNode {
  readonly anchorSeq: number
  readonly data: RuntimeContribution
  readonly target: typeof VIEW_TARGET
}

const EMPTY_SNAPSHOT: TuiTrajectoryRuntimeSnapshot = Object.freeze({
  headers: EMPTY_LIST,
  requests: EMPTY_LIST,
})

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null
}

function failureMessage(value: unknown): string {
  if (record(value)) {
    if (value.code === AUTH_FAILURE_CODE) return AUTH_FAILURE_MESSAGE
    const message = value.message
    if (typeof message === 'string' && message !== '') return message
  }
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function tokenDelta(value: unknown): boolean {
  return record(value) && TOKEN_DELTA_TYPES.has(String(value.type))
}

function runtimeNode(
  context: ConversationNodeContext,
  anchorSeq: number,
  data: RuntimeContribution,
): RuntimeViewNode {
  return {
    anchorSeq,
    data,
    id: context.id,
    key: context.key,
    kind: context.kind,
    target: VIEW_TARGET,
  }
}

function stepKey(turn: number, step: number): string {
  return `${String(turn)}\u0000${String(step)}`
}

function headerStepKey(header: TuiTrajectoryPromptHeader): string | undefined {
  return header.location.kind === 'step'
    ? stepKey(header.location.turn.turn, header.location.step.step)
    : undefined
}

function headerFor(
  request: AssistantRequest,
  exact: ReadonlyMap<string, TuiTrajectoryPromptHeader>,
  preceding: TuiTrajectoryPromptHeader | undefined,
): TuiTrajectoryPromptHeader | undefined {
  return exact.get(stepKey(request.turn, request.step))
    ?? (preceding !== undefined && preceding.seq < request.startSeq ? preceding : undefined)
}

function withHeader(
  request: AssistantRequest,
  header: TuiTrajectoryPromptHeader | undefined,
  includeChange: boolean,
): AssistantRequest {
  if (header === undefined) return request
  return {
    ...request,
    prompt: header.prompt,
    requestConfig: header.prompt.config,
    ...includeChange && header.change !== undefined ? { promptChange: header.change } : {},
  }
}

function interruptCompactions(
  requests: RequestView[],
  boundaries: readonly Extract<RuntimeContribution, { kind: 'session-end' }>[],
): void {
  let nextRequest = 0
  const running: number[] = []
  for (const boundary of boundaries) {
    while (nextRequest < requests.length) {
      const request = requests[nextRequest]
      if (request === undefined || request.startSeq >= boundary.seq) break
      if (request.purpose === 'compaction' && request.status === 'running') running.push(nextRequest)
      nextRequest++
    }
    let index = running.pop()
    while (index !== undefined && requests[index]?.status !== 'running') index = running.pop()
    if (index === undefined) continue
    const request = requests[index]
    if (request?.purpose !== 'compaction') continue
    requests[index] = {
      ...request,
      completedAt: boundary.time,
      error: COMPACTION_INTERRUPTED_MESSAGE,
      status: 'error',
    }
  }
}

function applyTurnErrors(
  requests: RequestView[],
  endings: readonly Extract<RuntimeContribution, { kind: 'turn-end' }>[],
): void {
  const lastByTurn = new Map<number, number>()
  requests.forEach((request, index) => {
    if (request.purpose === 'assistant') lastByTurn.set(request.turn, index)
  })
  for (const ending of endings) {
    if (ending.error === undefined) continue
    const index = lastByTurn.get(ending.turn)
    if (index === undefined) continue
    const request = requests[index]
    if (request?.purpose !== 'assistant') continue
    requests[index] = {
      ...request,
      completedAt: request.completedAt ?? ending.time,
      error: ending.error,
      status: 'error',
    }
  }
}

class RuntimeSnapshotBuilder implements ConversationViewBuilder<RuntimeViewNode, TuiTrajectoryRuntimeSnapshot> {
  private readonly nodes = new Map<string, RuntimeViewNode>()
  readonly empty = EMPTY_SNAPSHOT

  apply(input: { readonly upserts: readonly RuntimeViewNode[] }): TuiTrajectoryRuntimeSnapshot {
    for (const node of input.upserts) this.nodes.set(node.key, node)
    return this.snapshot()
  }

  replace(input: { readonly nodes: readonly RuntimeViewNode[] }): TuiTrajectoryRuntimeSnapshot {
    this.nodes.clear()
    for (const node of input.nodes) this.nodes.set(node.key, node)
    return this.snapshot()
  }

  private snapshot(): TuiTrajectoryRuntimeSnapshot {
    const contributions = [...this.nodes.values()]
      .toSorted((left, right) => left.anchorSeq - right.anchorSeq || left.key.localeCompare(right.key))
    const headers = contributions.flatMap(node => node.data.kind === 'header' ? [node.data.value] : [])
    const exactHeaders = new Map<string, TuiTrajectoryPromptHeader>()
    for (const header of headers) {
      const key = headerStepKey(header)
      if (key !== undefined) exactHeaders.set(key, header)
    }
    const requests: RequestView[] = []
    const boundaries: Extract<RuntimeContribution, { kind: 'session-end' }>[] = []
    const endings: Extract<RuntimeContribution, { kind: 'turn-end' }>[] = []
    const consumedChanges = new Set<number>()
    let preceding: TuiTrajectoryPromptHeader | undefined
    for (const node of contributions) {
      const contribution = node.data
      if (contribution.kind === 'header') {
        preceding = contribution.value
        continue
      }
      if (contribution.kind === 'turn-end') {
        endings.push(contribution)
        continue
      }
      if (contribution.kind === 'session-end') {
        boundaries.push(contribution)
        continue
      }
      const request = contribution.value
      if (request.purpose === 'compaction') {
        requests.push(request)
        continue
      }
      const header = headerFor(request, exactHeaders, preceding)
      const includeChange = header?.change !== undefined && !consumedChanges.has(header.seq)
      requests.push(withHeader(request, header, includeChange))
      if (includeChange && header !== undefined) consumedChanges.add(header.seq)
    }
    requests.sort((left, right) => left.startSeq - right.startSeq)
    interruptCompactions(requests, boundaries)
    applyTurnErrors(requests, endings)
    return Object.freeze({ headers: Object.freeze(headers), requests: Object.freeze(requests) })
  }
}

export const tuiTrajectoryViewDefinition: ConversationViewDefinition<RuntimeViewNode, TuiTrajectoryRuntimeSnapshot> = {
  create: () => new RuntimeSnapshotBuilder(),
  target: VIEW_TARGET,
}

function requestPrompt(match: ConversationMatch): ConversationPromptSnapshot {
  if (match.event.type !== 'request/header') throw new Error('trajectory request header requires request/header')
  const header = match.event.data.header
  const tools: unknown = header.tools
  return {
    config: header.config,
    system: header.system ?? '',
    tools: Array.isArray(tools) ? tools as ConversationPromptSnapshot['tools'] : [],
  }
}

function promptChange(
  previous: ConversationPromptSnapshot | undefined,
  prompt: ConversationPromptSnapshot,
  match: ConversationMatch,
): RequestPromptChange | undefined {
  if (match.event.type !== 'request/header') return undefined
  if (previous === undefined && match.event.data.reason !== INITIAL_PROMPT_REASON) return undefined
  const systemChanged = previous !== undefined && previous.system !== prompt.system
  const toolsChanged = previous !== undefined && JSON.stringify(previous.tools) !== JSON.stringify(prompt.tools)
  if (previous !== undefined && !systemChanged && !toolsChanged) return undefined
  return {
    kind: previous === undefined
      ? 'initial'
      : systemChanged && toolsChanged
        ? 'system-and-tools'
        : systemChanged ? 'system' : 'tools',
    ...previous === undefined ? {} : { previous },
    seq: match.event.seq,
    time: match.event.time,
  }
}

export const tuiTrajectoryHeaderDefinition: ConversationNodeDefinition<TuiTrajectoryPromptHeader> = {
  kind: 'tui-trajectory-request-header',
  target: VIEW_TARGET,
  match: event => event.type === 'request/header' ? { id: String(event.seq), role: 'start' } : null,
  start: (_context, match, reader) => {
    const prompt = requestPrompt(match)
    const previous = reader.previous<TuiTrajectoryPromptHeader>('tui-trajectory-request-header')?.state.prompt
    return {
      change: promptChange(previous, prompt, match),
      location: match.location,
      prompt,
      seq: match.event.seq,
      time: match.event.time,
    }
  },
  update: context => context.state,
  buildViewNode: context => context.state === undefined
    ? null
    : runtimeNode(context, context.state.seq, { kind: 'header', value: context.state }),
}

interface AssistantState {
  readonly completedAt: number | null
  readonly error: string | undefined
  readonly firstTokenTime: number | null
  readonly maxRetries: number | undefined
  readonly provenance: AssistantProvenanceView | undefined
  readonly resultSeq: number | undefined
  readonly retry: number | undefined
  readonly retryDelayMs: number | undefined
  readonly startSeq: number
  readonly startedAt: number
  readonly step: number
  readonly turn: number
  readonly usage: unknown
}

function initialAssistant(
  turn: number,
  step: number,
  seq: number,
  time: number,
): AssistantState {
  return {
    completedAt: null,
    error: undefined,
    firstTokenTime: null,
    maxRetries: undefined,
    provenance: undefined,
    resultSeq: undefined,
    retry: undefined,
    retryDelayMs: undefined,
    startSeq: seq,
    startedAt: time,
    step,
    turn,
    usage: undefined,
  }
}

function addUsage(current: unknown, next: unknown): unknown {
  if (!record(next)) return current
  if (!record(current)) return next
  const combined: Record<string, unknown> = { ...current }
  for (const [key, value] of Object.entries(next)) {
    combined[key] = finiteUsage(current[key]) && finiteUsage(value) ? current[key] + value : value
  }
  return combined
}

function finiteUsage(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function assistantFallback(context: ConversationNodeContext<AssistantState>): AssistantState | undefined {
  let state: AssistantState | undefined
  for (const match of context.matches) {
    const event = match.event
    if (event.type === 'assistant/chunk') {
      state ??= initialAssistant(event.data.turn, event.data.step, event.seq, event.time)
      state = updateAssistant(state, match)
    } else if (event.type === 'assistant/message') {
      state ??= initialAssistant(event.data.turn, event.data.step, event.seq, event.time)
      state = updateAssistant(state, match)
    }
  }
  return state
}

function updateAssistant(state: AssistantState, match: ConversationMatch): AssistantState {
  const event = match.event
  if (event.type === 'assistant/chunk') {
    const chunk = event.data.chunk
    if (chunk.type === 'usage') return { ...state, usage: addUsage(state.usage, chunk.usage) }
    return tokenDelta(chunk) && state.firstTokenTime === null
      ? { ...state, firstTokenTime: event.time }
      : state
  }
  if (event.type === 'assistant/message') {
    return {
      ...state,
      completedAt: event.time,
      provenance: {
        model: event.data.message.source.model,
        provider: event.data.message.source.provider,
      },
      resultSeq: event.seq,
      usage: state.usage ?? event.data.usage,
    }
  }
  if (event.type === 'llm/retry') {
    return {
      ...state,
      completedAt: null,
      error: failureMessage(event.data.failure),
      maxRetries: event.data.mode === 'normal' ? event.data.maxRetries : undefined,
      retry: event.data.retry,
      retryDelayMs: event.data.delayMs,
    }
  }
  if (event.type === 'step/end' && state.completedAt === null) {
    return { ...state, completedAt: event.time, error: 'Step ended before a final assistant message.' }
  }
  return state
}

function assistantStatus(state: AssistantState): AssistantRequest['status'] {
  if (state.resultSeq !== undefined) return 'complete'
  if (state.error !== undefined) return 'error'
  return state.completedAt === null ? 'running' : 'complete'
}

function assistantRequest(state: AssistantState): AssistantRequest {
  return {
    completedAt: state.completedAt,
    ...state.error === undefined ? {} : { error: state.error },
    ...state.provenance === undefined ? {} : { provenance: state.provenance },
    purpose: 'assistant',
    ...state.maxRetries === undefined ? {} : { maxRetries: state.maxRetries },
    ...state.resultSeq === undefined ? {} : { resultSeq: state.resultSeq },
    ...state.retry === undefined ? {} : { retry: state.retry },
    ...state.retryDelayMs === undefined ? {} : { retryDelayMs: state.retryDelayMs },
    startSeq: state.startSeq,
    startedAt: state.startedAt,
    status: assistantStatus(state),
    step: state.step,
    turn: state.turn,
    ...state.usage === undefined ? {} : { usage: state.usage },
  }
}

export const tuiTrajectoryAssistantDefinition: ConversationNodeDefinition<AssistantState> = {
  kind: 'tui-trajectory-assistant-request',
  target: VIEW_TARGET,
  match: (event) => {
    if (event.type === 'step/start') return { id: stepKey(event.data.turn, event.data.step), role: 'start' }
    if (event.type === 'assistant/chunk'
      || event.type === 'assistant/message'
      || event.type === 'llm/retry'
      || event.type === 'step/end') {
      return { id: stepKey(event.data.turn, event.data.step), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'step/start') throw new Error('trajectory assistant request requires step/start')
    return initialAssistant(
      match.event.data.turn,
      match.event.data.step,
      match.event.seq,
      match.event.time,
    )
  },
  update: (context, match) => updateAssistant(context.state, match),
  publication: match => match.event.type === 'assistant/chunk' && match.event.data.chunk.type !== 'usage'
    ? 'animation-frame'
    : 'immediate',
  buildViewNode: context => {
    const state = context.state ?? assistantFallback(context)
    return state === undefined
      ? null
      : runtimeNode(context, state.startSeq, { kind: 'request', value: assistantRequest(state) })
  },
}

interface TurnEndState {
  readonly error: string | undefined
  readonly seq: number
  readonly time: number
  readonly turn: number
}

export const tuiTrajectoryTurnEndDefinition: ConversationNodeDefinition<TurnEndState> = {
  kind: 'tui-trajectory-turn-end',
  target: VIEW_TARGET,
  match: event => event.type === 'turn/end' ? { id: String(event.seq), role: 'start' } : null,
  start: (_context, match) => {
    if (match.event.type !== 'turn/end') throw new Error('trajectory turn end requires turn/end')
    const reason = match.event.data.reason
    return {
      error: reason.kind === 'error' ? failureMessage(reason.error) : undefined,
      seq: match.event.seq,
      time: match.event.time,
      turn: match.event.data.turn,
    }
  },
  update: context => context.state,
  buildViewNode: context => context.state === undefined
    ? null
    : runtimeNode(context, context.state.seq, {
      error: context.state.error,
      kind: 'turn-end',
      time: context.state.time,
      turn: context.state.turn,
    }),
}

interface DynamicEvent {
  readonly data: Readonly<Record<string, unknown>>
  readonly seq: number
  readonly time: number
  readonly type: string
}

interface CompactionState {
  readonly completedAt: number | null
  readonly error: string | undefined
  readonly maxTokens: number | undefined
  readonly model: string | undefined
  readonly provider: string | undefined
  readonly rawOutput: CompactionRequest['rawOutput'] | undefined
  readonly replacementSeq: number | undefined
  readonly resultSeq: number | undefined
  readonly startSeq: number
  readonly startedAt: number
  readonly summary: CompactionRequest['summary'] | undefined
  readonly turn: number | null
  readonly usage: unknown
}

function dynamicEvent(value: unknown): DynamicEvent | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const data: unknown = Reflect.get(value, 'data')
  const seq: unknown = Reflect.get(value, 'seq')
  const time: unknown = Reflect.get(value, 'time')
  const type: unknown = Reflect.get(value, 'type')
  return record(data)
    && typeof seq === 'number' && Number.isFinite(seq)
    && typeof time === 'number' && Number.isFinite(time)
    && typeof type === 'string'
    ? { data, seq, time, type }
    : undefined
}

interface SessionEndState {
  readonly seq: number
  readonly time: number
}

export const tuiTrajectorySessionEndDefinition: ConversationNodeDefinition<SessionEndState> = {
  kind: 'tui-trajectory-session-end',
  target: VIEW_TARGET,
  match: (event) => {
    const dynamic = dynamicEvent(event)
    return dynamic?.type === 'session/end-seed' ? { id: String(dynamic.seq), role: 'start' } : null
  },
  start: (_context, match) => {
    const event = dynamicEvent(match.event)
    if (event?.type !== 'session/end-seed') throw new Error('trajectory session end requires session/end-seed')
    return { seq: event.seq, time: event.time }
  },
  update: context => context.state,
  buildViewNode: context => context.state === undefined
    ? null
    : runtimeNode(context, context.state.seq, {
      kind: 'session-end',
      seq: context.state.seq,
      time: context.state.time,
    }),
}

function checkpointId(event: unknown): string | undefined {
  const dynamic = dynamicEvent(event)
  if (dynamic?.type !== 'user/message') return undefined
  const source = dynamic.data.source
  if (!record(source)) return undefined
  const kind = source.kind
  const plugin = source.plugin
  const compactionId = source.compactionId
  return kind === 'plugin' && plugin === COMPACTION_PLUGIN && typeof compactionId === 'string' && compactionId !== ''
    ? compactionId
    : undefined
}

function eventCompactionId(event: unknown): string | undefined {
  const dynamic = dynamicEvent(event)
  if (dynamic === undefined
    || (dynamic.type !== 'compaction/start'
      && dynamic.type !== 'compaction/summary'
      && dynamic.type !== 'compaction/end')) return undefined
  const value = dynamic.data.compactionId
  return typeof value === 'string' && value !== '' ? value : undefined
}

function contentBlocks(value: unknown): CompactionRequest['summary'] | undefined {
  // Session events already passed the host protocol boundary; retain source blocks after an array-shape check.
  return Array.isArray(value) ? value as CompactionRequest['summary'] : undefined
}

function initialCompaction(event: DynamicEvent): CompactionState {
  const turn = event.data.turn
  return {
    completedAt: null,
    error: undefined,
    maxTokens: undefined,
    model: undefined,
    provider: undefined,
    rawOutput: undefined,
    replacementSeq: undefined,
    resultSeq: undefined,
    startSeq: event.seq,
    startedAt: event.time,
    summary: undefined,
    turn: typeof turn === 'number' && Number.isFinite(turn) ? turn : null,
    usage: undefined,
  }
}

function updateCompaction(state: CompactionState, event: DynamicEvent): CompactionState {
  if (event.type === 'compaction/summary') {
    return {
      ...state,
      maxTokens: typeof event.data.maxTokens === 'number' ? event.data.maxTokens : undefined,
      model: typeof event.data.model === 'string' ? event.data.model : undefined,
      provider: typeof event.data.provider === 'string' ? event.data.provider : undefined,
      rawOutput: contentBlocks(event.data.rawOutput),
      resultSeq: event.seq,
      summary: contentBlocks(event.data.summary),
      usage: event.data.usage,
    }
  }
  if (event.type === 'compaction/end') {
    return {
      ...state,
      completedAt: event.time,
      error: typeof event.data.error === 'string' ? event.data.error : undefined,
    }
  }
  return checkpointId(event) === undefined ? state : { ...state, replacementSeq: event.seq }
}

function compactionRequest(state: CompactionState): CompactionRequest {
  const hasProvenance = state.provider !== undefined && state.model !== undefined
  return {
    completedAt: state.completedAt,
    ...state.error === undefined ? {} : { error: state.error },
    purpose: 'compaction',
    ...hasProvenance ? {
      provenance: { model: state.model ?? '', provider: state.provider ?? '' },
      requestConfig: {
        ...state.maxTokens === undefined ? {} : { maxTokens: state.maxTokens },
        model: state.model ?? '',
        provider: state.provider ?? '',
        purpose: 'compaction',
      },
    } : {},
    ...state.rawOutput === undefined ? {} : { rawOutput: state.rawOutput },
    ...state.replacementSeq === undefined ? {} : { replacementSeq: state.replacementSeq },
    ...state.resultSeq === undefined ? {} : { resultSeq: state.resultSeq },
    startSeq: state.startSeq,
    startedAt: state.startedAt,
    status: state.completedAt === null ? 'running' : state.error === undefined ? 'complete' : 'error',
    step: 0,
    ...state.summary === undefined ? {} : { summary: state.summary },
    turn: state.turn,
    ...state.usage === undefined ? {} : { usage: state.usage },
  }
}

export const tuiTrajectoryCompactionDefinition: ConversationNodeDefinition<CompactionState> = {
  kind: 'tui-trajectory-compaction-request',
  target: VIEW_TARGET,
  match: (event) => {
    const id = eventCompactionId(event)
    const dynamic = dynamicEvent(event)
    if (id !== undefined && dynamic !== undefined) {
      return { id, role: dynamic.type === 'compaction/start' ? 'start' : 'update' }
    }
    const checkpoint = checkpointId(event)
    return checkpoint === undefined ? null : { id: checkpoint, role: 'update' }
  },
  start: (_context, match) => {
    const event = dynamicEvent(match.event)
    if (event?.type !== 'compaction/start') throw new Error('trajectory compaction request requires compaction/start')
    return initialCompaction(event)
  },
  update: (context, match) => {
    const event = dynamicEvent(match.event)
    return event === undefined ? context.state : updateCompaction(context.state, event)
  },
  buildViewNode: context => context.state === undefined
    ? null
    : runtimeNode(context, context.state.startSeq, {
      kind: 'request',
      value: compactionRequest(context.state),
    }),
}

export function registerTuiTrajectoryRuntime(ctx: Context): void {
  ctx.conversationViews.register(tuiTrajectoryViewDefinition)
  ctx.conversationEvents.register(tuiTrajectoryHeaderDefinition)
  ctx.conversationEvents.register(tuiTrajectoryAssistantDefinition)
  ctx.conversationEvents.register(tuiTrajectoryTurnEndDefinition)
  ctx.conversationEvents.register(tuiTrajectoryCompactionDefinition)
  ctx.conversationEvents.register(tuiTrajectorySessionEndDefinition)
}
