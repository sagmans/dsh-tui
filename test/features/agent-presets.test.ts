import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import {
  createSettingsController,
  type ConfigurationListState,
  type ConfigurationPort,
} from '../../src/features/settings/model.js'
import { createNavigationStore } from '../../src/kernel/navigation.js'

// Static fixture identity crosses only the Harness brand boundary.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const SESSION_ID = 'preset-session' as SessionId
const ACCESS_DEFAULT_ACTION = 'access.default'
const NOOP_RESULT = Promise.resolve({ ok: true as const, value: undefined })

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

function port(calls: unknown[]): ConfigurationPort {
  return {
    credentials: () => Promise.resolve({ ok: true, value: {} }),
    defaultPreset: preset => { calls.push(`preset-default:${preset}`); return NOOP_RESULT },
    discoverProviderModels: () => Promise.resolve({ ok: true, value: [] }),
    extensions: () => Promise.resolve({ ok: true, value: [] }),
    models: () => Promise.resolve({ ok: true, value: {
      current: { provider: 'deepseek', model: 'chat' }, failures: [], groups: [], routable: true,
    } }),
    mutateSettings: (namespace, operations, revision) => {
      calls.push({ namespace, operations, revision })
      return NOOP_RESULT
    },
    openPreset: () => Promise.resolve({ ok: true, value: { opened: false } }),
    openSettings: () => NOOP_RESULT,
    plugins: () => Promise.resolve({ ok: true, value: [] }),
    presets: () => Promise.resolve({ ok: true, value: {
      authorable: true,
      hasDocument: false,
      presets: [
        { id: 'standard', isDefault: true, name: 'Standard', trust: 'system' },
        { id: 'code', isDefault: false, name: 'Code', trust: 'system' },
      ],
    } }),
    providerCatalog: () => Promise.resolve({ ok: true, value: [] }),
    readPreset: preset => Promise.resolve({ ok: true, value: `preset:${preset}` }),
    removeExtension: () => NOOP_RESULT,
    removePreset: () => NOOP_RESULT,
    resetSetting: () => NOOP_RESULT,
    runExtension: () => NOOP_RESULT,
    selectAccess: (_sessionId, preset) => { calls.push(`access-current:${preset}`); return NOOP_RESULT },
    selectModel: () => NOOP_RESULT,
    selectPreset: (_sessionId, preset) => { calls.push(`preset-current:${preset}`); return NOOP_RESULT },
    setCredential: () => NOOP_RESULT,
    settings: () => Promise.resolve({ ok: true, value: {
      hasDocument: false,
      namespaces: [{
        applies: 'live',
        ns: 'permission',
        revision: 4,
        schema: {},
        secrets: [],
        value: { defaultPreset: 'workspace-write' },
      }],
      writable: true,
    } }),
    stopExtension: () => NOOP_RESULT,
    unsetCredential: () => NOOP_RESULT,
    copyPreset: () => NOOP_RESULT,
  }
}

function fixture() {
  const calls: unknown[] = []
  const list = source<ConfigurationListState>({
    current: SESSION_ID,
    byId: {
      [SESSION_ID]: {
        agentPreset: 'standard',
        blank: true,
        projectionValues: {
          permissions: {
            currentValue: 'read-only',
            options: [
              { name: 'Read Only', value: 'read-only' },
              { name: 'Workspace Write', value: 'workspace-write' },
              { name: 'Full Access', value: 'danger-full-access' },
            ],
          },
        },
      },
    },
  })
  return {
    calls,
    controller: createSettingsController({ list, navigation: createNavigationStore(), port: port(calls) }),
    list,
  }
}

async function open(
  controller: ReturnType<typeof createSettingsController>,
  section: 'access' | 'presets',
): Promise<void> {
  controller.selectSection(section)
  await controller.refresh()
}

test('manages defaults and only switches the preset of a blank session', async () => {
  const { calls, controller, list } = fixture()
  await controller.activate()
  await open(controller, 'presets')
  const code = controller.getSnapshot().rows.findIndex(row => row.id === 'preset:code')
  controller.selectRow(code)

  assert.equal(await controller.perform('preset.default'), true)
  assert.equal(await controller.perform('preset.select'), true)
  list.publish({
    current: SESSION_ID,
    byId: { [SESSION_ID]: { ...list.getSnapshot().byId[SESSION_ID]!, blank: false } },
  })
  await open(controller, 'presets')
  controller.selectRow(controller.getSnapshot().rows.findIndex(row => row.id === 'preset:code'))
  assert.equal(controller.getSnapshot().rows[controller.getSnapshot().rowIndex]?.actions.some(action => action.id === 'preset.select'), false)
  assert.deepEqual(calls, ['preset-default:code', 'preset-current:code'])
})

test('requires confirmation before making full access the future default', async () => {
  const { calls, controller } = fixture()
  await controller.activate()
  await open(controller, 'access')
  const rowIndex = controller.getSnapshot().rows.findIndex(row => row.id === 'access-default:danger-full-access')
  controller.selectRow(rowIndex)

  assert.equal(await controller.perform(), false)
  assert.equal(controller.getSnapshot().confirmation, 'access.default')
  assert.equal(await controller.perform(), true)
  assert.deepEqual(calls, [{
    namespace: 'permission',
    operations: [{ op: 'set', path: ['defaultPreset'], value: 'danger-full-access' }],
    revision: 4,
  }])
})

test('separates current-session access from the future-session default', async () => {
  const { calls, controller } = fixture()
  await controller.activate()
  await open(controller, 'access')

  const current = controller.getSnapshot().rows.find(row => row.id === 'access:workspace-write')
  const future = controller.getSnapshot().rows.find(row => row.id === 'access-default:read-only')
  assert.ok(current)
  assert.ok(future)
  assert.match(future.summary, /new sessions/u)
  const action = future.actions.find(candidate => candidate.id === ACCESS_DEFAULT_ACTION)
  assert.ok(action)
  controller.selectRow(controller.getSnapshot().rows.findIndex(row => row.id === future.id))
  assert.equal(await controller.perform(action.id), true)

  assert.deepEqual(calls, [{
    namespace: 'permission',
    operations: [{ op: 'set', path: ['defaultPreset'], value: 'read-only' }],
    revision: 4,
  }])
})
