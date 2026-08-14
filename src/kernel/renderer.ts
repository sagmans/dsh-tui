import { createCliRenderer, type CliRenderer, type CliRendererConfig } from '@opentui/core'

const TYPE_STRIP_WARNING = 'stripTypeScriptTypes is an experimental feature and might change at any time'
const EXPERIMENTAL_WARNING_TYPE = 'ExperimentalWarning'

interface ProcessWarningEmitter {
  emitWarning: NodeJS.Process['emitWarning']
}

export const DEFAULT_RENDERER_CONFIG: Readonly<CliRendererConfig> = {
  autoFocus: true,
  clearOnShutdown: true,
  consoleMode: 'disabled',
  enableMouseMovement: true,
  exitOnCtrlC: false,
  screenMode: 'alternate-screen',
  useMouse: true,
}

function warningType(value: unknown): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, 'type') : value
}

export function installExpectedRuntimeWarningFilter(
  emitter: ProcessWarningEmitter = process,
): () => void {
  const original = emitter.emitWarning
  const filtered = ((warning: string | Error, ...args: unknown[]): void => {
    const message = warning instanceof Error ? warning.message : warning
    if (message === TYPE_STRIP_WARNING && warningType(args[0]) === EXPERIMENTAL_WARNING_TYPE) return
    Reflect.apply(original, emitter, [warning, ...args])
  }) as NodeJS.Process['emitWarning']
  emitter.emitWarning = filtered
  return () => {
    if (emitter.emitWarning === filtered) emitter.emitWarning = original
  }
}

export async function createTuiRenderer(
  overrides: Readonly<CliRendererConfig> = {},
): Promise<CliRenderer> {
  const restoreWarning = installExpectedRuntimeWarningFilter()
  const onDestroy = overrides.onDestroy
  try {
    return await createCliRenderer({
      ...DEFAULT_RENDERER_CONFIG,
      ...overrides,
      onDestroy: () => {
        restoreWarning()
        onDestroy?.()
      },
    })
  } catch (error) {
    restoreWarning()
    throw error
  }
}
