import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsForms } from '@deepseek-ai/dsh-settings'
import { Context, type Plugin } from '@deepseek-ai/cordis'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import { LlmAdapter, LlmRuntime, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { readRowSettings } from '@/config.ts'
import * as tui from '@/index.ts'
import { createModelCatalog } from '@/agent/model.ts'
import { createStatusFacts } from '@/agent/status.ts'

const PLUGIN_ACTION_ID = 'plugin.example.options'
const PLUGIN_KEY = 'v'
const SESSION_ID = SessionId('config-loader-regression')
const PROVIDER = 'standalone-core'
const MODEL = 'offline-model'
const MODEL_NAME = 'Offline model'
const STREAM_ERROR = 'config-loader regression must not generate a model request'
const PREFERENCES = {
  theme: 'violet-orbit',
  palette: { muted: '#777777' },
  tokens: { 'transcript.user': { fg: '#ff0000' } },
  subcalls: 'collapsed',
  mermaid: 'off',
  prefix: 'alt+x',
  prefixWindow: 0,
  keys: { 'surface.effort': 'ctrl+e' },
  history: { enabled: false, ghost: false, maxEntries: 17 },
  tools: { bash: { collapsed: false, output: 'tail', tail: 3 } },
}

/** The public entry must expose the schema Cordis discovers, not only a private parser. */
function exportedConfig(): NonNullable<Plugin.Runtime['Config']> {
  const Config = (tui as typeof tui & { Config?: Plugin.Runtime['Config'] }).Config
  expect(Config).toBeDefined()
  return Config!
}

/** Static core metadata proves discovery without loading provider-extra or making requests. */
class OfflineAdapter extends LlmAdapter {
  override async listModels() {
    return [{ provider: PROVIDER, id: MODEL, name: MODEL_NAME }]
  }

  override async *stream(): AsyncIterable<StreamChunk> {
    throw new Error(STREAM_ERROR)
  }
}

describe('standalone plugin Config loading', () => {
  it('preserves existing preferences and explicit false history switches through Cordis validation', async () => {
    const Config = exportedConfig()
    const ctx = new Context()
    const apply = vi.fn()
    const raw = { sessionId: SESSION_ID, color: false, bell: false, ...structuredClone(PREFERENCES) }
    const before = structuredClone(raw)
    try {
      // A no-op body reaches Cordis validation without acquiring a terminal or session.
      const fiber = await ctx.plugin({ Config, apply }, raw)
      expect(apply).toHaveBeenCalledOnce()
      // Validation reaches the values through the references the schema runtime
      // creates, which is the layer the surface itself reads preferences from.
      expect(readRowSettings(fiber.config)).toMatchObject(PREFERENCES)
      expect(raw).toEqual(before)
      expect(readRowSettings(apply.mock.calls[0]?.[1])).toMatchObject({
        history: { enabled: false, ghost: false, maxEntries: PREFERENCES.history.maxEntries },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each([{}, { history: {} }])('does not synthesize enabled history before preferences arrive: %j', async preferences => {
    const Config = exportedConfig()
    const ctx = new Context()
    try {
      const fiber = await ctx.plugin({ Config, apply: vi.fn() }, { sessionId: SESSION_ID, ...preferences })
      // Absence stays absent: nothing here may turn the opt-in switches on for
      // a document whose import has not landed yet.
      expect(readRowSettings(fiber.config)).not.toHaveProperty('history.enabled')
      expect(readRowSettings(fiber.config)).not.toHaveProperty('history.ghost')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('discovers providers, models, and default selection using only normal core services', async () => {
    const ctx = new Context()
    const adapter = new OfflineAdapter()
    const stream = vi.spyOn(adapter, 'stream')
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(AgentDefaultModelConfig, { provider: PROVIDER, model: MODEL })
      ctx.llm.registerAdapter([PROVIDER], adapter)

      const catalog = createModelCatalog(ctx)
      expect(catalog).toBeDefined()
      expect(catalog!.providers()).toEqual([{ id: PROVIDER, name: PROVIDER }])
      await expect(catalog!.models(PROVIDER)).resolves.toEqual([{ id: MODEL, name: MODEL_NAME }])
      expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: PROVIDER, model: MODEL })
      expect(createStatusFacts(ctx, {
        sessionId: () => SESSION_ID,
        activity: () => ({ running: false, startedAt: undefined }),
      })()).toMatchObject({ provider: PROVIDER, model: MODEL })
      expect(stream).not.toHaveBeenCalled()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
it('keeps optional plugin key preferences through real Cordis Config references', async () => {
  const ctx = new Context()
  try {
    const fiber = await ctx.plugin({ Config: exportedConfig(), apply: vi.fn() }, { sessionId: SESSION_ID, keys: { [PLUGIN_ACTION_ID]: PLUGIN_KEY } })
    expect(readRowSettings(fiber.config)).toMatchObject({ keys: { [PLUGIN_ACTION_ID]: PLUGIN_KEY } })
  } finally { await ctx.fiber.dispose() }
})
/** The public form projection, not only Config parsing, controls what the painter can read. */
it('keeps optional plugin keys in the public profile settings projection', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-keymap-projection-'))
  const ctx = new Context()
  const raw = { sessionId: SESSION_ID, keys: { [PLUGIN_ACTION_ID]: PLUGIN_KEY } }
  try {
    const fiber = await ctx.plugin({ Config: exportedConfig(), apply: vi.fn() }, raw)
    const entry = { id: SESSION_ID, options: { id: SESSION_ID, config: raw }, fiber }
    // Metadata and startup readiness stay inert; the shipped service owns all projection behavior.
    ctx.provide('configEditor', { configuration: () => [{ entry, inherited: raw, override: raw }] } as never)
    ctx.provide('profileContext', { home } as never)
    ctx.provide('loader', { await: async () => {} } as never)
    const forms = new SettingsForms(ctx)
    expect(forms.describe()[0]?.value).toMatchObject({ keys: { [PLUGIN_ACTION_ID]: PLUGIN_KEY } })
    await new Promise<void>(resolve => setImmediate(resolve))
  } finally { await ctx.fiber.dispose(); rmSync(home, { recursive: true, force: true }) }
})
