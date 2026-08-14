import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import {
  createSettingsController,
  type ConfigurationActionId,
  type ConfigurationListState,
  type ConfigurationPort,
  type ConfigurationSection,
} from '../../src/features/settings/model.js'
import { createNavigationStore } from '../../src/kernel/navigation.js'
import { createTuiLocale } from '../../src/services/locale.js'
import { createTuiTheme } from '../../src/services/theme.js'

// Static fixture identity crosses only the Harness brand boundary.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const SESSION_ID = 'provider-session' as SessionId
const PROVIDER_SECTION: ConfigurationSection = 'providers'
const PROVIDER_CREATE: ConfigurationActionId = 'provider.create'
const PROVIDER_DISCOVER: ConfigurationActionId = 'provider.discover'
const PROVIDER_MODEL_ADOPT: ConfigurationActionId = 'provider.model.adopt'
const PROVIDER_MODEL_EDIT: ConfigurationActionId = 'provider.model.edit'
const PROVIDER_REMOVE: ConfigurationActionId = 'provider.remove'
const SECRET_VALUE = 'provider-secret'
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

function fixture() {
  const calls: unknown[] = []
  const list = source<ConfigurationListState>({
    current: SESSION_ID,
    byId: { [SESSION_ID]: { blank: true } },
  })
  const port: ConfigurationPort = {
    models: () => Promise.resolve({ ok: true as const, value: {
      current: { provider: 'openai', model: 'model-a' }, routable: true, groups: [], failures: [],
    } }),
    selectModel: () => NOOP_RESULT,
    selectAccess: () => NOOP_RESULT,
    presets: () => Promise.resolve({ ok: true as const, value: {
      authorable: false, hasDocument: false, presets: [],
    } }),
    selectPreset: () => NOOP_RESULT,
    defaultPreset: () => NOOP_RESULT,
    readPreset: () => Promise.resolve({ ok: true as const, value: '' }),
    copyPreset: () => NOOP_RESULT,
    openPreset: () => Promise.resolve({ ok: true as const, value: { opened: false } }),
    removePreset: () => NOOP_RESULT,
    settings: () => Promise.resolve({ ok: true as const, value: {
      writable: true,
      hasDocument: true,
      namespaces: [{
        ns: 'llm-pi-ai',
        schema: {},
        value: {
          providers: {
            openai: {
              apiKeyEnv: 'OPENAI_API_KEY',
              api: 'openai-completions',
              baseURL: 'https://api.example/v1',
              models: [{ id: 'model-a', name: 'Model A' }],
            },
          },
        },
        user: {
          providers: {
            openai: {
              apiKeyEnv: 'OPENAI_API_KEY',
              api: 'openai-completions',
              baseURL: 'https://api.example/v1',
              models: [{ id: 'model-a', name: 'Model A' }],
            },
          },
        },
        applies: 'live' as const,
        secrets: [],
        revision: 7,
      }],
    } }),
    openSettings: () => NOOP_RESULT,
    resetSetting: () => NOOP_RESULT,
    credentials: (refs: readonly string[]) => Promise.resolve({ ok: true as const, value: Object.fromEntries(refs.map(ref => [ref, {
      configured: ref === 'OPENAI_API_KEY', writable: true,
    }])) }),
    setCredential: (ref: string, value: string) => {
      calls.push({ kind: 'credential', ref, value })
      return NOOP_RESULT
    },
    unsetCredential: (ref: string) => {
      calls.push({ kind: 'credential-unset', ref })
      return NOOP_RESULT
    },
    plugins: () => Promise.resolve({ ok: true as const, value: [] }),
    extensions: () => Promise.resolve({ ok: true as const, value: [] }),
    runExtension: () => NOOP_RESULT,
    stopExtension: () => NOOP_RESULT,
    removeExtension: () => NOOP_RESULT,
    providerCatalog: () => Promise.resolve({ ok: true as const, value: [{
      provider: 'openai',
      displayName: 'OpenAI',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'openai'],
      active: true,
      declared: false,
    }] }),
    discoverProviderModels: () => Promise.resolve({ ok: true as const, value: [{ id: 'model-b', name: 'Model B' }] }),
    mutateSettings: (namespace: string, operations: unknown, revision: number) => {
      calls.push({ kind: 'mutation', namespace, operations, revision })
      return NOOP_RESULT
    },
  }
  const controller = createSettingsController({
    list,
    locale: createTuiLocale({ locale: 'en' }),
    navigation: createNavigationStore(),
    port,
    theme: createTuiTheme({ color: true }),
  })
  return { calls, controller }
}

async function providers(controller: ReturnType<typeof createSettingsController>): Promise<void> {
  controller.selectSection(PROVIDER_SECTION)
  await controller.refresh()
}

async function submit(controller: ReturnType<typeof createSettingsController>, value: string): Promise<void> {
  controller.setInput(value)
  assert.equal(await controller.submitInput(), true)
}

test('projects configurable providers, their models, and an explicit create path', async () => {
  const { controller } = fixture()
  await controller.activate()
  await providers(controller)

  assert.equal(controller.getSnapshot().section, PROVIDER_SECTION)
  assert.equal(controller.getSnapshot().rows.some(row => row.id === 'provider:create'), true)
  assert.equal(controller.getSnapshot().rows.some(row => row.id === 'provider:openai'), true)
  assert.equal(controller.getSnapshot().rows.some(row => row.id === 'provider-model:openai:model-a'), true)
  assert.match(controller.getSnapshot().rows.find(row => row.id === 'provider:openai')?.summary ?? '', /active.*configured/u)
})

test('creates a custom provider through a write-only staged form', async () => {
  const { calls, controller } = fixture()
  await controller.activate()
  await providers(controller)

  assert.equal(await controller.perform(PROVIDER_CREATE), true)
  assert.equal(controller.getSnapshot().input?.title, 'Provider id')
  await submit(controller, 'acme-gateway')
  await submit(controller, 'Acme Gateway')
  await submit(controller, 'https://gateway.example/v1')
  await submit(controller, 'openai-completions')
  await submit(controller, 'model-a')
  assert.equal(controller.getSnapshot().input?.secret, true)
  controller.setInput(SECRET_VALUE)
  assert.equal(JSON.stringify(controller.getSnapshot()).includes(SECRET_VALUE), false)
  assert.equal(await controller.submitInput(), true)

  assert.deepEqual(calls, [
    {
      kind: 'mutation',
      namespace: 'llm-pi-ai',
      operations: [{
        op: 'set',
        path: ['providers', 'acme-gateway'],
        value: {
          displayName: 'Acme Gateway',
          apiKeyEnv: 'ACME_GATEWAY_API_KEY',
          api: 'openai-completions',
          baseURL: 'https://gateway.example/v1',
          models: [{ id: 'model-a' }],
        },
      }],
      revision: 7,
    },
    { kind: 'credential', ref: 'ACME_GATEWAY_API_KEY', value: SECRET_VALUE },
  ])
})

test('edits model identity and capacity without retaining cleared optional fields', async () => {
  const { calls, controller } = fixture()
  await controller.activate()
  await providers(controller)
  const modelIndex = controller.getSnapshot().rows.findIndex(row => row.id === 'provider-model:openai:model-a')
  controller.selectRow(modelIndex)

  assert.equal(await controller.perform(PROVIDER_MODEL_EDIT), true)
  assert.equal(controller.getSnapshot().input?.value, 'model-a')
  await submit(controller, 'model-a')
  await submit(controller, '')
  await submit(controller, '128000')
  await submit(controller, '32000')

  assert.deepEqual(calls, [{
    kind: 'mutation',
    namespace: 'llm-pi-ai',
    operations: [{
      op: 'set',
      path: ['providers', 'openai', 'models'],
      value: [{ id: 'model-a', contextWindow: 128000, maxTokens: 32000 }],
    }],
    revision: 7,
  }])
})

test('discovers and adopts models, then confirms provider removal', async () => {
  const { calls, controller } = fixture()
  await controller.activate()
  await providers(controller)
  const providerIndex = controller.getSnapshot().rows.findIndex(row => row.id === 'provider:openai')
  controller.selectRow(providerIndex)
  assert.equal(await controller.perform(PROVIDER_DISCOVER), true)

  const candidateIndex = controller.getSnapshot().rows.findIndex(row => row.id === 'provider-candidate:openai:model-b')
  assert.notEqual(candidateIndex, -1)
  controller.selectRow(candidateIndex)
  assert.equal(await controller.perform(PROVIDER_MODEL_ADOPT), true)

  await providers(controller)
  controller.selectRow(controller.getSnapshot().rows.findIndex(row => row.id === 'provider:openai'))
  assert.equal(await controller.perform(PROVIDER_REMOVE), false)
  assert.equal(await controller.perform(PROVIDER_REMOVE), true)

  assert.deepEqual(calls, [
    {
      kind: 'mutation',
      namespace: 'llm-pi-ai',
      operations: [{
        op: 'set',
        path: ['providers', 'openai', 'models'],
        value: [{ id: 'model-a', name: 'Model A' }, { id: 'model-b', name: 'Model B' }],
      }],
      revision: 7,
    },
    { kind: 'credential-unset', ref: 'OPENAI_API_KEY' },
    {
      kind: 'mutation',
      namespace: 'llm-pi-ai',
      operations: [{ op: 'unset', path: ['providers', 'openai'] }],
      revision: 7,
    },
  ])
})
