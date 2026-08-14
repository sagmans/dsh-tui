import assert from 'node:assert/strict'
import { test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { BaseRenderable } from '@opentui/core'
import type { TuiClientFacade } from '../../src/client/context.js'
import { mountSessions } from '../../src/features/sessions/index.js'
import type { SessionsController } from '../../src/features/sessions/model.js'
import type { TuiSlots } from '../../src/contracts/slots.js'

interface Control {
  readonly bindings: Array<{ readonly command: string; readonly key: string }>
  readonly calls: string[]
  readonly commandNames: string[]
  controller: SessionsController | undefined
  renderRoute: (() => BaseRenderable) | undefined
}

const EXPECTED_COMMAND_NAMES = Object.freeze([
  'sessions.next',
  'sessions.previous',
  'sessions.accept',
  'sessions.group-mode',
  'sessions.order-mode',
  'sessions.unread',
  'sessions.new',
  'sessions.search',
  'sessions.rename',
  'sessions.fork',
  'sessions.archive',
  'sessions.close',
  'sessions.load-older',
  'sessions.move-up',
  'sessions.move-down',
  'sessions.add-workspace',
  'sessions.delete-workspace',
  'sessions.escape',
  'sessions.confirm-delete',
  'sessions.cancel-delete',
])

function fixture(control: Control): Context {
  const ctx = new Context()
  const slots: TuiSlots = {
    errors: [],
    registry: undefined,
    dispose: () => {},
    subscribeErrors: () => () => {},
    register(owner, contribution) {
      control.calls.push(`slot:${contribution.id}`)
      const route = contribution.slots['route.sessions']
      if (typeof route === 'function') {
        // Core slot context stays opaque in this wiring-only fixture.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        control.renderRoute = () => route({} as never, { focused: true })
      }
      const disposeEffect = owner.effect(
        () => () => { control.calls.push('slot:dispose') },
        'sessions slot fixture',
      )
      return () => { void disposeEffect() }
    },
  }
  const commands = {
    register(owner: Context, layer: {
      bindings: readonly { readonly command: string; readonly key: string }[]
      commands: readonly { name: string }[]
    }) {
      control.bindings.push(...layer.bindings)
      control.commandNames.push(...layer.commands.map(command => command.name))
      const disposeEffect = owner.effect(
        () => () => { control.calls.push('commands:dispose') },
        'sessions command fixture',
      )
      return () => { void disposeEffect() }
    },
  }
  // Plugin seam test needs client and renderer identities, not full runtime implementations.
  /* oxlint-disable typescript/no-unsafe-type-assertion */
  ctx.provide('tuiClient', {
    sessions: { list: {}, binding: () => undefined },
    workspaces: { list: {} },
  } as unknown as TuiClientFacade)
  ctx.provide('tuiKernel', {
    ready: true,
    resources: {
      slots,
      navigation: {},
      renderer: {},
      commands,
      theme: {},
    },
  } as never)
  /* oxlint-enable typescript/no-unsafe-type-assertion */
  return ctx
}

test('registers route contribution and disposes its controller with owner fiber', async () => {
  const control: Control = {
    bindings: [],
    calls: [],
    commandNames: [],
    controller: undefined,
    renderRoute: undefined,
  }
  const ctx = fixture(control)
  const controller = {
    deactivate: () => { control.calls.push('controller:deactivate') },
    dispose: () => { control.calls.push('controller:dispose') },
  }

  mountSessions(ctx, {
    // Seam isolates plugin wiring from model contracts.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    createController: () => controller as unknown as SessionsController,
    createView: (_renderer, _theme, received) => {
      control.controller = received
      // Slot adapter never renders this fixture node.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return {} as BaseRenderable
    },
  })

  assert.deepEqual(control.calls, ['slot:dsh-tui-sessions'])
  assert.deepEqual(control.commandNames, EXPECTED_COMMAND_NAMES)
  assert.deepEqual(
    control.bindings.filter(binding => binding.command === 'sessions.group-mode'
      || binding.command === 'sessions.order-mode'),
    [
      { key: 'shift+g', command: 'sessions.group-mode' },
      { key: 'shift+s', command: 'sessions.order-mode' },
    ],
  )
  control.renderRoute?.()
  assert.equal(control.controller, controller)
  await ctx.fiber.dispose()
  assert.deepEqual(control.calls.slice(-4), [
    'controller:dispose',
    'commands:dispose',
    'commands:dispose',
    'slot:dispose',
  ])
})
