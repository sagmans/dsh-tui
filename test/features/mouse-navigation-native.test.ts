import assert from 'node:assert/strict'
import { test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createTestRenderer } from '@opentui/core/testing'
import { createOpenTuiKeymap } from '@opentui/keymap/opentui'
import type { SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { TuiClientFacade } from '../../src/client/context.js'
import { mountOperations } from '../../src/features/operations/index.js'
import type { OperationsController } from '../../src/features/operations/model.js'
import { createShellController } from '../../src/features/shell/model.js'
import { createNavigationStore } from '../../src/kernel/navigation.js'
import { createTuiCommands } from '../../src/services/commands.js'
import { createTuiSlots } from '../../src/services/slots.js'
import { createTuiTheme } from '../../src/services/theme.js'
import { mountShellView } from '../../src/views/shell/root.js'

const NATIVE_RENDERER_AVAILABLE = process.versions.bun !== undefined
  || process.getBuiltinModule('node:ffi') !== undefined
const WIDTH = 80
const HEIGHT = 18
const OPERATIONS_ACTION_ID = 'operations-footer-open'

function sessionState(): SessionListState {
  return {
    ids: [],
    byId: {},
    current: undefined,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  }
}

function operationsController(opened: string[]): OperationsController {
  return {
    cancelInput: () => {},
    close: () => {},
    dispose: () => {},
    getSnapshot: () => ({
      busy: false,
      confirmation: undefined,
      error: undefined,
      input: undefined,
      overlayId: undefined,
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
    open: () => { opened.push('operations'); return Promise.resolve() },
    perform: () => Promise.resolve(false),
    selectRow: () => {},
    selectSection: () => {},
    setInput: () => {},
    submitInput: () => Promise.resolve(false),
    subscribe: () => () => {},
    toggle: () => Promise.resolve(),
  }
}

test.skipIf(!NATIVE_RENDERER_AVAILABLE)('keeps footer navigation mouse-accessible in zen mode', async () => {
  const harness = await createTestRenderer({ width: WIDTH, height: HEIGHT, bufferedOutput: 'memory' })
  const owner = new Context()
  const navigation = createNavigationStore()
  const theme = createTuiTheme({ color: true })
  // Native navigation proof needs slot identity, not live Harness services.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const client = { sessions: {} } as unknown as TuiClientFacade
  const slots = createTuiSlots(harness.renderer, { client, navigation, theme })
  const commands = createTuiCommands(createOpenTuiKeymap(harness.renderer))
  owner.provide('tuiClient', client)
  // Native fixture supplies only resources consumed by operations wiring.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  owner.provide('tuiKernel', { ready: true, resources: { commands, navigation, renderer: harness.renderer, slots, theme } } as never)
  const opened: string[] = []
  mountOperations(owner, {
    createController: () => operationsController(opened),
    createView: () => { throw new Error('operations overlay must remain closed') },
  })
  const shellController = createShellController({
    navigation,
    sessions: { getSnapshot: sessionState, subscribe: () => () => {}, open: () => {}, clear: () => {} },
  })
  const shell = mountShellView({ controller: shellController, renderer: harness.renderer, slots, theme })
  harness.renderer.root.add(shell.root)

  try {
    await harness.flush()
    assert.equal(shellController.getSnapshot().zen, true)
    assert.ok(shell.root.findDescendantById('shell-footer'))
    const operations = shell.root.findDescendantById(OPERATIONS_ACTION_ID)
    assert.ok(operations)
    await harness.mockMouse.click(operations.screenX + 1, operations.screenY)
    await harness.flush()
    assert.deepEqual(opened, ['operations'])
  } finally {
    shell.dispose()
    shellController.dispose()
    await owner.fiber.dispose()
    commands.dispose()
    slots.dispose()
    harness.renderer.destroy()
  }
})
