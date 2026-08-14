export type TuiSemanticColor =
  | 'accent'
  | 'background'
  | 'border'
  | 'danger'
  | 'focus'
  | 'muted'
  | 'success'
  | 'text'
  | 'warning'

export type TuiColorPalette = Readonly<Record<TuiSemanticColor, string>>

export const TUI_THEME_PREFERENCES = Object.freeze(['light', 'dark', 'system'] as const)
export const TUI_THEME_SCHEMES = Object.freeze(['light', 'dark'] as const)

export type TuiThemePreference = typeof TUI_THEME_PREFERENCES[number]
export type TuiThemeScheme = typeof TUI_THEME_SCHEMES[number]

export interface TuiThemeSnapshot {
  readonly colors: TuiColorPalette
  readonly preference: TuiThemePreference
  readonly revision: number
  readonly scheme: TuiThemeScheme
}

export interface TuiTheme {
  readonly color: boolean
  readonly colors: TuiColorPalette
  getSnapshot(): TuiThemeSnapshot
  setPreference(preference: TuiThemePreference): void
  setSystemScheme(scheme: TuiThemeScheme): void
  subscribe(listener: () => void): () => void
}
