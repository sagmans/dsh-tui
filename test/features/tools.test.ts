import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ChatSnapshot,
  ConversationSnapshot,
  ConversationViewSnapshotStore,
  ObservableSnapshot,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  createToolsController,
  type ToolPresentation,
} from '../../src/features/tools/model.js'
import { projectToolPresentation } from '../../src/features/tools/presentation.js'

// Static fixture identity crosses only the Harness brand boundary.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const SESSION_ID = 'session-one' as SessionId
const ESCAPE_CHARACTER = String.fromCodePoint(27)
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

function snapshot(tools: readonly ToolPresentation[]): ConversationSnapshot {
  const views: ConversationViewSnapshotStore = {
    get: target => target === 'tui' ? { lines: [], tools, workflows: [] } : undefined,
  }
  return {
    sessionId: SESSION_ID,
    views,
    chat: EMPTY_CHAT,
    nodes: [],
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
    hasMore: false,
    loadingOlder: false,
    promptError: null,
    blank: false,
    lastAgentError: null,
  }
}

test('maps structured terminal and malformed presentation intents safely', () => {
  const terminal = projectToolPresentation({
    args: '{"command":"pnpm test"}',
    callId: 'call-one',
    callView: { card: 'terminal', title: 'pnpm test', cwd: '/workspace', description: 'Run checks' },
    isError: false,
    name: 'bash',
    result: 'raw result',
    resultView: { card: 'terminal', output: 'ok\u001B]8;;https://unsafe.invalid\u0007', exitCode: 0 },
  })
  assert.equal(terminal.title, 'pnpm test')
  assert.equal(terminal.state, 'ok')
  assert.match(terminal.details, /Run checks/u)
  assert.match(terminal.details, /exit 0/u)
  assert.equal(terminal.details.includes(ESCAPE_CHARACTER), false)

  const malformed = projectToolPresentation({
    args: '{"path":"file.ts"}',
    callId: 'call-two',
    // Wire schemas intentionally validate only presentation discriminants.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    callView: { card: 'diff', title: 'Edit file', diffs: 'invalid' } as never,
    isError: false,
    name: 'edit',
  })
  assert.equal(malformed.title, 'edit')
  assert.match(malformed.details, /file\.ts/u)
})

test('projects nested tool rows and preserves selection across updates', () => {
  const child = projectToolPresentation({
    args: '{"path":"src/index.ts"}',
    callId: 'child',
    isError: false,
    name: 'read',
    result: 'file body',
  })
  const root = Object.freeze({
    ...projectToolPresentation({ args: '{}', callId: 'root', isError: false, name: 'run_code' }),
    children: Object.freeze([child]),
  })
  const binding = source(snapshot([root]))
  const list = source({ current: SESSION_ID, byId: { [SESSION_ID]: { displayTitle: 'Tool run' } } })
  const controller = createToolsController({
    sessions: { list, binding: () => binding },
  })

  assert.deepEqual(controller.getSnapshot().rows.map(row => [row.callId, row.depth]), [
    ['root', 0],
    ['child', 1],
  ])
  controller.move(1)
  assert.equal(controller.getSnapshot().selectedCallId, 'child')
  assert.match(controller.getSnapshot().details, /file body/u)

  binding.publish(snapshot([{ ...root, state: 'error' }]))
  assert.equal(controller.getSnapshot().selectedCallId, 'child')
  controller.select('root')
  controller.toggleSelected()
  assert.deepEqual(controller.getSnapshot().rows.map(row => row.callId), ['root'])
})
