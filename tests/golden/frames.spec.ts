import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createToolPresenter } from '@/agent/present.ts'
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
const theme = createTheme('none')

/** The rows this frame pins: a shell command whose output is kept, and a file read. */
const FIXTURE_COMMAND = 'pnpm test'
const FIXTURE_OUTPUT = 'Tests  154 passed (154)'
const FIXTURE_FILE = 'src/ui/view.ts'
const FIXTURE_FILE_LINES = ['const expanded = this.viewState.expandCards', 'const preview = cardDetailRows(card, expanded)', '…']

/**
 * Each tool's declared render intent, as the real tools declare it.
 *
 * A frame built without a presenter would fold a plain generic card and pin a
 * surface nobody runs: how a card reads is the tool's own declaration.
 */
function fixturePresenter(): ReturnType<typeof createToolPresenter> {
  const tools = {
    // The real thing: bash declares a terminal card, which is why its output
    // stays in the frame while every other card folds to its header. Its title
    // IS the command, so the frame pins the command a reader would run rather
    // than a decorated phrase around it.
    bash: {
      presentCall: (args: { command?: string }) => ({ card: 'terminal', title: args.command ?? '' }),
      presentResult: () => ({ card: 'terminal', title: FIXTURE_COMMAND, output: FIXTURE_OUTPUT, exitCode: 0 }),
    },
    read: {
      // A read declares its file as a location, which is what gives the card an
      // argument to colour; the result supplies the lines and the size stats.
      presentCall: () => ({ card: 'generic', title: `Read ${FIXTURE_FILE}`, kind: 'read', locations: [{ path: FIXTURE_FILE, line: 1 }] }),
      presentResult: () => ({
        card: 'read',
        path: FIXTURE_FILE,
        offset: 1,
        lines: FIXTURE_FILE_LINES.map((text, index) => ({ number: index + 1, text })),
        totalLines: FIXTURE_FILE_LINES.length,
      }),
    },
  } as Record<string, unknown>
  return createToolPresenter({ tools: { get: (name: string) => tools[name] } } as unknown as Context)
}

function fixture(frameTheme = theme): { view: TranscriptView; dock: WorkDock; status: StatusBar } {
  const model = new TranscriptModel(fixturePresenter())
  const work = new WorkFold()
  const feed = (event: { type: string; data?: unknown }): void => {
    model.apply(event)
    work.apply(event)
  }
  model.apply({ type: 'user/message', data: { content: [{ type: 'text', text: 'add a dock above the editor' }], source: { kind: 'user' } } })
  feed({ type: 'user/message', data: { content: [{ type: 'text', text: '<system-reminder>\nfollow the plan\nkeep it short' }], source: { kind: 'plugin', plugin: 'dsh-agent-instructions' } } })
  // The thought arrives the way the provider records it — a block of the
  // message, not a live delta — which is the only path a resume can replay.
  model.apply({
    type: 'assistant/message',
    data: {
      message: {
        content: [
          { type: 'reasoning', text: 'the dock needs the fold\nand the fold needs the events' },
          { type: 'text', text: 'Done.\n\n- fold the work state\n- render it only when it says something\n\n```ts\nconst dock = new WorkDock(state, theme)\n```' },
        ],
      },
    },
  })
  model.apply({ type: 'tool/call', data: { name: 'bash', arguments: `{"command":"${FIXTURE_COMMAND}"}`, callId: 'c1' } })
  model.apply({
    type: 'tool/result',
    data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', text: FIXTURE_OUTPUT }], isError: false } },
  })
  // A card whose rows the reader has not asked for: folded, only its header
  // survives, which is what keeps a long file out of the conversation.
  model.apply({ type: 'tool/call', data: { name: 'read', arguments: `{"path":"${FIXTURE_FILE}"}`, callId: 'c2' } })
  model.apply({
    type: 'tool/result',
    data: { message: { content: [{ type: 'tool-result', toolCallId: 'c2', text: FIXTURE_FILE_LINES.join('\n') }], isError: false } },
  })
  model.apply({ type: 'compaction/summary', data: { shadowedSeqs: [1, 2, 3], shadowedTokenCount: 4200 } })
  feed({ type: 'plan/mode', data: { active: true } })
  feed({ type: 'todo/write', data: { todos: [
    { content: 'write the dock', status: 'completed' },
    { content: 'verify the dock', status: 'in_progress' },
    { content: 'document the dock', status: 'pending' },
  ] } })
  // The shipped default: cards folded, reasoning open, so the frame pins what a
  // reader actually gets rather than a state they would have to ask for.
  const state: ViewState = { expandCards: false, expandReasoning: true }
  const view = new TranscriptView(model, frameTheme, new MarkdownRenderer(frameTheme.markdown), {
    state: () => state,
    gate: () => undefined,
    picker: () => undefined,
  })
  return {
    view,
    dock: new WorkDock(() => work.state(), frameTheme),
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
    }), frameTheme),
  }
}

/** One frozen moment, so a frame with elapsed times is still a stable artefact. */
const NOW = 1_700_000_000_000

function busyDock(frameTheme = theme): WorkDock {
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
  return new WorkDock(() => work.state(), frameTheme, () => jobs, () => runs, () => NOW)
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

  it('folds the same event log into identical rows, as a resume must', () => {
    // A resume replays the durable events into a fresh fold, so the same log has
    // to produce the same rows rather than a different order or an append.
    const live = fixture().view.render(80)
    const resumed = fixture().view.render(80)
    expect(resumed).toEqual(live)
  })
})

/**
 * Styled frames.
 *
 * The plain snapshots prove layout, not that a token reached the screen: with
 * colour off, every escape is dropped. These pin the emitted sequences, which is
 * the only place a wrong slot or a dropped reset would show up in CI.
 */
describe('styled golden frames', () => {
  const styled = createTheme('truecolor')

  it('renders the transcript with its escapes', () => {
    expect(fixture(styled).view.render(80)).toMatchSnapshot()
  })

  it('renders the status row with its escapes', () => {
    expect(fixture(styled).status.render(80)).toMatchSnapshot()
  })

  it('renders the busy dock with its escapes', () => {
    expect(busyDock(styled).render(80)).toMatchSnapshot()
  })
})
