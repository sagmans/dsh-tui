import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  InputTriggerCandidateView,
  InputTriggerCommand,
  InputTriggerController,
  InputTriggerControllerOptions,
  InputTriggerGroupView,
  InputTriggerHighlight,
  InputTriggerMutation,
  InputTriggerResult,
  InputTriggerSkill,
  InputTriggerSnapshotView,
  InputTriggerSource,
} from './contracts.js'
import { sanitizeText } from '../sessions/projection.js'

export type * from './contracts.js'

const TRIGGER_PATTERN = /[/@]/u
const WORD_PATTERN = /[\p{L}\p{N}_]/u
const WHITESPACE_PATTERN = /\s/u
const MODEL_COMMAND_NAME = 'model'
const MODEL_COMMAND_DESCRIPTION = 'Select session model'
const USER_ONLY_PREFIX = 'User only'
const CANDIDATE_LIMIT = 32

export interface DetectedInputTrigger {
  readonly end: number
  readonly position: 'inline' | 'leading'
  readonly query: string
  readonly start: number
  readonly trigger: '/' | '@'
}

interface Candidate extends InputTriggerCandidateView {
  readonly submit: boolean
  readonly text: string
}

interface Group {
  readonly items: readonly Candidate[]
  readonly source: InputTriggerSource
  readonly status: 'pending' | 'ready'
}

interface Hit {
  readonly end: number
  readonly launcher: boolean
  readonly position: 'inline' | 'leading'
  readonly query: string
  readonly sessionId: SessionId
  readonly start: number
  readonly trigger: '/' | '@' | 'launcher'
}

interface CatalogEntry<T> {
  readonly promise: Promise<readonly T[]>
}

function boundaryAllowed(draft: string, index: number, trigger: '/' | '@'): boolean {
  if (index === 0) return true
  const previous = draft.charAt(index - 1)
  if (WHITESPACE_PATTERN.test(previous)) return true
  if (WORD_PATTERN.test(previous)) return false
  if (trigger === '/') {
    if (previous === '/') return false
    if (previous === ':' && index >= 2 && !WHITESPACE_PATTERN.test(draft.charAt(index - 2))) return false
  }
  return true
}

export function detectInputTrigger(draft: string, caret: number): DetectedInputTrigger | undefined {
  const boundedCaret = Math.max(0, Math.min(caret, draft.length))
  for (let index = boundedCaret - 1; index >= 0; index--) {
    const character = draft.charAt(index)
    if (WHITESPACE_PATTERN.test(character)) return undefined
    if (!TRIGGER_PATTERN.test(character)) continue
    const trigger = character === '/' ? '/' : '@'
    if (!boundaryAllowed(draft, index, trigger)) continue
    return {
      end: boundedCaret,
      position: draft.search(/\S/u) === index ? 'leading' : 'inline',
      query: draft.slice(index + 1, boundedCaret),
      start: index,
      trigger,
    }
  }
  return undefined
}

function boundedReferenceIndex(text: string, literal: string, from: number): number {
  let index = text.indexOf(literal, from)
  while (index >= 0) {
    const after = text.charAt(index + literal.length)
    if (boundaryAllowed(text, index, '@') && !WORD_PATTERN.test(after)) return index
    index = text.indexOf(literal, index + 1)
  }
  return -1
}

function replaceBoundedReference(text: string, literal: string, replacement: string): string {
  let cursor = 0
  let result = ''
  let index = boundedReferenceIndex(text, literal, cursor)
  while (index >= 0) {
    result += `${text.slice(cursor, index)}${replacement}`
    cursor = index + literal.length
    index = boundedReferenceIndex(text, literal, cursor)
  }
  return `${result}${text.slice(cursor)}`
}

interface RankedCandidate {
  readonly candidate: Candidate
  readonly index: number
  readonly prefix: boolean
  readonly score: number
}

function boundaryBonus(name: string, index: number): number {
  return index === 0 || name.charAt(index - 1) === '-' || name.charAt(index - 1) === '_' ? 8 : 0
}

function fuzzyScore(name: string, query: string): number | undefined {
  if (query === '') return 0
  if (query.length > name.length) return undefined
  const noMatch = Number.NEGATIVE_INFINITY
  let previous = Array.from<number>({ length: name.length }).fill(noMatch)
  for (let index = 0; index < name.length; index++) {
    if (name.charAt(index) === query.charAt(0)) previous[index] = 1 + boundaryBonus(name, index) - index
  }
  for (let queryIndex = 1; queryIndex < query.length; queryIndex++) {
    const current = Array.from<number>({ length: name.length }).fill(noMatch)
    let bestGapped = noMatch
    for (let index = 0; index < name.length; index++) {
      const gappedIndex = index - 2
      if (gappedIndex >= 0) {
        const prior = previous[gappedIndex] ?? noMatch
        if (prior !== noMatch) bestGapped = Math.max(bestGapped, prior + gappedIndex)
      }
      if (name.charAt(index) !== query.charAt(queryIndex)) continue
      const bonus = 1 + boundaryBonus(name, index)
      const adjacent = index > 0 ? previous[index - 1] ?? noMatch : noMatch
      if (adjacent !== noMatch) current[index] = adjacent + bonus + 4
      if (bestGapped !== noMatch) current[index] = Math.max(current[index] ?? noMatch, bestGapped + bonus + 1 - index)
    }
    previous = current
  }
  const best = Math.max(...previous)
  return best === noMatch ? undefined : best
}

function fuzzyCandidates(candidates: readonly Candidate[], rawQuery: string): readonly Candidate[] {
  const query = rawQuery.toLowerCase()
  if (query === '') return candidates
  const ranked: RankedCandidate[] = []
  candidates.forEach((candidate, index) => {
    const name = candidate.name.toLowerCase()
    const score = fuzzyScore(name, query)
    if (score !== undefined) ranked.push({ candidate, index, prefix: name.startsWith(query), score })
  })
  ranked.sort((left, right) => Number(right.prefix) - Number(left.prefix)
    || right.score - left.score
    || left.index - right.index)
  return ranked.map(match => match.candidate)
}

function commandCandidate(command: InputTriggerCommand): Candidate {
  const name = sanitizeText(command.name)
  const takesInput = command.inputHint !== undefined
  return {
    description: sanitizeText(command.description),
    ...command.inputHint === undefined ? {} : { hint: sanitizeText(command.inputHint) },
    name,
    submit: !takesInput,
    text: takesInput ? `/${name} ` : `/${name}`,
  }
}

function skillCandidate(skill: InputTriggerSkill): Candidate {
  const description = skill.modelInvocable
    ? skill.description
    : `${USER_ONLY_PREFIX} · ${skill.description}`
  const name = sanitizeText(skill.name)
  return {
    description: sanitizeText(description),
    name,
    submit: false,
    text: `/${name} `,
  }
}

function modelCandidate(): Candidate {
  return {
    description: MODEL_COMMAND_DESCRIPTION,
    name: MODEL_COMMAND_NAME,
    submit: true,
    text: `/${MODEL_COMMAND_NAME}`,
  }
}

function firstHighlight(groups: readonly Group[]): InputTriggerHighlight | undefined {
  for (const group of groups) {
    if (group.status === 'ready' && group.items.length > 0) return { source: group.source, index: 0 }
  }
  return undefined
}

function positions(groups: readonly Group[]): InputTriggerHighlight[] {
  return groups.flatMap(group => group.status === 'ready'
    ? group.items.map((_item, index) => ({ source: group.source, index }))
    : [])
}

class InputTriggerControllerService implements InputTriggerController {
  private readonly commandCatalogs = new Map<SessionId, CatalogEntry<InputTriggerCommand>>()
  private readonly listeners = new Set<() => void>()
  private readonly modelAvailable: NonNullable<InputTriggerControllerOptions['modelAvailable']>
  private readonly port: InputTriggerControllerOptions['port']
  private readonly sessions: InputTriggerControllerOptions['sessions']
  private readonly skillCatalogs = new Map<SessionId, CatalogEntry<InputTriggerSkill>>()
  private readonly resources: Array<() => void>
  private fetch: AbortController | undefined
  private generation = 0
  private groups: readonly Group[] = []
  private highlight: InputTriggerHighlight | undefined
  private hit: Hit | undefined
  private disposed = false

  constructor(options: InputTriggerControllerOptions) {
    this.modelAvailable = options.modelAvailable ?? (() => true)
    this.port = options.port
    this.sessions = options.sessions
    this.resources = [options.sessions.subscribe(() => { this.refreshActiveReferences() })]
  }

  dismiss(): void {
    this.fetch?.abort()
    this.fetch = undefined
    this.hit = undefined
    this.groups = []
    this.highlight = undefined
    this.publish()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.fetch?.abort()
    this.commandCatalogs.clear()
    this.skillCatalogs.clear()
    for (const dispose of this.resources.splice(0).toReversed()) dispose()
    this.listeners.clear()
  }

  getSnapshot(): InputTriggerSnapshotView {
    return Object.freeze({
      groups: Object.freeze(this.groups.map((group): InputTriggerGroupView => ({
        items: Object.freeze(group.items.map(item => ({
          ...item.description === undefined ? {} : { description: item.description },
          ...item.hint === undefined ? {} : { hint: item.hint },
          name: item.name,
        }))),
        source: group.source,
      }))),
      highlight: this.highlight,
      launcher: this.hit?.launcher ?? false,
      open: this.hit !== undefined,
      pending: this.groups.some(group => group.status === 'pending'),
    })
  }

  invalidate(sessionId?: SessionId): void {
    if (sessionId === undefined) {
      this.commandCatalogs.clear()
      this.skillCatalogs.clear()
    } else {
      this.commandCatalogs.delete(sessionId)
      this.skillCatalogs.delete(sessionId)
    }
    if (this.hit !== undefined && (sessionId === undefined || this.hit.sessionId === sessionId)) {
      this.fetchCandidates(this.hit)
    }
  }

  launch(sessionId: SessionId, draft: string, caret: number): void {
    const position = Math.max(0, Math.min(caret, draft.length))
    const hit: Hit = {
      end: position,
      launcher: true,
      position: draft.slice(0, position).trim() === '' ? 'leading' : 'inline',
      query: '',
      sessionId,
      start: position,
      trigger: 'launcher',
    }
    this.open(hit)
  }

  move(delta: number): void {
    if (this.hit === undefined || !Number.isFinite(delta) || delta === 0) return
    const items = positions(this.groups)
    if (items.length === 0) return
    const current = this.highlight === undefined
      ? -1
      : items.findIndex(item => item.source === this.highlight?.source && item.index === this.highlight.index)
    const direction = delta < 0 ? -1 : 1
    const start = current < 0 ? direction < 0 ? 0 : -1 : current
    this.highlight = items[(start + direction + items.length) % items.length]
    this.publish()
  }

  pick(source: InputTriggerSource, index: number): InputTriggerMutation | undefined {
    const hit = this.hit
    const group = this.groups.find(candidate => candidate.source === source)
    const candidate = group?.status === 'ready' ? group.items[index] : undefined
    if (hit === undefined || candidate === undefined) return undefined
    const mutation = {
      end: hit.end,
      start: hit.start,
      submit: candidate.submit,
      text: candidate.text,
    }
    this.dismiss()
    return mutation
  }

  pickHighlighted(): InputTriggerMutation | undefined {
    return this.highlight === undefined
      ? undefined
      : this.pick(this.highlight.source, this.highlight.index)
  }

  async serialize(sessionId: SessionId, text: string, signal: AbortSignal): Promise<string> {
    const references = Object.values(this.sessions.getSnapshot().byId)
      .filter(summary => summary?.parentId === sessionId)
      .map(summary => ({
        literal: `@${sanitizeText(summary?.displayTitle ?? '')}`,
        owner: summary?.displayTitle ?? '',
      }))
      .filter(reference => reference.owner !== '')
      .toSorted((left, right) => right.literal.length - left.literal.length)
    let serialized = text
    for (const reference of references) {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('reference serialization aborted')
      if (boundedReferenceIndex(serialized, reference.literal, 0) < 0) continue
      const replacement = await this.port.serializeReference('subagent', reference.owner, signal)
      serialized = replaceBoundedReference(serialized, reference.literal, replacement)
    }
    return serialized
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  track(sessionId: SessionId, draft: string, caret: number): void {
    const detected = detectInputTrigger(draft, caret)
    if (detected === undefined) {
      if (this.hit !== undefined) this.dismiss()
      return
    }
    this.open({ ...detected, launcher: false, sessionId })
  }

  private catalog<T>(
    catalogs: Map<SessionId, CatalogEntry<T>>,
    sessionId: SessionId,
    load: () => Promise<InputTriggerResult<readonly T[]>>,
  ): Promise<readonly T[]> {
    const existing = catalogs.get(sessionId)
    if (existing !== undefined) return existing.promise
    const promise = load().then(result => {
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      return result.value
    })
    const entry = { promise }
    catalogs.set(sessionId, entry)
    void promise.catch(() => {
      if (catalogs.get(sessionId) === entry) catalogs.delete(sessionId)
    })
    return promise
  }

  private commandCandidates(hit: Hit, signal: AbortSignal): Promise<readonly Candidate[]> {
    return this.catalog(
      this.commandCatalogs,
      hit.sessionId,
      () => this.port.commands(hit.sessionId),
    ).then(commands => {
      if (signal.aborted) return []
      const candidates = commands
        .filter(command => hit.position === 'leading' || command.inputHint === undefined)
        .map(command => commandCandidate(command))
      if (this.modelAvailable(hit.sessionId)) candidates.push(modelCandidate())
      return fuzzyCandidates(candidates, hit.query).slice(0, CANDIDATE_LIMIT)
    })
  }

  private fetchCandidates(hit: Hit): void {
    this.fetch?.abort()
    const fetch = new AbortController()
    this.fetch = fetch
    const generation = ++this.generation
    const sources: readonly InputTriggerSource[] = hit.trigger === '/'
      ? ['command', 'skill']
      : hit.trigger === '@'
        ? ['subagent']
        : ['command', 'skill', 'subagent']
    this.groups = sources.map(source => ({ items: [], source, status: 'pending' }))
    this.highlight = undefined
    this.publish()
    for (const source of sources) {
      const request = this.sourceCandidates(source, hit, fetch.signal)
      void request.then(
        items => { this.settleSource(generation, source, items) },
        () => { this.failSource(generation, source) },
      )
    }
  }

  private failSource(generation: number, source: InputTriggerSource): void {
    if (!this.current(generation)) return
    this.groups = this.groups.filter(group => group.source !== source)
    this.reconcileAfterSettlement()
  }

  private open(hit: Hit): void {
    const same = this.hit !== undefined
      && this.hit.launcher === hit.launcher
      && this.hit.sessionId === hit.sessionId
      && this.hit.start === hit.start
      && this.hit.end === hit.end
      && this.hit.query === hit.query
      && this.hit.trigger === hit.trigger
    if (same) return
    this.hit = hit
    this.fetchCandidates(hit)
  }

  private publish(): void {
    if (this.disposed) return
    for (const listener of this.listeners) listener()
  }

  private reconcileAfterSettlement(): void {
    if (this.groups.length === 0
      || this.groups.every(group => group.status === 'ready' && group.items.length === 0)) {
      this.dismiss()
      return
    }
    const valid = this.highlight !== undefined
      && positions(this.groups).some(item => item.source === this.highlight?.source && item.index === this.highlight.index)
    if (!valid) this.highlight = firstHighlight(this.groups)
    this.publish()
  }

  private refreshActiveReferences(): void {
    if (this.hit?.trigger === '@' || this.hit?.trigger === 'launcher') this.fetchCandidates(this.hit)
  }

  private settleItems(source: InputTriggerSource, items: readonly Candidate[]): readonly Candidate[] {
    return source === 'subagent' ? items.slice(0, CANDIDATE_LIMIT) : items
  }

  private settleSource(generation: number, source: InputTriggerSource, items: readonly Candidate[]): void {
    if (!this.current(generation)) return
    this.groups = this.groups.map(group => group.source === source
      ? { items: this.settleItems(source, items), source, status: 'ready' }
      : group)
    this.reconcileAfterSettlement()
  }

  private skillCandidates(hit: Hit, signal: AbortSignal): Promise<readonly Candidate[]> {
    return this.catalog(
      this.skillCatalogs,
      hit.sessionId,
      () => this.port.skills(hit.sessionId),
    ).then(skills => signal.aborted
      ? []
      : skills
          .filter(skill => skill.name.startsWith(hit.query))
          .map(skill => skillCandidate(skill))
          .slice(0, CANDIDATE_LIMIT))
  }

  private sourceCandidates(
    source: InputTriggerSource,
    hit: Hit,
    signal: AbortSignal,
  ): Promise<readonly Candidate[]> {
    switch (source) {
      case 'command': return this.commandCandidates(hit, signal)
      case 'skill': return this.skillCandidates(hit, signal)
      case 'subagent': return Promise.resolve(this.subagentCandidates(hit))
      default: {
        const exhaustive: never = source
        return Promise.resolve(exhaustive)
      }
    }
  }

  private subagentCandidates(hit: Hit): readonly Candidate[] {
    const query = hit.query.toLowerCase()
    return Object.values(this.sessions.getSnapshot().byId)
      .filter(summary => summary?.parentId === hit.sessionId
        && summary.running
        && summary.displayTitle.toLowerCase().includes(query))
      .map(summary => {
        const name = sanitizeText(summary?.displayTitle ?? '')
        return {
          name,
          submit: false,
          text: `@${name} `,
        }
      })
  }

  private current(generation: number): boolean {
    return !this.disposed && this.fetch?.signal.aborted === false && generation === this.generation
  }
}

export function createInputTriggerController(options: InputTriggerControllerOptions): InputTriggerController {
  return new InputTriggerControllerService(options)
}
