import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { MessageId, PromptContentPart, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
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
  readonly prompts: Array<{ readonly content: readonly PromptContentPart[]; readonly mode: ConversationSendMode }>
  readonly exports: Array<{ readonly path: string; readonly sessionId: SessionId }>
  readonly loadedImages: string[]
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

function fixture(options: Pick<ConversationControllerOptions, 'completion' | 'media' | 'openSettings'> = {}): {
  readonly binding: MutableSource<ConversationSnapshot> & ConversationSessionBinding
  readonly control: Control
  readonly controller: ReturnType<typeof createConversationController>
  readonly list: MutableSource<{
    readonly current: SessionId
    readonly byId: Readonly<Record<SessionId, {
      readonly agentPreset?: string | undefined
      readonly displayTitle: string
      readonly projectionValues?: Readonly<Record<string, unknown>> | undefined
    } | undefined>>
  }>
} {
  const control: Control = { cancels: [], commands: [], exports: [], historyLoads: [], loadedImages: [], prompts: [] }
  const session = source(snapshot())
  const binding: MutableSource<ConversationSnapshot> & ConversationSessionBinding = {
    ...session,
    cancel: () => { control.cancels.push(1); return Promise.resolve() },
    command: (line) => { control.commands.push(line); return Promise.resolve(line === '/compact') },
    loadOlder: () => { control.historyLoads.push(1); return Promise.resolve() },
    prompt: (content, mode) => {
      control.prompts.push({ content, mode })
      const text = content.find(part => part.type === 'text')?.text
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
    list,
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
    { content: [{ type: 'text', text: 'hello' }], mode: 'queue' },
    { content: [{ type: 'text', text: '/skill' }], mode: 'steer' },
    { content: [{ type: 'text', text: 'fail' }], mode: 'queue' },
  ])
  assert.equal(controller.getSnapshot().error, 'send unavailable')
  assert.equal(controller.getSnapshot().draft, 'fail')

  await controller.cancel()
  await controller.loadOlder()
  assert.deepEqual(control.cancels, [1])
  assert.deepEqual(control.historyLoads, [1])
})

test('surfaces current preset seats and opens their exact settings sections', () => {
  const opened: string[] = []
  const { controller, list } = fixture({ openSettings: section => { opened.push(section) } })
  list.publish({
    current: SESSION_ID,
    byId: {
      [SESSION_ID]: {
        agentPreset: 'code',
        displayTitle: 'Terminal session',
        projectionValues: { permissions: { currentValue: 'workspace-write' } },
      },
    },
  })

  assert.equal(controller.getSnapshot().agentPreset, 'code')
  assert.equal(controller.getSnapshot().accessPreset, 'workspace-write')
  controller.openPreferences('access')
  controller.openPreferences('presets')
  assert.deepEqual(opened, ['access', 'presets'])
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

test('loads path-only image drafts, sends durable content, and exports explicitly', async () => {
  const control: Control = { cancels: [], commands: [], exports: [], historyLoads: [], loadedImages: [], prompts: [] }
  const media: NonNullable<ConversationControllerOptions['media']> = {
    loadImage: (path) => {
      control.loadedImages.push(path)
      return Promise.resolve({
        content: { type: 'image', mediaType: 'image/png', data: 'AQID', name: 'screen.png' },
        view: { bytes: 3, mediaType: 'image/png', name: 'screen.png' },
      })
    },
    exportSession: (sessionId, path) => {
      control.exports.push({ sessionId, path })
      return Promise.resolve()
    },
  }
  const { binding, controller, list } = fixture({ media })
  // Use the fixture's binding while retaining direct media call evidence.
  binding.publish(snapshot())

  controller.beginAttachment()
  controller.setInput('/tmp/private/screen.png')
  list.publish({ current: SESSION_ID, byId: { [SESSION_ID]: { displayTitle: 'Renamed terminal session' } } })
  assert.equal(controller.getSnapshot().input?.value, '/tmp/private/screen.png')
  assert.equal(await controller.submitInput(), true)
  assert.deepEqual(control.loadedImages, ['/tmp/private/screen.png'])
  assert.deepEqual(controller.getSnapshot().attachments, [{ bytes: 3, mediaType: 'image/png', name: 'screen.png' }])
  assert.equal(JSON.stringify(controller.getSnapshot()).includes('AQID'), false)
  assert.equal(JSON.stringify(controller.getSnapshot()).includes('/tmp/private'), false)

  controller.setDraft('inspect image')
  assert.equal(await controller.sendDraft(), true)
  assert.deepEqual(controller.getSnapshot().attachments, [])

  controller.beginExport()
  controller.setInput('/tmp/session.zip')
  assert.equal(await controller.submitInput(), true)
  assert.deepEqual(control.exports, [{ sessionId: SESSION_ID, path: '/tmp/session.zip' }])
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
