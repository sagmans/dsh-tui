import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createTestRenderer } from '@opentui/core/testing'
import type { SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { TuiClientFacade } from '../../src/client/context.js'
import type {
  ConfigurationActionId,
  ConfigurationController,
} from '../../src/features/settings/model.js'
import { createShellController } from '../../src/features/shell/model.js'
import { createNavigationStore } from '../../src/kernel/navigation.js'
import { createTuiLocale } from '../../src/services/locale.js'
import { createTuiSlots } from '../../src/services/slots.js'
import { createTuiTheme } from '../../src/services/theme.js'
import { mountShellView } from '../../src/views/shell/root.js'
import { createSettingsView } from '../../src/views/settings/root.js'

const NATIVE_RENDERER_AVAILABLE = process.versions.bun !== undefined
  || process.getBuiltinModule('node:ffi') !== undefined
const WIDTH = 44
const HEIGHT = 12
const ENGLISH_ENVIRONMENT = Object.freeze({ LANG: 'en_US.UTF-8' })
const NOOP = (): void => {}

function sessions(): SessionListState {
  return {
    byId: {},
    current: undefined,
    currentAddress: undefined,
    ids: [],
    jobsBySession: {},
    phase: 'ready',
    subagentsByParent: {},
  }
}

test.skipIf(!NATIVE_RENDERER_AVAILABLE)('reflows narrow chrome and keeps locale controls mouse-reachable', async () => {
  const harness = await createTestRenderer({ width: WIDTH, height: HEIGHT, bufferedOutput: 'memory' })
  const navigation = createNavigationStore()
  const controller = createShellController({
    navigation,
    sessions: {
      clear: () => {},
      getSnapshot: sessions,
      open: () => {},
      subscribe: () => () => {},
    },
  })
  const locale = createTuiLocale({ environment: ENGLISH_ENVIRONMENT })
  const theme = createTuiTheme({ color: true, preference: 'system', systemScheme: 'dark' })
  // Native shell proof never invokes client services.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const client = { api: {}, context: {} } as unknown as TuiClientFacade
  const slots = createTuiSlots(harness.renderer, { client, locale, navigation, theme })
  const view = mountShellView({ controller, locale, renderer: harness.renderer, slots, theme })
  harness.renderer.root.add(view.root)

  try {
    controller.run('shell.zen')
    await harness.flush()
    assert.match(harness.captureCharFrame(), /CHAT/u)

    locale.setLocale('zh')
    theme.setPreference('light')
    await harness.flush()
    const frame = harness.captureCharFrame()
    assert.equal(frame.split('\n')[0]?.length, WIDTH)
    assert.match(frame, /对话/u)
    assert.match(frame, /设置/u)

    const settings = view.root.findDescendantById('shell-tab-settings')
    assert.ok(settings)
    await harness.mockMouse.click(settings.screenX + 1, settings.screenY)
    await harness.flush()
    assert.equal(controller.getSnapshot().route, 'settings')
  } finally {
    view.dispose()
    slots.dispose()
    controller.dispose()
    harness.renderer.destroy()
  }
})

function preferencesController(calls: string[]): ConfigurationController {
  let listener = NOOP
  let rowIndex = 0
  return {
    activate: () => Promise.resolve(),
    cancelInput: NOOP,
    dispose: NOOP,
    getSnapshot: () => ({
      busy: false,
      confirmation: undefined,
      error: undefined,
      input: undefined,
      rowIndex,
      rows: [
        {
          actions: [
            { command: 'settings.action.theme.light', enabled: true, id: 'theme.light', label: '浅色', tone: 'default' },
            { command: 'settings.action.theme.dark', enabled: true, id: 'theme.dark', label: '深色', tone: 'positive' },
            { command: 'settings.action.theme.system', enabled: true, id: 'theme.system', label: '跟随系统', tone: 'default' },
          ],
          details: '选择终端主题。', id: 'preference:theme', state: 'success', summary: '当前：深色', title: '主题',
        },
        {
          actions: [
            { command: 'settings.action.locale.zh', enabled: true, id: 'locale.zh', label: '中文', tone: 'positive' },
            { command: 'settings.action.locale.en', enabled: true, id: 'locale.en', label: 'English', tone: 'default' },
          ],
          details: '选择界面语言。', id: 'preference:locale', state: 'success', summary: '当前：中文', title: '语言',
        },
      ],
      section: 'settings',
      sections: ['settings'],
      selectedActionId: rowIndex === 0 ? 'theme.light' : 'locale.zh',
      status: `${String(rowIndex + 1)}/2`,
    }),
    move: NOOP,
    moveAction: NOOP,
    moveSection: NOOP,
    perform(action?: ConfigurationActionId) {
      calls.push(String(action))
      return Promise.resolve(true)
    },
    refresh: () => Promise.resolve(),
    selectRow(index) { rowIndex = index; listener() },
    selectSection: NOOP,
    setInput: NOOP,
    submitInput: () => Promise.resolve(false),
    subscribe(next) { listener = next; return () => { listener = NOOP } },
    syncPreferences: () => Promise.resolve(),
  }
}

test.skipIf(!NATIVE_RENDERER_AVAILABLE)('invokes theme and locale choices through narrow mouse controls', async () => {
  const harness = await createTestRenderer({ width: WIDTH, height: HEIGHT, bufferedOutput: 'memory' })
  const calls: string[] = []
  const locale = createTuiLocale({ locale: 'zh' })
  const view = createSettingsView(
    harness.renderer,
    createTuiTheme({ color: true, preference: 'dark' }),
    locale,
    preferencesController(calls),
  )
  harness.renderer.root.add(view)

  try {
    await harness.flush()
    assert.match(harness.captureCharFrame(), /配置/u)
    const dark = view.findDescendantById('settings-action-theme.dark')
    assert.ok(dark)
    await harness.mockMouse.click(dark.screenX + 1, dark.screenY)

    const languageRow = view.findDescendantById('settings-row-1')
    assert.ok(languageRow)
    await harness.mockMouse.click(languageRow.screenX + 1, languageRow.screenY)
    await harness.flush()
    const english = view.findDescendantById('settings-action-locale.en')
    assert.ok(english)
    await harness.mockMouse.click(english.screenX + 1, english.screenY)

    assert.deepEqual(calls, ['theme.dark', 'locale.en'])
  } finally {
    view.destroyRecursively()
    harness.renderer.destroy()
  }
})
