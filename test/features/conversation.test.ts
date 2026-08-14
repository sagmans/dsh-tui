import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { MessageId, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ChatSnapshot,
  ConversationNode,
  ConversationSnapshot,
  ConversationViewSnapshotStore,
  ObservableSnapshot,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  createConversationController,
  type ConversationControllerOptions,
  type ConversationSendMode,
  type ConversationSessionBinding,
} from '../../src/features/conversation/model.js'

// Static fixture identities cross only Harness brand boundaries.
/* oxlint-disable typescript/no-unsafe-type-assertion */
const SESSION_ID = 'session-one' as SessionId
const QUEUE_ID = 'queue-one' as MessageId
/* oxlint-enable typescript/no-unsafe-type-assertion */
const EMPTY_VIEWS: ConversationViewSnapshotStore = { get: () => undefined }
const EMPTY_CHAT: ChatSnapshot = {
  order: [],
  nodes: { get: () => undefined, values: () => [] },
  locations: { getTurn: () => [], getStep: () => [] },
  timeline: { turnOrder: [], turns: new Map() },
  legacy: { nodes: [], turnTimings: new Map(), turnEnds: new Map(), partial: null, runningCalls: [] },
}

interface MutableSource<T> extends ObservableSnapshot<T> {
  publish(next: T): void
}

interface Control {
  readonly cancels: number[]
  readonly commands: string[]
  readonly historyLoads: number[]
  readonly prompts: Array<{ readonly mode: ConversationSendMode; readonly text: string }>
}

function source<T>(initial: T): MutableSource<T> {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => current,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    publish(next) {
      current = next
      for (const listener of listeners) listener()
    },
  }
}

function userNode(text: string, seq = 1): ConversationNode {
  return {
    kind: 'user',
    seq,
    time: seq,
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

function assistantNode(text: string): ConversationNode {
  return {
    kind: 'assistant',
    seq: 2,
    time: 2,
    turn: 1,
    step: 1,
    blocks: [
      { kind: 'reasoning', text: 'inspect contracts' },
      { kind: 'text', text },
    ],
  }
}

function snapshot(overrides: Partial<ConversationSnapshot> = {}): ConversationSnapshot {
  return {
    sessionId: SESSION_ID,
    views: EMPTY_VIEWS,
    chat: EMPTY_CHAT,
    nodes: [userNode('Build TUI'), assistantNode('Ready')],
    turnTimings: new Map(),
    turnEnds: new Map(),
    partial: null,
    runningCalls: [],
    pending: [],
    queue: [],
    running: false,
    subagent: null,
    composerPhase: 'active',
    removed: false,
    openState: 'open',
    openError: null,
    hasMore: true,
    loadingOlder: false,
    promptError: null,
    blank: false,
    lastAgentError: null,
    ...overrides,
  }
}

function fixture(options: Pick<ConversationControllerOptions, 'completion'> = {}): {
  readonly binding: MutableSource<ConversationSnapshot> & ConversationSessionBinding
  readonly control: Control
  readonly controller: ReturnType<typeof createConversationController>
} {
  const control: Control = { cancels: [], commands: [], historyLoads: [], prompts: [] }
  const session = source(snapshot())
  const binding: MutableSource<ConversationSnapshot> & ConversationSessionBinding = {
    ...session,
    cancel: () => { control.cancels.push(1); return Promise.resolve() },
    command: (line) => { control.commands.push(line); return Promise.resolve(line === '/compact') },
    loadOlder: () => { control.historyLoads.push(1); return Promise.resolve() },
    prompt: (text, mode) => {
      control.prompts.push({ text, mode })
      return text === 'fail' ? Promise.reject(new Error('send unavailable')) : Promise.resolve()
    },
  }
  const list = source({
    current: SESSION_ID,
    byId: { [SESSION_ID]: { displayTitle: 'Terminal session' } },
  })
  return {
    binding,
    control,
    controller: createConversationController({ ...options, sessions: { list, binding: id => id === SESSION_ID ? binding : undefined } }),
  }
}

test('projects durable, streaming, and queued conversation state', () => {
  const { binding, controller } = fixture()
  binding.publish(snapshot({
    running: true,
    partial: { turn: 2, step: 1, blocks: [{ kind: 'text', text: 'Streaming' }] },
    queue: [{
      id: QUEUE_ID,
      messageId: QUEUE_ID,
      placement: 'queued',
      content: [{ type: 'text', text: 'Next task' }],
      preview: 'Next task',
      text: 'Next task',
    }],
  }))

  const view = controller.getSnapshot()

  assert.equal(view.title, 'Terminal session')
  assert.equal(view.phase, 'ready')
  assert.equal(view.hasMore, true)
  assert.deepEqual(view.lines.map(line => [line.kind, line.text]), [
    ['user', 'Build TUI'],
    ['assistant', 'thinking: inspect contracts\nReady'],
    ['assistant', 'Streaming\n[streaming]'],
    ['user', 'queued: Next task'],
  ])
})

test('routes commands before skill prompts and preserves failed drafts', async () => {
  const { control, controller } = fixture()

  assert.equal(await controller.send('  hello  '), true)
  assert.equal(await controller.send('/compact'), true)
  assert.equal(await controller.send('/skill', 'steer'), true)
  assert.equal(await controller.send('fail'), false)

  assert.deepEqual(control.commands, ['/compact', '/skill'])
  assert.deepEqual(control.prompts, [
    { text: 'hello', mode: 'queue' },
    { text: '/skill', mode: 'steer' },
    { text: 'fail', mode: 'queue' },
  ])
  assert.equal(controller.getSnapshot().error, 'send unavailable')
  assert.equal(controller.getSnapshot().draft, 'fail')

  await controller.cancel()
  await controller.loadOlder()
  assert.deepEqual(control.cancels, [1])
  assert.deepEqual(control.historyLoads, [1])
})

test('completes command and skill names through the injected catalog', async () => {
  const { controller } = fixture({
    completion: { complete: (_sessionId, query) => Promise.resolve(query === 'com' ? ['commit', 'compact'] : []) },
  })
  controller.setDraft('/com')

  await controller.complete()

  assert.equal(controller.getSnapshot().draft, '/commit ')
  assert.deepEqual(controller.getSnapshot().suggestions, ['commit', 'compact'])
})

test('coalesces live updates and keeps bounded history windows', async () => {
  const { binding, controller } = fixture()
  let notifications = 0
  controller.subscribe(() => { notifications += 1 })
  controller.scroll(-1)
  binding.publish(snapshot({
    running: true,
    nodes: Array.from({ length: 300 }, (_, index) => userNode(`line ${index}`, index + 1)),
  }))

  await Promise.resolve()

  assert.equal(notifications, 1)
  assert.equal(controller.getSnapshot().running, true)
  assert.equal(controller.getSnapshot().lines.length, 240)
  assert.equal(controller.scrollOffset(), 12)
})
