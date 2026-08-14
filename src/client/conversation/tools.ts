import type {
  ConversationNodeContext,
  ConversationNodeDefinition,
  ConversationMatch,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ToolPresentation } from '../../features/tools/contracts.js'
import { projectToolPresentation } from '../../features/tools/presentation.js'
import {
  boundedJson,
  contentText,
  eventType,
  FALLBACK_PRIORITY,
  MAIN_PRIORITY,
  record,
  VIEW_TARGET,
  viewNode,
} from './shared.js'

const MAX_TOOL_DEPTH = 64

interface ToolItemState {
  readonly args: string
  readonly callId: string
  readonly callView: ToolCallView | undefined
  readonly errorCode: string | undefined
  readonly name: string
  readonly result: string | undefined
  readonly resultError: boolean
  readonly resultView: ToolResultView | undefined
}

interface ToolState {
  readonly children: ReadonlyMap<string, readonly ToolItemState[]>
  readonly parents: ReadonlyMap<string, string>
  readonly root: ToolItemState
}

interface ToolResultData {
  readonly error: boolean
  readonly errorCode: string | undefined
  readonly text: string
}

function toolResult(message: unknown, error: unknown): ToolResultData {
  const errorCode = record(error) && typeof error.code === 'string' ? error.code : undefined
  if (!record(message) || !Array.isArray(message.content)) {
    return { error: error !== undefined, errorCode, text: boundedJson(message) }
  }
  const block: unknown = message.content[0]
  if (!record(block)) return { error: error !== undefined, errorCode, text: boundedJson(block) }
  return {
    error: block.isError === true || error !== undefined,
    errorCode,
    text: contentText(block.content),
  }
}

function callView(match: ConversationMatch): ToolCallView | undefined {
  return match.view?.for === 'call' ? match.view.view : undefined
}

function resultView(match: ConversationMatch): ToolResultView | undefined {
  return match.view?.for === 'result' ? match.view.view : undefined
}

function rootCall(match: ConversationMatch): ToolItemState {
  if (match.event.type !== 'tool/call') throw new Error('tui tool call requires tool/call')
  return {
    args: match.event.data.arguments,
    callId: String(match.event.data.callId),
    callView: callView(match),
    errorCode: undefined,
    name: match.event.data.name,
    result: undefined,
    resultError: false,
    resultView: undefined,
  }
}

function acceptsEdge(state: ToolState, parent: string, child: string): boolean {
  if (parent === child || state.parents.has(child)) return false
  let cursor: string | undefined = parent
  let depth = 0
  while (cursor !== undefined) {
    if (cursor === child || depth >= MAX_TOOL_DEPTH) return false
    cursor = state.parents.get(cursor)
    depth++
  }
  return true
}

function dispatchData(match: ConversationMatch): Readonly<Record<string, unknown>> | undefined {
  const type = eventType(match.event)
  const data: unknown = match.event.data
  return (type === 'tool/code-dispatch-start' || type === 'tool/code-dispatch') && record(data)
    ? data
    : undefined
}

function dispatchItem(match: ConversationMatch, settled: boolean): ToolItemState | undefined {
  const data = dispatchData(match)
  if (data === undefined || typeof data.subCallId !== 'string' || typeof data.name !== 'string') return undefined
  return {
    args: boundedJson(data.arguments),
    callId: data.subCallId,
    callView: undefined,
    errorCode: undefined,
    name: data.name,
    result: settled ? contentText(data.content ?? []) : undefined,
    resultError: settled && data.isError === true,
    resultView: undefined,
  }
}

function updateDispatch(state: ToolState, match: ConversationMatch): ToolState {
  const data = dispatchData(match)
  if (data === undefined || typeof data.parentCallId !== 'string' || typeof data.subCallId !== 'string') return state
  const parentCallId = data.parentCallId
  const subCallId = data.subCallId
  const siblings = state.children.get(parentCallId) ?? []
  const existingIndex = siblings.findIndex(item => item.callId === subCallId)
  const settled = eventType(match.event) === 'tool/code-dispatch'
  const item = dispatchItem(match, settled)
  if (item === undefined) return state
  if (existingIndex < 0 && !acceptsEdge(state, parentCallId, subCallId)) return state
  if (!settled && existingIndex >= 0) return state
  const nextSiblings = existingIndex < 0
    ? [...siblings, item]
    : siblings.map((sibling, index) => index === existingIndex ? item : sibling)
  const children = new Map([...state.children, [parentCallId, nextSiblings] as const])
  const parents = new Map(state.parents)
  if (existingIndex < 0) parents.set(subCallId, parentCallId)
  return { ...state, children, parents }
}

function interruption(context: ConversationNodeContext<ToolState>): boolean {
  const location = context.start?.location
  if (location?.kind === 'step' && location.step.status === 'closed') return true
  return (location?.kind === 'step' || location?.kind === 'turn') && location.turn.status === 'closed'
}

function projectItem(
  item: ToolItemState,
  state: ToolState,
  interrupted: boolean,
  ancestors = new Set<string>(),
  depth = 0,
): ToolPresentation {
  const cyclic = ancestors.has(item.callId) || depth >= MAX_TOOL_DEPTH
  const nextAncestors = new Set([...ancestors, item.callId])
  const children = cyclic
    ? []
    : (state.children.get(item.callId) ?? []).map(child => projectItem(
        child,
        state,
        interrupted,
        nextAncestors,
        depth + 1,
      ))
  const stopped = interrupted && item.result === undefined
  return projectToolPresentation({
    args: item.args,
    callId: item.callId,
    callView: item.callView,
    children,
    errorCode: stopped ? 'interrupted' : item.errorCode,
    isError: stopped || item.resultError,
    name: item.name,
    result: stopped ? '' : item.result,
    resultView: item.resultView,
  })
}

export const toolDefinition: ConversationNodeDefinition<ToolState> = {
  kind: 'tui-tool-call',
  target: VIEW_TARGET,
  match: (event) => {
    if (event.type === 'tool/call') return { id: String(event.data.callId), role: 'start' }
    if (event.type === 'tool/result' && event.surfaceOp === 'append') {
      return { id: String(event.data.message.source.callId), role: 'update' }
    }
    if (eventType(event) === 'tool/code-dispatch-start' || eventType(event) === 'tool/code-dispatch') {
      const data: unknown = event.data
      const rootCallId = record(data) ? data.rootCallId : undefined
      return typeof rootCallId === 'string' && rootCallId !== ''
        ? { id: rootCallId, role: 'update' }
        : null
    }
    return null
  },
  start: (_context, match) => ({
    children: new Map(),
    parents: new Map(),
    root: rootCall(match),
  }),
  update: (context, match) => {
    if (match.event.type === 'tool/result') {
      const result = toolResult(match.event.data.message, match.event.data.error)
      return {
        ...context.state,
        root: {
          ...context.state.root,
          errorCode: result.errorCode,
          result: result.text,
          resultError: result.error,
          resultView: resultView(match),
        },
      }
    }
    return updateDispatch(context.state, match)
  },
  buildViewNode: (context) => {
    const state = context.state
    if (state === undefined) return null
    const tool = projectItem(state.root, state, interruption(context))
    return viewNode(
      context,
      context.start?.event.seq ?? 0,
      `tool:${state.root.callId}`,
      MAIN_PRIORITY,
      'tool',
      `${tool.title} · ${tool.state}\n${tool.summary}`,
      undefined,
      tool,
    )
  },
}

export const toolFallbackDefinition: ConversationNodeDefinition<{
  readonly callId: string
  readonly error: boolean
  readonly errorCode: string | undefined
  readonly resultView: ToolResultView | undefined
  readonly seq: number
  readonly text: string
}> = {
  kind: 'tui-tool-result',
  target: VIEW_TARGET,
  match: event => event.type === 'tool/result' && event.surfaceOp === 'append'
    ? { id: `${String(event.data.message.source.callId)}:${event.seq}`, role: 'start' }
    : null,
  start: (_context, match) => {
    if (match.event.type !== 'tool/result') throw new Error('tui tool result requires tool/result')
    const result = toolResult(match.event.data.message, match.event.data.error)
    return {
      callId: String(match.event.data.message.source.callId),
      error: result.error,
      errorCode: result.errorCode,
      resultView: resultView(match),
      seq: match.event.seq,
      text: result.text,
    }
  },
  update: context => context.state,
  buildViewNode: (context) => {
    const state = context.state
    if (state === undefined) return null
    const tool = projectToolPresentation({
      args: '',
      callId: state.callId,
      errorCode: state.errorCode,
      isError: state.error,
      name: state.callId,
      result: state.text,
      resultView: state.resultView,
    })
    return viewNode(
      context,
      state.seq,
      `tool:${state.callId}`,
      FALLBACK_PRIORITY,
      'tool',
      `${tool.title} · ${tool.state}\n${tool.summary}`,
      undefined,
      tool,
    )
  },
}
