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

const OPEN_TRAJECTORY: OperationActionView = defineTuiAction(OPERATION_ACTION_SCOPE, 'trajectory.open', 'OPEN', 'default')
const FEEDBACK_POSITIVE: OperationActionView = defineTuiAction(OPERATION_ACTION_SCOPE, 'feedback.positive', 'USEFUL', 'positive')
const FEEDBACK_NEGATIVE: OperationActionView = defineTuiAction(OPERATION_ACTION_SCOPE, 'feedback.negative', 'NOT USEFUL', 'danger')
const FEEDBACK_NOTE: OperationActionView = defineTuiAction(OPERATION_ACTION_SCOPE, 'feedback.note', 'NOTE', 'default')
const FEEDBACK_CLEAR: OperationActionView = defineTuiAction(OPERATION_ACTION_SCOPE, 'feedback.clear', 'CLEAR', 'danger')

function safe(value: string): string {
  return sanitizeConversationText(value)
}

export function trajectoryRows(
  input: OperationsProjectionInput,
  targets: Map<string, OperationTarget>,
): readonly OperationRowView[] {
  if (input.conversation === undefined) return []
  const id = 'trajectory:ledger'
  targets.set(id, { kind: 'trajectory' })
  return [{
    actions: [OPEN_TRAJECTORY],
    details: 'Searchable turn/step ledger with folding, totals, timing, and complete record details.',
    id,
    state: input.conversation.running ? 'running' : 'idle',
    summary: `${String(input.conversation.nodes.length)} loaded records`,
    title: 'Trajectory ledger',
  }]
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
