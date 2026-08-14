import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationLine, ConversationPhase } from './contracts.js'
import { projectConversationLines, projectQueuedLines } from './projection.js'
import { sanitizeText } from '../sessions/projection.js'

const EMPTY_STATUS = 'Open Sessions with gs or mouse.'
const MAX_VISIBLE_LINES = 240

export function conversationPhase(snapshot: ConversationSnapshot | undefined): ConversationPhase {
  if (snapshot === undefined) return 'empty'
  switch (snapshot.openState) {
    case 'cold':
    case 'loading': return 'loading'
    case 'error': return 'error'
    case 'open': return 'ready'
    default: {
      const exhaustive: never = snapshot.openState
      throw new Error(`unhandled conversation open state: ${String(exhaustive)}`)
    }
  }
}

export function conversationStatus(snapshot: ConversationSnapshot | undefined): string {
  if (snapshot === undefined) return EMPTY_STATUS
  if (snapshot.openState === 'loading' || snapshot.openState === 'cold') return 'Loading history…'
  if (snapshot.openState === 'error') return 'History unavailable.'
  if (snapshot.removed) return 'Session removed · read only'
  if (snapshot.pending.length > 0) return `${snapshot.pending.length} interaction${snapshot.pending.length === 1 ? '' : 's'} waiting`
  if (snapshot.queue.length > 0) return `${snapshot.queue.length} queued · Ctrl+Enter steers`
  if (snapshot.running) return 'Running · Ctrl+X stop · Ctrl+Enter steer'
  if (snapshot.loadingOlder) return 'Loading older history…'
  if (snapshot.hasMore) return 'Older history available · PageUp'
  return 'Ready'
}

export function conversationError(snapshot: ConversationSnapshot | undefined): string | undefined {
  if (snapshot === undefined) return undefined
  if (snapshot.openError !== null) return sanitizeText(snapshot.openError.message)
  if (snapshot.promptError !== null) return sanitizeText(snapshot.promptError.error.message)
  if (snapshot.lastAgentError !== null) return sanitizeText(snapshot.lastAgentError)
  return undefined
}

export function visibleConversationLines(
  snapshot: ConversationSnapshot,
  offset: number,
): readonly ConversationLine[] {
  const durable = snapshot.views.get('tui')?.lines ?? projectConversationLines({
    nodes: snapshot.nodes,
    partial: snapshot.partial,
    runningCalls: snapshot.runningCalls,
  })
  const lines = [...durable, ...projectQueuedLines(snapshot.queue)]
  const end = Math.max(0, lines.length - offset)
  const start = Math.max(0, end - MAX_VISIBLE_LINES)
  return Object.freeze(lines.slice(start, end))
}
