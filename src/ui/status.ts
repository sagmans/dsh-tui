import { type Component, truncateToWidth } from '@earendil-works/pi-tui'
import { displayText } from '../text.ts'
import type { TuiToken } from '../theme-tokens.ts'
import type { TuiTheme } from '../theme.ts'

/** Everything the footer states, gathered by the surface around it. */
export interface StatusFacts {
  readonly activity: 'idle' | 'working'
  /** How long the running turn has been running, when one is. */
  readonly elapsedMs: number | undefined
  readonly provider: string | undefined
  readonly model: string | undefined
  readonly effort: string | undefined
  /** The agent preset (mode) the session runs; fixed once it has a turn. */
  readonly agentPreset: string | undefined
  /** The permission preset, which is a sandbox policy and a different thing. */
  readonly preset: string | undefined
  readonly contextTokens: number | undefined
  readonly contextWindow: number | undefined
  /** Share of prompt tokens served from the provider's cache, 0–1. */
  readonly cacheRate: number | undefined
  /** Prompt tokens the provider did not have cached, when it reported any. */
  readonly uncachedInputTokens: number | undefined
  /** Tokens this session has generated, when the provider reported any. */
  readonly outputTokens: number | undefined
  readonly cwd: string
  readonly home: string | undefined
}

const THOUSAND = 1000
const HUNDRED_THOUSAND = 100 * THOUSAND
const MILLION = 1_000_000
const SECOND_MS = 1000
const MINUTE_MS = 60 * SECOND_MS
/** Path segments kept for a directory outside the home; a terminal row is not a file browser. */
const PATH_SEGMENTS = 2

/** Compact a token count, because the exact number changes nothing a reader decides. */
export function formatTokens(count: number): string {
  if (count >= MILLION) return `${(count / MILLION).toFixed(1)}M`
  // A decimal on a five-digit count is noise: 128.0k reads worse than 128k.
  if (count >= HUNDRED_THOUSAND) return `${Math.round(count / THOUSAND)}k`
  if (count >= THOUSAND) return `${(count / THOUSAND).toFixed(1)}k`
  return String(count)
}

/**
 * Shorten an absolute path for the footer: the reader's own home becomes `~`,
 * and only a path from outside it is cut down to its tail.
 *
 * A home path keeps every directory between `~` and the leaf. Dropping those
 * away would name a location that does not exist, which is worse than a long one.
 */
export function shortPath(path: string, home: string | undefined): string {
  if (home !== undefined && home !== '' && (path === home || path.startsWith(`${home}/`))) {
    const rest = path.slice(home.length).replace(/^\//u, '')
    return rest === '' ? '~/' : `~/${rest}`
  }
  const segments = path.split('/').filter(segment => segment !== '')
  if (segments.length <= PATH_SEGMENTS) return path
  return `…/${segments.slice(-PATH_SEGMENTS).join('/')}`
}

function elapsed(ms: number): string {
  if (ms < MINUTE_MS) return `${Math.max(1, Math.round(ms / SECOND_MS))}s`
  return `${Math.floor(ms / MINUTE_MS)}m${String(Math.round((ms % MINUTE_MS) / SECOND_MS)).padStart(2, '0')}s`
}

/**
 * One line of state, ordered by what a reader asks first: is it working, what is
 * it, how full is the context, and where am I.
 *
 * Each segment is its own element, so a reader can quiet the path without
 * losing the model, and the separator is one too.
 */
export function formatStatus(facts: StatusFacts, width: number, theme: TuiTheme): string {
  /** Segments and the text that joins them; a space keeps a value with its label. */
  const parts: string[] = []
  const push = (token: TuiToken, text: string): void => {
    if (theme.visible(token)) parts.push(theme.style(token, text))
  }
  const separator = (): string => (theme.visible('status.separator') ? theme.style('status.separator', ' · ') : ' · ')
  if (facts.activity === 'working') {
    // Elapsed belongs to the activity, so it rides in the same segment and
    // carries its own token; a separator would read as a separate fact.
    const ran = facts.elapsedMs === undefined ? '' : ` ${elapsed(facts.elapsedMs)}`
    const styled = ran === '' || !theme.visible('status.elapsed') ? ran : theme.style('status.elapsed', ran)
    push('status.activity.working', `▶ working${styled}`)
  } else {
    push('status.activity.ready', '● ready')
  }
  // The mode comes first: it decides which tools exist at all, so a reader who
  // saw a tool disappear needs it before the model that ran it.
  if (facts.agentPreset !== undefined && facts.agentPreset !== '') push('status.agentPreset', facts.agentPreset)
  if (facts.model !== undefined && facts.model !== '') {
    const route = facts.provider === undefined || facts.provider === '' ? facts.model : `${facts.provider}/${facts.model}`
    // The effort qualifies the model, so it reads as part of it.
    const effort = facts.effort === undefined || facts.effort === '' ? '' : ` (${facts.effort})`
    push('status.model', route)
    if (effort !== '') push('status.effort', effort)
  }
  if (facts.preset !== undefined && facts.preset !== '') push('status.permission', facts.preset)
  if (facts.contextTokens !== undefined) {
    push('status.context', facts.contextWindow === undefined
      ? `ctx ${formatTokens(facts.contextTokens)}`
      : `ctx ${formatTokens(facts.contextTokens)}/${formatTokens(facts.contextWindow)}`)
  }
  if (facts.cacheRate !== undefined) push('status.cache', `cache ${Math.round(facts.cacheRate * 100)}%`)
  push('status.cwd', shortPath(facts.cwd, facts.home))
  // A segment that begins with a space carries its own joining, so it must not
  // also receive the separator or the row would read "model · (max)".
  return truncateToWidth(displayText(parts.reduce(
    (line, part) => (part.startsWith(' ') ? `${line}${part}` : line === '' ? part : `${line}${separator()}${part}`),
    '',
  )), width, '…')
}

/** A one-row view of the state around the transcript. */
export class StatusBar implements Component {
  constructor(
    private readonly facts: () => StatusFacts,
    private readonly theme: TuiTheme,
  ) {}

  invalidate(): void {
    // The facts are read on every render; nothing is cached.
  }

  render(width: number): string[] {
    return width <= 0 ? [] : [formatStatus(this.facts(), width, this.theme)]
  }
}
