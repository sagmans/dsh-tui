import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { absentSession, agentRoute, startAgent } from '@/agent/host.ts'

const ctxServing = (selection: unknown): Context =>
  ({ get: () => selection === undefined ? undefined : { currentSelection: () => selection } }) as unknown as Context

/** Only the services `startAgent` reaches; the harness it drives is not under test. */
const ctxWithAgents = (agents: unknown): Context =>
  ({ get: () => undefined, agents }) as unknown as Context

/** No launch flags, so the route comes from the deployment default. */
const NO_FLAGS = { model: undefined, provider: undefined }

const RESUME = {
  sessionId: SessionId('s'),
  resume: true,
  model: undefined,
  provider: undefined,
  cwd: '/tmp',
}

const handle = { agent: {}, dispose: () => Promise.resolve() }

const absence = (): Error =>
  Object.assign(new Error('session "s" not found'), { name: 'SessionPersistenceNotFoundError' })

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
    const route = agentRoute(ctxServing({ provider: 'zai-coding-cn', model: 'glm-5.3' }), {
      provider: 'zai-coding-cn',
      model: 'glm-5.3',
    })
    expect(route).toEqual({ provider: 'zai-coding-cn', model: 'glm-5.3' })
  })
})

describe('absentSession', () => {
  it('recognises the harness absence refusal by its stable name', () => {
    expect(absentSession(absence())).toBe(true)
  })

  it('refuses to read any other failure as absence', () => {
    expect(absentSession(new Error('session "s" not found'))).toBe(false)
    expect(absentSession('session "s" not found')).toBe(false)
  })
})

describe('startAgent', () => {
  it('creates a session the resume could not find', async () => {
    const created: unknown[] = []
    const agents = {
      resume: () => Promise.reject(absence()),
      create: (options: unknown) => {
        created.push(options)
        return Promise.resolve(handle)
      },
    }
    await expect(startAgent(ctxWithAgents(agents), RESUME)).resolves.toMatchObject({ sessionId: 's' })
    expect(created).toHaveLength(1)
  })

  it('surfaces a resume failure that is not absence instead of masking it with a create', async () => {
    const failure = new Error('preset "probe" failed to mount')
    let created = 0
    const agents = {
      resume: () => Promise.reject(failure),
      create: () => {
        created += 1
        return Promise.resolve(handle)
      },
    }
    await expect(startAgent(ctxWithAgents(agents), RESUME)).rejects.toBe(failure)
    expect(created).toBe(0)
  })
})
