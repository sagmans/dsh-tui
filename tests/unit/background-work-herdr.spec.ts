import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import type { TuiAgent } from '@/agent/host.ts'
import type { HerdrClient } from '@/herdr/client.ts'
import { HERDR_STATES } from '@/herdr/constants.ts'
import { createHerdrReporter } from '@/herdr/reporter.ts'
import { createBackgroundWork, type BackgroundWorkPorts } from '@/surface/background-work.ts'

const PARENT_ID = 'parent-session'
const CHILD_ID = 'child-session'
const CHILD_RUN_ID = 'child-run'
const CHILD_PROVIDER = 'spawn'
const JOB_ID = 'background-job'
const JOB_KIND = 'shell'
const JOB_LABEL = 'sleep'
const STARTED_AT = 1
const JOB_RUNNING = 'running'
const JOB_COMPLETED = 'completed'
const DRIVER_RUNNING = 'running'
const DRIVER_IDLE = 'idle'
const SUBAGENT_START = 'subagent/start'
const SUBAGENT_END = 'subagent/end'
const STOP_COMPLETED = 'completed'
const JOBS_SERVICE = 'jobs'
/** Let the registry's completion handoff reach the deferred state report. */
const settleReports = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

/** The socket is external to this boundary; its state reports are the observable result. */
function fixture() {
  const states: string[] = []
  const listeners = new Map<string, (payload: unknown) => void>()
  let jobs: readonly unknown[] = []
  let jobsChanged: (owner?: unknown) => void = () => {}
  const client: HerdrClient = {
    enabled: true,
    reportState: async report => (states.push(report.state), true),
    reportSession: async () => true,
    reportMetadata: async () => true,
    reportStateLabel: async () => true,
    stop: () => {},
    settle: async () => {},
  }
  const reporter = createHerdrReporter({ client })
  const ctx = {
    get: (name: string) => name === JOBS_SERVICE ? {
      list: () => jobs,
      onJobsChanged: (listener: (owner?: unknown) => void) => {
        jobsChanged = listener
        return () => {}
      },
    } : undefined,
    on: (name: string, listener: (payload: unknown) => void) => {
      listeners.set(name, listener)
      return () => { listeners.delete(name) }
    },
  } as unknown as Context
  const ports: BackgroundWorkPorts = {
    drivingAgent: () => ({ agent: { id: PARENT_ID } }) as TuiAgent,
    activeSession: () => SessionId(PARENT_ID),
    notice: () => {},
    marker: () => {},
    render: () => {},
    navigate: () => {},
    backgroundChanged: running => reporter.background(running),
  }
  const work = createBackgroundWork(ctx, ports)
  return {
    states,
    reporter,
    work,
    emit: (name: string, payload: unknown) => listeners.get(name)?.(payload),
    setJobs: (next: readonly unknown[]) => { jobs = next; jobsChanged({ id: PARENT_ID }) },
  }
}

describe('background work reported to Herdr', () => {
  it('keeps the pane working after the parent driver stops while a child runs', async () => {
    const { states, reporter, work, emit } = fixture()
    work.subagentListeners()
    reporter.driver(DRIVER_RUNNING)

    emit(SUBAGENT_START, { runId: CHILD_RUN_ID, id: CHILD_ID, provider: CHILD_PROVIDER })
    reporter.driver(DRIVER_IDLE)
    expect(states.at(-1)).toBe(HERDR_STATES.working)

    emit(SUBAGENT_END, { runId: CHILD_RUN_ID, id: CHILD_ID, provider: CHILD_PROVIDER, stopReason: STOP_COMPLETED })
    await settleReports()
    expect(states.at(-1)).toBe(HERDR_STATES.idle)
  })

  it('keeps the pane working after the parent driver stops while a job runs', async () => {
    const { states, reporter, work, setJobs } = fixture()
    work.watchJobs()
    reporter.driver(DRIVER_RUNNING)

    setJobs([{ id: JOB_ID, kind: JOB_KIND, label: JOB_LABEL, status: JOB_RUNNING, startedAt: STARTED_AT }])
    reporter.driver(DRIVER_IDLE)
    expect(states.at(-1)).toBe(HERDR_STATES.working)

    setJobs([{ id: JOB_ID, kind: JOB_KIND, label: JOB_LABEL, status: JOB_COMPLETED, startedAt: STARTED_AT }])
    await settleReports()
    expect(states.at(-1)).toBe(HERDR_STATES.idle)
  })

  it('does not announce done between a job settling and its notice waking the parent', async () => {
    const { states, reporter, work, setJobs } = fixture()
    work.watchJobs()
    reporter.driver(DRIVER_RUNNING)
    setJobs([{ id: JOB_ID, kind: JOB_KIND, label: JOB_LABEL, status: JOB_RUNNING, startedAt: STARTED_AT }])
    reporter.driver(DRIVER_IDLE)
    const beforeCompletion = states.length

    // The job registry announces the settled record before its completion
    // listener sends a follow-up, so the two callbacks share one event turn.
    setJobs([{ id: JOB_ID, kind: JOB_KIND, label: JOB_LABEL, status: JOB_COMPLETED, startedAt: STARTED_AT }])
    reporter.driver(DRIVER_RUNNING)
    await settleReports()

    expect(states.slice(beforeCompletion)).toEqual([])
    expect(states.at(-1)).toBe(HERDR_STATES.working)
  })
})
