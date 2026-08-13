import assert from 'node:assert/strict'
import { test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Keymap } from '@opentui/keymap'
import { createTuiCommands } from '../../src/services/commands.js'
import type { TuiKeymap } from '../../src/contracts/commands.js'

const COMMAND_NAME = 'route.sessions'
const COMMAND_LAYER = {
  id: 'sessions-navigation',
  bindings: [{ key: 'gs', command: COMMAND_NAME }],
  commands: [{
    name: COMMAND_NAME,
    description: 'Open sessions',
    run: () => {},
  }],
} as const

class KeyEventFixture {
  readonly name: string
  readonly ctrl = false
  readonly shift = false
  readonly meta = false
  readonly super = false
  propagationStopped = false
  defaultPrevented = false

  constructor(name: string) {
    this.name = name
  }

  preventDefault(): void { this.defaultPrevented = true }
  stopPropagation(): void { this.propagationStopped = true }
}

function keymapFixture(): {
  readonly cleanup: () => void
  readonly keymap: TuiKeymap
  readonly press: (key: string) => KeyEventFixture
} {
  const root = { id: 'root', parent: null }
  const listeners = new Set<(event: KeyEventFixture) => void>()
  const destroyListeners = new Set<() => void>()
  const keymap = new Keymap({
    metadata: {
      platform: 'linux',
      primaryModifier: 'ctrl',
      modifiers: {
        ctrl: 'supported',
        shift: 'supported',
        meta: 'supported',
        super: 'supported',
        hyper: 'unsupported',
      },
    },
    rootTarget: root,
    isDestroyed: false,
    getFocusedTarget: () => null,
    getParentTarget: () => null,
    isTargetDestroyed: () => false,
    onKeyPress: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    onKeyRelease: () => () => {},
    onFocusChange: () => () => {},
    onDestroy: listener => { destroyListeners.add(listener); return () => { destroyListeners.delete(listener) } },
    onTargetDestroy: () => () => {},
    createCommandEvent: () => new KeyEventFixture('command'),
  })
  return {
    // Structural fixture matches adapter contract without native Renderable allocation.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    keymap: keymap as unknown as TuiKeymap,
    press: key => {
      const event = new KeyEventFixture(key)
      for (const listener of listeners) listener(event)
      return event
    },
    cleanup: () => {
      for (const listener of destroyListeners) listener()
      listeners.clear()
    },
  }
}

test('registers discoverable commands and dispatches configured sequences', () => {
  const ctx = new Context()
  const harness = keymapFixture()
  const commands = createTuiCommands(harness.keymap)
  const dispose = commands.register(ctx, COMMAND_LAYER)

  const listed = commands.list({ visibility: 'registered' })
  assert.deepEqual(listed.map(item => item.name), [COMMAND_NAME])
  assert.deepEqual(listed[0]?.bindings, ['g s'])

  harness.press('g')
  assert.equal(harness.press('s').defaultPrevented, true)
  assert.equal(harness.press('x').defaultPrevented, false)

  dispose()
  assert.deepEqual(commands.list({ visibility: 'registered' }), [])
  commands.dispose()
  harness.cleanup()
})

test('reports shadowed bindings as conflicts', () => {
  const ctx = new Context()
  const harness = keymapFixture()
  const commands = createTuiCommands(harness.keymap)
  const first = commands.register(ctx, {
    id: 'first',
    priority: 10,
    bindings: [{ key: 'x', command: 'first.run' }],
    commands: [{ name: 'first.run', description: 'First', run: () => {} }],
  })
  const second = commands.register(ctx, {
    id: 'second',
    bindings: [{ key: 'x', command: 'second.run' }],
    commands: [{ name: 'second.run', description: 'Second', run: () => {} }],
  })

  assert.deepEqual(commands.conflicts().map(conflict => conflict.key), ['x'])
  second()
  first()
  commands.dispose()
  harness.cleanup()
})

test('rejects registrations after service disposal', () => {
  const ctx = new Context()
  const harness = keymapFixture()
  const commands = createTuiCommands(harness.keymap)
  commands.dispose()

  assert.throws(() => commands.register(ctx, COMMAND_LAYER), /disposed/u)
  harness.cleanup()
})

test('rolls back command registration when owner is inactive', async () => {
  const ctx = new Context()
  const harness = keymapFixture()
  const commands = createTuiCommands(harness.keymap)
  const owner = await ctx.plugin({ name: 'inactive-command-owner', apply() {} })
  await owner.dispose()

  assert.throws(() => commands.register(owner.ctx, COMMAND_LAYER), /inactive context/u)
  assert.deepEqual(commands.list({ visibility: 'registered' }), [])

  commands.dispose()
  harness.cleanup()
})

test('removes command layers with their contributing Cordis fiber', async () => {
  const ctx = new Context()
  const harness = keymapFixture()
  const commands = createTuiCommands(harness.keymap)
  ctx.provide('tuiCommands', commands)
  const feature = await ctx.plugin({
    name: 'command-feature-fixture',
    inject: ['tuiCommands'],
    apply(inner) {
      inner.tuiCommands.register(inner, COMMAND_LAYER)
    },
  })

  assert.deepEqual(commands.list({ visibility: 'registered' }).map(item => item.name), [COMMAND_NAME])
  await feature.dispose()
  assert.deepEqual(commands.list({ visibility: 'registered' }), [])

  commands.dispose()
  harness.cleanup()
})
