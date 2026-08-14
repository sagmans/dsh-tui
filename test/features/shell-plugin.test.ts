import assert from 'node:assert/strict'
import { test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { KernelResources } from '../../src/kernel/lifecycle.js'
import { Config, DEFAULT_SHELL_CONFIG, mountShell } from '../../src/features/shell/index.js'

interface ShellPluginControl {
  readonly calls: string[]
  readonly commandNames: string[]
  failViewAdd?: boolean
}

// One fixture preserves service identity and teardown ordering across the complete plugin seam.
// oxlint-disable-next-line eslint/max-lines-per-function
function contextFixture(control: ShellPluginControl): Context {
  const ctx = new Context()
  const navigation = {
    getSnapshot: () => ({ route: 'chat' as const, overlays: [] }),
    subscribe: () => () => {},
    go: () => {},
    back: () => {},
    openOverlay: () => {},
    closeOverlay() {},
  }
  const commands = {
    keymap: {},
    conflicts: () => [],
    dispose: () => {},
    list: () => [],
    run: () => ({ ok: true as const }),
    subscribe: () => () => {},
    register(owner: Context, layer: { commands: readonly { name: string }[] }) {
      control.commandNames.push(...layer.commands.map(command => command.name))
      control.calls.push('commands:register')
      const disposeEffect = owner.effect(
        () => () => { control.calls.push('commands:dispose') },
        'shell plugin command fixture',
      )
      return () => { void disposeEffect() }
    },
  }
  const slots = {
    errors: [],
    registry: { context: { client: {} } },
    dispose: () => {},
    subscribeErrors: () => () => {},
    register() { return () => {} },
  }
  const renderer = {
    root: {
      add: () => {
        control.calls.push('view:add')
        if (control.failViewAdd === true) throw new Error('view add failed')
      },
    },
    destroy: () => { control.calls.push('renderer:destroy') },
  }
  // Plugin lifecycle test needs service identity only; native view behavior has Bun renderer tests.
  /* oxlint-disable typescript/no-unsafe-type-assertion */
  const resources = {
    navigation,
    commands,
    slots,
    renderer,
    theme: { color: true, colors: {} },
  } as unknown as KernelResources
  ctx.provide('tuiKernel', { ready: true, resources })
  ctx.provide('tuiClient', {
    api: {},
    context: ctx,
    sessions: {
      list: {
        getSnapshot: () => ({ ids: [], byId: {}, phase: 'ready' }),
        subscribe: () => () => { control.calls.push('sessions:dispose') },
      },
      open: () => {},
      clear: () => {},
    },
  })
  /* oxlint-enable typescript/no-unsafe-type-assertion */
  return ctx
}

test('fills optional config bindings and rejects blank keys', () => {
  const valid = Config['~standard'].validate({ bindings: { quit: 'ctrl+q' } })
  assert.ok('value' in valid)
  assert.equal(valid.value.bindings.quit, 'ctrl+q')
  assert.equal(valid.value.bindings.routeChat, DEFAULT_SHELL_CONFIG.bindings.routeChat)

  const invalid = Config['~standard'].validate({ bindings: { quit: ' ' } })
  assert.ok('issues' in invalid)
  assert.match(invalid.issues[0]?.message ?? '', /quit/u)
})

// Full lifecycle assertion keeps registration and reverse teardown order in one proof.
// oxlint-disable-next-line eslint/max-lines-per-function
test('registers configurable shell commands and disposes the view before command layers', async () => {
  const control: ShellPluginControl = { calls: [], commandNames: [] }
  const ctx = contextFixture(control)

  mountShell(
    ctx,
    { ...DEFAULT_SHELL_CONFIG, bindings: { ...DEFAULT_SHELL_CONFIG.bindings, quit: 'ctrl+q' } },
    {
      mountView: () => {
        control.calls.push('view:mount')
        return {
          // Lifecycle fixture only needs root identity.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          root: {} as never,
          dispose: () => { control.calls.push('view:dispose') },
        }
      },
    },
  )

  assert.deepEqual(control.commandNames, [
    'route.chat',
    'route.sessions',
    'route.inspect',
    'route.settings',
    'session.next',
    'session.previous',
    'shell.palette',
    'shell.help',
    'shell.zen',
    'shell.escape',
    'shell.quit',
    'palette.next',
    'palette.previous',
    'palette.run',
  ])
  assert.deepEqual(control.calls.slice(0, 4), [
    'commands:register',
    'commands:register',
    'view:mount',
    'view:add',
  ])

  await ctx.fiber.dispose()
  assert.deepEqual(control.calls.slice(-4), [
    'view:dispose',
    'sessions:dispose',
    'commands:dispose',
    'commands:dispose',
  ])
})

test('rolls back shell resources when renderer insertion fails', async () => {
  const control: ShellPluginControl = { calls: [], commandNames: [], failViewAdd: true }
  const ctx = contextFixture(control)
  let viewDisposals = 0

  assert.throws(() => {
    mountShell(ctx, DEFAULT_SHELL_CONFIG, {
      mountView: () => ({
        // Lifecycle fixture only needs root identity.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        root: {} as never,
        dispose: () => { viewDisposals += 1 },
      }),
    })
  }, /view add failed/u)

  assert.equal(viewDisposals, 1)
  assert.equal(control.calls.includes('sessions:dispose'), true)
  assert.equal(control.calls.includes('commands:dispose'), true)
  await ctx.fiber.dispose()
})
