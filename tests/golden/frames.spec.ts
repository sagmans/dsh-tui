import { type TUI } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createToolPresenter } from '@/agent/present.ts'
import { cardOfCall, cardOfResult, contentLines } from '@/cards.ts'
import type { GateCard } from '@/gates.ts'
import { defaultKeymap } from '@/input/actions.ts'
import { createTheme } from '@/theme.ts'
import { TranscriptModel } from '@/transcript.ts'
import { MarkdownRenderer } from '@/ui/markdown.ts'
import { createMermaidTransform } from '@/ui/mermaid.ts'
import { BoxedEditor } from '@/ui/editor.ts'
import { StatusBar, type StatusFacts } from '@/ui/status.ts'
import { DEFAULT_VIEW_STATE, TranscriptView } from '@/ui/view.ts'
import { WorkDock } from '@/ui/dock.ts'
import { ModelPicker, SessionPicker } from '@/ui/picker.ts'
import { StashPicker } from '@/ui/stash-picker.ts'
import { QueueBar } from '@/ui/queue.ts'
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

/** The footer facts this file pins; a case that varies one spreads over them. */
const STATUS_FACTS: StatusFacts = {
  chord: undefined,
  back: undefined,
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
}

/** The terminal the gate's bar renders against; a golden frame reads its rows only. */
const STUB_TUI = { requestRender: () => {}, terminal: { rows: 24, cols: 80 } } as unknown as TUI

/** The rows this frame pins: a shell command whose output waits behind its fold, and a file read. */
const FIXTURE_COMMAND = 'pnpm test'
/** A fixed request time and a fixed wait, so a running row's duration is a constant. */
const FIXTURE_STARTED_AT = 1_000_000
const FIXTURE_RUNNING_MS = 12_000
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
    // The real thing: bash declares a terminal card, and the shipped fold draws
    // it as one row carrying the command, the exit status, and the count of rows
    // waiting behind it. Its title IS the command, so the frame pins the command
    // a reader would run rather than a decorated phrase around it.
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
  // survives, and the same fold keeps a shell run's output out of the flow.
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
  // The shipped default is the folded view for both, so the frame pins what a
  // reader actually gets rather than a state they would have to ask for.
  const state = DEFAULT_VIEW_STATE
  const view = new TranscriptView(model, frameTheme, new MarkdownRenderer(frameTheme.markdown), {
    state: () => state,
    gate: () => undefined,
    picker: () => undefined,
  })
  return {
    view,
    dock: new WorkDock(() => work.state(), frameTheme),
    status: new StatusBar(() => STATUS_FACTS, frameTheme),
  }
}

/**
 * The footer with drafts parked.
 *
 * Nothing is trimmed: the row carries the running numbers a real session shows,
 * so the frame proves the count survives beside facts it is ranked above.
 */
function parkedStatus(count: number, frameTheme = theme): StatusBar {
  return new StatusBar(() => ({
    ...STATUS_FACTS,
    cwd: '/Users/dev/src/app',
    stashed: count,
  }), frameTheme)
}

/**
 * A reply whose diagram is the answer at a comfortable width and the source at
 * a cramped one: the drawing is 43 columns, which is exactly the boundary a
 * terminal can be on either side of.
 */
const FIXTURE_DIAGRAM = [
  '```mermaid',
  'flowchart TB',
  '  A["read the event log"] --> B["fold settled entries"]',
  '  B --> C{"cursor moved?"}',
  '  C -->|"yes"| D["rebuild the rows"]',
  '  C -->|"no"| E["reuse the cache"]',
  '```',
].join('\n')

function mermaidFixture(frameTheme = theme): TranscriptView {
  const model = new TranscriptModel()
  model.apply({
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: `The fold keeps a session small.\n\n${FIXTURE_DIAGRAM}\n\nSettled rows are cached.` }] } },
  })
  const mermaid = createMermaidTransform({ theme: frameTheme, mode: () => 'streaming' })
  return new TranscriptView(model, frameTheme, new MarkdownRenderer(frameTheme.markdown, mermaid), {
    state: () => DEFAULT_VIEW_STATE,
    gate: () => undefined,
    picker: () => undefined,
  })
}

/** A prompt and a thought that carry markdown, with the thought opened. */
const MARKDOWN_PROMPT = 'summarize this:\n\n- first item\n- second item\n\n```ts\nconst x = 1\n```'
const MARKDOWN_THOUGHT = '**weigh** the options\n\n1. keep the parser\n2. drop the cache'

/**
 * The frame owns the prompt's markdown width and the thought's indent, so these
 * frames pin where a list and a fence land inside the box, and that an opened
 * thought's markdown stays in its own shade rather than the answer's.
 */
function markdownMessages(frameTheme = theme): TranscriptView {
  const model = new TranscriptModel()
  model.apply({ type: 'user/message', data: { content: [{ type: 'text', text: MARKDOWN_PROMPT }], source: { kind: 'user' } } })
  model.apply({
    type: 'assistant/message',
    data: {
      message: {
        content: [
          { type: 'reasoning', text: MARKDOWN_THOUGHT },
          { type: 'text', text: 'Kept the parser.' },
        ],
      },
    },
  })
  return new TranscriptView(model, frameTheme, new MarkdownRenderer(frameTheme.markdown), {
    state: () => ({ expandCards: false, expandReasoning: true, expandSubCalls: false }),
    gate: () => undefined,
    picker: () => undefined,
  })
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
  work.apply({ type: 'goal/change', data: { operation: 'create', roundsStarted: 6, goal: { objective: 'complete the plan for this dsh-tui plugin', phase: 'active', maxGoalRounds: 256 } } })
  const jobs = [
    { id: 'bash-1', kind: 'bash', label: 'sleep 45 && echo bg-done', status: 'running' as const, startedAt: NOW - 12_000, finishedAt: undefined },
  ]
  const runs = [
    { runId: 'r1', provider: 'spawn', id: 'c000cfa3-1111-2222', startedAt: NOW - 4_000, status: 'running' as const },
    { runId: 'r2', provider: 'fork', id: 'f05abce2-3333-4444', startedAt: NOW - 30_000, status: 'completed' as const, finishedAt: NOW - 28_000 },
  ]
  return new WorkDock(() => work.state(), frameTheme, () => jobs, () => runs, () => NOW)
}

/**
 * The queue a running turn leaves behind: prompts the agent has not taken yet.
 *
 * The second is longer than one row at the cramped width, so the frame, the
 * wrapping, and the count on the closing rule are all pinned here.
 */
const QUEUED_PROMPTS = [
  'also mention the queue in the summary',
  'and keep the README sentence short, with the same shape the bar above the editor draws',
]

function queued(frameTheme = theme): QueueBar {
  return new QueueBar(() => QUEUED_PROMPTS, frameTheme)
}

function pickerCard(): SessionPicker {
  return new SessionPicker(
    [
      { id: 'tui-session-33e6ddc3-c871-4534-aae1-8c38f7cf69a2', cwd: '/Users/dev/source/opensource/deepseek-harness/master', createdAt: NOW - 240_000, eventCount: 22 },
      { id: 'tui-session-f38b6841-9229-4c2f-8c82-0ced1eee68ea', cwd: '/Users/dev/source/opensource/deepseek-harness/master', createdAt: NOW - 900_000, eventCount: 41 },
    ],
    () => new Map([['tui-session-33e6ddc3-c871-4534-aae1-8c38f7cf69a2', 'dock polish']]),
    () => NOW,
    defaultKeymap,
  )
}

/** The configured-route list, headed by the route the next step will use. */
function modelPickerCard(): ModelPicker {
  return new ModelPicker(
    () => [
      { provider: 'kimi-coding', model: 'k2', name: 'K2' },
      { provider: 'opencode-go', model: 'qwen3-coder', name: 'Qwen3 Coder' },
      { provider: 'zai-coding-cn', model: 'glm-5.3', name: 'GLM 5.3' },
    ],
    () => ({ provider: 'kimi-coding', model: 'k2', reasoningEffort: 'high' }),
    defaultKeymap,
  )
}

/** The drafts parked for one session, whose rows are the draft itself. */
function stashPickerCard(): StashPicker {
  return new StashPicker(
    [
      { entry: { id: 'a1', text: 'refactor the fold cursor so a resume replays it', createdAt: NOW - 90_000 }, index: 0 },
      { entry: { id: 'b2', text: 'why does the dock render twice on the first frame?', createdAt: NOW - 600_000 }, index: 1 },
    ],
    'tui-session-87c1e0d2',
    defaultKeymap,
    () => NOW,
  )
}

/**
 * A pending question whose option is longer than a cramped terminal holds.
 *
 * A decision is only answerable when its rows are readable, so this frame pins
 * wrapping in place of truncation, the free-text row every question with
 * options carries, and the input bar that row opens.
 */
function gateCard(typed = ''): TranscriptView {
  const typing = typed !== ''
  const bar = new BoxedEditor(STUB_TUI, theme.editor)
  bar.setText(typed)
  const gate: GateCard = {
    kind: 'question',
    title: 'which deployment target?  (1/2)',
    detail: ['showing 1–2 of 9'],
    optionOffset: 0,
    options: [
      { label: 'staging-eu-west-1', description: 'canary the rollout behind an audit window', current: !typing, selected: false },
      { label: 'production', description: undefined, current: false, selected: false },
    ],
    custom: { label: 'other', description: 'type your own answer', current: typing, selected: typing },
    answerInput: typing ? bar : undefined,
    hint: typing
      ? 'type or paste an answer · enter confirm · ↑↓/ctrl+p/ctrl+n or esc back to options'
      : 'space select · digits pick · 0 answer freely · type to filter · enter confirm · esc skip',
  }
  return new TranscriptView(new TranscriptModel(), theme, new MarkdownRenderer(theme.markdown), {
    state: () => DEFAULT_VIEW_STATE,
    gate: () => gate,
    picker: () => undefined,
  })
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

    it(`renders the queued prompts at ${width} columns`, () => {
      expect(queued().render(width)).toMatchSnapshot()
    })

    it(`renders a question gate at ${width} columns`, () => {
      expect(gateCard().render(width)).toMatchSnapshot()
    })

    it(`renders a question gate collecting a typed answer at ${width} columns`, () => {
      expect(gateCard('the eu-central cluster').render(width)).toMatchSnapshot()
    })
  }

  for (const width of WIDTHS) {
    it(`renders a busy dock at ${width} columns`, () => {
      expect(busyDock().render(width)).toMatchSnapshot()
    })

    it(`renders the session picker at ${width} columns`, () => {
      expect(pickerCard().card()).toMatchSnapshot()
    })

    it(`renders the model picker at ${width} columns`, () => {
      expect(modelPickerCard().card()).toMatchSnapshot()
    })

    it(`renders the stash picker at ${width} columns`, () => {
      expect(stashPickerCard().card()).toMatchSnapshot()
    })
  }

  it('renders the status row with parked drafts at 80 columns', () => {
    expect(parkedStatus(3).render(80)).toMatchSnapshot()
  })

  it('folds the same event log into identical rows, as a resume must', () => {
    // A resume replays the durable events into a fresh fold, so the same log has
    // to produce the same rows rather than a different order or an append.
    const live = fixture().view.render(80)
    const resumed = fixture().view.render(80)
    expect(resumed).toEqual(live)
  })

  for (const width of WIDTHS) {
    it(`renders a call that has not answered yet at ${width} columns`, () => {
      expect(runningFrame().render(width)).toMatchSnapshot()
    })
  }
})

/**
 * A frame with one call still in flight.
 *
 * The clock is pinned rather than read: a snapshot of a running row carries the
 * elapsed time it was drawn with, so a real clock would make the frame differ on
 * every run and pin nothing.
 */
function runningFrame(frameTheme = theme): TranscriptView {
  let clock = FIXTURE_STARTED_AT
  const model = new TranscriptModel(fixturePresenter(), () => clock)
  model.apply({ type: 'user/message', data: { content: [{ type: 'text', text: 'run the suite' }], source: { kind: 'user' } } })
  model.apply({ type: 'tool/call', data: { name: 'bash', arguments: `{"command":"${FIXTURE_COMMAND}"}`, callId: 'c1' } })
  clock = FIXTURE_STARTED_AT + FIXTURE_RUNNING_MS
  return new TranscriptView(model, frameTheme, new MarkdownRenderer(frameTheme.markdown), {
    state: () => DEFAULT_VIEW_STATE,
    gate: () => undefined,
    picker: () => undefined,
  })
}

/**
 * A drawn diagram is layout, not only text: these frames pin the box art and the
 * source a narrow terminal falls back to, which unit tests cannot see.
 */
describe('a mermaid reply', () => {
  for (const width of WIDTHS) {
    it(`renders the diagram at ${width} columns`, () => {
      expect(mermaidFixture().render(width)).toMatchSnapshot()
    })
  }

  it('renders the diagram with its escapes', () => {
    expect(mermaidFixture(createTheme('truecolor')).render(80)).toMatchSnapshot()
  })
})

describe('markdown messages', () => {
  for (const width of WIDTHS) {
    it(`renders a prompt and a thought as markdown at ${width} columns`, () => {
      expect(markdownMessages().render(width)).toMatchSnapshot()
    })
  }

  it('renders the prompt and the thought with their escapes', () => {
    expect(markdownMessages(createTheme('truecolor')).render(80)).toMatchSnapshot()
  })
})

/**
 * Styled frames.
 *
 * The plain snapshots prove layout, not that a token reached the screen: with
 * colour off, every escape is dropped. These pin the emitted sequences, which is
 * the only place a wrong slot or a dropped reset would show up in CI.
 */
/**
 * A tool row a terminal would have acted on: a tab on its stop, a colour run,
 * and a carriage return that rewrites the row it sits on.
 *
 * These are the three things a reader must not be shown raw — a tab is a jump,
 * not eight spaces; a colour is not a word; and only the last state of a
 * progress bar was ever meant to be read.
 */
const TERMINAL_TEXT_OUTPUT = ['name\trole', '\u001b[31mred\u001b[0m plain', 'progress 10%\rprogress 100%'].join('\n')

function terminalTextFrame(frameTheme = theme): TranscriptView {
  const model = new TranscriptModel({
    call: name => cardOfCall({ card: 'terminal', title: 'run report' }, name),
    result: (name, input) => cardOfResult(
      { card: 'terminal', output: TERMINAL_TEXT_OUTPUT, exitCode: 0 },
      { name, failed: input.isError, contentLines: contentLines(input.content) },
    ),
  })
  model.apply({ type: 'tool/call', data: { name: 'run', arguments: '{}', callId: 'c1' } })
  model.apply({
    type: 'tool/result',
    data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', text: TERMINAL_TEXT_OUTPUT }], isError: false } },
  })
  return new TranscriptView(model, frameTheme, new MarkdownRenderer(frameTheme.markdown), {
    state: () => ({ expandCards: true, expandReasoning: false, expandSubCalls: false }),
    gate: () => undefined,
    picker: () => undefined,
  })
}

describe('terminal text', () => {
  for (const width of WIDTHS) {
    it(`draws a tab, a colour, and a carriage return at ${width} columns`, () => {
      expect(terminalTextFrame().render(width)).toMatchSnapshot()
    })
  }

  it('draws the colour when the terminal has one, and no escape when it does not', () => {
    expect(terminalTextFrame(createTheme('truecolor')).render(80).join('\n')).toMatchSnapshot()
    // The reader turned styling off, so the same rows must carry no escape at
    // all — not a dropped colour, not a reset the surface opened for itself.
    const plain = terminalTextFrame().render(80).join('\n')
    expect(plain).not.toContain('\u001b')
    // The row starts four columns in, so the tab after "name" reaches the stop
    // at sixteen: eight columns, not four.
    expect(plain).toContain(`name${' '.repeat(8)}role`)
    expect(plain).toContain('red plain')
    expect(plain).toContain('progress 100%')
  })
})

describe('styled golden frames', () => {
  const styled = createTheme('truecolor')

  it('renders the transcript with its escapes', () => {
    expect(fixture(styled).view.render(80)).toMatchSnapshot()
  })

  it('renders the status row with its escapes', () => {
    expect(fixture(styled).status.render(80)).toMatchSnapshot()
  })

  it('renders the parked-draft count with its escapes', () => {
    expect(parkedStatus(3, styled).render(80)).toMatchSnapshot()
  })

  it('renders the busy dock with its escapes', () => {
    expect(busyDock(styled).render(80)).toMatchSnapshot()
  })

  it('renders the queued prompts with their escapes', () => {
    expect(queued(styled).render(80)).toMatchSnapshot()
  })
})
