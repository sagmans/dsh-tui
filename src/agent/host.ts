import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionLogOffset, type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** Everything the terminal surface needs to own one interactive agent. */
export interface TuiAgent {
  readonly sessionId: SessionId
  readonly agent: Agent
  /** Queue an ordinary next-turn prompt from the human. */
  submit(text: string): void
  /** Redirect the running turn without starting another one. */
  steer(text: string): void
  /** Abort the active activity; the inbox is left alone. */
  interrupt(): void
  /** Stop the loop and release the session. */
  dispose(): Promise<void>
}

/** History a fork inherits from the session it branches off. */
export interface ForkInheritance {
  /** Session the branch starts from. */
  readonly from: SessionId
  /** Contiguous prefix of that session's log, ending on a completed turn. */
  readonly events: readonly unknown[]
}

/** Launch inputs that decide which agent this run drives. */
export interface StartAgentOptions {
  readonly sessionId: SessionId
  readonly resume: boolean
  readonly model: string | undefined
  readonly provider: string | undefined
  /** Workspace for a fresh session; ignored when resuming persisted history. */
  readonly cwd: string
  /**
   * Compose the agent's own scoped world before it is published.
   *
   * Agent-scoped waterfalls — model selection among them — only see requests
   * dispatched inside that scope, so they must be registered here rather than
   * on the context that created the agent.
   */
  readonly setup?: (agentCtx: Context) => void
  /** Branch from another session's completed history instead of starting empty. */
  readonly fork?: ForkInheritance
  /**
   * Agent preset a NEW session runs, recorded in its header.
   *
   * The caller mounts it in `setup`; a resume keeps the preset its own log
   * recorded, so it never passes one.
   */
  readonly preset?: string | undefined
}

function routeOf(ctx: Context, options: StartAgentOptions): { provider?: string; model?: string } {
  if (options.model !== undefined || options.provider !== undefined) {
    return {
      ...(options.provider === undefined ? {} : { provider: options.provider }),
      ...(options.model === undefined ? {} : { model: options.model }),
    }
  }
  const selection = ctx.get('agentDefaultModel')?.currentSelection()
  return selection === undefined ? {} : { provider: selection.provider, model: selection.model }
}

function userMessage(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/**
 * Create or resume the one agent this surface drives.
 *
 * A resume is attempted first when the launcher asked for it, because a
 * session that exists must keep its own identity and history; a missing
 * session is not an error the user should see, so creation is the fallback.
 */
export async function startAgent(ctx: Context, options: StartAgentOptions): Promise<TuiAgent> {
  const agentOptions = routeOf(ctx, options)
  const meta = { cwd: options.cwd }
  const setup = options.setup === undefined ? {} : { setup: options.setup }
  // A branch inherits a prefix of its parent's log, so the child is marked as
  // seeded and carries the exact cut the host validates against.
  const branch = options.fork === undefined
    ? {}
    : {
        seed: options.fork.events as readonly SessionEvent[],
        inheritedEventCount: SessionLogOffset(options.fork.events.length),
      }
  const preset = options.preset === undefined ? {} : { agentPreset: options.preset }
  const identity = options.fork === undefined
    ? { ...meta, ...preset }
    : { ...meta, parentSession: options.fork.from, isSeeded: true, ...preset }
  const handle = options.resume
    ? await ctx.agents
        .resume({ resumeSessionId: options.sessionId, agentOptions, ...setup })
        .catch(() => ctx.agents.create({ sessionId: options.sessionId, meta: identity, agentOptions, ...branch, ...setup }))
    : await ctx.agents.create({ sessionId: options.sessionId, meta: identity, agentOptions, ...branch, ...setup })
  let disposed = false
  return {
    sessionId: options.sessionId,
    agent: handle.agent,
    submit: text => handle.agent.followup(userMessage(text)),
    steer: text => handle.agent.steer(userMessage(text)),
    interrupt: () => handle.agent.cancel({ kind: 'user' }),
    dispose: async () => {
      if (disposed) return
      disposed = true
      await handle.dispose()
    },
  }
}
