/**
 * The surface's own margin: the blank cells the reader keeps at the window's
 * edges, as one leaf of the root layout.
 *
 * It is a leaf the stack lays out rather than a wrapper around the parts, because
 * the transcript's scroll view belongs to the layout: a wrapper would hide that
 * node, and with it following, wheel scrolling, and the scrollbar. Giving the
 * rows below it less width is also the one way the margin stays a margin for the
 * mouse, which is handed coordinates the layout already accounts for.
 */
import { type Component } from '@earendil-works/pi-tui'

/** One column of air a reader asked for, drawn blank. */
const AIR = ' '

export class Gutter implements Component {
  constructor(private readonly columns: () => number) {}

  /**
   * The air as the one row the stack measures, read per frame.
   *
   * Its leaf's width is what the layout measures, so the row is exactly as wide
   * as the reader asked for; the height comes from the stack that stretches it.
   */
  render(): string[] {
    return [AIR.repeat(Math.max(0, Math.floor(this.columns())))]
  }

  /** Nothing is held between frames: the count is read from the settings that own it. */
  invalidate(): void {}
}
