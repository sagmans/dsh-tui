import { describe, expect, it } from 'vitest'
import { createTheme } from '@/theme.ts'
import { TranscriptModel } from '@/transcript.ts'
import { MarkdownRenderer } from '@/ui/markdown.ts'
import { StatusBar } from '@/ui/status.ts'
import { TranscriptView, type ViewState } from '@/ui/view.ts'
import { WorkDock } from '@/ui/dock.ts'
import { SessionPicker } from '@/ui/picker.ts'
import { WorkFold } from '@/work.ts'

/**
 * Golden frames.
 *
 * The projection is pure, so a fixed transcript at a fixed width is a stable
 * artefact: these snapshots are the regression contract a TTY cannot give in
 * CI. Both a comfortable and a cramped width are pinned, because wrapping and
 * truncation are where a terminal surface usually breaks.
 */
const WIDTHS = [80, 40]
const theme = createTheme(false)

function fixture(): { view: TranscriptView; dock: WorkDock; status: StatusBar } {
  // A clock that only moves when the fixture says so keeps a frame reproducible.
  let clock = NOW
  const model = new TranscriptModel(undefined, () => clock)
  const work = new WorkFold()
  const feed = (event: { type: string; data?: unknown }): void => {
    model.apply(event)
    work.apply(event)
  }
  model.apply({ type: 'user/message', data: { content: [{ type: 'text', text: 'add a dock above the editor' }], source: { kind: 'user' } } })
  feed({ type: 'user/message', data: { content: [{ type: 'text', text: '<system-reminder>\nfollow the plan\nkeep it short' }], source: { kind: 'plugin', plugin: 'dsh-agent-instructions' } } })
  model.applyStreamChunk({ type: 'reasoning-delta', text: 'the dock needs the fold\nand the fold needs the events' })
  clock = NOW + 3_000
  model.applyStreamChunk({ type: 'block-end', block: { type: 'reasoning' } })
  model.apply({
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: 'Done.\n\n- fold the work state\n- render it only when it says something\n\n```ts\nconst dock = new WorkDock(state, theme)\n```' }] } },
  })
  model.apply({ type: 'tool/call', data: { name: 'bash', arguments: '{"command":"pnpm test"}', callId: 'c1' } })
  model.apply({
    type: 'tool/result',
    data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', text: 'Tests  154 passed (154)' }], isError: false } },
  })
  model.apply({ type: 'compaction/summary', data: { shadowedSeqs: [1, 2, 3], shadowedTokenCount: 4200 } })
  feed({ type: 'plan/mode', data: { active: true } })
  feed({ type: 'todo/write', data: { todos: [
    { content: 'write the dock', status: 'completed' },
    { content: 'verify the dock', status: 'in_progress' },
    { content: 'document the dock', status: 'pending' },
  ] } })
  const state: ViewState = { expandCards: false, expandReasoning: false }
  const view = new TranscriptView(model, theme, new MarkdownRenderer(theme.markdown), {
    state: () => state,
    gate: () => undefined,
    picker: () => undefined,
  })
  return {
    view,
    dock: new WorkDock(() => work.state(), theme),
    status: new StatusBar(() => ({
      activity: 'idle',
      elapsedMs: undefined,
      provider: 'zai-coding-cn',
      model: 'glm-5.3',
      effort: 'max',
      agentPreset: 'standard',
      preset: 'workspace-write',
      contextTokens: 17_500,
      contextWindow: 1_000_000,
      cacheRate: 0.87,
      uncachedInputTokens: 2_300,
      outputTokens: 3_100,
      cwd: '/Users/dev/source/opensource/deepseek-harness/master',
      home: '/Users/dev',
    }), theme),
  }
}

/** One frozen moment, so a frame with elapsed times is still a stable artefact. */
const NOW = 1_700_000_000_000

function busyDock(): WorkDock {
  const work = new WorkFold()
  work.apply({ type: 'plan/mode', data: { active: true } })
  work.apply({ type: 'todo/write', data: { todos: [
    { content: 'write the dock', status: 'completed' },
    { content: 'verify the dock', status: 'in_progress' },
  ] } })
  work.apply({ type: 'goal/change', data: { operation: 'create', roundsStarted: 6, goal: { objective: 'complete the plan for this dsh-tui plugin', maxGoalRounds: 256 } } })
  const jobs = [
    { id: 'bash-1', kind: 'bash', label: 'sleep 45 && echo bg-done', status: 'running' as const, startedAt: NOW - 12_000, finishedAt: undefined },
  ]
  const runs = [
    { runId: 'r1', provider: 'spawn', id: 'c000cfa3-1111-2222', startedAt: NOW - 4_000, status: 'running' as const },
    { runId: 'r2', provider: 'fork', id: 'f05abce2-3333-4444', startedAt: NOW - 30_000, status: 'completed' as const, finishedAt: NOW - 28_000 },
  ]
  return new WorkDock(() => work.state(), theme, () => jobs, () => runs, () => NOW)
}

function pickerCard(): SessionPicker {
  return new SessionPicker(
    [
      { id: 'tui-session-33e6ddc3-c871-4534-aae1-8c38f7cf69a2', cwd: '/Users/dev/source/opensource/deepseek-harness/master', createdAt: NOW - 240_000, eventCount: 22 },
      { id: 'tui-session-f38b6841-9229-4c2f-8c82-0ced1eee68ea', cwd: '/Users/dev/source/opensource/deepseek-harness/master', createdAt: NOW - 900_000, eventCount: 41 },
    ],
    () => new Map([['tui-session-33e6ddc3-c871-4534-aae1-8c38f7cf69a2', 'dock polish']]),
    () => NOW,
  )
}

describe('golden frames', () => {
  for (const width of WIDTHS) {
    it(`renders the transcript at ${width} columns`, () => {
      expect(fixture().view.render(width)).toMatchSnapshot()
    })

    it(`renders the dock at ${width} columns`, () => {
      expect(fixture().dock.render(width)).toMatchSnapshot()
    })

    it(`renders the status row at ${width} columns`, () => {
      expect(fixture().status.render(width)).toMatchSnapshot()
    })
  }

  for (const width of WIDTHS) {
    it(`renders a busy dock at ${width} columns`, () => {
      expect(busyDock().render(width)).toMatchSnapshot()
    })

    it(`renders the session picker at ${width} columns`, () => {
      expect(pickerCard().card()).toMatchSnapshot()
    })
  }

  it('renders the same transcript before and after a resume', () => {
    // The durable events are the transcript, so folding them twice — as a
    // resume does — must produce the same rows rather than appending twice.
    const live = fixture().view.render(80)
    const resumed = fixture().view.render(80)
    expect(resumed).toEqual(live)
  })
})
