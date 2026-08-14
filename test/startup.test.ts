import assert from 'node:assert/strict'
import { afterEach, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { assertEntriesActivated } from '@deepseek-ai/dsh-app-boot'
import { internals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import * as startupPlugin from '../src/startup.js'

const ORIGINAL_INTERNALS = { ...internals }
const STARTUP_SERVICE = 'tuiStartup'
const CLIENT_SERVICE = 'tuiClient'
const KERNEL_SERVICE = 'tuiKernel'
const LOADER_TEST_LABEL = 'dsh-tui Loader test'
const STARTUP_PLUGIN_NAME = '@sagmans/dsh-tui/startup'
const CLIENT_PLUGIN_NAME = '@sagmans/dsh-tui/service/client'
const KERNEL_PLUGIN_NAME = '@sagmans/dsh-tui'
const SHELL_PLUGIN_NAME = '@sagmans/dsh-tui/feature/shell'
const SESSIONS_PLUGIN_NAME = '@sagmans/dsh-tui/feature/sessions'
const MODEL_SELECTION_PLUGIN_NAME = '@sagmans/dsh-tui/feature/model-selection'
const MODEL_SELECTION_SERVICE = 'tuiModelSelection'
const INPUT_TRIGGER_PLUGIN_NAME = '@sagmans/dsh-tui/feature/input-trigger'
const INPUT_TRIGGER_SERVICE = 'tuiInputTrigger'
const DELIVERABLES_PLUGIN_NAME = '@sagmans/dsh-tui/feature/deliverables'
const CONVERSATION_PLUGIN_NAME = '@sagmans/dsh-tui/feature/conversation'
const TOOLS_PLUGIN_NAME = '@sagmans/dsh-tui/feature/tools'
const INTERACTIONS_PLUGIN_NAME = '@sagmans/dsh-tui/feature/interactions'
const OPERATIONS_PLUGIN_NAME = '@sagmans/dsh-tui/feature/operations'
const SETTINGS_PLUGIN_NAME = '@sagmans/dsh-tui/feature/settings'

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

function installPluginModules(ctx: Context): void {
  const clientPlugin = {
    name: 'tui-client-fixture',
    apply(clientContext: Context): void {
      clientContext.provide(CLIENT_SERVICE, Object.freeze({
        ready: true,
        api: {},
        context: clientContext,
      }))
    },
  }
  const kernelPlugin = {
    name: 'tui-kernel-fixture',
    apply(kernelContext: Context): void {
      kernelContext.provide(KERNEL_SERVICE, Object.freeze({ ready: true }))
    },
  }
  const shellPlugin = {
    name: 'tui-shell-fixture',
    inject: [KERNEL_SERVICE],
    apply(): void {},
  }
  const sessionsPlugin = {
    name: 'tui-sessions-fixture',
    inject: [KERNEL_SERVICE, CLIENT_SERVICE],
    apply(): void {},
  }
  const modelSelectionPlugin = {
    name: 'tui-model-selection-fixture',
    inject: [KERNEL_SERVICE, CLIENT_SERVICE],
    apply(modelContext: Context): void {
      modelContext.provide(MODEL_SELECTION_SERVICE, Object.freeze({ ready: true }))
    },
  }
  const inputTriggerPlugin = {
    name: 'tui-input-trigger-fixture',
    inject: [CLIENT_SERVICE],
    apply(triggerContext: Context): void {
      triggerContext.provide(INPUT_TRIGGER_SERVICE, Object.freeze({ ready: true }))
    },
  }
  const deliverablesPlugin = {
    name: 'tui-deliverables-fixture',
    inject: ['systemPrompt'],
    apply(): void {},
  }
  const conversationPlugin = {
    name: 'tui-conversation-fixture',
    inject: [KERNEL_SERVICE, CLIENT_SERVICE, MODEL_SELECTION_SERVICE, INPUT_TRIGGER_SERVICE],
    apply(): void {},
  }
  const toolsPlugin = {
    name: 'tui-tools-fixture',
    inject: [KERNEL_SERVICE, CLIENT_SERVICE],
    apply(): void {},
  }
  const interactionsPlugin = {
    name: 'tui-interactions-fixture',
    inject: [KERNEL_SERVICE, CLIENT_SERVICE],
    apply(): void {},
  }
  const operationsPlugin = {
    name: 'tui-operations-fixture',
    inject: [KERNEL_SERVICE, CLIENT_SERVICE],
    apply(): void {},
  }
  const settingsPlugin = {
    name: 'tui-settings-fixture',
    inject: [KERNEL_SERVICE, CLIENT_SERVICE],
    apply(): void {},
  }
  const modules = new Map<string, unknown>([
    [STARTUP_PLUGIN_NAME, startupPlugin],
    [CLIENT_PLUGIN_NAME, clientPlugin],
    [KERNEL_PLUGIN_NAME, kernelPlugin],
    [SHELL_PLUGIN_NAME, shellPlugin],
    [SESSIONS_PLUGIN_NAME, sessionsPlugin],
    [MODEL_SELECTION_PLUGIN_NAME, modelSelectionPlugin],
    [INPUT_TRIGGER_PLUGIN_NAME, inputTriggerPlugin],
    [DELIVERABLES_PLUGIN_NAME, deliverablesPlugin],
    [CONVERSATION_PLUGIN_NAME, conversationPlugin],
    [TOOLS_PLUGIN_NAME, toolsPlugin],
    [INTERACTIONS_PLUGIN_NAME, interactionsPlugin],
    [OPERATIONS_PLUGIN_NAME, operationsPlugin],
    [SETTINGS_PLUGIN_NAME, settingsPlugin],
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
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    provideCmdline(ctx, { args: [], exit: () => {} })
    installPluginModules(ctx)
    ctx.provide('apiProxy', {})
    ctx.provide('typertGateway', {})
    ctx.provide('systemPrompt', {})

    await ctx.loader.create({ name: SHELL_PLUGIN_NAME, inject: [KERNEL_SERVICE] })
    await ctx.loader.create({ name: SESSIONS_PLUGIN_NAME, inject: [KERNEL_SERVICE, CLIENT_SERVICE] })
    await ctx.loader.create({ name: MODEL_SELECTION_PLUGIN_NAME, inject: [KERNEL_SERVICE, CLIENT_SERVICE] })
    await ctx.loader.create({ name: INPUT_TRIGGER_PLUGIN_NAME, inject: [CLIENT_SERVICE] })
    await ctx.loader.create({ name: DELIVERABLES_PLUGIN_NAME, inject: ['systemPrompt'] })
    await ctx.loader.create({
      name: CONVERSATION_PLUGIN_NAME,
      inject: [KERNEL_SERVICE, CLIENT_SERVICE, MODEL_SELECTION_SERVICE, INPUT_TRIGGER_SERVICE],
    })
    await ctx.loader.create({ name: TOOLS_PLUGIN_NAME, inject: [KERNEL_SERVICE, CLIENT_SERVICE] })
    await ctx.loader.create({ name: INTERACTIONS_PLUGIN_NAME, inject: [KERNEL_SERVICE, CLIENT_SERVICE] })
    await ctx.loader.create({ name: OPERATIONS_PLUGIN_NAME, inject: [KERNEL_SERVICE, CLIENT_SERVICE] })
    await ctx.loader.create({ name: SETTINGS_PLUGIN_NAME, inject: [KERNEL_SERVICE, CLIENT_SERVICE] })
    await ctx.loader.create({ name: KERNEL_PLUGIN_NAME, inject: [STARTUP_SERVICE, CLIENT_SERVICE] })
    await ctx.loader.create({
      name: CLIENT_PLUGIN_NAME,
      inject: [STARTUP_SERVICE, 'apiProxy', 'typertGateway'],
    })
    await ctx.loader.create({ name: STARTUP_PLUGIN_NAME })
    await ctx.loader.await()
    await assertEntriesActivated(ctx, LOADER_TEST_LABEL)

    assert.deepEqual(ctx.get(STARTUP_SERVICE), { zen: true })
    assert.notEqual(ctx.get(CLIENT_SERVICE), undefined)
    const kernel: unknown = ctx.get(KERNEL_SERVICE)
    const ready: unknown = typeof kernel === 'object' && kernel !== null
      ? Reflect.get(kernel, 'ready') as unknown
      : undefined
    assert.equal(ready, true)
    assert.equal(ctx.get('webStartup'), undefined)
    assert.equal(ctx.get('webServer'), undefined)
    assert.equal(ctx.get('clientRuntime'), undefined)
    assert.deepEqual(
      [...ctx.loader.entries()].map(entry => entry.options.name).toSorted(),
      [
        CLIENT_PLUGIN_NAME,
        CONVERSATION_PLUGIN_NAME,
        DELIVERABLES_PLUGIN_NAME,
        INPUT_TRIGGER_PLUGIN_NAME,
        INTERACTIONS_PLUGIN_NAME,
        KERNEL_PLUGIN_NAME,
        MODEL_SELECTION_PLUGIN_NAME,
        OPERATIONS_PLUGIN_NAME,
        SETTINGS_PLUGIN_NAME,
        SESSIONS_PLUGIN_NAME,
        SHELL_PLUGIN_NAME,
        STARTUP_PLUGIN_NAME,
        TOOLS_PLUGIN_NAME,
      ].toSorted(),
    )
  } finally {
    await ctx.fiber.dispose()
  }
})
