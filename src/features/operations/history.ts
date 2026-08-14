import type { ConversationNode } from '@deepseek-ai/dsh-client-runtime/client'
import { defineTuiAction } from '../../contracts/actions.js'
import {
  OPERATION_ACTION_SCOPE,
  type OperationActionView,
  type OperationRowView,
} from './contracts.js'
import type {
  OperationsProjectionInput,
  OperationTarget,
} from './projection.js'
import { boundedJson } from '../../client/conversation/shared.js'
import { sanitizeConversationText } from '../conversation/projection.js'

const LOAD_OLDER: OperationActionView = defineTuiAction(OPERATION_ACTION_SCOPE, 'trajectory.older', 'LOAD OLDER', 'default')
const FEEDBACK_POSITIVE: OperationActionView = defineTuiAction(OPERATION_ACTION_SCOPE, 'feedback.positive', 'USEFUL', 'positive')
const FEEDBACK_NEGATIVE: OperationActionView = defineTuiAction(OPERATION_ACTION_SCOPE, 'feedback.negative', 'NOT USEFUL', 'danger')
const FEEDBACK_NOTE: OperationActionView = defineTuiAction(OPERATION_ACTION_SCOPE, 'feedback.note', 'NOTE', 'default')
const FEEDBACK_CLEAR: OperationActionView = defineTuiAction(OPERATION_ACTION_SCOPE, 'feedback.clear', 'CLEAR', 'danger')

function safe(value: string): string {
  return sanitizeConversationText(value)
}

function trajectoryTitle(node: ConversationNode): string {
  switch (node.kind) {
    case 'assistant': return `Assistant #${node.seq}`
    case 'command': return `Command #${node.seq}`
    case 'compaction': return `Compaction #${node.seq}`
    case 'context': return `Context #${node.seq}`
    case 'model-retry': return `Retry #${node.seq}`
    case 'steering': return `Steering #${node.seq}`
    case 'tool-result': return `Tool #${node.seq}`
    case 'turn-error': return `Error #${node.seq}`
    case 'turn-max-tokens': return `Token limit #${node.seq}`
    case 'unknown': return `Unknown #${node.seq}`
    case 'user': return `User #${node.seq}`
    default: {
      const exhaustive: never = node
      return String(exhaustive)
    }
  }
}

export function trajectoryRows(
  input: OperationsProjectionInput,
  targets: Map<string, OperationTarget>,
): readonly OperationRowView[] {
  const conversation = input.conversation
  if (conversation === undefined) return []
  const rows = conversation.nodes.map((node): OperationRowView => {
    const id = `trajectory:${node.kind}:${node.seq}`
    targets.set(id, { kind: 'trajectory' })
    return {
      actions: [],
      details: boundedJson(node),
      id,
      state: node.kind === 'turn-error' || (node.kind === 'tool-result' && node.isError) ? 'error' : 'idle',
      summary: node.kind,
      title: trajectoryTitle(node),
    }
  })
  if (conversation.hasMore) {
    const id = 'trajectory:older'
    targets.set(id, { kind: 'trajectory' })
    rows.unshift({
      actions: [LOAD_OLDER],
      details: 'Load one earlier history page.',
      id,
      state: 'idle',
      summary: 'more history',
      title: 'Earlier events',
    })
  }
  return rows
}

export function feedbackRows(
  input: OperationsProjectionInput,
  targets: Map<string, OperationTarget>,
): readonly OperationRowView[] {
  if (input.feedbackLoading) return []
  return (input.conversation?.nodes ?? []).flatMap((node): OperationRowView[] => {
    if (node.kind !== 'assistant' || node.messageId === undefined) return []
    const messageId = node.messageId
    const item = input.feedback.get(String(messageId))
    const id = `feedback:${messageId}`
    targets.set(id, { item, kind: 'feedback', messageId })
    return [{
      actions: item === undefined
        ? [FEEDBACK_POSITIVE, FEEDBACK_NEGATIVE]
        : [FEEDBACK_POSITIVE, FEEDBACK_NEGATIVE, FEEDBACK_NOTE, FEEDBACK_CLEAR],
      details: `${boundedJson(node.blocks)}${item?.note === undefined ? '' : `\n\nnote: ${safe(item.note)}`}`,
      id,
      state: item?.rating === 'positive' ? 'success' : item?.rating === 'negative' ? 'warning' : 'idle',
      summary: item === undefined ? 'not rated' : `${item.rating}${item.note === undefined ? '' : ' · note'}`,
      title: `Assistant #${node.seq}`,
    }]
  })
}
