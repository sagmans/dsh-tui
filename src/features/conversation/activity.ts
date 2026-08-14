import type { ConversationNode } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationLifecycleView } from './contracts.js'
import { sanitizeConversationText } from './projection.js'
import { sanitizeText } from '../sessions/projection.js'

const COMPACTION_TITLE = 'Context compacted'
const RETRY_TITLE = 'Model retry'
const UNKNOWN_SUMMARY = 'summary unavailable'
const ITEMS_LABEL = 'items'
const TOKENS_LABEL = 'tokens'
const PROVIDER_LABEL = 'provider'
const ATTEMPT_LABEL = 'attempt'
const DELAY_LABEL = 'delay'
const FAILURE_LABEL = 'failure'
const THOUSAND = 1_000
const MILLION = 1_000_000
const PERCENT_SCALE = 100

export function formatConversationTokens(value: number): string {
  const scaled = (candidate: number): string => candidate >= PERCENT_SCALE
    ? String(Math.round(candidate))
    : String(Math.round(candidate * 10) / 10)
  if (value < THOUSAND) return String(Math.round(value))
  if (value < MILLION) return `${scaled(value / THOUSAND)}K`
  return `${scaled(value / MILLION)}M`
}

export function formatConversationDuration(value: number): string {
  const seconds = value / THOUSAND
  if (seconds < 60) return `${Math.round(seconds * 10) / 10}s`
  const wholeSeconds = Math.round(seconds)
  return `${Math.floor(wholeSeconds / 60)}m${wholeSeconds % 60}s`
}

function compactionDetails(node: Extract<ConversationNode, { readonly kind: 'compaction' }>): string {
  const counts = node.shadowedItemCount === null || node.shadowedTokenCount === null
    ? UNKNOWN_SUMMARY
    : `${String(node.shadowedItemCount)} ${ITEMS_LABEL} · ${formatConversationTokens(node.shadowedTokenCount)} ${TOKENS_LABEL}`
  const summary = node.summary === null ? UNKNOWN_SUMMARY : sanitizeConversationText(node.summary)
  return `${counts}\n${summary}`
}

function retryDetails(node: Extract<ConversationNode, { readonly kind: 'model-retry' }>): string {
  const attempts = node.mode === 'always'
    ? String(node.retry)
    : `${String(node.retry)}/${String(node.maxRetries)}`
  return [
    `${PROVIDER_LABEL} ${sanitizeText(node.provider)} · ${ATTEMPT_LABEL} ${attempts} · ${sanitizeText(node.retryState)}`,
    `${DELAY_LABEL} ${formatConversationDuration(node.delayMs)}`,
    `${FAILURE_LABEL} ${sanitizeText(node.failure.code)} · ${sanitizeConversationText(node.failure.message)}`,
  ].join('\n')
}

export function projectConversationLifecycle(
  nodes: readonly ConversationNode[],
): readonly ConversationLifecycleView[] {
  return Object.freeze(nodes.flatMap((node): ConversationLifecycleView[] => {
    switch (node.kind) {
      case 'compaction': return [{ kind: 'compaction', title: COMPACTION_TITLE, details: compactionDetails(node) }]
      case 'model-retry': return [{ kind: 'retry', title: RETRY_TITLE, details: retryDetails(node) }]
      case 'user':
      case 'steering':
      case 'context':
      case 'assistant':
      case 'tool-result':
      case 'command':
      case 'turn-error':
      case 'turn-max-tokens':
      case 'unknown': return []
      default: {
        const exhaustive: never = node
        return exhaustive
      }
    }
  }))
}
