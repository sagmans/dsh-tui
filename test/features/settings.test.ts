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

// Static fixture identities cross only Harness brand boundaries.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const SESSION_ID = 'session-one' as SessionId
const SECRET_VALUE = 'never-render-this-secret'

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

function fixture() {
  const calls: string[] = []
  const list = source<ConfigurationListState>({
    current: SESSION_ID,
    byId: {
      [SESSION_ID]: {
        agentPreset: 'safe',
        blank: true,
        projectionValues: {
          permissions: {
            currentValue: 'workspace-write',
            options: [
              { value: 'read-only', name: 'Read Only' },
              { value: 'workspace-write', name: 'Workspace Write' },
              { value: 'danger-full-access', name: 'Full access' },
            ],
          },
        },
      },
    },
  })
  const port: ConfigurationPort = {
    models: () => Promise.resolve({ ok: true, value: {
      current: { provider: 'deepseek', model: 'chat', reasoningEffort: 'high' },
      routable: true,
      groups: [{
        id: 'deepseek',
        name: 'DeepSeek',
        models: [{
          id: 'chat',
          name: 'DeepSeek Chat',
          reasoning: {
            defaultEffort: 'high',
            efforts: [
              { id: 'low', name: 'Low' },
              { id: 'high', name: 'High' },
            ],
          },
        }],
      }],
      failures: [],
    } }),
    selectModel: (_sessionId, selection) => {
      calls.push(`model:${selection.provider}/${selection.model}/${selection.reasoningEffort ?? 'default'}`)
      return Promise.resolve({ ok: true, value: undefined })
    },
    selectAccess: (_sessionId, preset) => {
      calls.push(`access:${preset}`)
      return Promise.resolve({ ok: true, value: undefined })
    },
    presets: () => Promise.resolve({ ok: true, value: {
      authorable: true,
      hasDocument: false,
      presets: [
        { id: 'safe', trust: 'system', isDefault: true, name: 'Safe' },
        { id: 'mine', trust: 'user', isDefault: false, name: 'Mine' },
      ],
    } }),
    selectPreset: (_sessionId, preset) => {
      calls.push(`preset:select:${preset}`)
      return Promise.resolve({ ok: true, value: undefined })
    },
    defaultPreset: preset => {
      calls.push(`preset:default:${preset}`)
      return Promise.resolve({ ok: true, value: undefined })
    },
    readPreset: preset => Promise.resolve({ ok: true, value: `content:${preset}` }),
    copyPreset: request => {
      calls.push(`preset:copy:${request.from}:${request.id}:${request.name ?? ''}`)
      return Promise.resolve({ ok: true, value: undefined })
    },
    openPreset: preset => Promise.resolve({ ok: true, value: { opened: false, path: `/presets/${preset}` } }),
    removePreset: preset => {
      calls.push(`preset:remove:${preset}`)
      return Promise.resolve({ ok: true, value: undefined })
    },
    settings: () => Promise.resolve({ ok: true, value: {
      writable: true,
      hasDocument: true,
      namespaces: [{
        ns: 'llm-deepseek',
        schema: {},
        value: { apiKeyEnv: 'DEEPSEEK_API_KEY', endpoint: 'https://api.deepseek.com' },
        user: { endpoint: 'https://api.deepseek.com' },
        applies: 'live',
        secrets: [{ path: ['apiKey'], set: true }],
        revision: 3,
      }],
    } }),
    openSettings: () => Promise.resolve({ ok: true, value: undefined }),
    resetSetting: (namespace, revision) => {
      calls.push(`settings:reset:${namespace}:${revision}`)
      return Promise.resolve({ ok: true, value: undefined })
    },
    credentials: refs => Promise.resolve({ ok: true, value: Object.fromEntries(refs.map(ref => [ref, {
      configured: true,
      source: 'file',
      writable: true,
    }])) }),
    setCredential: (ref, value) => {
      calls.push(`credential:set:${ref}:${value}`)
      return Promise.resolve({ ok: true, value: undefined })
    },
    unsetCredential: ref => {
      calls.push(`credential:unset:${ref}`)
      return Promise.resolve({ ok: true, value: undefined })
    },
    plugins: () => Promise.resolve({ ok: true, value: [{
      entryId: 'tui-settings',
      moduleName: '@sagmans/dsh-tui/feature/settings',
      enabled: true,
      fiberPhase: 'active',
    }] }),
    extensions: () => Promise.resolve({ ok: true, value: [
      {
        pluginId: 'dyn-host',
        agentId: SESSION_ID,
        packages: [{ packageId: 'pkg-host', name: 'Host tools', purpose: 'Host-only', hasHostHalf: true, hasClientHalf: false }],
      },
      {
        pluginId: 'dyn-web',
        agentId: SESSION_ID,
        packages: [{ packageId: 'pkg-web', name: 'Web card', purpose: 'Browser-only', hasHostHalf: true, hasClientHalf: true }],
      },
    ] }),
    runExtension: request => {
      calls.push(`extension:run:${request.pluginId}:${request.packageId}:${request.mode}`)
      return Promise.resolve({ ok: true, value: undefined })
    },
    stopExtension: (_agentId, pluginId) => {
      calls.push(`extension:stop:${pluginId}`)
      return Promise.resolve({ ok: true, value: undefined })
    },
    removeExtension: (_agentId, pluginId) => {
      calls.push(`extension:remove:${pluginId}`)
      return Promise.resolve({ ok: true, value: undefined })
    },
  }
  const navigation = createNavigationStore()
  const controller = createSettingsController({ list, navigation, port })
  return { calls, controller, list, navigation, port }
}

async function section(
  controller: ReturnType<typeof createSettingsController>,
  name: Parameters<typeof controller.selectSection>[0],
): Promise<void> {
  controller.selectSection(name)
  await controller.refresh()
}

test('projects every configuration domain without exposing credential values', async () => {
  const { controller } = fixture()
  await controller.activate()
  assert.equal(controller.getSnapshot().rows.some(row => row.title.includes('DeepSeek Chat')), true)
  assert.equal(controller.getSnapshot().rows.find(row => row.id.endsWith(':high'))?.state, 'success')

  await section(controller, 'access')
  assert.equal(controller.getSnapshot().rows.some(row => row.title === 'Full access'), true)
  await section(controller, 'presets')
  assert.equal(controller.getSnapshot().rows.some(row => row.title === 'Mine'), true)
  await section(controller, 'settings')
  assert.equal(controller.getSnapshot().rows[0]?.title, 'llm-deepseek')
  await section(controller, 'credentials')
  assert.equal(controller.getSnapshot().rows[0]?.title, 'DEEPSEEK_API_KEY')
  assert.equal(JSON.stringify(controller.getSnapshot()).includes(SECRET_VALUE), false)
  await section(controller, 'plugins')
  assert.equal(controller.getSnapshot().rows[0]?.summary, 'enabled · active')
  await section(controller, 'extensions')
  assert.match(controller.getSnapshot().rows.find(row => row.id.includes('dyn-web'))?.details ?? '', /Browser client half/u)
})

test('keeps a routable current model visible when its catalog entry is absent', async () => {
  const { controller, port } = fixture()
  port.models = () => Promise.resolve({
    ok: true,
    value: {
      current: { provider: 'legacy-provider', model: 'legacy-model' },
      routable: true,
      groups: [],
      failures: [],
    },
  })
  await controller.activate()
  assert.equal(controller.getSnapshot().rows[0]?.title, 'legacy-model')
  assert.equal(controller.getSnapshot().rows[0]?.state, 'success')
  assert.deepEqual(controller.getSnapshot().rows[0]?.actions, [])
})

test('routes model, access, preset, credential, and host-only extension actions safely', async () => {
  const { calls, controller } = fixture()
  await controller.activate()
  controller.selectRow(0)
  assert.equal(await controller.perform('model.select'), true)

  await section(controller, 'access')
  controller.selectRow(2)
  assert.equal(await controller.perform('access.select'), false)
  assert.equal(controller.getSnapshot().confirmation, 'access.select')
  assert.equal(await controller.perform('access.select'), true)

  await section(controller, 'credentials')
  assert.equal(await controller.perform('credential.set'), true)
  assert.equal(controller.getSnapshot().input?.secret, true)
  controller.setInput(SECRET_VALUE)
  assert.equal(JSON.stringify(controller.getSnapshot()).includes(SECRET_VALUE), false)
  assert.equal(await controller.submitInput(), true)
  assert.equal(controller.getSnapshot().input, undefined)
  assert.equal(JSON.stringify(controller.getSnapshot()).includes(SECRET_VALUE), false)

  await section(controller, 'extensions')
  assert.equal(await controller.perform('extension.run'), true)
  controller.selectRow(1)
  assert.equal(controller.getSnapshot().rows[1]?.actions.some(action => action.id === 'extension.run'), false)

  assert.deepEqual(calls, [
    'model:deepseek/chat/low',
    'access:danger-full-access',
    `credential:set:DEEPSEEK_API_KEY:${SECRET_VALUE}`,
    'extension:run:dyn-host:pkg-host:run',
  ])
})

test('redacts credential failures after clearing write-only input', async () => {
  const { controller, port } = fixture()
  port.setCredential = () => Promise.resolve({
    ok: false,
    error: { code: 'credential-rejected', message: `rejected ${SECRET_VALUE}` },
  })
  await controller.activate()
  await section(controller, 'credentials')
  assert.equal(await controller.perform('credential.set'), true)
  controller.setInput(SECRET_VALUE)
  assert.equal(await controller.submitInput(), false)
  const serialized = JSON.stringify(controller.getSnapshot())
  assert.equal(serialized.includes(SECRET_VALUE), false)
  assert.match(controller.getSnapshot().error ?? '', /Credential update failed/u)
})

test('drops write-only input when the active session changes', async () => {
  const { calls, controller, list } = fixture()
  await controller.activate()
  await section(controller, 'credentials')
  assert.equal(await controller.perform('credential.set'), true)
  controller.setInput(SECRET_VALUE)
  list.publish({ current: undefined, byId: list.getSnapshot().byId })
  assert.equal(controller.getSnapshot().input, undefined)
  assert.equal(await controller.submitInput(), false)
  assert.deepEqual(calls, [])
})

test('confirms destructive reset, credential removal, preset removal, and extension removal', async () => {
  const { calls, controller } = fixture()
  await controller.activate()

  await section(controller, 'settings')
  assert.equal(await controller.perform('settings.reset'), false)
  assert.equal(await controller.perform('settings.reset'), true)
  await section(controller, 'credentials')
  assert.equal(await controller.perform('credential.unset'), false)
  assert.equal(await controller.perform('credential.unset'), true)
  await section(controller, 'presets')
  controller.selectRow(1)
  assert.equal(await controller.perform('preset.remove'), false)
  assert.equal(await controller.perform('preset.remove'), true)
  await section(controller, 'extensions')
  assert.equal(await controller.perform('extension.remove'), false)
  assert.equal(await controller.perform('extension.remove'), true)

  assert.deepEqual(calls, [
    'settings:reset:llm-deepseek:3',
    'credential:unset:DEEPSEEK_API_KEY',
    'preset:remove:mine',
    'extension:remove:dyn-host',
  ])
})
