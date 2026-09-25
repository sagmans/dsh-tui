import { cardFromLines, type ToolCard, type ToolPresenter } from '../cards.ts'
import { carriedFields, mergeCards, subCallRow, subCallRows, SUBCALL_MAX } from '../cards/composition.ts'
import type { TranscriptEntry } from '../transcript.ts'
import { contentLinesOf } from './message-content.ts'

/** One second in milliseconds, which is the unit a duration is reported in. */
export const SECOND_MS = 1000

interface PendingCall {
  readonly name: string
  readonly argumentsJson: string
  readonly index: number
  /**
   * When the call was requested, which is the only clock a running card has.
   *
   * The log carries no execution-start event for a tool, so the request is the
   * earliest moment the surface can call the call in flight — and the elapsed
   * time it shows a reader has to be measured from there.
   */
  readonly startedAt: number
  /** Sub-calls this call dispatched, so its settle can drop their bookkeeping. */
  readonly subs: string[]
}

/**
 * What is known about one call the fold has seen requested and not answered.
 *
 * A settled call reads as nothing rather than as a zero elapsed time: "started
 * now" and "waiting an unknown time" are different things to say, and only the
 * fold can tell which one is true.
 */
export interface LiveCallState {
  readonly running: boolean
  readonly elapsed: number
}

/**
 * The rows one folded tool event asks the transcript to commit.
 *
 * The fold never writes to the transcript: it holds the call-to-row bookkeeping
 * that only tool events need, and hands back the rows it drew so the transcript
 * stays the single owner of reading order and of what a row's index means.
 */
export interface ToolCallOutcome {
  /** Rows to append, in the order the fold drew them. */
  readonly appends: readonly TranscriptEntry[]
  /** Rows to restate in place, at the index the fold recorded when it drew them. */
  readonly replacements: readonly { readonly index: number; readonly entry: TranscriptEntry }[]
}

/** An event that changes no row. */
const NOTHING: ToolCallOutcome = { appends: [], replacements: [] }

/**
 * The tool rows a session's events fold into.
 *
 * A tool call is the one transcript row that is drawn before it is finished: the
 * request lands a card, a nested dispatch restates it, and the result replaces
 * it, so the fold has to remember where each call's row went. That bookkeeping —
 * and the request-to-result clock it times a running row with — is the whole of
 * this module; the ordering and the rows themselves belong to the transcript.
 */
export class ToolCallFold {
  private readonly pending = new Map<string, PendingCall>()
  /**
   * Where each nested call landed on its root card.
   *
   * A dispatch logs a start and then a settle, so the second event has to find
   * the row the first one drew instead of adding a second line for one call.
   */
  private readonly pendingSub = new Map<string, { readonly rootIndex: number; readonly childIndex: number }>()

  constructor(
    private readonly presenter: ToolPresenter | undefined,
    private readonly clock: () => number,
    /** Reads back the card a settled row holds, so a dispatch or a result restates the row it drew. */
    private readonly cardAt: (index: number) => ToolCard | undefined,
  ) {}

  /** Fold one tool event, which is the only family of events that owns cross-event state. */
  apply(type: string, data: Record<string, unknown>, landingIndex: number): ToolCallOutcome {
    switch (type) {
      case 'tool/call':
        return this.rootCall(data, landingIndex)
      case 'tool/ptc-dispatch-start':
        return this.subCall(data, false)
      case 'tool/ptc-dispatch':
        return this.subCall(data, true)
      case 'tool/result':
        return this.settleResult(data)
      default:
        return NOTHING
    }
  }

  /**
   * How long one call has been in flight, or that it is not.
   *
   * The fold owns the request-to-result window, so a renderer asks here rather
   * than timing the row itself: a row read twice in one frame would otherwise
   * report two durations for one call.
   */
  liveCall(callId: string): LiveCallState {
    const call = callId === '' ? undefined : this.pending.get(callId)
    if (call === undefined) return { running: false, elapsed: 0 }
    return { running: true, elapsed: this.secondsSince(call.startedAt) }
  }

  /**
   * Drop the in-flight bookkeeping.
   *
   * The sub-call records name rows of the transcript being dropped, so they go
   * with the transcript: an index kept across the reset would refuse a replayed
   * call the row it is entitled to.
   */
  reset(): void {
    this.pending.clear()
    this.pendingSub.clear()
  }

  /**
   * Whole seconds since a moment the fold read the clock at.
   *
   * Floored, not rounded: a duration that claims a second it has not waited yet
   * would tick up before the call has been waiting that long.
   */
  private secondsSince(startedAt: number): number {
    return Math.max(0, Math.floor((this.clock() - startedAt) / SECOND_MS))
  }

  /** The row a requested call draws, which is the row its result later replaces. */
  private rootCall(data: Record<string, unknown>, landingIndex: number): ToolCallOutcome {
    const name = typeof data.name === 'string' ? data.name : 'tool'
    const argumentsJson = typeof data.arguments === 'string' ? data.arguments : ''
    const callId = typeof data.callId === 'string' ? data.callId : ''
    const card = this.presenter?.call(name, argumentsJson)
    const entry: TranscriptEntry = {
      kind: 'tool',
      // The id is what keeps a reader's click on this message after the
      // result replaces the card: the entry object does not survive, the id does.
      id: callId,
      // Without a presenter the row still has to say what ran and with what.
      card: card ?? cardFromLines('generic', name, name, argumentsJson === '' ? [] : argumentsJson.split('\n'), false),
    }
    if (callId !== '') this.pending.set(callId, { name, argumentsJson, index: landingIndex, startedAt: this.clock(), subs: [] })
    return { appends: [entry], replacements: [] }
  }

  /**
   * Fold one nested PTC call onto the card of the run_code call that dispatched it.
   *
   * Dispatches are logged while the program runs, so the root is still pending;
   * a dispatch whose root is not in this fold belongs to a window that starts
   * mid-run, and attaching it to another card would claim a call that card
   * never made.
   */
  private subCall(data: Record<string, unknown>, settled: boolean): ToolCallOutcome {
    const rootCallId = typeof data.rootCallId === 'string' ? data.rootCallId : ''
    const subCallId = typeof data.subCallId === 'string' ? data.subCallId : ''
    const root = rootCallId === '' ? undefined : this.pending.get(rootCallId)
    if (root === undefined || subCallId === '') return NOTHING
    const card = this.cardAt(root.index)
    if (card === undefined) return NOTHING
    const name = typeof data.name === 'string' ? data.name : 'tool'
    const argumentsJson = argumentsJsonOf(data.arguments)
    // The call's own view is asked for once: it names the row and it is what the
    // row shows of the call itself, so two asks could disagree about one call.
    const view = this.presenter?.call(name, argumentsJson)
    const isError = data.isError === true
    const result = settled ? this.subCallResult(name, argumentsJson, data, view) : undefined
    const output = result === undefined ? undefined : subCallRows(result)
    // A call that answered has told the surface how it went, and that is what the
    // row reports from then on — a program's calls are read by their outcomes.
    const failed = settled && (isError || result?.failed === true)
    const known = this.pendingSub.get(subCallId)
    if (known !== undefined) {
      // A settle restates the row its start drew: it ends the claim that the
      // call is still in flight, adds the outcome a reader opens the row for, and
      // a failure takes back what the call only declared. A call that produced
      // nothing to open still has to be restated, or its row would keep saying it
      // is running for as long as the card lives.
      if (!settled || known.childIndex < 0) return NOTHING
      const drawn = (card.subCalls ?? [])[known.childIndex]
      if (!isError && output === undefined && drawn?.running !== true) return NOTHING
      // A settle that reports nothing to open leaves the row's own outcome in
      // place; only a failure takes it back, because the rows it drew as applied
      // never happened.
      const settledOutput = isError ? output : output ?? drawn?.output
      const subCalls = (card.subCalls ?? []).map((call, at) => at === known.childIndex
        ? subCallRow(subCallId, name, argumentsJson, { view, output: settledOutput, status: result?.status, running: false, failed }, call)
        : call)
      return { appends: [], replacements: [{ index: root.index, entry: { kind: 'tool', id: rootCallId, card: { ...card, subCalls } } }] }
    }
    // A dispatch log arrives only once the call has settled, so a row that no
    // settle has restated yet is the one still running.
    const call = subCallRow(subCallId, name, argumentsJson, { view, output, status: result?.status, running: !settled, failed })
    const kept = card.subCalls ?? []
    const total = (card.subCallsTotal ?? 0) + 1
    if (kept.length >= SUBCALL_MAX) {
      // Retention keeps the head, where the calls that shaped the program are;
      // the count still reports everything it dispatched. The id is remembered
      // so a settle is not counted twice, and listed on the root so the root's
      // own cleanup forgets it — an overflow row has no row to clean up after.
      this.pendingSub.set(subCallId, { rootIndex: root.index, childIndex: -1 })
      root.subs.push(subCallId)
      return { appends: [], replacements: [{ index: root.index, entry: { kind: 'tool', id: rootCallId, card: { ...card, subCallsTotal: total } } }] }
    }
    root.subs.push(subCallId)
    this.pendingSub.set(subCallId, { rootIndex: root.index, childIndex: kept.length })
    return { appends: [], replacements: [{ index: root.index, entry: { kind: 'tool', id: rootCallId, card: { ...card, subCalls: [...kept, call], subCallsTotal: total } } }] }
  }

  /**
   * The card a dispatched call's log answers with.
   *
   * A presenter can only rebuild the view it declared when the logged content is
   * enough for it: a shell's output is, while a read's numbered window and a
   * search's hits live in the metadata a dispatch does not carry. The fallback is
   * the content the program was actually shown, so a row whose tool cannot be
   * re-presented still opens to its outcome rather than to nothing.
   */
  private subCallResult(
    name: string,
    argumentsJson: string,
    data: Record<string, unknown>,
    view: ToolCard | undefined,
  ): ToolCard {
    const failed = data.isError === true
    return this.presenter?.result(name, { argumentsJson, content: data.content, isError: failed, meta: data.meta })
      ?? cardFromLines(view?.kind ?? 'generic', name, view?.title ?? name, contentLinesOf(data.content), failed)
  }

  /** The row a call's result settles into: the card it drew, restated with what answered it. */
  private settleResult(data: Record<string, unknown>): ToolCallOutcome {
    const message = asRecord(data.message)
    const firstBlock = Array.isArray(message?.content) ? asRecord(message.content[0]) : undefined
    const callId = typeof firstBlock?.toolCallId === 'string' ? firstBlock.toolCallId : ''
    const pending = callId === '' ? undefined : this.pending.get(callId)
    if (callId !== '') this.pending.delete(callId)
    // The length of the run is readable here and nowhere else: the surface saw
    // the call logged and now sees it answered, and this is the only moment the
    // fold holds both readings of the clock.
    const ranFor = pending === undefined ? undefined : this.secondsSince(pending.startedAt)
    /** The card that reports this result, carrying the seconds the call took. */
    const finished = (card: ToolCard): ToolCard => (ranFor === undefined ? card : { ...card, elapsed: ranFor })
    // The root is done dispatching, so its bookkeeping goes with it; the rows it
    // already drew stay on the card.
    if (pending !== undefined) for (const sub of pending.subs) this.pendingSub.delete(sub)
    const name = pending?.name ?? 'tool'
    const isError = message?.isError === true
    const result = this.presenter?.result(name, {
      argumentsJson: pending?.argumentsJson ?? '',
      content: message?.content,
      isError,
      meta: data.meta,
    })
    if (pending === undefined) {
      // No matching call in this fold: a resumed transcript may start mid-call.
      return {
        appends: [{
          kind: 'tool',
          id: callId,
          card: result ?? cardFromLines('generic', name, name, contentLinesOf(message?.content), isError),
        }],
        replacements: [],
      }
    }
    const call = this.cardAt(pending.index)
    if (result === undefined) {
      // No presenter answered: the model-facing content is still what happened,
      // and a reader without it would see a tool row that never reported back.
      const reported = contentLinesOf(message?.content)
      const base = call ?? cardFromLines('generic', name, name, [], false)
      const rebuilt = reported.length === 0
        ? { ...base, failed: isError }
        : { ...cardFromLines(base.kind, base.tool, base.title, reported, isError), ...carriedFields(base) }
      return { appends: [], replacements: [{ index: pending.index, entry: { kind: 'tool', id: callId, card: finished(rebuilt) } }] }
    }
    // Two readings decide this, and either is enough: the log says whether the tool
    // raised, and the card the presenter built says how the call itself ended — a
    // shell's non-zero exit is a failure the log's flag never carries.
    const settledCard = mergeCards(call, { ...result, failed: result.failed || isError })
    return { appends: [], replacements: [{ index: pending.index, entry: { kind: 'tool', id: callId, card: finished(settledCard) } }] }
  }
}

/** The arguments a nested call was made with, as the shape a presenter is asked with. */
function argumentsJsonOf(value: unknown): string {
  if (value === undefined) return ''
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

/** Narrowing for the structural event reads above; each reader keeps its own copy rather than sharing one. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}
