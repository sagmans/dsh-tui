import type { TuiColorPalette, TuiTheme } from '../contracts/theme.js'

const COLOR_PALETTE: TuiColorPalette = {
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

export interface TuiThemeOptions {
  readonly color: boolean
}

function freezePalette(palette: TuiColorPalette): TuiColorPalette {
  return Object.freeze({ ...palette })
}

export function createTuiTheme(options: TuiThemeOptions): TuiTheme {
  return Object.freeze({
    color: options.color,
    colors: freezePalette(options.color ? COLOR_PALETTE : PLAIN_PALETTE),
  })
}
