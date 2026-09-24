/**
 * What a durable message says, read out of its content blocks.
 *
 * A block is whatever the harness recorded — text, a thought, or a tool result
 * that carries its model-facing content one level deeper — and a reader is shown
 * only the few shapes this module recognises. It sits apart from the fold
 * because reading a recorded message is the same whether the message arrived
 * live or came back out of a log.
 */

/** Narrowing for the structural event reads below; each reader keeps its own copy rather than sharing one. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

/** The visible lines a content block list holds, thoughts excluded. */
export function contentLinesOf(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  const lines: string[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (record === undefined) continue
    // A thought is a row of its own; reading it here would hand the model's
    // private reasoning to the reader as though it had been said out loud.
    if (record.type === 'reasoning') continue
    // Any block that carries text counts; a tool-result block also holds its
    // model-facing content one level deeper.
    if (typeof record.text === 'string') lines.push(...record.text.split('\n'))
    if (Array.isArray(record.content)) lines.push(...contentLinesOf(record.content))
  }
  return lines
}

/** The same lines as one string, for the callers that store text rather than rows. */
export function textOfContent(content: unknown): string {
  return contentLinesOf(content).join('\n')
}

/**
 * The thoughts a durable message carries, in the order they were recorded.
 *
 * A recorded thought is the only path a resumed session has to the model's
 * reasoning, and the live stream does not outlive the turn that produced it.
 */
export function reasoningTextsOf(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  const thoughts: string[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (record === undefined) continue
    if (record.type === 'reasoning' && typeof record.text === 'string') thoughts.push(record.text)
    if (Array.isArray(record.content)) thoughts.push(...reasoningTextsOf(record.content))
  }
  return thoughts
}
