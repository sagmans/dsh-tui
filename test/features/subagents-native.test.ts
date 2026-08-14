import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createTestRenderer } from '@opentui/core/testing'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ConversationController,
  ConversationSnapshotView,
  ConversationSubagentRowView,
} from '../../src/features/conversation/model.js'
import { createTuiTheme } from '../../src/services/theme.js'
import { createConversationView } from '../../src/views/conversation/root.js'

const NATIVE_RENDERER_AVAILABLE = process.versions.bun !== undefined
  || process.getBuiltinModule('node:ffi') !== undefined
const WIDTH = 88
const HEIGHT = 24
const SETTLE_DELAY_MS = 0
const ROOT_KEY = 'root:child'
const NESTED_KEY = 'child:nested'
const NOOP = (): void => {}
// Static fixture identity crosses only Harness brand boundaries.
/* oxlint-disable typescript/no-unsafe-type-assertion */
const SESSION_ID = 'session-root' as SessionId
const CHILD_ID = 'session-child' as SessionId
const NESTED_ID = 'session-nested' as SessionId
/* oxlint-enable typescript/no-unsafe-type-assertion */

function settle(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, SETTLE_DELAY_MS) })
}

function row(
  key: string,
  depth: number,
  sessionId: SessionId,
  hasChildren: boolean,
  expanded: boolean,
): ConversationSubagentRowView {
  return {
    active: key === ROOT_KEY,
    activity: key === ROOT_KEY ? 'running' : 'inactive',
    depth,
    enabled: true,
    expanded,
    hasChildren,
    key,
    kind: 'child',
    label: key === ROOT_KEY ? 'worker' : 'nested',
    mode: key === ROOT_KEY ? 'continuable' : 'one-shot',
    parentSessionId: key === ROOT_KEY ? SESSION_ID : CHILD_ID,
    sessionId,
    summary: key === ROOT_KEY ? 'continuable · running' : 'one-shot · inactive',
  }
}

function fixture(calls: string[]): ConversationController {
  let activeRowKey: string | undefined = ROOT_KEY
  let expanded = false
  let open = false
  let listener = NOOP
  const publish = (): void => { listener() }
  const snapshot = (): ConversationSnapshotView => ({
    accessPreset: undefined,
    agentPreset: undefined,
    attachments: [],
    busy: false,
    busyEnter: 'queue',
    busyEnterAvailable: false,
    busyEnterBusy: false,
    draft: '',
    error: undefined,
    hasMore: false,
    informationSection: undefined,
    input: undefined,
    context: undefined,
    goal: undefined,
    lifecycle: [],
    lines: [],
    loadingOlder: false,
    modelAvailable: false,
    modelEffort: undefined,
    modelLabel: undefined,
    modelRoutable: undefined,
    phase: 'ready',
    primarySendMode: 'queue',
    queue: [],
    queueMutable: false,
    running: false,
    sessionId: SESSION_ID,
    statistics: undefined,
    status: 'Ready',
    subagent: undefined,
    subagents: {
      activeRowKey,
      count: 2,
      open,
      rows: open
        ? [
            row(ROOT_KEY, 0, CHILD_ID, true, expanded),
            ...expanded ? [row(NESTED_KEY, 1, NESTED_ID, false, false)] : [],
          ]
        : [],
      runningCount: 1,
    },
    suggestions: [],
    plan: undefined,
    title: 'Subagent tree',
    todos: [],
    trigger: undefined,
  })
  return {
    beginAttachment: NOOP,
    beginExport: NOOP,
    beginQueueEdit: NOOP,
    cancel: () => Promise.resolve(),
    cancelInput: NOOP,
    clearAttachments: NOOP,
    closeInformation: NOOP,
    closeSubagents: () => { open = false; calls.push('close'); publish() },
    compact: () => Promise.resolve(false),
    complete: () => Promise.resolve(),
    dismissTrigger: NOOP,
    dispose: NOOP,
    getSnapshot: snapshot,
    launchTrigger: NOOP,
    loadOlder: () => Promise.resolve(),
    moveSubagent: delta => {
      activeRowKey = delta > 0 && expanded ? NESTED_KEY : ROOT_KEY
      calls.push(`move:${String(delta)}`)
      publish()
    },
    moveTrigger: NOOP,
    openInformation: NOOP,
    openModelSelection: NOOP,
    openPreferences: NOOP,
    pickTrigger: NOOP,
    pickTriggerHighlight: NOOP,
    refreshSubagents: () => Promise.resolve(),
    removeAttachment: NOOP,
    removeQueue: () => Promise.resolve(false),
    scroll: NOOP,
    scrollOffset: () => 0,
    send: () => Promise.resolve(false),
    sendAlternateDraft: () => Promise.resolve(false),
    sendDraft: () => Promise.resolve(false),
    selectSubagent: key => { activeRowKey = key; calls.push(`select:${key}`) },
    exitPlanMode: () => Promise.resolve(false),
    setDraft: NOOP,
    setInput: NOOP,
    steerQueue: () => Promise.resolve(false),
    steerQueueAll: () => Promise.resolve(false),
    submitInput: () => Promise.resolve(false),
    subscribe: next => { listener = next; return () => { listener = NOOP } },
    toggleBusyEnter: () => Promise.resolve(false),
    toggleSubagentBranch: key => {
      expanded = !expanded
      activeRowKey = key
      calls.push(`branch:${key}`)
      publish()
    },
    toggleSubagents: () => { open = !open; calls.push('toggle'); publish() },
    activateSubagent: () => { calls.push(`open:${activeRowKey ?? ''}`); return true },
  }
}

test.skipIf(!NATIVE_RENDERER_AVAILABLE)('navigates recursive subagents with keyboard and mouse', async () => {
  const harness = await createTestRenderer({ width: WIDTH, height: HEIGHT, bufferedOutput: 'memory' })
  const calls: string[] = []
  const view = createConversationView(harness.renderer, createTuiTheme({ color: true }), fixture(calls))
  harness.renderer.root.add(view)

  try {
    await harness.flush()
    const trigger = view.findDescendantById('conversation-subagents')
    assert.ok(trigger)
    await harness.mockMouse.click(trigger.screenX + 1, trigger.screenY)
    await settle()
    await harness.flush()
    assert.ok(view.findDescendantById('conversation-subagents-overlay'))

    harness.mockInput.pressArrow('right')
    await settle()
    await harness.flush()
    assert.ok(view.findDescendantById(`conversation-subagent-row-${NESTED_KEY}`))
    harness.mockInput.pressArrow('down')
    await settle()
    await harness.flush()
    harness.mockInput.pressEnter()
    await settle()
    assert.equal(calls.includes(`open:${NESTED_KEY}`), true)

    const nested = view.findDescendantById(`conversation-subagent-row-${NESTED_KEY}`)
    assert.ok(nested)
    await harness.mockMouse.click(nested.screenX + 1, nested.screenY)
    await settle()
    assert.equal(calls.filter(call => call === `open:${NESTED_KEY}`).length, 2)

    const toggle = view.findDescendantById(`conversation-subagent-toggle-${ROOT_KEY}`)
    assert.ok(toggle)
    await harness.mockMouse.click(toggle.screenX, toggle.screenY)
    await settle()
    assert.equal(calls.includes(`branch:${ROOT_KEY}`), true)
  } finally {
    view.destroyRecursively()
    harness.renderer.destroy()
  }
})
