import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createTestRenderer } from '@opentui/core/testing'
import type { CliRenderer } from '@opentui/core'
import { createOpenTuiKeymap } from '@opentui/keymap/opentui'
import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import type { TuiClientFacade } from '../../src/client/context.js'
import { createShellController, type ShellController } from '../../src/features/shell/model.js'
import { mountShellView } from '../../src/views/shell/root.js'
import { createNavigationStore } from '../../src/kernel/navigation.js'
import { createTuiCommands } from '../../src/services/commands.js'
import type { TuiCommands } from '../../src/contracts/commands.js'
import { createTuiSlots } from '../../src/services/slots.js'
import { createTuiTheme } from '../../src/services/theme.js'

const NATIVE_RENDERER_AVAILABLE = process.versions.bun !== undefined
  || process.getBuiltinModule('node:ffi') !== undefined
const WIDE_WIDTH = 80
const WIDE_HEIGHT = 24
const COMPACT_WIDTH = 44
const COMPACT_HEIGHT = 12
const STATUS_MOUSE_X = 4
const STATUS_MOUSE_Y = 0
const SESSIONS_TAB_X = 12
const TABS_Y = 0
const PALETTE_BUTTON_X = 24
const FOOTER_Y = WIDE_HEIGHT - 1
// Test identities stay static; branding belongs to the Harness boundary.
/* oxlint-disable typescript/no-unsafe-type-assertion */
const FIRST_ID = 'session-one' as SessionId
const SECOND_ID = 'session-two' as SessionId
/* oxlint-enable typescript/no-unsafe-type-assertion */

function summary(id: SessionId, title: string): SessionSummary {
  return {
    id,
    displayTitle: title,
    running: id === FIRST_ID,
    blank: false,
    updatedAt: 1,
  }
}

function state(): SessionListState {
  return {
    ids: [FIRST_ID, SECOND_ID],
    byId: {
      [FIRST_ID]: summary(FIRST_ID, 'Implement terminal shell'),
      [SECOND_ID]: summary(SECOND_ID, 'Review plugin wiring'),
    },
    current: FIRST_ID,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  }
}

function registerShellKeys(
  renderer: CliRenderer,
  controller: ShellController,
): { readonly commands: TuiCommands; readonly owner: Context } {
  const owner = new Context()
  const commands = createTuiCommands(createOpenTuiKeymap(renderer))
  commands.register(owner, {
    id: 'native-shell-keys',
    bindings: [
      { key: 'z', command: 'shell.zen' },
      { key: 'gs', command: 'route.sessions' },
      { key: '<leader>p', command: 'shell.palette' },
    ],
    commands: [
      { name: 'shell.zen', description: 'Toggle zen', run: () => { controller.run('shell.zen') } },
      { name: 'route.sessions', description: 'Open sessions', run: () => { controller.run('route.sessions') } },
      { name: 'shell.palette', description: 'Open palette', run: () => { controller.run('shell.palette') } },
    ],
  })
  commands.register(owner, {
    id: 'native-shell-palette-keys',
    priority: 200,
    active: () => controller.getSnapshot().overlay === 'palette',
    bindings: [
      { key: 'j', command: 'palette.next' },
      { key: 'return', command: 'palette.run' },
    ],
    commands: [
      { name: 'palette.next', description: 'Select next', run: () => { controller.run('palette.next') } },
      { name: 'palette.run', description: 'Run selected', run: () => { controller.run('palette.run') } },
    ],
  })
  return { commands, owner }
}

// One renderer lifetime proves stateful input, pointer, overlay, and resize interactions together.
// oxlint-disable-next-line eslint/max-lines-per-function
test.skipIf(!NATIVE_RENDERER_AVAILABLE)('renders zen shell with mouse parity and compact reflow', async () => {
  const harness = await createTestRenderer({
    width: WIDE_WIDTH,
    height: WIDE_HEIGHT,
    bufferedOutput: 'memory',
  })
  const navigation = createNavigationStore()
  const opened: SessionId[] = []
  const sessions = {
    getSnapshot: state,
    subscribe: () => () => {},
    open: (id: SessionId) => { opened.push(id) },
    clear: () => {},
  }
  const controller = createShellController({ navigation, sessions })
  const theme = createTuiTheme({ color: true })
  // Native shell test never invokes client services.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const client = { api: {}, context: {} } as unknown as TuiClientFacade
  const slots = createTuiSlots(harness.renderer, { client, navigation, theme })
  const view = mountShellView({ controller, renderer: harness.renderer, slots, theme })
  const keyHarness = registerShellKeys(harness.renderer, controller)
  harness.renderer.root.add(view.root)

  try {
    await harness.flush()
    const frame = harness.captureCharFrame()
    assert.doesNotMatch(frame, /SESSIONS/u)
    assert.match(frame, /Implement terminal shell/u)
    assert.match(frame, /running/u)
    assert.doesNotMatch(frame, /commands/u)

    harness.mockInput.pressKey('z')
    await harness.flush()
    assert.equal(controller.getSnapshot().zen, false)
    assert.match(harness.captureCharFrame(), /CHAT/u)

    await harness.mockInput.pressKeys(['g', 's'])
    await harness.flush()
    assert.equal(controller.getSnapshot().route, 'sessions')
    assert.match(harness.captureCharFrame(), /SESSIONS/u)
    controller.openRoute('chat')
    await harness.mockMouse.click(SESSIONS_TAB_X, TABS_Y)
    await harness.flush()
    assert.equal(controller.getSnapshot().route, 'sessions')

    await harness.mockMouse.click(PALETTE_BUTTON_X, FOOTER_Y)
    await harness.flush()
    assert.equal(controller.getSnapshot().overlay, 'palette')
    assert.match(harness.captureCharFrame(), /COMMANDS/u)
    const palette = view.root.findDescendantById('shell-palette')
    assert.ok(palette)
    const paletteChat = view.root.findDescendantById('shell-palette-route.chat')
    assert.ok(paletteChat)
    await harness.mockMouse.click(paletteChat.screenX, paletteChat.screenY)
    await harness.flush()
    assert.equal(controller.getSnapshot().overlay, undefined)
    assert.equal(controller.getSnapshot().route, 'chat')
    await harness.mockInput.pressKeys([' ', 'p'])
    await harness.flush()
    assert.equal(controller.getSnapshot().overlay, 'palette')
    harness.mockInput.pressKey('j')
    await harness.flush()
    harness.mockInput.pressEnter()
    await harness.flush()
    assert.equal(controller.getSnapshot().overlay, undefined)
    assert.equal(controller.getSnapshot().route, 'sessions')

    controller.run('shell.zen')
    await harness.flush()
    await harness.mockMouse.click(STATUS_MOUSE_X, STATUS_MOUSE_Y)
    await harness.flush()
    assert.equal(controller.getSnapshot().zen, false)

    controller.run('session.next')
    assert.deepEqual(opened, [SECOND_ID])

    harness.resize(COMPACT_WIDTH, COMPACT_HEIGHT)
    controller.run('shell.help')
    await harness.flush()
    const compactFrame = harness.captureCharFrame()
    assert.equal(compactFrame.split('\n')[0]?.length, COMPACT_WIDTH)
    assert.match(compactFrame, /KEYS/u)
  } finally {
    view.dispose()
    slots.dispose()
    controller.dispose()
    await keyHarness.owner.fiber.dispose()
    keyHarness.commands.dispose()
    harness.renderer.destroy()
  }
})
