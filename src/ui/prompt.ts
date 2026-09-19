import type { Component } from '@earendil-works/pi-tui'
import type { BoxedEditor } from './editor.ts'

/**
 * The prompt bar, and the question that borrows it.
 *
 * A question is answered in the reader's own editor, because that is the one
 * with everything they expect of it — completion, history, undo, and the keys
 * their terminal sends — so the question takes the bar rather than a copy of it.
 * The bar hides while the question is open, and the prompt nobody has sent yet
 * is held aside and put back afterwards.
 */
export class PromptBar implements Component {
  private borrowed = false
  private held = ''

  constructor(private readonly editor: BoxedEditor) {}

  /**
   * Borrow the editor for a gate that collects answers in it.
   *
   * The builder runs after the prompt is held aside, because a gate empties the
   * editor for its first answer as it is built, and a prompt is not an answer.
   */
  borrow<T>(build: () => T): T {
    this.held = this.editor.getExpandedText()
    this.editor.setText('')
    this.borrowed = true
    return build()
  }

  /** Give the editor back, with the prompt that was in it. */
  giveBack(): void {
    if (!this.borrowed) return
    this.borrowed = false
    this.editor.setText(this.held)
    this.held = ''
  }

  /** The rows the bar occupies, which a borrowing question leaves empty. */
  render(width: number): string[] {
    return this.borrowed ? [] : this.editor.render(width)
  }

  invalidate(): void {
    this.editor.invalidate()
  }
}
