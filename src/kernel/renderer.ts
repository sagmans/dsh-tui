import { createCliRenderer, type CliRenderer, type CliRendererConfig } from '@opentui/core'

export const DEFAULT_RENDERER_CONFIG: Readonly<CliRendererConfig> = {
  autoFocus: true,
  clearOnShutdown: true,
  consoleMode: 'disabled',
  enableMouseMovement: true,
  exitOnCtrlC: false,
  screenMode: 'alternate-screen',
  useMouse: true,
}

export function createTuiRenderer(
  overrides: Readonly<CliRendererConfig> = {},
): Promise<CliRenderer> {
  return createCliRenderer({ ...DEFAULT_RENDERER_CONFIG, ...overrides })
}
