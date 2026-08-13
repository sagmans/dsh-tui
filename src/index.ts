import type { Context } from '@deepseek-ai/cordis'

const MINIMUM_NODE_VERSION = [26, 4, 0] as const
const NODE_FFI_SPECIFIER = 'node:ffi'
const NODE_VERSION_ERROR = 'dsh-tui requires Node.js 26.4.0 or newer.'
const NODE_FFI_ERROR = 'dsh-tui requires Node.js FFI. Start Harness with --experimental-ffi.'
const VERSION_PART_SEPARATOR = '.'

export interface RuntimeProbe {
  readonly nodeVersion: string
  readonly hasFfi: boolean
}

export const name = 'dsh-tui'
export const inject: readonly string[] = []

export function assertSupportedRuntime(probe?: RuntimeProbe): void {
  let runtime = probe

  if (runtime === undefined) {
    let hasFfi = false

    try {
      hasFfi = process.getBuiltinModule(NODE_FFI_SPECIFIER) !== undefined
    } catch {
      hasFfi = false
    }

    runtime = { nodeVersion: process.versions.node, hasFfi }
  }

  const actualVersion = runtime.nodeVersion
    .split(VERSION_PART_SEPARATOR)
    .slice(0, MINIMUM_NODE_VERSION.length)
    .map(Number)
  const supportsNode = MINIMUM_NODE_VERSION.every((minimumPart, index) => {
    const earlierPartsMatch = MINIMUM_NODE_VERSION.slice(0, index).every(
      (earlierMinimum, earlierIndex) => actualVersion[earlierIndex] === earlierMinimum,
    )

    return !earlierPartsMatch || (actualVersion[index] ?? Number.NaN) >= minimumPart
  })

  if (!supportsNode) {
    throw new Error(NODE_VERSION_ERROR)
  }

  if (!runtime.hasFfi) {
    throw new Error(NODE_FFI_ERROR)
  }
}

export function apply(_ctx: Readonly<Context>): void {}
