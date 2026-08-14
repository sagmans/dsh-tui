import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationLineKind } from '../../features/conversation/contracts.js'
import { imageFallback } from '../../features/attachments/presentation.js'
import {
  boundedJson,
  contentText,
  EMPTY_TEXT,
  FALLBACK_PRIORITY,
  MAIN_PRIORITY,
  numberField,
  record,
  sourceLabel,
  stringField,
  usageText,
  VIEW_TARGET,
  viewNode,
} from './shared.js'

const STREAMING_TEXT = '[streaming]'

export interface AssistantPart {
  readonly kind: 'other' | 'reasoning' | 'text' | 'tool'
  readonly text: string
}

export interface AssistantState {
  readonly blocks: ReadonlyMap<number, AssistantPart>
  readonly final: boolean
  readonly step: number
  readonly turn: number
  readonly usage: unknown
}

function initialAssistant(turn: number, step: number): AssistantState {
  return { blocks: new Map(), final: false, step, turn, usage: undefined }
}

function assistantPart(block: unknown): AssistantPart {
  if (!record(block)) return { kind: 'other', text: boundedJson(block) }
  switch (block.type) {
    case 'text': return { kind: 'text', text: typeof block.text === 'string' ? block.text : '' }
    case 'reasoning': return { kind: 'reasoning', text: typeof block.text === 'string' ? block.text : '' }
    case 'tool-call': return {
      kind: 'tool',
      text: `${typeof block.name === 'string' ? block.name : 'unknown'}: ${typeof block.arguments === 'string' ? block.arguments : ''}`,
    }
    case 'image': return { kind: 'other', text: imageFallback(block.attachment) }
    default: return { kind: 'other', text: boundedJson(block) }
  }
}

function assistantContent(content: unknown): ReadonlyMap<number, AssistantPart> {
  if (!Array.isArray(content)) return new Map()
  return new Map(content.map((block, index) => [index, assistantPart(block)]))
}

function updateAssistantChunk(state: AssistantState, chunk: unknown): AssistantState {
  if (!record(chunk) || typeof chunk.type !== 'string') return state
  if (chunk.type === 'usage') return { ...state, usage: chunk.usage }
  const index = numberField(chunk, 'index')
  if (index === undefined) return state
  const blocks = new Map(state.blocks)
  const previous = blocks.get(index)
  switch (chunk.type) {
    case 'block-start': {
      const blockType = stringField(chunk, 'blockType')
      const kind = blockType === 'reasoning' ? 'reasoning' : blockType === 'tool-call' ? 'tool' : 'text'
      blocks.set(index, { kind, text: '' })
      break
    }
    case 'text-delta':
      blocks.set(index, { kind: 'text', text: `${previous?.kind === 'text' ? previous.text : ''}${stringField(chunk, 'text') ?? ''}` })
      break
    case 'reasoning-delta':
      blocks.set(index, { kind: 'reasoning', text: `${previous?.kind === 'reasoning' ? previous.text : ''}${stringField(chunk, 'text') ?? ''}` })
      break
    case 'tool-call-delta': {
      const previousName = previous?.kind === 'tool' ? previous.text.split(':', 1)[0] : 'tool'
      const previousArgs = previous?.kind === 'tool' ? previous.text.split(': ').slice(1).join(': ') : ''
      blocks.set(index, {
        kind: 'tool',
        text: `${stringField(chunk, 'name') ?? previousName}: ${previousArgs}${stringField(chunk, 'argumentsDelta') ?? ''}`,
      })
      break
    }
    case 'block-end':
      blocks.set(index, assistantPart(chunk.block))
      break
    default: return state
  }
  return { ...state, blocks }
}

function assistantText(state: AssistantState): string {
  const body = [...state.blocks.entries()]
    .toSorted(([left], [right]) => left - right)
    .map(([, block]) => block.kind === 'reasoning' ? `thinking: ${block.text}` : block.kind === 'tool' ? `tool ${block.text}` : block.text)
    .filter(text => text.trim() !== '')
    .join('\n')
  const output = body === '' ? EMPTY_TEXT : body
  return `${output}${usageText(state.usage)}${state.final ? '' : `\n${STREAMING_TEXT}`}`
}

export const messageDefinition: ConversationNodeDefinition<{
  readonly content: unknown
  readonly kind: ConversationLineKind
  readonly label: string
  readonly seq: number
}> = {
  kind: 'tui-input-message',
  target: VIEW_TARGET,
  match: event => event.type === 'user/message' && event.surfaceOp === 'append'
    ? { id: String(event.data.id), role: 'start' }
    : null,
  start: (_context, match) => {
    if (match.event.type !== 'user/message') throw new Error('tui input message requires user/message')
    const label = sourceLabel(match.event.data.source)
    return {
      content: match.event.data.content,
      kind: label === 'user' ? 'user' : 'context',
      label,
      seq: match.event.seq,
    }
  },
  update: context => context.state,
  buildViewNode: (context) => {
    const state = context.state
    if (state === undefined) return null
    const prefix = state.kind === 'context' ? `${state.label}: ` : ''
    return viewNode(context, state.seq, `message:${context.id}`, MAIN_PRIORITY, state.kind, `${prefix}${contentText(state.content)}`)
  },
}

export const assistantDefinition: ConversationNodeDefinition<AssistantState> = {
  kind: 'tui-assistant-step',
  target: VIEW_TARGET,
  match: (event) => {
    if (event.type === 'step/start') return { id: `${event.data.turn}:${event.data.step}`, role: 'start' }
    if (event.type === 'assistant/chunk'
      || (event.type === 'assistant/message' && event.surfaceOp === 'append')) {
      return { id: `${event.data.turn}:${event.data.step}`, role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'step/start') throw new Error('tui assistant step requires step/start')
    return initialAssistant(match.event.data.turn, match.event.data.step)
  },
  update: (context, match) => {
    if (match.event.type === 'assistant/chunk') return updateAssistantChunk(context.state, match.event.data.chunk)
    if (match.event.type === 'assistant/message') {
      return {
        ...context.state,
        blocks: assistantContent(match.event.data.message.content),
        final: true,
        usage: match.event.data.usage,
      }
    }
    return context.state
  },
  publication: match => match.event.type === 'assistant/chunk' ? 'animation-frame' : 'immediate',
  buildViewNode: (context) => {
    const state = context.state
    if (state === undefined || (state.blocks.size === 0 && !state.final)) return null
    const seq = context.matches.findLast(match => match.event.type === 'assistant/message')?.event.seq
      ?? context.matches.find(match => match.event.type === 'assistant/chunk')?.event.seq
      ?? context.start?.event.seq
      ?? 0
    return viewNode(context, seq, `assistant:${state.turn}:${state.step}`, MAIN_PRIORITY, 'assistant', assistantText(state))
  },
}

export const assistantFallbackDefinition: ConversationNodeDefinition<{
  readonly seq: number
  readonly state: AssistantState
}> = {
  kind: 'tui-assistant-final',
  target: VIEW_TARGET,
  match: event => event.type === 'assistant/message' && event.surfaceOp === 'append'
    ? { id: `${event.data.turn}:${event.data.step}:${event.seq}`, role: 'start' }
    : null,
  start: (_context, match) => {
    if (match.event.type !== 'assistant/message') throw new Error('tui assistant final requires assistant/message')
    return {
      seq: match.event.seq,
      state: {
        blocks: assistantContent(match.event.data.message.content),
        final: true,
        step: match.event.data.step,
        turn: match.event.data.turn,
        usage: match.event.data.usage,
      },
    }
  },
  update: context => context.state,
  buildViewNode: (context) => {
    const state = context.state
    return state === undefined
      ? null
      : viewNode(
          context,
          state.seq,
          `assistant:${state.state.turn}:${state.state.step}`,
          FALLBACK_PRIORITY,
          'assistant',
          assistantText(state.state),
        )
  },
}
