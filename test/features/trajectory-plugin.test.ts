import assert from 'node:assert/strict'
import { test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { BaseRenderable } from '@opentui/core'
import type { TuiClientFacade } from '../../src/client/context.js'
import { mountTrajectory } from '../../src/features/trajectory/index.js'
import type { TrajectoryController } from '../../src/features/trajectory/model.js'
import type { TuiSlots } from '../../src/contracts/slots.js'

interface Control {
  readonly calls: string[]
  readonly commandNames: string[]
  controller: TrajectoryController | undefined
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
        'trajectory slot fixture',
      )
      return () => { void disposeEffect() }
    },
  }
  const commands = {
    register(owner: Context, layer: { commands: readonly { name: string }[] }) {
      control.commandNames.push(...layer.commands.map(command => command.name))
      const disposeEffect = owner.effect(
        () => () => { control.calls.push('commands:dispose') },
        'trajectory command fixture',
      )
      return () => { void disposeEffect() }
    },
  }
  /* oxlint-disable typescript/no-unsafe-type-assertion -- Wiring fixture supplies identities only. */
  ctx.provide('tuiClient', { sessions: {} } as unknown as TuiClientFacade)
  ctx.provide('tuiKernel', {
    ready: true,
    resources: {
      slots,
      navigation: { getSnapshot: () => ({ route: 'chat', overlays: [{ id: 'trajectory' }] }) },
      renderer: { currentFocusedEditor: null },
      commands,
      theme: {},
    },
  } as never)
  /* oxlint-enable typescript/no-unsafe-type-assertion */
  return ctx
}

test('registers trajectory overlay, global entry, and scoped commands', async () => {
  const control: Control = { calls: [], commandNames: [], controller: undefined, renderOverlay: undefined }
  const ctx = fixture(control)
  const controller = {
    dispose: () => { control.calls.push('controller:dispose') },
    getSnapshot: () => ({ active: true }),
  }

  mountTrajectory(ctx, {
    // Seam isolates plugin wiring from the trajectory model.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    createController: () => controller as unknown as TrajectoryController,
    createView: (_renderer, _theme, received) => {
      control.controller = received
      // Slot adapter never renders this fixture node.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return {} as BaseRenderable
    },
  })

  assert.deepEqual(control.calls, ['slot:dsh-tui-trajectory'])
  assert.ok(control.commandNames.includes('trajectory.open'))
  assert.ok(control.commandNames.includes('trajectory.search'))
  assert.ok(control.commandNames.includes('trajectory.older'))
  assert.ok(control.commandNames.includes('trajectory.detail.raw'))
  control.renderOverlay?.()
  assert.equal(control.controller, controller)
  assert.equal(ctx.tuiTrajectory, controller)
  await ctx.fiber.dispose()
  assert.equal(control.calls.includes('controller:dispose'), true)
  assert.equal(control.calls.filter(call => call === 'commands:dispose').length, 2)
})
