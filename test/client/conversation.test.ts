import assert from 'node:assert/strict'
import { test } from 'vitest'
import type {
  ConversationMatch,
  ConversationNodeContext,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  assistantDefinition,
  type AssistantState,
} from '../../src/client/conversation/messages.js'
import {
  contentText,
  tuiConversationViewDefinition,
  type TuiConversationViewNode,
} from '../../src/client/conversation/shared.js'

const TURN = 1
const STEP = 1
const START_SEQ = 1
const CHUNK_SEQ = 2
const START_TIME = 10
const CHUNK_TIME = 20
const TARGET = 'tui'

type Event = Parameters<ConversationNodeDefinition['match']>[0]

function match(event: Event, role: ConversationMatch['role']): ConversationMatch {
  return { event, role, view: undefined, location: { kind: 'unresolved' } }
}

function context<State>(
  matches: readonly ConversationMatch[],
  state?: State,
): ConversationNodeContext<State> {
  return {
    key: '18:tui-assistant-step1:1',
    kind: assistantDefinition.kind,
    id: `${TURN}:${STEP}`,
    matches,
    start: matches[0],
    state,
    current: new Map(),
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null
}

function lineText(node: ReturnType<NonNullable<typeof assistantDefinition.buildViewNode>>): string {
  assert.notEqual(node, null)
  const data: unknown = node?.data
  assert.equal(isRecord(data), true)
  const line: unknown = isRecord(data) ? data.line : undefined
  assert.equal(isRecord(line), true)
  const text: unknown = isRecord(line) ? line.text : undefined
  assert.equal(typeof text, 'string')
  return typeof text === 'string' ? text : ''
}

function viewNode(
  key: string,
  logicalKey: string,
  anchorSeq: number,
  priority: number,
  text: string,
  latestGroup?: string,
): TuiConversationViewNode {
  return {
    key,
    kind: 'fixture',
    id: key,
    target: TARGET,
    data: {
      anchorSeq,
      logicalKey,
      priority,
      line: { key: logicalKey, kind: 'system', text },
      ...latestGroup === undefined ? {} : { latestGroup },
    },
  }
}

test('renders image metadata without embedding binary data or local paths', () => {
  const text = contentText([{
    type: 'image',
    attachment: {
      attachmentId: 'sha256:fixture',
      mediaType: 'image/png',
      bytes: 4_096,
      width: 800,
      height: 600,
      name: 'screen.png',
      data: 'never-render',
      path: '/private/screen.png',
    },
  }])

  assert.equal(text, '[image screen.png · 800×600 · 4 KiB · image/png]')
  assert.equal(text.includes('never-render'), false)
  assert.equal(text.includes('/private'), false)
})

test('projects assistant chunks at animation-frame cadence', () => {
  const startEvent: Event = {
    type: 'step/start',
    seq: START_SEQ,
    time: START_TIME,
    data: { turn: TURN, step: STEP },
  }
  const chunkEvent: Event = {
    type: 'assistant/chunk',
    seq: CHUNK_SEQ,
    time: CHUNK_TIME,
    data: { turn: TURN, step: STEP, chunk: { type: 'text-delta', index: 0, text: 'Hello' } },
  }
  const start = match(startEvent, 'start')
  const update = match(chunkEvent, 'update')
  const initial = assistantDefinition.start(context<AssistantState>([start]), start, { previous: () => undefined })
  const state = assistantDefinition.update({ ...context([start, update], initial), state: initial }, update)
  const projected = assistantDefinition.buildViewNode?.(context([start, update], state)) ?? null

  assert.equal(assistantDefinition.match(startEvent)?.role, 'start')
  assert.equal(assistantDefinition.match(chunkEvent)?.role, 'update')
  assert.equal(assistantDefinition.publication?.(update), 'animation-frame')
  assert.equal(lineText(projected), 'Hello\n[streaming]')
})

test('deduplicates correlated fallbacks and retains only latest state rows', () => {
  const builder = tuiConversationViewDefinition.create()
  const snapshot = builder.replace({
    nodes: [
      viewNode('fallback', 'assistant:1:1', CHUNK_SEQ, 2, 'fallback'),
      viewNode('main', 'assistant:1:1', START_SEQ, 3, 'main'),
      viewNode('todo-old', 'todos', 3, 1, 'old todos', 'todos'),
      viewNode('todo-new', 'todos', 4, 1, 'new todos', 'todos'),
    ],
    timeline: { turnOrder: [], turns: new Map() },
  })

  assert.deepEqual(snapshot.lines.map(line => line.text), ['main', 'new todos'])
})
