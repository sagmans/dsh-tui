import { Context, type Plugin } from '@deepseek-ai/cordis'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import { LlmAdapter, LlmRuntime, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import * as tui from '@/index.ts'
import { createModelCatalog } from '@/agent/model.ts'
import { createStatusFacts } from '@/agent/status.ts'

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
  it('exports a loader-discoverable Config from the public plugin entry', () => {
    expect(exportedConfig()['~standard']).toBeDefined()
  })

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
      expect(fiber.config).toMatchObject(before)
      expect(raw).toEqual(before)
      expect(apply.mock.calls[0]?.[1]).toMatchObject({
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
      expect(fiber.config.history?.enabled).toBeUndefined()
      expect(fiber.config.history?.ghost).toBeUndefined()
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
