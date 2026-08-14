import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createTestRenderer } from '@opentui/core/testing'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { ConversationController } from '../../src/features/conversation/model.js'
import { createTuiTheme } from '../../src/services/theme.js'
import { createConversationView } from '../../src/views/conversation/root.js'

const NATIVE_RENDERER_AVAILABLE = process.versions.bun !== undefined
  || process.getBuiltinModule('node:ffi') !== undefined
const WIDTH = 88
const HEIGHT = 22
const NOOP = (): void => {}
const SETTLE_DELAY_MS = 50
// Static fixture identity crosses only Harness brand boundaries.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const SESSION_ID = 'trigger-session' as SessionId

function settle(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, SETTLE_DELAY_MS) })
}

function controller(calls: string[]): ConversationController {
  return {
    beginAttachment: NOOP,
    beginExport: NOOP,
    beginQueueEdit: NOOP,
    cancel: () => Promise.resolve(),
    cancelInput: NOOP,
    clearAttachments: NOOP,
    closeInformation: NOOP,
    closeSubagents: NOOP,
    compact: () => Promise.resolve(false),
    complete: () => Promise.resolve(),
    dismissTrigger: () => { calls.push('dismiss') },
    dispose: NOOP,
    getSnapshot: () => ({
      accessPreset: undefined,
      agentPreset: undefined,
      attachments: [],
      busy: false,
      busyEnter: 'queue',
      busyEnterAvailable: false,
      busyEnterBusy: false,
      draft: '/co',
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
      subagents: undefined,
      suggestions: [],
      plan: undefined,
      title: 'Trigger menu',
      todos: [],
      trigger: {
        groups: [
          {
            items: [
              { description: 'Compact context', name: 'compact' },
              { description: 'Show configuration', name: 'config-show' },
            ],
            source: 'command',
          },
          {
            items: [{ description: 'Create commit', name: 'commit' }],
            source: 'skill',
          },
        ],
        highlight: { source: 'command', index: 0 },
        launcher: false,
        open: true,
        pending: false,
      },
    }),
    launchTrigger: () => { calls.push('launch') },
    loadOlder: () => Promise.resolve(),
    moveSubagent: NOOP,
    moveTrigger: delta => { calls.push(`move:${delta}`) },
    openInformation: NOOP,
    openModelSelection: NOOP,
    openPreferences: NOOP,
    pickTrigger: (source, index) => { calls.push(`pick:${source}:${index}`) },
    pickTriggerHighlight: () => { calls.push('pick:highlight') },
    refreshSubagents: () => Promise.resolve(),
    removeAttachment: NOOP,
    removeQueue: () => Promise.resolve(false),
    scroll: NOOP,
    scrollOffset: () => 0,
    send: () => Promise.resolve(false),
    sendAlternateDraft: () => Promise.resolve(false),
    sendDraft: () => Promise.resolve(false),
    selectSubagent: NOOP,
    exitPlanMode: () => Promise.resolve(false),
    setDraft: (text, caret) => { calls.push(`draft:${text}:${String(caret)}`) },
    setInput: NOOP,
    steerQueue: () => Promise.resolve(false),
    steerQueueAll: () => Promise.resolve(false),
    submitInput: () => Promise.resolve(false),
    toggleBusyEnter: () => Promise.resolve(false),
    toggleSubagentBranch: NOOP,
    toggleSubagents: NOOP,
    activateSubagent: () => false,
    subscribe: () => NOOP,
  }
}

test.skipIf(!NATIVE_RENDERER_AVAILABLE)('supports keyboard and mouse trigger navigation plus launcher', async () => {
  const harness = await createTestRenderer({ width: WIDTH, height: HEIGHT, bufferedOutput: 'memory' })
  const calls: string[] = []
  const view = createConversationView(harness.renderer, createTuiTheme({ color: true }), controller(calls))
  harness.renderer.root.add(view)

  try {
    await harness.flush()
    const frame = harness.captureCharFrame()
    assert.match(frame, /COMMAND/u)
    assert.match(frame, /compact/u)
    assert.match(frame, /SKILL/u)

    const candidate = view.findDescendantById('input-trigger-command-1')
    assert.ok(candidate)
    await harness.mockMouse.click(candidate.screenX + 1, candidate.screenY)

    const launcher = view.findDescendantById('conversation-trigger-launcher')
    assert.ok(launcher)
    await harness.mockMouse.click(launcher.screenX + 1, launcher.screenY)

    const composer = view.findDescendantById('conversation-composer')
    assert.ok(composer)
    composer.focus()
    await harness.mockInput.typeText('x')
    await settle()
    harness.mockInput.pressKey('l', { meta: true })
    harness.mockInput.pressArrow('down')
    harness.mockInput.pressEnter()
    await settle()
    assert.equal(harness.renderer.currentFocusedEditor === null
      || harness.renderer.currentFocusedEditor === undefined, true)
    composer.focus()
    harness.mockInput.pressEscape()
    await settle()

    assert.deepEqual(calls, [
      'pick:command:1',
      'launch',
      'draft:/cox:4',
      'launch',
      'move:1',
      'pick:highlight',
      'dismiss',
    ])
  } finally {
    view.destroyRecursively()
    harness.renderer.destroy()
  }
})
