import assert from 'node:assert/strict'
import { test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createTuiSlots } from '../../src/services/slots.js'
import type { TuiSlotContribution, TuiSlotRegistryAdapter } from '../../src/contracts/slots.js'

interface AdapterControl {
  readonly active: string[]
  readonly disposed: string[]
  readonly registered: string[]
}

function adapterFixture(control: AdapterControl, fail = false): TuiSlotRegistryAdapter {
  return {
    register(plugin) {
      if (fail) throw new Error('adapter failed')
      control.registered.push(plugin.id)
      if (plugin.slots.route !== undefined) control.active.push(plugin.id)
      return () => { control.disposed.push(plugin.id) }
    },
    clear() {},
  }
}

function contribution(id: string): TuiSlotContribution {
  return {
    id,
    slots: {
      route: {
        // Adapter tests registration ownership; native render nodes belong to renderer tests.
        render: () => { throw new Error('render must remain unused') },
      },
    },
  }
}

test('registers and disposes slot contributions reversibly', () => {
  const ctx = new Context()
  const control: AdapterControl = { active: [], disposed: [], registered: [] }
  const slots = createTuiSlots(adapterFixture(control))
  const dispose = slots.register(ctx, contribution('sessions'))

  assert.deepEqual(control.registered, ['sessions'])
  assert.deepEqual(control.active, ['sessions'])
  dispose()
  dispose()
  assert.deepEqual(control.disposed, ['sessions'])
})

test('rejects duplicate contribution ids until their owner disposes', () => {
  const ctx = new Context()
  const control: AdapterControl = { active: [], disposed: [], registered: [] }
  const slots = createTuiSlots(adapterFixture(control))
  const dispose = slots.register(ctx, contribution('sessions'))

  assert.throws(() => slots.register(ctx, contribution('sessions')), /duplicate TUI slot contribution/u)
  dispose()
  assert.doesNotThrow(() => slots.register(ctx, contribution('sessions')))
})

test('rejects registrations after service disposal', () => {
  const ctx = new Context()
  const control: AdapterControl = { active: [], disposed: [], registered: [] }
  const slots = createTuiSlots(adapterFixture(control))
  slots.dispose()

  assert.throws(() => slots.register(ctx, contribution('sessions')), /disposed/u)
})

test('rolls back failed registration without reserving its id', () => {
  const ctx = new Context()
  const control: AdapterControl = { active: [], disposed: [], registered: [] }
  const failing = createTuiSlots(adapterFixture(control, true))

  assert.throws(() => failing.register(ctx, contribution('sessions')), /adapter failed/u)
  const recovered = createTuiSlots(adapterFixture(control))
  assert.doesNotThrow(() => recovered.register(ctx, contribution('sessions')))
})

test('rolls back slot registration when owner is inactive', async () => {
  const ctx = new Context()
  const control: AdapterControl = { active: [], disposed: [], registered: [] }
  const slots = createTuiSlots(adapterFixture(control))
  const owner = await ctx.plugin({ name: 'inactive-slot-owner', apply() {} })
  await owner.dispose()

  assert.throws(() => slots.register(owner.ctx, contribution('sessions')), /inactive context/u)
  assert.deepEqual(control.disposed, ['sessions'])
})

test('removes error subscriptions with their owning Cordis fiber', async () => {
  const ctx = new Context()
  const control: AdapterControl = { active: [], disposed: [], registered: [] }
  const slots = createTuiSlots(adapterFixture(control))
  ctx.provide('tuiSlots', slots)
  const feature = await ctx.plugin({
    name: 'slot-error-feature-fixture',
    inject: ['tuiSlots'],
    apply(inner) {
      inner.tuiSlots.subscribeErrors(inner, () => {})
    },
  })

  await feature.dispose()
  assert.equal(feature.uid, null)
})

test('removes slot contributions with their contributing Cordis fiber', async () => {
  const ctx = new Context()
  const control: AdapterControl = { active: [], disposed: [], registered: [] }
  const slots = createTuiSlots(adapterFixture(control))
  ctx.provide('tuiSlots', slots)
  const feature = await ctx.plugin({
    name: 'slot-feature-fixture',
    inject: ['tuiSlots'],
    apply(inner) {
      inner.tuiSlots.register(inner, contribution('sessions'))
    },
  })

  assert.deepEqual(control.registered, ['sessions'])
  await feature.dispose()
  assert.deepEqual(control.disposed, ['sessions'])
})
