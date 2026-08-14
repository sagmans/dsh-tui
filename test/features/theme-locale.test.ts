import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import {
  SettingsProvider,
  settingsNamespace,
  type SettingsNamespace,
} from '@deepseek-ai/dsh-settings'
import { test } from 'vitest'
import type { ConfigurationPort, ConfigurationSettingsCatalog } from '../../src/features/settings/model.js'
import { createSettingsController } from '../../src/features/settings/model.js'
import { createNavigationStore } from '../../src/kernel/navigation.js'
import { EN_LOCALE, type LocaleKey } from '../../src/locales/en.js'
import { ZH_LOCALE } from '../../src/locales/zh.js'
import { createTuiLocale } from '../../src/services/locale.js'
import { registerTuiPreferenceSettings } from '../../src/services/preference-settings.js'
import { createTuiTheme } from '../../src/services/theme.js'

const ENGLISH_ENVIRONMENT = Object.freeze({ LANG: 'en_US.UTF-8' })
const UNSUPPORTED_ENVIRONMENT = Object.freeze({ LANG: 'fr_FR.UTF-8' })
const NOOP_RESULT = Promise.resolve({ ok: true as const, value: undefined })

class MemorySettings extends SettingsProvider {
  readonly writable = true

  protected load(): Promise<Record<string, unknown>> { return Promise.resolve({}) }

  protected persist(_namespace: SettingsNamespace, _section: Record<string, unknown>): Promise<void> {
    return Promise.resolve()
  }
}

test('registers Web-compatible durable preference namespaces', async () => {
  const ctx = new Context()
  await ctx.plugin(MemorySettings).await()
  const fiber = ctx.plugin({ apply: registerTuiPreferenceSettings })
  await fiber.await()

  assert.deepEqual(ctx.settings.get(settingsNamespace('ui-theme')), { preference: 'system' })
  assert.deepEqual(ctx.settings.get(settingsNamespace('locale')), {})
  await ctx.settings.update(settingsNamespace('ui-theme'), { preference: 'light' })
  await ctx.settings.update(settingsNamespace('locale'), { preference: 'en' })
  assert.deepEqual(ctx.settings.get(settingsNamespace('ui-theme')), { preference: 'light' })
  assert.deepEqual(ctx.settings.get(settingsNamespace('locale')), { preference: 'en' })

  await fiber.dispose()
  await ctx.fiber.dispose()
})

test('resolves light, dark, and system preferences through semantic palettes', () => {
  const light = createTuiTheme({ color: true, preference: 'light', systemScheme: 'dark' })
  const dark = createTuiTheme({ color: true, preference: 'dark', systemScheme: 'light' })
  const system = createTuiTheme({ color: true, preference: 'system', systemScheme: 'light' })

  assert.equal(light.getSnapshot().scheme, 'light')
  assert.equal(dark.getSnapshot().scheme, 'dark')
  assert.equal(system.getSnapshot().scheme, 'light')
  assert.notEqual(light.colors.background, dark.colors.background)
  assert.notEqual(light.colors.text, dark.colors.text)
})

test('publishes live theme changes while preserving no-color output', () => {
  const theme = createTuiTheme({ color: true, preference: 'system', systemScheme: 'dark' })
  const plain = createTuiTheme({ color: false, preference: 'system', systemScheme: 'dark' })
  let changes = 0
  const unsubscribe = theme.subscribe(() => { changes += 1 })

  theme.setSystemScheme('light')
  theme.setPreference('dark')
  theme.setPreference('dark')
  unsubscribe()

  assert.equal(changes, 2)
  assert.equal(theme.getSnapshot().preference, 'dark')
  assert.equal(theme.getSnapshot().revision, 2)
  assert.equal(plain.colors.background, 'default')
  assert.equal(plain.colors.text, 'default')
})

test('uses complete typed dictionaries and Web-compatible locale fallback', () => {
  const englishKeys = Object.keys(EN_LOCALE).toSorted()
  const chineseKeys = Object.keys(ZH_LOCALE).toSorted()
  const checkedKey: LocaleKey = 'shell.route.chat'
  const english = createTuiLocale({ environment: ENGLISH_ENVIRONMENT })
  const fallback = createTuiLocale({ environment: UNSUPPORTED_ENVIRONMENT })

  assert.deepEqual(chineseKeys, englishKeys)
  assert.equal(english.t(checkedKey), 'CHAT')
  assert.equal(fallback.getSnapshot().id, 'zh')
  assert.equal(fallback.t(checkedKey), '对话')
})

test('switches English and Chinese live without exposing missing keys', () => {
  const locale = createTuiLocale({ environment: ENGLISH_ENVIRONMENT })
  let changes = 0
  locale.subscribe(() => { changes += 1 })

  locale.setLocale('zh')
  assert.equal(locale.t('settings.title'), '配置')
  assert.equal(locale.t('settings.preference.theme.summary', { value: '深色' }), '当前：深色')
  locale.setLocale('en')

  assert.equal(changes, 2)
  assert.equal(locale.t('settings.title'), 'CONFIGURATION')
  assert.equal(locale.getSnapshot().revision, 2)
})

function preferencePort(
  calls: string[],
  getCatalog: () => ConfigurationSettingsCatalog,
  setCatalog: (catalog: ConfigurationSettingsCatalog) => void,
): ConfigurationPort {
  return {
    copyPreset: () => NOOP_RESULT,
    credentials: () => Promise.resolve({ ok: true, value: {} }),
    defaultPreset: () => NOOP_RESULT,
    discoverProviderModels: () => Promise.resolve({ ok: true, value: [] }),
    extensions: () => Promise.resolve({ ok: true, value: [] }),
    models: () => Promise.resolve({
      ok: true,
      value: { current: { model: 'chat', provider: 'deepseek' }, failures: [], groups: [], routable: true },
    }),
    mutateSettings(namespace, operations, revision) {
      const operation = operations[0]
      const value = operation?.op === 'set' ? operation.value : undefined
      calls.push(`${namespace}:${String(revision)}:${String(value)}`)
      const current = getCatalog()
      setCatalog({
        ...current,
        namespaces: current.namespaces.map(candidate => candidate.ns === namespace
          ? {
              ...candidate,
              revision: candidate.revision + 1,
              value: { preference: value },
              user: { preference: value },
            }
          : candidate),
      })
      return NOOP_RESULT
    },
    openPreset: () => Promise.resolve({ ok: true, value: { opened: false } }),
    openSettings: () => NOOP_RESULT,
    plugins: () => Promise.resolve({ ok: true, value: [] }),
    presets: () => Promise.resolve({
      ok: true,
      value: { authorable: false, hasDocument: false, presets: [] },
    }),
    providerCatalog: () => Promise.resolve({ ok: true, value: [] }),
    readPreset: () => Promise.resolve({ ok: true, value: '' }),
    removeExtension: () => NOOP_RESULT,
    removePreset: () => NOOP_RESULT,
    resetSetting: () => NOOP_RESULT,
    runExtension: () => NOOP_RESULT,
    selectAccess: () => NOOP_RESULT,
    selectModel: () => NOOP_RESULT,
    selectPreset: () => NOOP_RESULT,
    setCredential: () => NOOP_RESULT,
    settings: () => Promise.resolve({ ok: true, value: getCatalog() }),
    stopExtension: () => NOOP_RESULT,
    unsetCredential: () => NOOP_RESULT,
  }
}

test('persists theme and locale choices through revision-checked Host settings', async () => {
  let catalog: ConfigurationSettingsCatalog = {
    hasDocument: true,
    namespaces: [
      {
        applies: 'live', ns: 'ui-theme', revision: 3, schema: {}, secrets: [],
        value: { preference: 'system' }, user: { preference: 'system' },
      },
      {
        applies: 'live', ns: 'locale', revision: 7, schema: {}, secrets: [],
        value: { preference: 'en' }, user: { preference: 'en' },
      },
    ],
    writable: true,
  }
  const calls: string[] = []
  const locale = createTuiLocale({ locale: 'en' })
  const theme = createTuiTheme({ color: true })
  const controller = createSettingsController({
    list: { getSnapshot: () => ({ byId: {}, current: undefined }), subscribe: () => () => {} },
    locale,
    navigation: createNavigationStore(),
    port: preferencePort(calls, () => catalog, next => { catalog = next }),
    theme,
  })

  controller.selectSection('settings')
  await controller.refresh()
  const themeRow = controller.getSnapshot().rows.findIndex(row => row.id === 'preference:theme')
  controller.selectRow(themeRow)
  assert.equal(await controller.perform('theme.dark'), true)
  assert.equal(theme.getSnapshot().preference, 'dark')

  const localeRow = controller.getSnapshot().rows.findIndex(row => row.id === 'preference:locale')
  controller.selectRow(localeRow)
  assert.equal(await controller.perform('locale.zh'), true)
  assert.equal(locale.getSnapshot().id, 'zh')
  assert.deepEqual(calls, ['ui-theme:3:dark', 'locale:7:zh'])
  controller.dispose()
})
