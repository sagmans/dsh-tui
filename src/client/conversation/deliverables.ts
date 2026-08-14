import type { ToolCallView } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ConversationMatch,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import { producedPaths } from '../../features/deliverables/projection.js'
import {
  MAIN_PRIORITY,
  record,
  VIEW_TARGET,
  viewNode,
} from './shared.js'

const TURN_TAIL_OFFSET = 0.5
const LINE_SEPARATOR = '\n'
const TURN_TAIL_TITLE = 'produced files'

interface ProducedPath {
  readonly path: string
  readonly seq: number
}

interface DeliverablesState {
  readonly calls: ReadonlyMap<string, ToolCallView | undefined>
  readonly closingSeq: number | undefined
  readonly closed: boolean
  readonly produced: readonly ProducedPath[]
  readonly turn: number
}

function callView(match: ConversationMatch): ToolCallView | undefined {
  return match.view?.for === 'call' ? match.view.view : undefined
}

function resultFailed(match: ConversationMatch): boolean {
  if (match.event.type !== 'tool/result') return true
  const message: unknown = match.event.data.message
  if (!record(message) || !Array.isArray(message.content)) return true
  const block: unknown = message.content[0]
  return !record(block) || block.isError === true || match.event.data.error !== undefined
}

function dedupedPaths(produced: readonly ProducedPath[], closingSeq: number): readonly string[] {
  const seen = new Set<string>()
  const paths: string[] = []
  for (const item of produced) {
    if (item.seq > closingSeq || seen.has(item.path)) continue
    seen.add(item.path)
    paths.push(item.path)
  }
  return paths
}

export const deliverablesDefinition: ConversationNodeDefinition<DeliverablesState> = {
  kind: 'tui-deliverables',
  target: VIEW_TARGET,
  match: (event) => {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (event.type === 'tool/call'
      || event.type === 'turn/end'
      || (event.type === 'assistant/message' && event.surfaceOp === 'append')
      || (event.type === 'tool/result' && event.surfaceOp === 'append')) {
      return { id: String(event.data.turn), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'turn/start') throw new Error('tui deliverables require turn/start')
    return {
      calls: new Map(),
      closingSeq: undefined,
      closed: false,
      produced: [],
      turn: match.event.data.turn,
    }
  },
  update: (context, match) => {
    if (match.event.type === 'tool/call') {
      const calls = new Map([
        ...context.state.calls,
        [String(match.event.data.callId), callView(match)] as const,
      ])
      return { ...context.state, calls }
    }
    if (match.event.type === 'tool/result') {
      if (resultFailed(match)) return context.state
      const callId = String(match.event.data.message.source.callId)
      const additions = producedPaths(context.state.calls.get(callId), false)
        .map(path => ({ path, seq: match.event.seq }))
      return additions.length === 0
        ? context.state
        : { ...context.state, produced: [...context.state.produced, ...additions] }
    }
    if (match.event.type === 'assistant/message') {
      return { ...context.state, closingSeq: match.event.seq }
    }
    if (match.event.type === 'turn/end') return { ...context.state, closed: true }
    return context.state
  },
  buildViewNode: (context) => {
    const state = context.state
    if (state === undefined || !state.closed || state.closingSeq === undefined) return null
    const paths = dedupedPaths(state.produced, state.closingSeq)
    if (paths.length === 0) return null
    const text = [TURN_TAIL_TITLE, ...paths.map(path => `\`${path}\``)].join(LINE_SEPARATOR)
    return viewNode(
      context,
      state.closingSeq + TURN_TAIL_OFFSET,
      `deliverables:${state.turn}`,
      MAIN_PRIORITY,
      'system',
      text,
    )
  },
}
