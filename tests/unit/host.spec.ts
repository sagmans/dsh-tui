import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { agentRoute } from '@/agent/host.ts'

const ctxServing = (selection: unknown): Context =>
  ({ get: () => selection === undefined ? undefined : { currentSelection: () => selection } }) as unknown as Context

/** No launch flags, so the route comes from the deployment default. */
const NO_FLAGS = { model: undefined, provider: undefined }

describe('agentRoute', () => {
  it('carries the deployment default reasoning effort into the agent options', () => {
    const route = agentRoute(ctxServing({ provider: 'kimi-coding', model: 'k2', reasoningEffort: 'max' }), NO_FLAGS)
    expect(route).toEqual({ provider: 'kimi-coding', model: 'k2', reasoningEffort: 'max' })
  })

  it('omits an effort the deployment default does not carry', () => {
    expect(agentRoute(ctxServing({ provider: 'kimi-coding', model: 'k2' }), NO_FLAGS))
      .toEqual({ provider: 'kimi-coding', model: 'k2' })
  })

  it('lets an explicit launch route stand without the default effort', () => {
    const route = agentRoute(ctxServing({ provider: 'kimi-coding', model: 'k2', reasoningEffort: 'max' }), {
      provider: 'zai-coding-cn',
      model: 'glm-5.3',
    })
    expect(route).toEqual({ provider: 'zai-coding-cn', model: 'glm-5.3' })
  })
})
