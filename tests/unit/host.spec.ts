import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { startAgent } from '@/agent/host.ts'

/** Only the services `startAgent` reaches; the harness it drives is not under test. */
const ctxWithAgents = (agents: unknown, selection?: unknown): Context =>
  ({
    get: (name: string) => name === 'agentDefaultModel' && selection !== undefined
      ? { currentSelection: () => selection }
      : undefined,
    agents,
  }) as unknown as Context

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

describe('startAgent', () => {
  it('creates a session the resume could not find', async () => {
    const created: { agentOptions?: unknown }[] = []
    const agents = {
      resume: () => Promise.reject(absence()),
      create: (options: { agentOptions?: unknown }) => {
        created.push(options)
        return Promise.resolve(handle)
      },
    }
    const selection = { provider: 'kimi-coding', model: 'k2', reasoningEffort: 'max' }
    await expect(startAgent(ctxWithAgents(agents, selection), RESUME)).resolves.toMatchObject({ sessionId: 's' })
    expect(created).toHaveLength(1)
    // The route reaches the agent options whole, effort included: an effort left
    // behind here is one the reader sees in the status line but no request gets.
    expect(created[0]?.agentOptions).toEqual({ provider: 'kimi-coding', model: 'k2', reasoningEffort: 'max' })
    await startAgent(ctxWithAgents(agents, { provider: 'kimi-coding', model: 'k2' }), RESUME)
    // A default that carries no effort hands over no effort key at all, rather
    // than an undefined one the host would have to tolerate.
    expect(created[1]?.agentOptions).toEqual({ provider: 'kimi-coding', model: 'k2' })
    await startAgent(ctxWithAgents(agents, selection), { ...RESUME, provider: 'zai-coding-cn', model: 'glm-5.3' })
    // A launch flag is explicit, so it stands alone: the deployment default must
    // not widen the route the reader asked for.
    expect(created[2]?.agentOptions).toEqual({ provider: 'zai-coding-cn', model: 'glm-5.3' })
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
