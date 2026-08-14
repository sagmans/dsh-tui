import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createTestRenderer } from '@opentui/core/testing'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ConversationController,
  ConversationInputView,
  ConversationSnapshotView,
} from '../../src/features/conversation/model.js'
import type {
  InteractionsController,
  InteractionSnapshotView,
} from '../../src/features/interactions/model.js'
import type {
  OperationActionId,
  OperationsController,
  OperationsSnapshotView,
} from '../../src/features/operations/model.js'
import type {
  SessionsController,
  SessionsInputState,
  SessionsSnapshot,
} from '../../src/features/sessions/model.js'
import { createTuiTheme } from '../../src/services/theme.js'
import { createConversationView } from '../../src/views/conversation/root.js'
import { createInteractionsView } from '../../src/views/interactions/root.js'
import { createOperationsView } from '../../src/views/operations/root.js'
import { createSessionsView } from '../../src/views/sessions/root.js'

const NATIVE_RENDERER_AVAILABLE = process.versions.bun !== undefined
  || process.getBuiltinModule('node:ffi') !== undefined
const WIDTH = 80
const HEIGHT = 24
const NOOP_LISTENER = (): void => {}
// Static fixture identity crosses only Harness brand boundaries.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const SESSION_ID = 'session-overlay' as SessionId

function sessionsController(calls: string[]): {
  readonly controller: SessionsController
  readonly open: (kind: SessionsInputState['kind']) => void
} {
  let listener = NOOP_LISTENER
  let input: SessionsInputState | undefined
  const publish = (): void => { listener() }
  const open = (kind: SessionsInputState['kind']): void => {
    input = {
      kind,
      initialValue: kind === 'rename' ? 'Before' : '',
      placeholder: 'Type value',
      title: kind === 'search' ? 'SEARCH SESSIONS' : 'RENAME SESSION',
      sessionId: SESSION_ID,
      workspaceId: undefined,
    }
    publish()
  }
  const snapshot = (): SessionsSnapshot => ({
    activeRowKey: undefined,
    confirmDelete: false,
    error: undefined,
    groupMode: 'workspace',
    input,
    orderMode: 'updated',
    phase: 'ready',
    rows: [],
    searchHasMore: false,
    searchQuery: '',
    unreadCount: 0,
  })
  return {
    open,
    controller: {
      accept: () => {},
      activate: () => {},
      archive: () => Promise.resolve(),
      cancel: () => { calls.push('cancel'); input = undefined; publish() },
      close: () => {},
      confirmDelete: () => Promise.resolve(),
      deactivate: () => {},
      dispose: () => {},
      fork: () => Promise.resolve(),
      getSnapshot: snapshot,
      loadOlder: () => Promise.resolve(),
      move: () => {},
      moveSelected: () => Promise.resolve(),
      moveUnread: () => {},
      openInput: open,
      requestDelete: () => {},
      select: () => {},
      setGroupMode: () => {},
      setOrderMode: () => {},
      startSession: () => {},
      submitInput: value => { calls.push(`save:${value}`); input = undefined; publish(); return Promise.resolve() },
      subscribe: next => { listener = next; return () => { listener = NOOP_LISTENER } },
      toggleWorkspace: () => {},
    },
  }
}

function conversationController(calls: string[]): ConversationController {
  let listener = NOOP_LISTENER
  let input: ConversationInputView | undefined
  let inputValue = ''
  let attachments: ConversationSnapshotView['attachments'] = [
    { bytes: 1, mediaType: 'image/png', name: 'first.png' },
    { bytes: 2, mediaType: 'image/jpeg', name: 'second.jpg' },
  ]
  const publish = (): void => { listener() }
  return {
    beginAttachment: () => {
      input = { kind: 'attachment', placeholder: 'Absolute path', title: 'ATTACH IMAGE', value: '' }
      inputValue = ''
      publish()
    },
    beginExport: () => {
      input = { kind: 'export', placeholder: 'Absolute path', title: 'EXPORT SESSION', value: '' }
      inputValue = ''
      publish()
    },
    beginQueueEdit: () => {},
    cancel: () => Promise.resolve(),
    cancelInput: () => { calls.push('cancel'); input = undefined; publish() },
    clearAttachments: () => { attachments = []; publish() },
    closeInformation: () => {},
    closeSubagents: () => {},
    compact: () => Promise.resolve(false),
    complete: () => Promise.resolve(),
    dismissTrigger: () => {},
    dispose: () => {},
    getSnapshot: () => ({
      accessPreset: undefined,
      agentPreset: undefined,
      attachments,
      busy: false,
      busyEnter: 'queue',
      busyEnterAvailable: false,
      busyEnterBusy: false,
      draft: '',
      error: undefined,
      hasMore: false,
      informationSection: undefined,
      input,
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
      subagents: undefined,
      suggestions: [],
      plan: undefined,
      title: 'Overlay controls',
      todos: [],
      trigger: undefined,
    }),
    launchTrigger: () => {},
    loadOlder: () => Promise.resolve(),
    moveSubagent: () => {},
    moveTrigger: () => {},
    openInformation: () => {},
    openModelSelection: () => {},
    openPreferences: () => {},
    pickTrigger: () => {},
    pickTriggerHighlight: () => {},
    refreshSubagents: () => Promise.resolve(),
    removeAttachment: index => {
      calls.push(`remove:${index}`)
      attachments = attachments.filter((_attachment, current) => current !== index)
      publish()
    },
    removeQueue: () => Promise.resolve(false),
    scroll: () => {},
    scrollOffset: () => 0,
    send: () => Promise.resolve(false),
    sendAlternateDraft: () => Promise.resolve(false),
    sendDraft: () => Promise.resolve(false),
    selectSubagent: () => {},
    exitPlanMode: () => Promise.resolve(false),
    setDraft: () => {},
    setInput: value => { inputValue = value },
    steerQueue: () => Promise.resolve(false),
    steerQueueAll: () => Promise.resolve(false),
    submitInput: () => { calls.push(`save:${inputValue}`); input = undefined; publish(); return Promise.resolve(true) },
    toggleBusyEnter: () => Promise.resolve(false),
    toggleSubagentBranch: () => {},
    toggleSubagents: () => {},
    activateSubagent: () => false,
    subscribe: next => { listener = next; return () => { listener = NOOP_LISTENER } },
  }
}

function operationsController(calls: string[]): OperationsController {
  let listener = NOOP_LISTENER
  let input: OperationsSnapshotView['input'] = { kind: 'goal-edit', title: 'EDIT GOAL', value: 'Before' }
  let inputValue = input.value
  const publish = (): void => { listener() }
  return {
    cancelInput: () => { calls.push('cancel'); input = undefined; publish() },
    close: () => {},
    dispose: () => {},
    getSnapshot: () => ({
      busy: false,
      confirmation: undefined,
      error: undefined,
      input,
      overlayId: 'operations',
      rowIndex: 0,
      rows: [],
      section: 'goal',
      sections: ['goal', 'plan', 'workflows', 'jobs', 'subagents', 'trajectory', 'feedback'],
      selectedActionId: undefined,
      status: '',
    }),
    move: () => {},
    moveAction: () => {},
    moveSection: () => {},
    open: () => Promise.resolve(),
    perform: (_action?: OperationActionId) => Promise.resolve(false),
    selectRow: () => {},
    selectSection: () => {},
    setInput: value => { inputValue = value },
    submitInput: () => { calls.push(`save:${inputValue}`); input = undefined; publish(); return Promise.resolve(true) },
    subscribe: next => { listener = next; return () => { listener = NOOP_LISTENER } },
    toggle: () => Promise.resolve(),
  }
}

function interactionsController(calls: string[]): InteractionsController {
  const snapshot: InteractionSnapshotView = {
    body: 'Provide context',
    busy: false,
    canReject: false,
    canSubmit: true,
    custom: '',
    error: undefined,
    key: 'question:one',
    kind: 'question',
    multiSelect: false,
    optionIndex: 0,
    options: [],
    overlayId: 'interaction:question:one',
    questionCount: 1,
    questionIndex: 0,
    status: '1/1',
    title: 'Question',
  }
  return {
    approve: () => Promise.resolve(false),
    cancel: () => { calls.push('cancel'); return Promise.resolve(true) },
    chooseOption: () => {},
    dispose: () => {},
    getSnapshot: () => snapshot,
    moveOption: () => {},
    nextQuestion: () => {},
    previousQuestion: () => {},
    reject: () => Promise.resolve(false),
    selectOption: () => {},
    setCustom: value => { calls.push(`custom:${value}`) },
    skipQuestion: () => {},
    submit: () => { calls.push('submit'); return Promise.resolve(true) },
    subscribe: () => () => {},
  }
}

test.skipIf(!NATIVE_RENDERER_AVAILABLE)('submits and cancels session overlays with mouse controls', async () => {
  const harness = await createTestRenderer({ width: WIDTH, height: HEIGHT, bufferedOutput: 'memory' })
  const calls: string[] = []
  const fixture = sessionsController(calls)
  fixture.open('rename')
  const view = createSessionsView(harness.renderer, createTuiTheme({ color: true }), fixture.controller)
  harness.renderer.root.add(view)

  try {
    await harness.flush()
    await harness.mockInput.typeText(' updated')
    const save = view.findDescendantById('sessions-input-save')
    assert.ok(save)
    assert.equal(save.focusable, true)
    await harness.mockMouse.click(save.screenX + 1, save.screenY)
    await harness.flush()
    assert.deepEqual(calls, ['save:Before updated'])
    assert.equal(harness.renderer.currentFocusedEditor, null)

    fixture.open('search')
    await harness.flush()
    const cancel = view.findDescendantById('sessions-input-cancel')
    assert.ok(cancel)
    assert.equal(cancel.focusable, true)
    await harness.mockMouse.click(cancel.screenX + 1, cancel.screenY)
    await harness.flush()
    assert.deepEqual(calls, ['save:Before updated', 'cancel'])
  } finally {
    view.destroyRecursively()
    harness.renderer.destroy()
  }
})

test.skipIf(!NATIVE_RENDERER_AVAILABLE)('supports mouse path actions and per-attachment keyboard removal', async () => {
  const harness = await createTestRenderer({ width: WIDTH, height: HEIGHT, bufferedOutput: 'memory' })
  const calls: string[] = []
  const controller = conversationController(calls)
  const view = createConversationView(harness.renderer, createTuiTheme({ color: true }), controller)
  harness.renderer.root.add(view)

  try {
    await harness.flush()
    const attach = view.findDescendantById('conversation-attach')
    assert.ok(attach)
    await harness.mockMouse.click(attach.screenX + 1, attach.screenY)
    await harness.flush()
    await harness.mockInput.typeText('/tmp/third.png')
    const save = view.findDescendantById('conversation-path-save')
    assert.ok(save)
    assert.equal(save.focusable, true)
    await harness.mockMouse.click(save.screenX + 1, save.screenY)
    await harness.flush()
    assert.deepEqual(calls, ['save:/tmp/third.png'])
    assert.equal(harness.renderer.currentFocusedEditor?.id, 'conversation-composer')

    harness.mockInput.pressTab({ shift: true })
    harness.mockInput.pressKey('DELETE')
    await harness.flush()
    assert.deepEqual(calls, ['save:/tmp/third.png', 'remove:1'])

    const first = view.findDescendantById('conversation-attachment-0')
    assert.ok(first)
    await harness.mockMouse.click(first.screenX + 1, first.screenY)
    await harness.flush()
    assert.deepEqual(calls, ['save:/tmp/third.png', 'remove:1', 'remove:0'])
  } finally {
    view.destroyRecursively()
    harness.renderer.destroy()
  }
})

test.skipIf(!NATIVE_RENDERER_AVAILABLE)('provides focusable catalog and question submit controls', async () => {
  const harness = await createTestRenderer({ width: WIDTH, height: HEIGHT, bufferedOutput: 'memory' })
  const theme = createTuiTheme({ color: true })
  const catalogCalls: string[] = []
  const catalog = createOperationsView(harness.renderer, theme, operationsController(catalogCalls))
  harness.renderer.root.add(catalog)

  try {
    await harness.flush()
    const save = catalog.findDescendantById('operations-input-save')
    const cancel = catalog.findDescendantById('operations-input-cancel')
    assert.ok(save)
    assert.ok(cancel)
    assert.equal(save.focusable, true)
    assert.equal(cancel.focusable, true)
    await harness.mockMouse.click(cancel.screenX + 1, cancel.screenY)
    await harness.flush()
    assert.deepEqual(catalogCalls, ['cancel'])

    catalog.destroyRecursively()
    const interactionCalls: string[] = []
    const interactions = createInteractionsView(harness.renderer, theme, interactionsController(interactionCalls))
    harness.renderer.root.add(interactions)
    await harness.flush()
    const custom = interactions.findDescendantById('interaction-custom')
    assert.ok(custom)
    await harness.mockMouse.click(custom.screenX + 1, custom.screenY)
    await harness.mockInput.typeText('detail')
    harness.mockInput.pressTab()
    harness.mockInput.pressEnter()
    await harness.flush()
    assert.equal(interactionCalls.includes('custom:detail'), true)
    assert.equal(interactionCalls.includes('submit'), true)
    const cancelQuestion = interactions.findDescendantById('interaction-cancel')
    assert.ok(cancelQuestion)
    assert.equal(cancelQuestion.focusable, true)
    interactions.destroyRecursively()
  } finally {
    if (!catalog.isDestroyed) catalog.destroyRecursively()
    harness.renderer.destroy()
  }
})
