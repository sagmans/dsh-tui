import type { Component } from '@earendil-works/pi-tui'
import type { TuiTheme } from '../theme.ts'
import { canFrame, frameText } from './frame.ts'
import { pushGap } from './gap.ts'

/** Queued prompts the bar draws; everything older becomes one count above them. */
const QUEUE_LIMIT = 3
/** Text rows one queued prompt keeps before its own count takes over. */
const QUEUE_TEXT_ROWS = 3

/**
 * The prompts the agent has not taken yet, drawn above the editor.
 *
 * The rows take the editor's own frame because that is what they are: input the
 * reader already submitted, waiting for the agent to reach it. Only the face
 * differs — faint and italic — so a reader can tell at a glance that the text is
 * waiting rather than being typed.
 */
export class QueueBar implements Component {
  constructor(
    private readonly prompts: () => readonly string[],
    private readonly theme: TuiTheme,
  ) {}

  invalidate(): void {
    // Nothing is cached: the prompts are read fresh on every frame.
  }

  /** Matching rails keep a submitted draft recognizable while it waits. */
  private box(text: string, width: number, framed: boolean): string[] {
    // A prompt can be longer than the screen; the reader needs to see that it is
    // waiting, not to re-read all of it, so the first rows stand for the whole.
    return frameText(text, width, {
      text: line => this.theme.style('editor.queued', line),
      border: rule => this.theme.editor.borderColor(rule),
      framed,
      rail: true,
    }, QUEUE_TEXT_ROWS)
  }

  render(width: number): string[] {
    if (width <= 0) return []
    const prompts = this.prompts()
    if (prompts.length === 0) return []
    // Hiding the face hides the rows: a frame around text the reader cannot read
    // would look like an empty prompt waiting to be typed into.
    if (!this.theme.visible('editor.queued')) return []
    const framed = canFrame(width, this.theme.visible('editor.border'), true)
    const shown = prompts.slice(-QUEUE_LIMIT)
    const lines: string[] = []
    // Every queued prompt is an object the reader already submitted, so each
    // block opens with the air a transcript card opens with: a rail drawn tight
    // under the rows above it, or under the prompt before it, reads as part of
    // them rather than as a prompt of its own. The bar cannot see the rows above
    // it, so it draws its own break unconditionally — a fused block is the error
    // a reader loses by.
    // The reader typed the newest prompt last, so that is the row that must stay
    // on screen; the ones dropped here are the ones a claim is about to take.
    if (shown.length < prompts.length) {
      pushGap(lines)
      lines.push(this.theme.style('editor.queued.more', this.theme.cut(`… ${prompts.length - shown.length} queued earlier`, width, '…')))
    }
    for (const prompt of shown) {
      pushGap(lines)
      lines.push(...this.box(prompt, width, framed))
    }
    return lines
  }
}
