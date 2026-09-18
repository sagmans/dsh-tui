import type { Context } from '@deepseek-ai/cordis'
import { projectionState } from './agent/projections.ts'

/**
 * The prompts an agent has not taken yet.
 *
 * The harness owns pending input and records every append, claim, and
 * cancellation as a durable splice; the `inbox` projection folds those into the
 * two lists a claim drains. Reading that projection rather than keeping a list
 * of our own is what makes a row disappear exactly when the message is taken —
 * including when an interrupt discarded it — and what lets a resumed session
 * show input that is still owed.
 */

/** What a queued prompt shows when it carries no text block, so its row is never blank. */
const NO_TEXT = '(no text)'

/**
 * The pending lists, in the order the harness delivers them.
 *
 * A step boundary claims next-step first and takes a queued turn after it, so
 * this is also the order the reader's own rows reach the transcript in.
 */
const TARGETS = ['next-step', 'next-turn'] as const

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/**
 * Whether a pending message is the reader's own input.
 *
 * Next-step also carries the contexts a tool or a plugin injects, which are
 * machinery rather than something the reader is waiting to see delivered.
 */
function fromHuman(message: Record<string, unknown>): boolean {
  return asRecord(message.source)?.kind === 'user'
}

/** The text one pending message carries; a thought is the model's, not the reader's words. */
function textOf(message: Record<string, unknown>): string {
  const blocks = Array.isArray(message.content) ? message.content : []
  const texts: string[] = []
  for (const block of blocks) {
    const record = asRecord(block)
    if (record?.type !== 'text' || typeof record.text !== 'string') continue
    texts.push(record.text)
  }
  return texts.length === 0 ? NO_TEXT : texts.join('\n')
}

/** The reader's own prompts still waiting in one inbox projection state. */
export function promptsOf(state: unknown): readonly string[] {
  const inbox = asRecord(state)
  if (inbox === undefined) return []
  const prompts: string[] = []
  for (const target of TARGETS) {
    const pending = inbox[target]
    if (!Array.isArray(pending)) continue
    for (const entry of pending) {
      const message = asRecord(entry)
      if (message === undefined || !fromHuman(message)) continue
      prompts.push(textOf(message))
    }
  }
  return prompts
}

/** The prompts one session's agent has not taken yet. */
export function pendingPrompts(ctx: Context, session: unknown): readonly string[] {
  return session === undefined ? [] : promptsOf(projectionState(ctx, session, 'inbox'))
}
