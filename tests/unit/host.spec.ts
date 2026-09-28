import type { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
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

  it('seeds a fork with the inherited prefix and the count the host validates it at', async () => {
    const created: Record<string, unknown>[] = []
    const agents = {
      create: (options: Record<string, unknown>) => {
        created.push(options)
        return Promise.resolve(handle)
      },
    }
    const events = [{ type: 'turn/end' }]
    await startAgent(ctxWithAgents(agents), {
      ...RESUME,
      resume: false,
      fork: { from: SessionId('parent'), events },
    })
    // A fork replays a prefix of the parent's log, so the child has to be told
    // both the events and where the cut was taken: a dropped count presents
    // inherited history as the child's own and loses the parent's turns.
    expect(created[0]).toMatchObject({
      seed: events,
      inheritedEventCount: SessionLogOffset(events.length),
      meta: { parentSession: 'parent', isSeeded: true },
    })
  })

  it('starts a launch that is not a fork with nothing inherited', async () => {
    const created: { meta?: Record<string, unknown> }[] = []
    const agents = {
      create: (options: { meta?: Record<string, unknown> }) => {
        created.push(options)
        return Promise.resolve(handle)
      },
    }
    await startAgent(ctxWithAgents(agents), { ...RESUME, resume: false })
    // The seed marker is what makes the harness treat a log as inherited, so a
    // session that branches off nothing must carry none of it.
    expect(created[0]).not.toHaveProperty('seed')
    expect(created[0]).not.toHaveProperty('inheritedEventCount')
    expect(created[0]?.meta).not.toHaveProperty('isSeeded')
    expect(created[0]?.meta).not.toHaveProperty('parentSession')
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
