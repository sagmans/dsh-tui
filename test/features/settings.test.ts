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
import { createTuiLocale } from '../../src/services/locale.js'
import { createTuiTheme } from '../../src/services/theme.js'

// Static fixture identities cross only Harness brand boundaries.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const SESSION_ID = 'session-one' as SessionId
const SECRET_VALUE = 'never-render-this-secret'
const SHELL_NAMESPACE = 'shell'
const AGENT_LOOP_NAMESPACE = 'agent-loop'
const WEB_SEARCH_NAMESPACE = 'web-search-deepseek'
const WEB_SEARCH_CREDENTIAL_REF = 'DEEPSEEK_API_KEY'

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
  const mutations: unknown[] = []
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
    providerCatalog: () => Promise.resolve({ ok: true, value: [] }),
    discoverProviderModels: () => Promise.resolve({ ok: true, value: [] }),
    mutateSettings: (namespace, operations, revision) => {
      mutations.push({ namespace, operations, revision })
      return Promise.resolve({ ok: true, value: undefined })
    },
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
      namespaces: [
        {
          ns: 'llm-deepseek',
          schema: {},
          value: { apiKeyEnv: WEB_SEARCH_CREDENTIAL_REF, endpoint: 'https://api.deepseek.com' },
          user: { endpoint: 'https://api.deepseek.com' },
          applies: 'live',
          secrets: [{ path: ['apiKey'], set: true }],
          revision: 3,
        },
        {
          ns: SHELL_NAMESPACE,
          schema: {},
          base: { timeoutMs: 60_000, maxOutputBytes: 64_000 },
          value: { timeoutMs: 9_000, maxOutputBytes: 64_000 },
          user: { timeoutMs: 9_000 },
          applies: 'live',
          secrets: [],
          revision: 4,
        },
        {
          ns: AGENT_LOOP_NAMESPACE,
          schema: {},
          base: { maxParallelToolCalls: 4 },
          value: { maxParallelToolCalls: 4 },
          user: {},
          applies: 'live',
          secrets: [],
          revision: 5,
        },
        {
          ns: WEB_SEARCH_NAMESPACE,
          schema: {},
          base: { baseURL: 'https://api.deepseek.com', maxUses: 5 },
          value: { apiKeyEnv: WEB_SEARCH_CREDENTIAL_REF, baseURL: 'https://search.example', maxUses: 5 },
          user: { baseURL: 'https://search.example' },
          applies: 'live',
          secrets: [{ path: ['apiKey'], set: true }],
          revision: 6,
        },
      ],
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
  const controller = createSettingsController({
    list,
    locale: createTuiLocale({ locale: 'en' }),
    navigation,
    port,
    theme: createTuiTheme({ color: true }),
  })
  return { calls, controller, list, mutations, navigation, port }
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
  assert.equal(controller.getSnapshot().rows[0]?.id, 'plugin-setting:shell:timeoutMs')
  await section(controller, 'extensions')
  assert.match(controller.getSnapshot().rows.find(row => row.id.includes('dyn-web'))?.details ?? '', /Browser client half/u)
  assert.equal(controller.getSnapshot().rows.some(row => row.summary === 'enabled · active'), true)
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

test('cycles every enabled row action and runs the selected action', async () => {
  const { calls, controller } = fixture()
  await controller.activate()
  await section(controller, 'presets')
  controller.selectRow(1)

  assert.equal(controller.getSnapshot().selectedActionId, 'preset.select')
  controller.moveAction(1)
  assert.equal(controller.getSnapshot().selectedActionId, 'preset.default')
  assert.equal(await controller.perform(), true)
  controller.moveAction(-1)
  assert.equal(controller.getSnapshot().selectedActionId, 'preset.select')

  assert.deepEqual(calls, ['preset:default:mine'])
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

test('projects field-level plugin settings with inherited, overridden, and write-only state', async () => {
  const { controller } = fixture()
  await controller.activate()
  await section(controller, 'plugins')

  const timeout = controller.getSnapshot().rows.find(row => row.id === 'plugin-setting:shell:timeoutMs')
  const output = controller.getSnapshot().rows.find(row => row.id === 'plugin-setting:shell:maxOutputBytes')
  const parallel = controller.getSnapshot().rows.find(row => row.id === 'plugin-setting:agent-loop:maxParallelToolCalls')
  const key = controller.getSnapshot().rows.find(row => row.id === 'plugin-setting:web-search-deepseek:apiKey')
  assert.match(timeout?.summary ?? '', /9000.*overridden/u)
  assert.match(output?.summary ?? '', /64000.*inherited/u)
  assert.match(parallel?.summary ?? '', /4.*inherited/u)
  assert.equal(timeout?.actions.some(action => action.id === 'plugin-setting.edit'), true)
  assert.equal(timeout?.actions.some(action => action.id === 'plugin-setting.reset'), true)
  assert.equal(output?.actions.some(action => action.id === 'plugin-setting.reset'), false)
  assert.equal(key?.actions.some(action => action.id === 'plugin-setting.credential'), true)
  assert.equal(JSON.stringify(key).includes(SECRET_VALUE), false)
})

test('edits and resets plugin fields with revision-fenced writes', async () => {
  const { controller, mutations } = fixture()
  await controller.activate()
  await section(controller, 'plugins')
  const timeoutIndex = controller.getSnapshot().rows.findIndex(row => row.id === 'plugin-setting:shell:timeoutMs')
  controller.selectRow(timeoutIndex)

  assert.equal(await controller.perform('plugin-setting.edit'), true)
  assert.equal(controller.getSnapshot().input?.value, '9000')
  controller.setInput('12000')
  assert.equal(await controller.submitInput(), true)
  assert.deepEqual(mutations, [{
    namespace: SHELL_NAMESPACE,
    operations: [{ op: 'set', path: ['timeoutMs'], value: 12_000 }],
    revision: 4,
  }])

  assert.equal(await controller.perform('plugin-setting.reset'), true)
  assert.deepEqual(mutations.at(-1), {
    namespace: SHELL_NAMESPACE,
    operations: [{ op: 'unset', path: ['timeoutMs'] }],
    revision: 4,
  })
})

test('rejects invalid plugin numbers without writing', async () => {
  const { controller, mutations } = fixture()
  await controller.activate()
  await section(controller, 'plugins')
  controller.selectRow(controller.getSnapshot().rows.findIndex(row => row.id === 'plugin-setting:shell:timeoutMs'))

  assert.equal(await controller.perform('plugin-setting.edit'), true)
  controller.setInput('soon')
  assert.equal(await controller.submitInput(), false)
  assert.match(controller.getSnapshot().error ?? '', /finite number/u)
  assert.equal(controller.getSnapshot().input?.value, 'soon')
  assert.deepEqual(mutations, [])
})

test('writes plugin credentials without exposing literals in snapshots', async () => {
  const { calls, controller } = fixture()
  await controller.activate()
  await section(controller, 'plugins')
  controller.selectRow(controller.getSnapshot().rows.findIndex(row => row.id === 'plugin-setting:web-search-deepseek:apiKey'))

  assert.equal(await controller.perform('plugin-setting.credential'), true)
  assert.equal(controller.getSnapshot().input?.secret, true)
  controller.setInput(SECRET_VALUE)
  assert.equal(JSON.stringify(controller.getSnapshot()).includes(SECRET_VALUE), false)
  assert.equal(await controller.submitInput(), true)
  assert.equal(JSON.stringify(controller.getSnapshot()).includes(SECRET_VALUE), false)
  assert.equal(calls.includes(`credential:set:${WEB_SEARCH_CREDENTIAL_REF}:${SECRET_VALUE}`), true)
})

test('fences plugin drafts to their opening revision and retains rejected text', async () => {
  const { controller, mutations, port } = fixture()
  await controller.activate()
  await section(controller, 'plugins')
  controller.selectRow(controller.getSnapshot().rows.findIndex(row => row.id === 'plugin-setting:shell:timeoutMs'))
  assert.equal(await controller.perform('plugin-setting.edit'), true)
  controller.setInput('12000')

  const refreshedSettings = await port.settings()
  assert.equal(refreshedSettings.ok, true)
  if (!refreshedSettings.ok) return
  port.settings = () => Promise.resolve({
    ok: true,
    value: {
      ...refreshedSettings.value,
      namespaces: refreshedSettings.value.namespaces.map(namespace => namespace.ns === SHELL_NAMESPACE
        ? { ...namespace, revision: 7, value: { timeoutMs: 15_000, maxOutputBytes: 64_000 } }
        : namespace),
    },
  })
  port.mutateSettings = (namespace, operations, revision) => {
    mutations.push({ namespace, operations, revision })
    return Promise.resolve({ ok: false, error: { code: 'revision-conflict', message: 'stale revision' } })
  }
  await controller.refresh()

  assert.equal(await controller.submitInput(), false)
  assert.deepEqual(mutations, [{
    namespace: SHELL_NAMESPACE,
    operations: [{ op: 'set', path: ['timeoutMs'], value: 12_000 }],
    revision: 4,
  }])
  assert.equal(controller.getSnapshot().input?.value, '12000')
  assert.match(controller.getSnapshot().error ?? '', /stale revision.*revision-conflict/u)
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
