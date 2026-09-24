import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TuiAgent } from '../agent/host.ts'
import {
  JOB_READ_LINES,
  createJobDirectory,
  describeJobs,
  parseJobsArgument,
  type JobDirectory,
  type JobSummary,
} from '../jobs.ts'
import { SubagentRoster, createSubagentControl, describeSubagents, parseSubagentsArgument, resolveRun } from '../subagents.ts'

/** Decode a lifecycle payload the roster only takes when it carries the shape it expects. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

/**
 * What the background-work owner needs from the surface that composes it.
 *
 * The agent and the session on screen are read at call time: a command, a
 * listener, or the job watch each has to follow whatever this terminal drives
 * now, and a captured identity would follow the one it drove at construction.
 */
export interface BackgroundWorkPorts {
  readonly drivingAgent: () => TuiAgent | undefined
  readonly activeSession: () => SessionId
  readonly notice: (text: string) => void
  readonly marker: (text: string) => void
  readonly render: () => void
  /** Show the session a child runs in; the viewed-session owner performs it. */
  readonly navigate: (id: string) => void
}

/** The commands and live reads the composing surface routes to this owner. */
export interface BackgroundWork {
  readonly roster: SubagentRoster
  readonly jobs: () => readonly JobSummary[]
  readonly refresh: () => void
  /** Fold the parent's durable catalog, which is where a child's task name lives. */
  readonly acceptCatalog: (info: unknown) => void
  readonly resetRoster: () => void
  readonly runSubagentsCommand: (argument: string) => void
  readonly runJobsCommand: (argument: string) => void
  /**
   * Register the two subagent lifecycle listeners.
   *
   * They are returned rather than pushed here so the composition root keeps one
   * ordered list of teardowns, which is unwound in reverse registration order.
   */
  readonly subagentListeners: () => readonly (() => void)[]
  readonly watchJobs: () => () => void
}

/**
 * The work that runs beside the conversation: background jobs and child agents.
 *
 * Neither is folded from the transcript. A job board is live state owned by a
 * service, and a child's name arrives on its own event, so this owner keeps
 * those reads and the two commands that show them in one place.
 */
export function createBackgroundWork(ctx: Context, ports: BackgroundWorkPorts): BackgroundWork {
  const jobDirectory: JobDirectory | undefined = createJobDirectory(ctx)
  let jobs: readonly JobSummary[] = []
  const roster = new SubagentRoster()
  const subagentControl = createSubagentControl(ctx)

  /** Re-read the job board; it is live state, so nothing else can fold it. */
  const refresh = (): void => {
    const agent = ports.drivingAgent()
    jobs = agent === undefined || jobDirectory === undefined ? [] : jobDirectory.list(agent.agent)
    ports.render()
  }

  /**
   * List or stop the delegations this session started.
   *
   * A child runs in the same process as an ordinary agent, so a stop is the
   * cancel a reader's Ctrl+C sends to the parent; nothing here reaches into the
   * child's own session, which keeps its own transcript either way.
   */
  const runSubagentsCommand = (argument: string): void => {
    const command = parseSubagentsArgument(argument)
    switch (command.kind) {
      case 'list':
        ports.notice(describeSubagents(roster.list(), Date.now()))
        ports.render()
        return
      case 'open': {
        const run = resolveRun(roster.list(), command.id)
        if (run === undefined) {
          ports.notice(`${command.id}: no single child matches; /subagents lists them`)
          ports.render()
          return
        }
        ports.navigate(run.id)
        return
      }
      case 'kill': {
        const stopped = subagentControl?.stop(command.id) ?? false
        ports.notice(stopped
          ? `${command.id}: stop requested`
          : `${command.id}: no live child with that id`)
        ports.render()
        return
      }
      case 'invalid':
        ports.notice(`/subagents: ${command.reason}`)
        ports.render()
        return
    }
  }

  const runJobsCommand = (argument: string): void => {
    const agent = ports.drivingAgent()
    if (jobDirectory === undefined) {
      ports.notice('this profile has no job registry, so there is nothing to list')
      ports.render()
      return
    }
    if (agent === undefined) {
      ports.notice('the agent is still starting; try again in a moment')
      ports.render()
      return
    }
    const command = parseJobsArgument(argument)
    switch (command.kind) {
      case 'list':
        refresh()
        ports.notice(describeJobs(jobs, Date.now()))
        ports.render()
        return
      case 'read': {
        const result = jobDirectory.read(agent.agent, command.id)
        const text = result?.text.trim() ?? ''
        ports.notice(text === ''
          ? `${command.id}: no output yet`
          : `${command.id} output\n${text.split('\n').slice(-JOB_READ_LINES).join('\n')}`)
        refresh()
        return
      }
      case 'kill': {
        const outcome = jobDirectory.kill(agent.agent, command.id)
        ports.notice(outcome === undefined
          ? `${command.id}: no such job`
          : outcome === 'requested' ? `${command.id}: stop requested` : `${command.id} had already finished`)
        refresh()
        return
      }
      case 'invalid':
        ports.notice(`/jobs: ${command.reason}`)
        ports.render()
        return
    }
  }

  /**
   * Subagent lifecycle arrives as a service event rather than a session event,
   * so it is decoration in the transcript: the parent's durable catalog
   * carries the child's task. The name is cast so a rename in the
   * harness cannot break compilation of this surface.
   */
  const listenFor = (name: string, handler: (...args: readonly unknown[]) => void): (() => void) =>
    (ctx.on as unknown as (event: string, listener: (...args: readonly unknown[]) => void) => () => void)(name, handler)

  return {
    roster,
    jobs: () => jobs,
    refresh,
    acceptCatalog: info => roster.catalog(info),
    resetRoster: () => roster.reset(),
    runSubagentsCommand,
    runJobsCommand,
    subagentListeners: () => [
      listenFor('subagent/start', info => {
        roster.start(info)
        const record = asRecord(info)
        const provider = typeof record?.provider === 'string' ? record.provider : 'subagent'
        const id = typeof record?.id === 'string' ? record.id : ''
        ports.marker(`subagent ${provider} started${id === '' ? '' : ` · ${id}`}`)
        ports.render()
      }),
      listenFor('subagent/end', info => {
        roster.end(info)
        const record = asRecord(info)
        const provider = typeof record?.provider === 'string' ? record.provider : 'subagent'
        const stop = typeof record?.stopReason === 'string' ? record.stopReason : undefined
        ports.marker(`subagent ${provider} finished${stop === undefined ? '' : ` · ${stop}`}`)
        ports.render()
      }),
    ],
    // The board is live state: watch it directly rather than folding events.
    watchJobs: () => jobDirectory?.watch(owner => {
      if (owner !== undefined && (owner as { id?: string }).id !== ports.activeSession()) return
      refresh()
    }) ?? (() => {}),
  }
}
