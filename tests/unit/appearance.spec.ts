import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTheme } from '@/theme.ts'
import { parseSettings, toOverrides } from '@/theme-settings.ts'
import { loadThemes, builtinThemesDir } from '@/theme-files.ts'
import { createAppearance } from '@/surface/appearance.ts'
import type { Picker } from '@/surface/modal-input.ts'

const THEME = 'violet-orbit'
const OTHER_THEME = 'deepseek-blue'

/** No terminal or home writes: the fixture exercises only the preference owner. */
function fixture(service?: unknown, rowSettings: Record<string, unknown> = {}, deferred = false) {
  const listeners = new Map<string, (...args: unknown[]) => void>()
  let attachSettings = (): void => {}
  const ctx = {
    fiber: { entry: { id: 'include:terminal-custom', options: { id: 'terminal-custom' } } },
    inject: (_names: string[], callback: (ctx: unknown) => void) => {
      attachSettings = () => { if (service !== undefined) callback({ settings: service }) }
      if (!deferred) attachSettings()
    },
    on: (event: string, callback: (...args: unknown[]) => void) => {
      listeners.set(event, callback)
      return () => { listeners.delete(event) }
    },
  } as unknown as Context
  const notices: string[] = []
  const picker = vi.fn(async (_picker: Picker) => undefined as string | undefined)
  const appearance = createAppearance(ctx, {
    color: () => true,
    rowTheme: typeof rowSettings.theme === 'string' ? rowSettings.theme : undefined,
    rowSettings: () => rowSettings,
    rowSettingsLive: true,
    notice: message => notices.push(message),
    render: vi.fn(), invalidateMarkdown: vi.fn(), invalidateView: vi.fn(),
    keybindings: () => ({ installBindings: vi.fn(), disarmChord: vi.fn() }),
    openPicker: picker,
  })
  appearance.openNotices(message => notices.push(message))
  return { appearance, notices, listeners, picker, attachSettings: () => attachSettings() }
}

beforeEach(() => {
  vi.stubEnv('NO_COLOR', '')
  vi.stubEnv('TERM', 'xterm-256color')
  vi.stubEnv('COLORTERM', 'truecolor')
})

afterEach(() => { vi.unstubAllEnvs() })

describe('appearance preference startup', () => {
  it('reapplies a successful durable theme save without waiting for a notification', async () => {
    let value = { theme: THEME }
    const update = vi.fn(async (_ns: string, patch: object) => { value = { ...value, ...patch } })
    const forms = { describe: () => [{ ns: 'terminal-custom', value, revision: 0 }], update }
    const { appearance, notices } = fixture(forms, value)
    appearance.registerSection()
    const previous = appearance.theme.style('status.cwd', 'cwd')
    appearance.runThemeCommand(OTHER_THEME)
    await vi.waitFor(() => { expect(notices.join('\n')).toContain('written to the settings document') })
    expect(update).toHaveBeenCalledWith('terminal-custom', { theme: OTHER_THEME }, 0)
    expect(appearance.theme.style('status.cwd', 'cwd')).not.toBe(previous)
    notices.length = 0
    appearance.runThemeCommand('tokens')
    expect(notices.join('\n')).toContain(OTHER_THEME)
  })

  it('filters unrelated changes and disposes both settings event listeners', () => {
    let value = { theme: THEME }
    const describe = vi.fn(() => [{ ns: 'terminal-custom', value, revision: 0 }])
    const { appearance, listeners } = fixture({ describe, update: vi.fn() }, value)
    appearance.registerSection()
    const dispose = appearance.settingsListener()
    const previous = appearance.theme.style('status.cwd', 'cwd')
    describe.mockClear()
    value = { theme: OTHER_THEME }
    listeners.get('settings/document-updated')?.('another-plugin', 1)
    expect(describe).not.toHaveBeenCalled()
    listeners.get('settings/document-updated')?.('terminal-custom', 1)
    expect(describe).toHaveBeenCalled()
    expect(appearance.theme.style('status.cwd', 'cwd')).not.toBe(previous)
    dispose()
    expect(listeners.has('settings/updated')).toBe(false)
    expect(listeners.has('settings/document-updated')).toBe(false)
  })

  it('keeps history off while Cordis defers the settings injection', () => {
    const service = { register: () => ({ get: () => ({ history: { enabled: true, ghost: true } }), update: async () => {} }) }
    const { appearance, attachSettings, notices } = fixture(service, { theme: THEME }, true)
    appearance.registerSection()
    expect(appearance.historyEnabled()).toBe(false)
    expect(appearance.historyGhost()).toBe(false)
    appearance.runThemeCommand('tokens')
    expect(notices.join('\n')).toContain(THEME)
    attachSettings()
    expect(appearance.historyEnabled()).toBe(true)
    expect(appearance.historyGhost()).toBe(true)
  })

  it('preserves row opt-outs through the register API base layer', () => {
    const register = (_ns: string, _schema: unknown, options?: { base: unknown }) => ({
      get: () => options?.base ?? {},
      update: async () => {},
    })
    const { appearance } = fixture({ register }, { history: { enabled: false, ghost: false } })
    appearance.registerSection()
    expect(appearance.historyEnabled()).toBe(false)
    expect(appearance.historyGhost()).toBe(false)
  })

  it('does not opt in while source legacy import is pending or failed', () => {
    let value: unknown = {}
    const forms = { describe: () => [{ ns: 'terminal-custom', value, revision: 0 }], update: vi.fn() }
    const { appearance, listeners } = fixture(forms)
    appearance.registerSection()
    appearance.settingsListener()
    expect(appearance.historyEnabled()).toBe(false)
    expect(appearance.historyGhost()).toBe(false)
    listeners.get('settings/document-updated')?.('terminal-custom', 1)
    expect(appearance.historyEnabled()).toBe(false)
    value = { history: { enabled: false, ghost: false } }
    listeners.get('settings/document-updated')?.('terminal-custom', 2)
    expect(appearance.historyEnabled()).toBe(false)
    expect(appearance.historyGhost()).toBe(false)
    value = { history: { enabled: true, ghost: true } }
    listeners.get('settings/document-updated')?.('terminal-custom', 3)
    expect(appearance.historyEnabled()).toBe(true)
    expect(appearance.historyGhost()).toBe(true)
  })

  it('uses row preferences before the source descriptor becomes active', () => {
    const forms = { describe: () => [], update: vi.fn() }
    const { appearance } = fixture(forms, { theme: THEME, history: { enabled: false, ghost: false } })
    appearance.registerSection()
    expect(appearance.historyEnabled()).toBe(false)
    expect(appearance.historyGhost()).toBe(false)
  })

  it('applies Config theme and false history switches before rendering or history construction', () => {
    const value = { theme: THEME, history: { enabled: false, ghost: false }, mermaid: 'off' }
    const forms = { describe: () => [{ ns: 'terminal-custom', value, revision: 0 }], update: vi.fn() }
    const { appearance, notices } = fixture(forms, value)
    appearance.registerSection()
    expect(appearance.historyEnabled()).toBe(false)
    expect(appearance.historyGhost()).toBe(false)
    expect(appearance.mermaidMode()).toBe('off')
    const library = loadThemes('/nonexistent-dsh-tui-test-home', builtinThemesDir())
    const expected = createTheme('truecolor', toOverrides(parseSettings(value), library))
    expect(appearance.theme.style('status.cwd', 'cwd')).toBe(expected.style('status.cwd', 'cwd'))
    appearance.runThemeCommand('tokens')
    expect(notices.join('\n')).toContain(THEME)
  })

  it.each([undefined, {}])('cannot silently save a theme or record unread history: %s', async service => {
    const { appearance, notices } = fixture(service, { theme: THEME })
    appearance.registerSection()
    expect(appearance.historyEnabled()).toBe(false)
    appearance.runThemeCommand(OTHER_THEME)
    await vi.waitFor(() => { expect(notices.join('\n')).toMatch(/cannot write/) })
    expect(notices.join('\n')).not.toContain('written')
  })

  it('keeps the last good painter and diagnostics after malformed live settings', () => {
    let value: unknown = { theme: THEME, history: { enabled: false, ghost: false } }
    const forms = { describe: () => [{ ns: 'terminal-custom', value, revision: 0 }], update: vi.fn() }
    const { appearance, notices, listeners } = fixture(forms)
    appearance.registerSection()
    appearance.settingsListener()
    const painted = appearance.theme.style('status.cwd', 'cwd')
    value = { theme: OTHER_THEME, history: { enabled: false, ghost: false }, tools: 'invalid' }
    listeners.get('settings/document-updated')?.('terminal-custom', 1)
    expect(appearance.theme.style('status.cwd', 'cwd')).toBe(painted)
    expect(appearance.historyEnabled()).toBe(false)
    notices.length = 0
    appearance.runThemeCommand('tokens')
    expect(notices.join('\n')).toContain(THEME)
  })

  it('reports and rolls back a rejected picker preview', async () => {
    const value = { theme: THEME }
    const forms = {
      describe: () => [{ ns: 'terminal-custom', value, revision: 0 }],
      update: vi.fn(async () => { throw new Error('write refused') }),
    }
    const { appearance, notices, picker } = fixture(forms, value)
    appearance.registerSection()
    const painted = appearance.theme.style('status.cwd', 'cwd')
    picker.mockImplementation(async list => {
      for (const character of OTHER_THEME) list.handleKey(character)
      expect(appearance.theme.style('status.cwd', 'cwd')).not.toBe(painted)
      return OTHER_THEME
    })
    appearance.runThemeCommand('')
    await vi.waitFor(() => { expect(notices.join('\n')).toContain('write refused') })
    expect(appearance.theme.style('status.cwd', 'cwd')).toBe(painted)
  })
})
