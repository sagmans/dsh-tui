import assert from 'node:assert/strict'
import { test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { BaseRenderable } from '@opentui/core'
import type { TuiClientFacade } from '../../src/client/context.js'
import { mountInteractions } from '../../src/features/interactions/index.js'
import type { InteractionsController } from '../../src/features/interactions/model.js'
import type { TuiSlots } from '../../src/contracts/slots.js'

const OVERLAY_ID = 'interaction:a:one'

interface Control {
  readonly calls: string[]
  readonly commandNames: string[]
  controller: InteractionsController | undefined
  renderOverlay: (() => BaseRenderable) | undefined
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
      const overlay = contribution.slots.overlay
      if (typeof overlay === 'function') {
        // Core slot context stays opaque in this wiring-only fixture.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        control.renderOverlay = () => overlay({} as never, { focused: true })
      }
      const disposeEffect = owner.effect(
        () => () => { control.calls.push('slot:dispose') },
        'interactions slot fixture',
      )
      return () => { void disposeEffect() }
    },
  }
  const commands = {
    register(owner: Context, layer: { commands: readonly { name: string }[] }) {
      control.commandNames.push(...layer.commands.map(command => command.name))
      const disposeEffect = owner.effect(
        () => () => { control.calls.push('commands:dispose') },
        'interactions command fixture',
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
      navigation: { getSnapshot: () => ({ route: 'chat', overlays: [{ id: OVERLAY_ID }] }) },
      renderer: { currentFocusedEditor: null },
      commands,
      theme: {},
    },
  } as never)
  /* oxlint-enable typescript/no-unsafe-type-assertion */
  return ctx
}

test('registers fail-closed interaction overlay and disposes its controller', async () => {
  const control: Control = { calls: [], commandNames: [], controller: undefined, renderOverlay: undefined }
  const ctx = fixture(control)
  const controller = {
    dispose: () => { control.calls.push('controller:dispose') },
    getSnapshot: () => ({ overlayId: OVERLAY_ID }),
  }

  mountInteractions(ctx, {
    // Seam isolates plugin wiring from model contracts.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    createController: () => controller as unknown as InteractionsController,
    createView: (_renderer, _theme, received) => {
      control.controller = received
      // Slot adapter never renders this fixture node.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return {} as BaseRenderable
    },
  })

  assert.deepEqual(control.calls, ['slot:dsh-tui-interactions'])
  assert.deepEqual(control.commandNames, [
    'interaction.approve',
    'interaction.cancel',
    'interaction.next',
    'interaction.previous',
    'interaction.question-next',
    'interaction.question-previous',
    'interaction.reject',
    'interaction.select',
    'interaction.skip',
    'interaction.submit',
  ])
  control.renderOverlay?.()
  assert.equal(control.controller, controller)
  await ctx.fiber.dispose()
  assert.deepEqual(control.calls.slice(-3), [
    'controller:dispose',
    'commands:dispose',
    'slot:dispose',
  ])
})
