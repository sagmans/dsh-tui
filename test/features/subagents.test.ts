import assert from 'node:assert/strict'
import { test } from 'vitest'
import type {
  MessageId,
  PromptContentPart,
  SessionId,
  SubagentAddress,
} from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ChatSnapshot,
  ConversationSnapshot,
  ConversationViewSnapshotStore,
  ObservableSnapshot,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  createConversationController,
  type ConversationSendMode,
  type ConversationSessionBinding,
  type ConversationSubagentListState,
} from '../../src/features/conversation/model.js'
import { projectSubagentCatalog } from '../../src/features/conversation/subagents.js'

const PROJECTION_NOW = 4_000
// Static fixture identities cross only Harness brand boundaries.
/* oxlint-disable typescript/no-unsafe-type-assertion */
const ROOT = 'session-root' as SessionId
const CHILD = 'session-child' as SessionId
const GRANDCHILD = 'session-grandchild' as SessionId
const FORK = 'session-fork' as SessionId
const FORK_CHILD = 'session-fork-child' as SessionId
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

function listState(): ConversationSubagentListState {
  return {
    current: ROOT,
    byId: {
      [ROOT]: { id: ROOT, displayTitle: 'Root', running: false },
      [CHILD]: {
        id: CHILD,
        displayTitle: 'Worker transcript',
        title: 'Build index',
        origin: 'subagent',
        parentId: ROOT,
        running: true,
        projectionValues: {
          tokenUsage: {
            cacheReadTokens: 3,
            cacheWriteTokens: 4,
            outputTokens: 2,
            uncachedInputTokens: 1,
          },
          subagentTiming: {
            settledMs: 1_000,
            active: { since: 2_000, through: 2_500 },
          },
        },
      },
      [GRANDCHILD]: {
        id: GRANDCHILD,
        displayTitle: 'Nested transcript',
        origin: 'subagent',
        parentId: CHILD,
        running: false,
      },
      [FORK]: { id: FORK, displayTitle: 'Ordinary fork', parentId: ROOT, running: false },
      [FORK_CHILD]: {
        id: FORK_CHILD,
        displayTitle: 'Fork worker',
        origin: 'subagent',
        parentId: FORK,
        running: true,
      },
    },
    subagentsByParent: {
      [ROOT]: {
        entries: [{
          kind: 'child',
          id: CHILD,
          mode: 'continuable',
          label: 'worker',
          activity: 'running',
          hasChildren: true,
        }],
        parentAvailable: true,
        state: 'ready',
        error: null,
      },
      [CHILD]: {
        entries: [{
          kind: 'child',
          id: GRANDCHILD,
          mode: 'one-shot',
          activity: 'inactive',
          hasChildren: false,
        }],
        parentAvailable: true,
        state: 'ready',
        error: null,
      },
    },
  }
}

function conversationSnapshot(
  subagent: ConversationSnapshot['subagent'] = null,
  running = false,
): ConversationSnapshot {
  return {
    sessionId: subagent?.address.childSessionId ?? ROOT,
    views: EMPTY_VIEWS,
    chat: EMPTY_CHAT,
    nodes: [],
    turnTimings: new Map(),
    turnEnds: new Map(),
    partial: null,
    runningCalls: [],
    pending: [],
    queue: [{
      id: QUEUE_ID,
      messageId: QUEUE_ID,
      placement: 'queued',
      content: [{ type: 'text', text: 'Queued' }],
      preview: 'Queued',
      text: 'Queued',
    }],
    running,
    subagent,
    composerPhase: 'active',
    removed: false,
    openState: 'open',
    openError: null,
    hasMore: false,
    loadingOlder: false,
    promptError: null,
    blank: false,
    lastAgentError: null,
  }
}

function addressed(mode: SubagentAddress['mode'], parentAvailable: boolean): ConversationSnapshot['subagent'] {
  return {
    address: { parentSessionId: ROOT, childSessionId: CHILD, mode },
    parentAvailable,
  }
}

function controllerFixture(): {
  readonly binding: MutableSource<ConversationSnapshot> & ConversationSessionBinding
  readonly cancels: number[]
  readonly controller: ReturnType<typeof createConversationController>
  readonly opened: SubagentAddress[]
  readonly prompts: Array<{ readonly content: readonly PromptContentPart[]; readonly mode: ConversationSendMode }>
  readonly visibility: Array<{ readonly open: boolean; readonly parentSessionId: SessionId }>
} {
  const bindingSource = source(conversationSnapshot())
  const cancels: number[] = []
  const opened: SubagentAddress[] = []
  const prompts: Array<{ readonly content: readonly PromptContentPart[]; readonly mode: ConversationSendMode }> = []
  const visibility: Array<{ readonly open: boolean; readonly parentSessionId: SessionId }> = []
  const binding: MutableSource<ConversationSnapshot> & ConversationSessionBinding = {
    ...bindingSource,
    cancel: () => { cancels.push(1); return Promise.resolve() },
    command: () => Promise.resolve(false),
    loadOlder: () => Promise.resolve(),
    projection: () => source(undefined),
    prompt: (content, mode) => { prompts.push({ content, mode }); return Promise.resolve() },
    updateQueue: () => Promise.resolve({ ok: true, value: { accepted: true } }),
  }
  const subagentList = source(listState())
  return {
    binding,
    cancels,
    opened,
    prompts,
    visibility,
    controller: createConversationController({
      sessions: {
        list: source({ current: ROOT, byId: { [ROOT]: { displayTitle: 'Root' } } }),
        binding: () => binding,
      },
      subagents: {
        list: subagentList,
        open: address => { opened.push(address) },
        refresh: () => Promise.resolve(),
        setOpen: (parentSessionId, open) => { visibility.push({ open, parentSessionId }) },
      },
    }),
  }
}

test('projects recursive direct catalogs with descendant activity, usage, and timing', () => {
  const projected = projectSubagentCatalog(listState(), ROOT, {
    activeRowKey: undefined,
    expanded: new Set([CHILD]),
    now: PROJECTION_NOW,
    open: true,
  })

  assert.equal(projected?.count, 2)
  assert.equal(projected?.runningCount, 1)
  assert.deepEqual(projected?.rows.filter(row => row.kind === 'child').map(row => ({
    depth: row.depth,
    label: row.label,
    mode: row.mode,
    parentSessionId: row.parentSessionId,
    summary: row.summary,
  })), [
    {
      depth: 0,
      label: 'worker',
      mode: 'continuable',
      parentSessionId: ROOT,
      summary: 'Build index · continuable · running · 10 tok · 3s',
    },
    {
      depth: 1,
      label: String(GRANDCHILD),
      mode: 'one-shot',
      parentSessionId: CHILD,
      summary: 'one-shot · inactive',
    },
  ])
})

test('opens nested rows through their exact direct-parent address and tracks visible catalogs', () => {
  const { controller, opened, visibility } = controllerFixture()

  controller.toggleSubagents()
  const rootRow = controller.getSnapshot().subagents?.rows.find(row => row.sessionId === CHILD)
  assert.ok(rootRow)
  controller.toggleSubagentBranch(rootRow.key)
  const nested = controller.getSnapshot().subagents?.rows.find(row => row.sessionId === GRANDCHILD)
  assert.ok(nested)
  controller.selectSubagent(nested.key)
  assert.equal(controller.activateSubagent(), true)

  assert.deepEqual(opened, [{
    parentSessionId: CHILD,
    childSessionId: GRANDCHILD,
    mode: 'one-shot',
  }])
  assert.deepEqual(visibility, [
    { parentSessionId: ROOT, open: true },
    { parentSessionId: CHILD, open: true },
    { parentSessionId: ROOT, open: false },
    { parentSessionId: CHILD, open: false },
  ])
})

test('enforces one-shot and unavailable-parent composer ownership', async () => {
  const { binding, cancels, controller, prompts } = controllerFixture()

  binding.publish(conversationSnapshot(addressed('one-shot', true), true))
  assert.deepEqual(controller.getSnapshot().subagent, {
    attachmentEnabled: false,
    inputEnabled: false,
    mode: 'one-shot',
    parentAvailable: true,
    readOnlyReason: 'one-shot',
    sendEnabled: false,
    stopEnabled: false,
  })
  assert.equal(await controller.send('blocked'), false)
  await controller.cancel()
  assert.deepEqual(cancels, [])

  binding.publish(conversationSnapshot(addressed('continuable', false), true))
  assert.equal(controller.getSnapshot().subagent?.readOnlyReason, undefined)
  assert.equal(controller.getSnapshot().subagent?.inputEnabled, false)
  assert.equal(controller.getSnapshot().subagent?.stopEnabled, true)
  await controller.cancel()
  assert.deepEqual(cancels, [1])

  binding.publish(conversationSnapshot(addressed('continuable', false), false))
  assert.equal(controller.getSnapshot().subagent?.readOnlyReason, 'parent-unavailable')

  binding.publish(conversationSnapshot(addressed('continuable', true), true))
  assert.equal(controller.getSnapshot().subagent?.inputEnabled, true)
  assert.equal(await controller.send('follow up'), true)
  assert.deepEqual(prompts, [{ content: [{ type: 'text', text: 'follow up' }], mode: 'queue' }])
})
