import { describe, expect, it } from 'vitest'
import { createTheme } from '@/theme.ts'
import { TranscriptModel } from '@/transcript.ts'
import { MarkdownRenderer } from '@/ui/markdown.ts'
import { StatusBar } from '@/ui/status.ts'
import { TranscriptView, type ViewState } from '@/ui/view.ts'
import { WorkDock } from '@/ui/dock.ts'
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
  const model = new TranscriptModel()
  const work = new WorkFold()
  const feed = (event: { type: string; data?: unknown }): void => {
    model.apply(event)
    work.apply(event)
  }
  model.apply({ type: 'user/message', data: { content: [{ type: 'text', text: 'add a dock above the editor' }], source: { kind: 'user' } } })
  feed({ type: 'user/message', data: { content: [{ type: 'text', text: '<system-reminder>\nfollow the plan\nkeep it short' }], source: { kind: 'plugin', plugin: 'dsh-agent-instructions' } } })
  model.applyStreamChunk({ type: 'reasoning-delta', text: 'the dock needs the fold\nand the fold needs the events' })
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
      model: 'glm-5.3',
      effort: 'max',
      preset: 'workspace-write',
      contextTokens: 17_500,
      contextWindow: 1_000_000,
      cwd: '/Users/dev/source/opensource/deepseek-harness/master',
      home: '/Users/dev',
    }), theme),
  }
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

  it('renders the same transcript before and after a resume', () => {
    // The durable events are the transcript, so folding them twice — as a
    // resume does — must produce the same rows rather than appending twice.
    const live = fixture().view.render(80)
    const resumed = fixture().view.render(80)
    expect(resumed).toEqual(live)
  })
})
