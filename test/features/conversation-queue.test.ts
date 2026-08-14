import assert from 'node:assert/strict'
import { test } from 'vitest'
import type {
  MessageId,
  PromptContentPart,
  QueueAction,
  RpcResult,
  SessionId,
} from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ChatSnapshot,
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
const SESSION_ID = 'queue-session' as SessionId
const FIRST_ID = 'queue-first' as MessageId
const SECOND_ID = 'queue-second' as MessageId
const STEERING_ID = 'queue-steering' as MessageId
const IMAGE_ATTACHMENT_ID = 'image' as never
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
  readonly prompts: Array<{ readonly content: readonly PromptContentPart[]; readonly mode: ConversationSendMode }>
  readonly updates: Array<{ readonly action: QueueAction; readonly id: MessageId }>
}

function settle(): Promise<void> {
  return Promise.resolve().then(() => Promise.resolve())
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

function queueSnapshot(overrides: Partial<ConversationSnapshot> = {}): ConversationSnapshot {
  return {
    sessionId: SESSION_ID,
    views: EMPTY_VIEWS,
    chat: EMPTY_CHAT,
    nodes: [],
    turnTimings: new Map(),
    turnEnds: new Map(),
    partial: null,
    runningCalls: [],
    pending: [],
    queue: [
      {
        id: FIRST_ID,
        messageId: FIRST_ID,
        placement: 'queued',
        content: [{ type: 'text', text: 'First queued prompt' }],
        preview: 'First queued prompt',
        text: 'First queued prompt',
      },
      {
        id: SECOND_ID,
        messageId: SECOND_ID,
        placement: 'queued',
        content: [{
          type: 'image',
          attachment: {
            attachmentId: IMAGE_ATTACHMENT_ID,
            bytes: 1,
            height: 1,
            mediaType: 'image/png',
            width: 1,
          },
        }],
        preview: '[image]',
        text: null,
      },
      {
        id: STEERING_ID,
        messageId: STEERING_ID,
        placement: 'steering',
        content: [{ type: 'text', text: 'Already steering' }],
        preview: 'Already steering',
        text: 'Already steering',
      },
    ],
    running: true,
    subagent: null,
    composerPhase: 'active',
    removed: false,
    openState: 'open',
    openError: null,
    hasMore: false,
    loadingOlder: false,
    promptError: null,
    blank: false,
    lastAgentError: null,
    ...overrides,
  }
}

function accepted(): RpcResult<{ accepted: true }> {
  return { ok: true, value: { accepted: true } }
}

function rejected(code: 'internal' | 'queue-item-not-found'): RpcResult<{ accepted: true }> {
  switch (code) {
    case 'internal': return { ok: false, error: { code, details: {}, message: code } }
    case 'queue-item-not-found': return {
      ok: false,
      error: { code, details: { itemId: SECOND_ID }, message: code },
    }
    default: {
      const exhaustive: never = code
      throw new Error(`unhandled queue fixture error: ${String(exhaustive)}`)
    }
  }
}

function fixture(input: {
  readonly preferences?: ConversationControllerOptions['preferences']
  readonly update?: (id: MessageId, action: QueueAction) => Promise<RpcResult<{ accepted: true }>>
} = {}) {
  const control: Control = { prompts: [], updates: [] }
  const session = source(queueSnapshot())
  const binding: MutableSource<ConversationSnapshot> & ConversationSessionBinding = {
    ...session,
    cancel: () => Promise.resolve(),
    command: () => Promise.resolve(false),
    loadOlder: () => Promise.resolve(),
    projection: () => source(undefined),
    prompt: (content, mode) => {
      control.prompts.push({ content, mode })
      return Promise.resolve()
    },
    updateQueue: (id, action) => {
      control.updates.push({ action, id })
      return input.update?.(id, action) ?? Promise.resolve(accepted())
    },
  }
  const controller = createConversationController({
    preferences: input.preferences,
    sessions: {
      list: source({ current: SESSION_ID, byId: { [SESSION_ID]: { displayTitle: 'Queue session' } } }),
      binding: () => binding,
    },
  })
  return { binding, control, controller }
}

test('edits, removes, and strict-steers exact queue occurrences', async () => {
  const { control, controller } = fixture()
  controller.beginQueueEdit(FIRST_ID)
  assert.deepEqual(controller.getSnapshot().input, {
    kind: 'queue-edit',
    placeholder: 'Queued prompt text',
    title: 'EDIT QUEUED PROMPT',
    value: 'First queued prompt',
  })
  controller.setInput('Revised queued prompt')

  assert.equal(await controller.submitInput(), true)
  assert.equal(await controller.removeQueue(SECOND_ID), true)
  assert.equal(await controller.steerQueue(FIRST_ID), true)

  assert.deepEqual(control.updates, [
    {
      action: { kind: 'edit', content: [{ type: 'text', text: 'Revised queued prompt' }] },
      id: FIRST_ID,
    },
    { action: { kind: 'remove' }, id: SECOND_ID },
    { action: { kind: 'steer' }, id: FIRST_ID },
  ])
  assert.equal(controller.getSnapshot().input, undefined)
})

test('closes an edit when its exact queue occurrence disappears', async () => {
  const { binding, controller } = fixture()
  controller.beginQueueEdit(FIRST_ID)

  binding.publish(queueSnapshot({ queue: [] }))
  await settle()

  assert.equal(controller.getSnapshot().input, undefined)
})

test('strict-steers the whole queue in FIFO order and converges stale rows', async () => {
  const { control, controller } = fixture({
    update: id => Promise.resolve(id === SECOND_ID ? rejected('queue-item-not-found') : accepted()),
  })

  assert.equal(await controller.steerQueueAll(), true)

  assert.deepEqual(control.updates.map(update => update.id), [FIRST_ID, SECOND_ID])
  assert.equal(controller.getSnapshot().error, undefined)
})

test('surfaces host queue errors and preserves an unsaved edit', async () => {
  const { controller } = fixture({
    update: () => Promise.resolve(rejected('internal')),
  })
  controller.beginQueueEdit(FIRST_ID)
  controller.setInput('Keep this edit')

  assert.equal(await controller.submitInput(), false)

  assert.equal(controller.getSnapshot().input?.value, 'Keep this edit')
  assert.equal(controller.getSnapshot().queue[0]?.busy, false)
  assert.match(controller.getSnapshot().error ?? '', /internal/u)
})

test('uses the persisted busy-submit preference and exposes the opposite chord', async () => {
  const writes: string[] = []
  const preferences: ConversationControllerOptions['preferences'] = {
    read: () => Promise.resolve({ ok: true, value: { behavior: 'steer', revision: 4 } }),
    subscribe: () => () => {},
    write: (behavior, revision) => {
      writes.push(`${behavior}:${revision}`)
      return Promise.resolve({ ok: true, value: { behavior, revision: revision + 1 } })
    },
  }
  const { control, controller } = fixture({ preferences })
  await settle()
  assert.equal(controller.getSnapshot().busyEnter, 'steer')

  controller.setDraft('primary')
  assert.equal(await controller.sendDraft(), true)
  controller.setDraft('opposite')
  assert.equal(await controller.sendAlternateDraft(), true)
  assert.deepEqual(control.prompts.map(prompt => prompt.mode), ['steer', 'queue'])

  assert.equal(await controller.toggleBusyEnter(), true)
  assert.equal(controller.getSnapshot().busyEnter, 'queue')
  assert.deepEqual(writes, ['queue:4'])
})

test('recovers when the busy-submit preference write fails', async () => {
  const preferences: ConversationControllerOptions['preferences'] = {
    read: () => Promise.resolve({ ok: true, value: { behavior: 'queue', revision: 1 } }),
    subscribe: () => () => {},
    write: () => Promise.reject(new Error('preference write failed')),
  }
  const { controller } = fixture({ preferences })
  await settle()

  assert.equal(await controller.toggleBusyEnter(), false)
  assert.equal(controller.getSnapshot().busyEnterBusy, false)
  assert.match(controller.getSnapshot().error ?? '', /preference write failed/u)
})

test('projects only mutable queued occurrences into the queue dock', () => {
  const { controller } = fixture()

  assert.deepEqual(controller.getSnapshot().queue, [
    {
      busy: false,
      editable: true,
      id: FIRST_ID,
      preview: 'First queued prompt',
    },
    {
      busy: false,
      editable: false,
      id: SECOND_ID,
      preview: '[image]',
    },
  ])
  assert.equal(controller.getSnapshot().queueMutable, true)
  assert.match(controller.getSnapshot().status, /^2 queued/u)
})
