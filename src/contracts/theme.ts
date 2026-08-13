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

export interface TuiTheme {
  readonly color: boolean
  readonly colors: TuiColorPalette
}
