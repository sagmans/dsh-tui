import { type ToolSubCall, type ToolSubCallRows, type ToolCard, clipLine } from '../cards.ts'
import { title } from './presenter.ts'

/**
 * Nested calls retained on one PTC card.
 *
 * A program can dispatch in a loop, and one line each is small but not free;
 * the cap keeps a card bounded while {@link ToolCard.subCallsTotal} still
 * reports everything the program ran.
 */
export const SUBCALL_MAX = 100

/**
 * What the fold learned about one dispatched call, in the order it learned it.
 *
 * A call is logged twice — once when the program asks for it, once with what it
 * answered — and each moment supplies part of the row: the call view names it,
 * the result view says how it ended and what it produced.
 */
export interface SubCallFacts {
  /** The card the call declared, or nothing when no presenter answered for it. */
  readonly view: ToolCard | undefined
  /** The rows the row opens to, once the call reported them. */
  readonly output: ToolSubCallRows | undefined
  /** How the call finished, as the tool that ran it reported. */
  readonly status: string | undefined
  /** Whether the call is logged and still unanswered. */
  readonly running: boolean
  /** Whether the call is one the log marked as an error. */
  readonly failed: boolean
}

/**
 * The one-line row for one nested call, as its start or its settle leaves it.
 *
 * A tool that declares a call view is drawn exactly as its own header would be;
 * only a tool with no view at all falls back to its registry name and raw call,
 * because the surface cannot name a salient argument for a schema it never saw.
 * A settle logs the same call again, and the presenter that answered the first
 * time is asked again for the view it would draw — so the row's identity comes
 * from the row already on screen wherever there is one, and only a call that was
 * dropped earlier is named from the log. The row also keeps how the call ended,
 * because a program's calls are told apart by their outcomes rather than by
 * anything the program itself says about them.
 */
export function subCallRow(id: string, name: string, argumentsJson: string, facts: SubCallFacts, existing?: ToolSubCall): ToolSubCall {
  const { view, output, status, running, failed } = facts
  const title = view?.title ?? existing?.title ?? name
  const raw = view !== undefined || existing !== undefined ? undefined : clipLine(argumentsJson)
  const argument = view?.argument ?? existing?.argument ?? raw
  // A failed call keeps only what still holds: the change it declared never
  // happened, so the rows that drew as applied go with the outcome that never
  // came. Its outcome stays, because the reason it failed is what a reader opens
  // the row to read.
  const presented = failed ? undefined : subCallRows(view) ?? existing?.presented
  // A settle that reports nothing keeps what the row already said about its own
  // outcome, because a call does not stop having finished a certain way.
  const ended = status ?? existing?.status
  return {
    id,
    title,
    ...(argument === undefined || argument === '' ? {} : { argument }),
    ...(ended === undefined || ended === '' ? {} : { status: ended }),
    failed,
    running,
    ...(presented === undefined ? {} : { presented }),
    ...(output === undefined ? {} : { output }),
  }
}

/**
 * The rows one dispatched call keeps, from the card that drew them.
 *
 * The total is clamped to what was kept: a card built from a call or result
 * view reports no total of its own, because it is not a stream retention had to
 * cut, and a count below the rows on screen would hint at rows already shown.
 */
export function subCallRows(card: ToolCard | undefined): ToolSubCallRows | undefined {
  if (card === undefined || card.detail.length === 0) return undefined
  return { kind: card.kind, rows: card.detail, totalLines: Math.max(card.totalLines, card.detail.length) }
}

/**
 * The header fields a rebuilt card must keep.
 *
 * Replacing a card's rows says nothing about what the call was made with, what
 * it measured, how it ended, or which calls it dispatched, so those fields
 * travel with the rebuild: dropping the argument is how a shell card loses its
 * command the moment a presenter declines the result.
 */
export function carriedFields(card: ToolCard): Pick<ToolCard, 'argument' | 'stats' | 'status' | 'subCalls' | 'subCallsTotal'> {
  return {
    ...(card.argument === undefined ? {} : { argument: card.argument }),
    ...(card.stats === undefined ? {} : { stats: card.stats }),
    ...(card.status === undefined ? {} : { status: card.status }),
    ...(card.subCalls === undefined ? {} : { subCalls: card.subCalls }),
    ...(card.subCallsTotal === undefined ? {} : { subCallsTotal: card.subCallsTotal }),
  }
}

/**
 * Collapse one call and its result into the single row the reader sees.
 *
 * The pending row already told the reader what the tool is doing, so the
 * settled row keeps that header and swaps in the outcome; a result that
 * presents nothing keeps the call's detail rather than blanking the row.
 */
export function mergeCards(call: ToolCard | undefined, result: ToolCard | undefined): ToolCard {
  const base = call ?? result
  if (base === undefined) throw new Error('mergeCards requires at least one card')
  if (call === undefined || result === undefined) return base
  const kind = result.kind === 'generic' ? call.kind : result.kind
  // The result, when it names one, knows the argument that was actually acted
  // on; a terminal result omits it, so the pending call's command is kept. The
  // result also owns the measured facts, because only it knows the outcome.
  const argument = result.argument ?? call.argument
  const stats = result.stats ?? call.stats
  const status = result.status ?? call.status
  // The nested calls belong to the call, not the outcome: a result never carries
  // them, so the merge has to hand the call's own list through.
  const subCalls = result.subCalls ?? call.subCalls
  const subCallsTotal = result.subCallsTotal ?? call.subCallsTotal
  return {
    kind,
    // The tool that ran is the call's identity: a result card describes the same
    // call, so it cannot rename the message a reader's clicks are remembered by.
    tool: call.tool,
    title: call.title,
    ...(argument === undefined ? {} : { argument }),
    ...(stats === undefined ? {} : { stats }),
    ...(status === undefined ? {} : { status }),
    ...(subCalls === undefined ? {} : { subCalls }),
    ...(subCallsTotal === undefined ? {} : { subCallsTotal }),
    detail: result.detail.length > 0 ? result.detail : call.detail,
    failed: result.failed,
    totalLines: result.detail.length > 0 ? result.totalLines : call.totalLines,
  }
}
