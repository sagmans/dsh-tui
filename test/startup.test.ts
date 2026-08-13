import assert from 'node:assert/strict'
import { afterEach, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { assertEntriesActivated } from '@deepseek-ai/dsh-app-boot'
import { internals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import * as kernelPlugin from '../src/index.js'
import * as shellPlugin from '../src/features/shell/index.js'
import * as startupPlugin from '../src/startup.js'

const ORIGINAL_INTERNALS = { ...internals }
const STARTUP_SERVICE = 'tuiStartup'
const CLIENT_SERVICE = 'tuiClient'
const KERNEL_SERVICE = 'tuiKernel'
const NODE_FFI_SPECIFIER = 'node:ffi'
const SUPPORTED_NODE_VERSION = '26.4.0'
const LOADER_TEST_LABEL = 'dsh-tui Loader test'
const STARTUP_PLUGIN_NAME = '@sagmans/dsh-tui/startup'
const CLIENT_PLUGIN_NAME = '@sagmans/dsh-tui/service/client'
const KERNEL_PLUGIN_NAME = '@sagmans/dsh-tui'
const SHELL_PLUGIN_NAME = '@sagmans/dsh-tui/feature/shell'
const RUNTIME_DESCRIPTOR_ERROR = 'Node runtime descriptors unavailable'

interface StartupResult {
  readonly exits: readonly number[]
  readonly output: string
  readonly values: startupPlugin.TuiStartupValues | undefined
}

afterEach(() => {
  Object.assign(internals, ORIGINAL_INTERNALS)
})

function isTuiStartupValues(value: unknown): value is startupPlugin.TuiStartupValues {
  return typeof value === 'object' && value !== null && 'zen' in value && value.zen === true
}

function runStartup(args: readonly string[]): StartupResult {
  const ctx = new Context()
  const exits: number[] = []
  let output = ''
  const sink = { write: (chunk: string): boolean => { output += chunk; return true } }
  internals.stdout = sink
  internals.stderr = sink
  provideCmdline(ctx, { args, exit: code => void exits.push(code) })

  startupPlugin.apply(ctx)

  const service: unknown = ctx.get(STARTUP_SERVICE)
  const values = isTuiStartupValues(service) ? service : undefined

  return { exits, output, values }
}

function installSupportedRuntime(): () => void {
  const nodeVersionDescriptor = Object.getOwnPropertyDescriptor(process.versions, 'node')
  const getBuiltinModuleDescriptor = Object.getOwnPropertyDescriptor(process, 'getBuiltinModule')
  if (nodeVersionDescriptor === undefined || getBuiltinModuleDescriptor === undefined) {
    throw new Error(RUNTIME_DESCRIPTOR_ERROR)
  }

  Object.defineProperty(process.versions, 'node', { ...nodeVersionDescriptor, value: SUPPORTED_NODE_VERSION })
  Object.defineProperty(process, 'getBuiltinModule', {
    ...getBuiltinModuleDescriptor,
    value: (specifier: string): unknown => specifier === NODE_FFI_SPECIFIER ? {} : undefined,
  })

  return () => {
    Object.defineProperty(process.versions, 'node', nodeVersionDescriptor)
    Object.defineProperty(process, 'getBuiltinModule', getBuiltinModuleDescriptor)
  }
}

function installPluginModules(ctx: Context): void {
  const clientPlugin = {
    name: 'tui-client-fixture',
    apply(clientContext: Context): void {
      clientContext.provide(CLIENT_SERVICE, Object.freeze({ ready: true }))
    },
  }
  const modules = new Map<string, unknown>([
    [STARTUP_PLUGIN_NAME, startupPlugin],
    [CLIENT_PLUGIN_NAME, clientPlugin],
    [KERNEL_PLUGIN_NAME, kernelPlugin],
    [SHELL_PLUGIN_NAME, shellPlugin],
  ])
  Reflect.set(ctx.loader, 'internal', {
    version: 'v2',
    import(specifier: string): Promise<unknown> {
      const module = modules.get(specifier)
      if (module === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
      return Promise.resolve(module)
    },
  })
}

test('publishes immutable startup state for a normal TUI launch', () => {
  const result = runStartup([])

  assert.deepEqual(result.values, { zen: true })
  assert.equal(Object.isFrozen(result.values), true)
  assert.deepEqual(result.exits, [])
})

test('owns TUI help without activating dependent rows', () => {
  const result = runStartup(['--help'])

  assert.match(result.output, /dsh --profile tui/u)
  assert.equal(result.values, undefined)
  assert.deepEqual(result.exits, [0])
})

test('rejects unsupported TUI arguments before activation', () => {
  const result = runStartup(['--unknown'])

  assert.match(result.output, /unknown option '--unknown'/u)
  assert.equal(result.values, undefined)
  assert.deepEqual(result.exits, [1])
})

test('settles keyless startup, client, kernel, and shell Loader rows without browser services', async () => {
  const restoreRuntime = installSupportedRuntime()
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    provideCmdline(ctx, { args: [], exit: () => {} })
    installPluginModules(ctx)
    ctx.provide('apiProxy', {})
    ctx.provide('typertGateway', {})

    await ctx.loader.create({ name: SHELL_PLUGIN_NAME, inject: [KERNEL_SERVICE] })
    await ctx.loader.create({ name: KERNEL_PLUGIN_NAME, inject: [STARTUP_SERVICE, CLIENT_SERVICE] })
    await ctx.loader.create({
      name: CLIENT_PLUGIN_NAME,
      inject: [STARTUP_SERVICE, 'apiProxy', 'typertGateway'],
    })
    await ctx.loader.create({ name: STARTUP_PLUGIN_NAME })
    await ctx.loader.await()
    await assertEntriesActivated(ctx, LOADER_TEST_LABEL)

    assert.deepEqual(ctx.get(STARTUP_SERVICE), { zen: true })
    assert.deepEqual(ctx.get(CLIENT_SERVICE), { ready: true })
    assert.deepEqual(ctx.get(KERNEL_SERVICE), { ready: true })
    assert.equal(ctx.get('webStartup'), undefined)
    assert.equal(ctx.get('webServer'), undefined)
    assert.equal(ctx.get('clientRuntime'), undefined)
    assert.deepEqual(
      [...ctx.loader.entries()].map(entry => entry.options.name).toSorted(),
      [CLIENT_PLUGIN_NAME, KERNEL_PLUGIN_NAME, SHELL_PLUGIN_NAME, STARTUP_PLUGIN_NAME].toSorted(),
    )
  } finally {
    restoreRuntime()
    await ctx.fiber.dispose()
  }
})
