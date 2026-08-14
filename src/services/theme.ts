import {
  TUI_THEME_PREFERENCES,
  type TuiColorPalette,
  type TuiTheme,
  type TuiThemePreference,
  type TuiThemeScheme,
  type TuiThemeSnapshot,
} from '../contracts/theme.js'

export const THEME_SETTINGS_NAMESPACE = 'ui-theme'
export const THEME_PREFERENCE_FIELD = 'preference'
export const DEFAULT_THEME_PREFERENCE: TuiThemePreference = 'system'
export const DEFAULT_SYSTEM_SCHEME: TuiThemeScheme = 'dark'

const LIGHT_BACKGROUND_CODES = new Set([7, 9, 10, 11, 12, 13, 14, 15])
const DARK_PALETTE: TuiColorPalette = {
  accent: '#4d8dff',
  background: '#10141c',
  border: '#303a4d',
  danger: '#ff6b7a',
  focus: '#75a7ff',
  muted: '#8994a8',
  success: '#55c995',
  text: '#e6ebf3',
  warning: '#e8b85d',
}
const LIGHT_PALETTE: TuiColorPalette = {
  accent: '#245fd6',
  background: '#f7f8fa',
  border: '#bac2d0',
  danger: '#b42335',
  focus: '#174ea6',
  muted: '#5d6879',
  success: '#16724b',
  text: '#17202d',
  warning: '#8a5a00',
}
const PLAIN_COLOR = 'default'
const PLAIN_PALETTE: TuiColorPalette = {
  accent: PLAIN_COLOR,
  background: PLAIN_COLOR,
  border: PLAIN_COLOR,
  danger: PLAIN_COLOR,
  focus: PLAIN_COLOR,
  muted: PLAIN_COLOR,
  success: PLAIN_COLOR,
  text: PLAIN_COLOR,
  warning: PLAIN_COLOR,
}

export interface TuiThemeEnvironment {
  readonly COLORFGBG?: string | undefined
}

export interface TuiThemeOptions {
  readonly color: boolean
  readonly environment?: TuiThemeEnvironment | undefined
  readonly preference?: TuiThemePreference | undefined
  readonly systemScheme?: TuiThemeScheme | undefined
}

const PALETTES: Readonly<Record<TuiThemeScheme, TuiColorPalette>> = Object.freeze({
  dark: freezePalette(DARK_PALETTE),
  light: freezePalette(LIGHT_PALETTE),
})
const FROZEN_PLAIN_PALETTE = freezePalette(PLAIN_PALETTE)

function freezePalette(palette: TuiColorPalette): TuiColorPalette {
  return Object.freeze({ ...palette })
}

export function isThemePreference(value: unknown): value is TuiThemePreference {
  return TUI_THEME_PREFERENCES.some(preference => preference === value)
}

export function resolveTerminalSystemScheme(environment: TuiThemeEnvironment): TuiThemeScheme {
  const background = environment.COLORFGBG?.split(';').at(-1)
  if (background === undefined) return DEFAULT_SYSTEM_SCHEME
  const code = Math.trunc(Number(background))
  return LIGHT_BACKGROUND_CODES.has(code) ? 'light' : 'dark'
}

function activeScheme(preference: TuiThemePreference, systemScheme: TuiThemeScheme): TuiThemeScheme {
  return preference === 'system' ? systemScheme : preference
}

export function createTuiTheme(options: TuiThemeOptions): TuiTheme {
  let preference = options.preference ?? DEFAULT_THEME_PREFERENCE
  let systemScheme = options.systemScheme ?? resolveTerminalSystemScheme(options.environment ?? process.env)
  let revision = 0
  const listeners = new Set<() => void>()
  const colors = (): TuiColorPalette => options.color
    ? PALETTES[activeScheme(preference, systemScheme)]
    : FROZEN_PLAIN_PALETTE
  const publish = (): void => {
    revision += 1
    for (const listener of listeners) listener()
  }

  return Object.freeze({
    color: options.color,
    get colors(): TuiColorPalette { return colors() },
    getSnapshot(): TuiThemeSnapshot {
      return Object.freeze({
        colors: colors(),
        preference,
        revision,
        scheme: activeScheme(preference, systemScheme),
      })
    },
    setPreference(next: TuiThemePreference): void {
      if (next === preference) return
      preference = next
      publish()
    },
    setSystemScheme(next: TuiThemeScheme): void {
      if (next === systemScheme) return
      systemScheme = next
      if (preference === 'system') publish()
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  })
}
