import assert from 'node:assert/strict'
import { test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { BaseRenderable } from '@opentui/core'
import type { TuiClientFacade } from '../../src/client/context.js'
import { mountTools } from '../../src/features/tools/index.js'
import type { ToolsController } from '../../src/features/tools/model.js'
import type { TuiSlots } from '../../src/contracts/slots.js'

interface Control {
  readonly calls: string[]
  readonly commandNames: string[]
  controller: ToolsController | undefined
  renderRoute: (() => BaseRenderable) | undefined
}

function fixture(control: Control): Context {
  const ctx = new Context()
  const slots: TuiSlots = {
    errors: [],
    registry: undefined,
    dispose: () => {},
    subscribeErrors: () => () => {},
    register(owner, contribution) {
      control.calls.push(`slot:${contribution.id}`)
      const route = contribution.slots['route.inspect']
      if (typeof route === 'function') {
        // Core slot context stays opaque in this wiring-only fixture.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        control.renderRoute = () => route({} as never, { focused: true })
      }
      const disposeEffect = owner.effect(
        () => () => { control.calls.push('slot:dispose') },
        'tools slot fixture',
      )
      return () => { void disposeEffect() }
    },
  }
  const commands = {
    register(owner: Context, layer: { commands: readonly { name: string }[] }) {
      control.commandNames.push(...layer.commands.map(command => command.name))
      const disposeEffect = owner.effect(
        () => () => { control.calls.push('commands:dispose') },
        'tools command fixture',
      )
      return () => { void disposeEffect() }
    },
  }
  // Plugin seam test needs client and renderer identities, not full runtime implementations.
  /* oxlint-disable typescript/no-unsafe-type-assertion */
  ctx.provide('tuiClient', {
    sessions: { list: {}, binding: () => undefined },
  } as unknown as TuiClientFacade)
  ctx.provide('tuiKernel', {
    ready: true,
    resources: {
      slots,
      navigation: { getSnapshot: () => ({ route: 'inspect', overlays: [] }) },
      renderer: { currentFocusedEditor: null },
      commands,
      theme: {},
    },
  } as never)
  /* oxlint-enable typescript/no-unsafe-type-assertion */
  return ctx
}

test('registers inspect contribution and disposes its controller with owner fiber', async () => {
  const control: Control = { calls: [], commandNames: [], controller: undefined, renderRoute: undefined }
  const ctx = fixture(control)
  const controller = { dispose: () => { control.calls.push('controller:dispose') } }

  mountTools(ctx, {
    // Seam isolates plugin wiring from model contracts.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    createController: () => controller as unknown as ToolsController,
    createView: (_renderer, _theme, received) => {
      control.controller = received
      // Slot adapter never renders this fixture node.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return {} as BaseRenderable
    },
  })

  assert.deepEqual(control.calls, ['slot:dsh-tui-tools'])
  assert.deepEqual(control.commandNames, [
    'tools.next',
    'tools.previous',
    'tools.file-next',
    'tools.file-previous',
    'tools.toggle',
    'tools.open',
  ])
  control.renderRoute?.()
  assert.equal(control.controller, controller)
  await ctx.fiber.dispose()
  assert.deepEqual(control.calls.slice(-3), [
    'controller:dispose',
    'commands:dispose',
    'slot:dispose',
  ])
})
