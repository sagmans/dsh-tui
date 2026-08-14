import assert from 'node:assert/strict'
import { test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { BaseRenderable } from '@opentui/core'
import type { TuiClientFacade } from '../../src/client/context.js'
import { mountSettings } from '../../src/features/settings/index.js'
import type { ConfigurationController } from '../../src/features/settings/model.js'
import type { TuiSlots } from '../../src/contracts/slots.js'

interface Control {
  activeCommands: number
  activeEvents: number
  activeSlots: number
  readonly commandNames: string[]
  controllerDisposals: number
  renderedController: ConfigurationController | undefined
  renderSettings: (() => BaseRenderable) | undefined
}

function fakeController(control: Control): ConfigurationController {
  return {
    activate: () => Promise.resolve(),
    cancelInput: () => {},
    dispose: () => { control.controllerDisposals += 1 },
    getSnapshot: () => ({
      busy: false,
      confirmation: undefined,
      error: undefined,
      input: undefined,
      rowIndex: 0,
      rows: [],
      section: 'models',
      sections: ['models', 'providers', 'access', 'presets', 'settings', 'credentials', 'plugins', 'extensions'],
      selectedActionId: undefined,
      status: '',
    }),
    move: () => {},
    moveAction: () => {},
    moveSection: () => {},
    perform: () => Promise.resolve(false),
    refresh: () => Promise.resolve(),
    selectRow: () => {},
    selectSection: () => {},
    setInput: () => {},
    submitInput: () => Promise.resolve(false),
    subscribe: () => () => {},
  }
}

function fixture(control: Control): Context {
  const ctx = new Context()
  const slots: TuiSlots = {
    errors: [],
    registry: undefined,
    dispose: () => {},
    subscribeErrors: () => () => {},
    register(owner, contribution) {
      control.activeSlots += 1
      const route = contribution.slots['route.settings']
      if (typeof route === 'function') {
        // Core slot context stays opaque in this wiring-only fixture.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        control.renderSettings = () => route({} as never, { focused: true })
      }
      const disposeEffect = owner.effect(() => () => { control.activeSlots -= 1 }, 'settings slot fixture')
      return () => { void disposeEffect() }
    },
  }
  const commands = {
    register(owner: Context, layer: { commands: readonly { name: string }[] }) {
      control.activeCommands += 1
      control.commandNames.push(...layer.commands.map(command => command.name))
      const disposeEffect = owner.effect(() => () => { control.activeCommands -= 1 }, 'settings command fixture')
      return () => { void disposeEffect() }
    },
  }
  const remote = {
    $on() {
      control.activeEvents += 1
      let active = true
      return () => {
        if (!active) return
        active = false
        control.activeEvents -= 1
      }
    },
  }
  /* oxlint-disable typescript/no-unsafe-type-assertion -- Wiring fixture supplies identities only. */
  ctx.provide('tuiClient', {
    api: {},
    remote,
    sessions: { list: { getSnapshot: () => ({ current: undefined }) } },
  } as unknown as TuiClientFacade)
  ctx.provide('tuiKernel', {
    ready: true,
    resources: {
      slots,
      navigation: { getSnapshot: () => ({ route: 'settings', overlays: [] }), go: () => {} },
      renderer: { currentFocusedEditor: null },
      commands,
      theme: {},
    },
  } as never)
  /* oxlint-enable typescript/no-unsafe-type-assertion */
  return ctx
}

async function mountCycle(control: Control): Promise<void> {
  const ctx = fixture(control)
  const controller = fakeController(control)
  mountSettings(ctx, {
    createController: () => controller,
    createView: (_renderer, _theme, received) => {
      control.renderedController = received
      // Slot adapter never renders this fixture node.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return {} as BaseRenderable
    },
  })
  assert.equal(control.activeSlots, 1)
  assert.equal(control.activeCommands, 1)
  assert.equal(control.activeEvents, 6)
  control.renderSettings?.()
  assert.equal(control.renderedController, controller)
  await ctx.fiber.dispose()
  assert.equal(control.activeSlots, 0)
  assert.equal(control.activeCommands, 0)
  assert.equal(control.activeEvents, 0)
}

test('recomposition leaves no duplicate settings slots, commands, or subscriptions', async () => {
  const control: Control = {
    activeCommands: 0,
    activeEvents: 0,
    activeSlots: 0,
    commandNames: [],
    controllerDisposals: 0,
    renderedController: undefined,
    renderSettings: undefined,
  }

  await mountCycle(control)
  await mountCycle(control)

  assert.ok(control.commandNames.includes('settings.primary'))
  assert.ok(control.commandNames.includes('settings.section.extensions'))
  assert.equal(control.controllerDisposals, 2)
})
