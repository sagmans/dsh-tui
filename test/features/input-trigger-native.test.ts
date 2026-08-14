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
const SETTLE_DELAY_MS = 0
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
      input: undefined,
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
      status: 'Ready',
      suggestions: [],
      title: 'Trigger menu',
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
    moveTrigger: delta => { calls.push(`move:${delta}`) },
    openModelSelection: NOOP,
    openPreferences: NOOP,
    pickTrigger: (source, index) => { calls.push(`pick:${source}:${index}`) },
    pickTriggerHighlight: () => { calls.push('pick:highlight') },
    removeAttachment: NOOP,
    removeQueue: () => Promise.resolve(false),
    scroll: NOOP,
    scrollOffset: () => 0,
    send: () => Promise.resolve(false),
    sendAlternateDraft: () => Promise.resolve(false),
    sendDraft: () => Promise.resolve(false),
    setDraft: NOOP,
    setInput: NOOP,
    steerQueue: () => Promise.resolve(false),
    steerQueueAll: () => Promise.resolve(false),
    submitInput: () => Promise.resolve(false),
    toggleBusyEnter: () => Promise.resolve(false),
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
    await harness.mockMouse.click(composer.screenX + 1, composer.screenY)
    harness.mockInput.pressKey('ARROWDOWN')
    harness.mockInput.pressEnter()
    harness.mockInput.pressKey('ESCAPE')
    await settle()

    assert.deepEqual(calls, [
      'pick:command:1',
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
