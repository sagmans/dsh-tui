import { type Component, truncateToWidth } from '@earendil-works/pi-tui'
import { displayText } from '../text.ts'
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
/** Path segments kept in the footer; a terminal row is not a file browser. */
const PATH_SEGMENTS = 2

/** Compact a token count, because the exact number changes nothing a reader decides. */
export function formatTokens(count: number): string {
  if (count >= MILLION) return `${(count / MILLION).toFixed(1)}M`
  // A decimal on a five-digit count is noise: 128.0k reads worse than 128k.
  if (count >= HUNDRED_THOUSAND) return `${Math.round(count / THOUSAND)}k`
  if (count >= THOUSAND) return `${(count / THOUSAND).toFixed(1)}k`
  return String(count)
}

/** Shorten an absolute path to its tail, with `~` for the reader's own home. */
export function shortPath(path: string, home: string | undefined): string {
  const withinHome = home !== undefined && home !== '' && (path === home || path.startsWith(`${home}/`))
  const rest = withinHome ? path.slice(home.length).replace(/^\//u, '') : path
  const segments = rest.split('/').filter(segment => segment !== '')
  if (segments.length <= PATH_SEGMENTS) return withinHome ? `~/${segments.join('/')}` : path
  const tail = segments.slice(-PATH_SEGMENTS).join('/')
  return withinHome ? `~/${tail}` : `…/${tail}`
}

function elapsed(ms: number): string {
  if (ms < MINUTE_MS) return `${Math.max(1, Math.round(ms / SECOND_MS))}s`
  return `${Math.floor(ms / MINUTE_MS)}m${String(Math.round((ms % MINUTE_MS) / SECOND_MS)).padStart(2, '0')}s`
}

/**
 * One line of state, ordered by what a reader asks first: is it working, what is
 * it, how full is the context, and where am I.
 */
export function formatStatus(facts: StatusFacts, width: number, theme: TuiTheme): string {
  const parts: string[] = []
  if (facts.activity === 'working') {
    parts.push(facts.elapsedMs === undefined ? '▶ working' : `▶ working ${elapsed(facts.elapsedMs)}`)
  } else {
    parts.push('● ready')
  }
  // The mode comes first: it decides which tools exist at all, so a reader who
  // saw a tool disappear needs it before the model that ran it.
  if (facts.agentPreset !== undefined && facts.agentPreset !== '') parts.push(facts.agentPreset)
  if (facts.model !== undefined && facts.model !== '') {
    const route = facts.provider === undefined || facts.provider === '' ? facts.model : `${facts.provider}/${facts.model}`
    parts.push(facts.effort === undefined || facts.effort === '' ? route : `${route} (${facts.effort})`)
  }
  if (facts.preset !== undefined && facts.preset !== '') parts.push(facts.preset)
  if (facts.contextTokens !== undefined) {
    parts.push(facts.contextWindow === undefined
      ? `ctx ${formatTokens(facts.contextTokens)}`
      : `ctx ${formatTokens(facts.contextTokens)}/${formatTokens(facts.contextWindow)}`)
  }
  if (facts.cacheRate !== undefined) parts.push(`cache ${Math.round(facts.cacheRate * 100)}%`)
  parts.push(shortPath(facts.cwd, facts.home))
  return theme.dim(truncateToWidth(displayText(parts.join(' · ')), width, '…'))
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
