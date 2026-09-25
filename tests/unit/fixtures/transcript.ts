/**
 * The fold fixtures each transcript suite folds through: message content, a
 * card of a chosen shape, and a presenter that records what it was asked.
 */

import { type ToolCard, type ToolPresenter } from '@/cards.ts'

export const text = (value: string) => [{ type: 'text', text: value }]
export const card = (title: string, detail: string[] = [], tool = title): ToolCard =>
  ({ kind: 'generic', tool, title, detail: detail.map(text => ({ parts: [{ class: 'detail' as const, text }] })), failed: false, totalLines: detail.length })
export /** Presenter that records what it was asked, so pairing can be asserted. */
function recordingPresenter(): ToolPresenter & { readonly calls: string[]; readonly results: string[] } {
  const calls: string[] = []
  const results: string[] = []
  return {
    calls,
    results,
    call(name, argumentsJson) {
      calls.push(`${name}:${argumentsJson}`)
      return card(`${name} pending`, ['from presenter'], name)
    },
    result(name, input) {
      results.push(`${name}:${input.argumentsJson}:${input.isError ? 'error' : 'ok'}`)
      return card(`${name} settled`, ['result line'], name)
    },
  }
}
