import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { KeyEvent, Renderable } from '@opentui/core'
import type { CommandContext } from '@opentui/keymap'
import type { ModelSelection, SessionId, SessionModels } from '@deepseek-ai/dsh-api-remotes/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { createNavigationStore } from '../../src/kernel/navigation.js'
import {
  createModelSelectionController,
  type ModelSelectionController,
  type ModelSelectionControllerOptions,
  type ModelSelectionEntry,
  type ModelSelectionPort,
  type ModelSelectionResult,
} from '../../src/features/model-selection/model.js'
import { modelSelectionCommands } from '../../src/features/model-selection/index.js'

// Static fixture identities cross only Harness brand boundaries.
/* oxlint-disable typescript/no-unsafe-type-assertion */
const BLANK_SESSION_ID = 'blank-session' as SessionId
const ACTIVE_SESSION_ID = 'active-session' as SessionId
/* oxlint-enable typescript/no-unsafe-type-assertion */
const NOOP = (): void => {}
// Command handlers ignore render context; fixture preserves public signature.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const COMMAND_CONTEXT = Object.freeze({}) as unknown as CommandContext<Renderable, KeyEvent>

interface MutableSource<T> extends ObservableSnapshot<T> {
  publish(next: T): void
}

function source<T>(initial: T): MutableSource<T> {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => current,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    publish(next) {
      current = next
      for (const listener of listeners) listener()
    },
  }
}

function success<T>(value: T): ModelSelectionResult<T> {
  return { ok: true, value }
}

function directory(current?: ModelSelection): SessionModels {
  return {
    current: current ?? { provider: 'deepseek', model: 'flash', reasoningEffort: 'high' },
    routable: true,
    groups: [{
      id: 'deepseek',
      name: 'DeepSeek',
      models: [
        {
          id: 'flash',
          name: 'Flash',
          description: 'Fast',
          reasoning: {
            defaultEffort: 'high',
            efforts: [
              { id: 'off', name: 'Off' },
              { id: 'high', name: 'High' },
              { id: 'max', name: 'Max', description: 'Largest budget' },
            ],
          },
        },
        {
          id: 'pro',
          name: 'Pro',
          reasoning: {
            defaultEffort: 'max',
            efforts: [{ id: 'high', name: 'High' }, { id: 'max', name: 'Max' }],
          },
        },
      ],
    }],
    failures: [],
  }
}

function fixture(input: {
  readonly available?: (sessionId: SessionId) => boolean
  readonly directory?: ReturnType<typeof directory>
} = {}) {
  const list = source({
    current: BLANK_SESSION_ID,
    byId: {
      [BLANK_SESSION_ID]: { blank: true },
      [ACTIVE_SESSION_ID]: { blank: false },
    },
  })
  let currentDirectory = input.directory ?? directory()
  const loads: SessionId[] = []
  const selections: Array<{ readonly sessionId: SessionId; readonly selection: Parameters<ModelSelectionPort['select']>[1] }> = []
  const providerHandoffs: number[] = []
  const port: ModelSelectionPort = {
    models(sessionId) {
      loads.push(sessionId)
      return Promise.resolve(success(currentDirectory))
    },
    select(sessionId, selection) {
      selections.push({ sessionId, selection })
      currentDirectory = { ...currentDirectory, current: selection, routable: true }
      return Promise.resolve(success(selection))
    },
  }
  const options: ModelSelectionControllerOptions = {
    available: input.available ?? (() => true),
    list,
    navigation: createNavigationStore(),
    openProviders: () => { providerHandoffs.push(1) },
    port,
  }
  return {
    controller: createModelSelectionController(options),
    list,
    loads,
    providerHandoffs,
    selections,
  }
}

async function openPane(
  controller: ReturnType<typeof createModelSelectionController>,
  entry: ModelSelectionEntry,
  row: number,
): Promise<void> {
  assert.equal(await controller.open(entry), true)
  controller.selectRow(row)
  assert.equal(await controller.activate(), true)
}

test('shares host selection across composer model and reasoning panes', async () => {
  const { controller, selections } = fixture()

  assert.equal(await controller.open('composer'), true)
  let view = controller.getSnapshot()
  assert.equal(view.pane, 'root')
  assert.equal(view.currentLabel, 'Flash')
  assert.equal(view.effortLabel, 'High')
  assert.deepEqual(view.rows.map(row => row.title), ['Model', 'Effort'])

  controller.selectRow(0)
  assert.equal(await controller.activate(), true)
  assert.equal(controller.getSnapshot().pane, 'model')
  controller.selectRow(1)
  assert.equal(await controller.activate(), true)
  assert.deepEqual(selections.at(-1)?.selection, {
    provider: 'deepseek',
    model: 'pro',
    reasoningEffort: 'max',
  })

  await openPane(controller, 'composer', 1)
  assert.equal(controller.getSnapshot().pane, 'effort')
  controller.selectRow(0)
  assert.equal(await controller.activate(), true)
  assert.deepEqual(selections.at(-1)?.selection, {
    provider: 'deepseek',
    model: 'pro',
    reasoningEffort: 'high',
  })

  view = controller.getSnapshot()
  assert.equal(view.active, false)
  assert.equal(view.currentLabel, 'Pro')
  assert.equal(view.effortLabel, 'High')
})

test('uses model default effort for /model and supports blank plus active sessions', async () => {
  const { controller, list, loads, selections } = fixture()

  assert.equal(await controller.open('command'), true)
  assert.equal(controller.getSnapshot().pane, 'model')
  controller.selectRow(1)
  assert.equal(await controller.activate(), true)
  assert.deepEqual(selections.at(-1), {
    sessionId: BLANK_SESSION_ID,
    selection: { provider: 'deepseek', model: 'pro', reasoningEffort: 'max' },
  })

  list.publish({
    current: ACTIVE_SESSION_ID,
    byId: {
      [BLANK_SESSION_ID]: { blank: true },
      [ACTIVE_SESSION_ID]: { blank: false },
    },
  })
  assert.equal(await controller.open('command'), true)
  assert.equal(loads.includes(BLANK_SESSION_ID), true)
  assert.equal(loads.includes(ACTIVE_SESSION_ID), true)
})

test('blocks only an explicitly unroutable route and offers provider setup', async () => {
  const unroutable = { ...directory(), routable: false }
  const { controller, providerHandoffs } = fixture({ directory: unroutable })

  assert.equal(await controller.open('composer'), true)
  assert.equal(controller.getSnapshot().blocked, true)
  assert.equal(controller.getSnapshot().routable, false)
  controller.openProviders()

  assert.deepEqual(providerHandoffs, [1])
  assert.equal(controller.getSnapshot().active, false)
})

test('treats missing catalog membership as display fallback, not route failure', async () => {
  const unadvertised = directory({ provider: 'deepseek', model: 'retired' })
  const { controller } = fixture({ directory: unadvertised })

  assert.equal(await controller.open('composer'), true)
  const view = controller.getSnapshot()

  assert.equal(view.currentLabel, 'Select model')
  assert.equal(view.effortLabel, undefined)
  assert.equal(view.blocked, false)
  assert.deepEqual(view.rows.map(row => row.title), ['Model'])
})

test('withholds selection from unsupported addressed sessions', async () => {
  const { controller, loads } = fixture({ available: () => false })

  assert.equal(await controller.open('composer'), false)
  assert.equal(controller.getSnapshot().available, false)
  assert.deepEqual(loads, [])
})

test('maps keyboard commands to the same controller actions', async () => {
  const calls: string[] = []
  const controller: ModelSelectionController = {
    activate: () => { calls.push('activate'); return Promise.resolve(true) },
    back: () => { calls.push('back') },
    close: () => { calls.push('close') },
    dispose: NOOP,
    getSnapshot: () => ({
      active: true,
      available: true,
      blocked: false,
      busy: false,
      currentLabel: 'Flash',
      effortLabel: 'High',
      entry: 'composer',
      error: undefined,
      overlayId: 'model-selection',
      pane: 'root',
      routable: true,
      rowIndex: 0,
      rows: [],
      status: 'Ready',
    }),
    move: (delta: number) => { calls.push(`move:${delta}`) },
    open: () => Promise.resolve(true),
    openProviders: () => { calls.push('providers') },
    refresh: () => { calls.push('refresh'); return Promise.resolve() },
    selectRow: NOOP,
    subscribe: () => NOOP,
  }
  const layer = modelSelectionCommands(controller, () => true)
  for (const name of [
    'model-selection.next',
    'model-selection.previous',
    'model-selection.select',
    'model-selection.back',
    'model-selection.providers',
    'model-selection.refresh',
  ]) {
    const command = layer.commands.find(candidate => candidate.name === name)
    assert.ok(command)
    await command.run(COMMAND_CONTEXT)
  }

  assert.deepEqual(calls, ['move:1', 'move:-1', 'activate', 'back', 'providers', 'refresh'])
  assert.equal(layer.bindings.some(binding => binding.key === 'return' && binding.command === 'model-selection.select'), true)
  assert.equal(layer.bindings.some(binding => binding.key === 'escape' && binding.command === 'model-selection.back'), true)
})
