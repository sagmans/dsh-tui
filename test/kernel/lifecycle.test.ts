import assert from 'node:assert/strict'
import { test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountKernel } from '../../src/kernel/lifecycle.js'
import type { KernelResources } from '../../src/kernel/lifecycle.js'
import { createTuiLocale } from '../../src/services/locale.js'

interface LifecycleControl {
  readonly calls: string[]
  failAt?: 'commands' | 'renderer' | 'slots'
}

function resourceFixture(control: LifecycleControl): KernelResources {
  // Lifecycle tests use only cleanup faces; renderer behavior has native tests.
  /* oxlint-disable typescript/no-unsafe-type-assertion */
  return {
    renderer: {
      root: {},
      destroy() { control.calls.push('renderer:dispose') },
    } as never,
    commands: {
      dispose() { control.calls.push('commands:dispose') },
    } as never,
    locale: createTuiLocale({ locale: 'en' }),
    slots: {
      dispose() { control.calls.push('slots:dispose') },
    } as never,
    theme: { color: true, colors: {} } as never,
    navigation: {} as never,
  }
  /* oxlint-enable typescript/no-unsafe-type-assertion */
}

function seams(control: LifecycleControl) {
  return {
    createRenderer: () => {
      control.calls.push('renderer:create')
      if (control.failAt === 'renderer') throw new Error('renderer failed')
      return Promise.resolve(resourceFixture(control).renderer)
    },
    createCommands: () => {
      control.calls.push('commands:create')
      if (control.failAt === 'commands') throw new Error('commands failed')
      return resourceFixture(control).commands
    },
    createLocale: () => resourceFixture(control).locale,
    createSlots: () => {
      control.calls.push('slots:create')
      if (control.failAt === 'slots') throw new Error('slots failed')
      return resourceFixture(control).slots
    },
    createTheme: () => resourceFixture(control).theme,
    createNavigation: () => resourceFixture(control).navigation,
  }
}

test('publishes kernel services and tears resources down in reverse ownership order', async () => {
  const ctx = new Context()
  ctx.provide('tuiClient', { api: {}, context: ctx })
  const control: LifecycleControl = { calls: [] }
  await mountKernel(ctx, seams(control))

  assert.notEqual(ctx.get('tuiHost'), undefined)
  assert.notEqual(ctx.get('tuiSlots'), undefined)
  assert.notEqual(ctx.get('tuiCommands'), undefined)
  assert.notEqual(ctx.get('tuiLocale'), undefined)
  assert.notEqual(ctx.get('tuiTheme'), undefined)

  await ctx.fiber.dispose()
  assert.deepEqual(control.calls, [
    'renderer:create',
    'commands:create',
    'slots:create',
    'slots:dispose',
    'commands:dispose',
    'renderer:dispose',
  ])
})

test('cleans earlier resources when startup fails', async () => {
  const ctx = new Context()
  ctx.provide('tuiClient', { api: {}, context: ctx })
  const control: LifecycleControl = { calls: [], failAt: 'slots' }

  await assert.rejects(mountKernel(ctx, seams(control)), /slots failed/u)
  assert.deepEqual(control.calls, [
    'renderer:create',
    'commands:create',
    'slots:create',
    'commands:dispose',
    'renderer:dispose',
  ])
  assert.equal(ctx.get('tuiHost'), undefined)
})
