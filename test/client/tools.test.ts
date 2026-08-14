import assert from 'node:assert/strict'
import { test } from 'vitest'
import type {
  ConversationMatch,
  ConversationNodeContext,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ToolEventView } from '@deepseek-ai/dsh-api-remotes/client'
import { toolDefinition } from '../../src/client/conversation/tools.js'

/* oxlint-disable typescript/no-unsafe-type-assertion -- Fixtures cross branded and open Harness event boundaries. */
const ROOT_CALL_ID = 'root-call'
const CHILD_CALL_ID = 'child-call'
const TURN = 1
const STEP = 1

type Event = Parameters<ConversationNodeDefinition['match']>[0]
type ToolState = ReturnType<typeof toolDefinition.start>

function match(event: Event, role: ConversationMatch['role'], view?: ToolEventView): ConversationMatch {
  return { event, role, view, location: { kind: 'unresolved' } }
}

function context(
  matches: readonly ConversationMatch[],
  state?: ToolState,
): ConversationNodeContext<ToolState> {
  return {
    key: '13:tui-tool-callroot-call',
    kind: toolDefinition.kind,
    id: ROOT_CALL_ID,
    matches,
    start: matches[0],
    state,
    current: new Map(),
  }
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null
}

function toolOf(node: ReturnType<NonNullable<typeof toolDefinition.buildViewNode>>): Readonly<Record<string, unknown>> {
  assert.notEqual(node, null)
  const data: unknown = node?.data
  if (!record(data)) throw new Error('missing TUI node data')
  const tool: unknown = data.tool
  if (!record(tool)) throw new Error('missing tool presentation')
  return tool
}

function toolCallEvent(): Event {
  return {
    type: 'tool/call',
    seq: 1,
    time: 1,
    data: { turn: TURN, step: STEP, callId: ROOT_CALL_ID, name: 'bash', arguments: '{"command":"pnpm test"}' },
  } as unknown as Event
}

test('carries host terminal presentation into the TUI tool snapshot', () => {
  const event = toolCallEvent()
  const start = match(event, 'start', {
    for: 'call',
    view: { card: 'terminal', title: 'pnpm test', cwd: '/workspace' },
  })
  const state = toolDefinition.start(context([start]), start, { previous: () => undefined })
  const projected = toolDefinition.buildViewNode?.(context([start], state)) ?? null
  const tool = toolOf(projected)

  assert.equal(tool.title, 'pnpm test')
  assert.equal(tool.state, 'running')
  assert.equal(typeof tool.details, 'string')
  if (typeof tool.details !== 'string') throw new Error('missing tool details')
  assert.match(tool.details, /\/workspace/u)
})

test('folds nested Code Mode dispatches under their root call', () => {
  const startEvent = toolCallEvent()
  const childStartEvent = {
    type: 'tool/code-dispatch-start',
    seq: 2,
    time: 2,
    data: {
      rootCallId: ROOT_CALL_ID,
      parentCallId: ROOT_CALL_ID,
      subCallId: CHILD_CALL_ID,
      name: 'read',
      arguments: { path: 'src/index.ts' },
    },
  } as unknown as Event
  const childDoneEvent = {
    type: 'tool/code-dispatch',
    seq: 3,
    time: 3,
    data: {
      rootCallId: ROOT_CALL_ID,
      parentCallId: ROOT_CALL_ID,
      subCallId: CHILD_CALL_ID,
      name: 'read',
      arguments: { path: 'src/index.ts' },
      content: [{ type: 'text', text: 'source' }],
      isError: false,
    },
  } as unknown as Event
  const start = match(startEvent, 'start')
  const childStart = match(childStartEvent, 'update')
  const childDone = match(childDoneEvent, 'update')
  const initial = toolDefinition.start(context([start]), start, { previous: () => undefined })
  const running = toolDefinition.update({ ...context([start, childStart], initial), state: initial }, childStart)
  const settled = toolDefinition.update({ ...context([start, childStart, childDone], running), state: running }, childDone)
  const projected = toolDefinition.buildViewNode?.(context([start, childStart, childDone], settled)) ?? null
  const tool = toolOf(projected)

  if (!Array.isArray(tool.children) || !record(tool.children[0])) throw new Error('missing child tool')
  const child = tool.children[0]
  assert.equal(tool.children.length, 1)
  assert.equal(child.callId, CHILD_CALL_ID)
  assert.equal(child.state, 'ok')
  assert.equal(typeof child.details, 'string')
  assert.match(typeof child.details === 'string' ? child.details : '', /source/u)
})

/* oxlint-enable typescript/no-unsafe-type-assertion */
