/** How many names a row shows before it summarizes the rest. */
const LIST_MAX = 3

/** Longest preview line kept, so one long first line cannot fill the row. */
const PREVIEW_MAX = 72

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

function nonBlankLines(text: string): string[] {
  return text.split('\n').filter(line => line.trim() !== '')
}

function countLines(text: string): string {
  return `${nonBlankLines(text).length} lines`
}

function previewOf(text: string): string {
  const first = nonBlankLines(text)[0]?.trim() ?? ''
  return first.length > PREVIEW_MAX ? `${first.slice(0, PREVIEW_MAX - 1)}…` : first
}

function recordsOf(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.map(asRecord).filter((record): record is Record<string, unknown> => record !== undefined)
}

/** Render a bounded name list; a row is worth reading only while it stays one line. */
function listOf(values: readonly unknown[]): string {
  const names = [...new Set(values.filter((value): value is string => typeof value === 'string' && value !== ''))]
  if (names.length <= LIST_MAX) return names.join(', ')
  return `${names.slice(0, LIST_MAX).join(', ')} +${names.length - LIST_MAX} more`
}

/**
 * Name the instruction files a workspace context touched.
 *
 * Paths come from the producer's change records rather than the rendered
 * reminder, whose headings exist for the model and may be reworded.
 */
function instructionLabel(source: Record<string, unknown>, text: string): string {
  const changes = recordsOf(source.changes)
  const paths = listOf(changes.map(change => change.path))
  if (changes.length > 0 && changes.every(change => change.action === 'remove')) {
    return ['injected instructions removed', paths].filter(part => part !== '').join(' · ')
  }
  const head = source.baseline === true ? 'injected instructions' : 'injected instructions updated'
  return [head, paths, countLines(text)].filter(part => part !== '').join(' · ')
}

/** Name the skill whose body was injected. */
function skillLabel(source: Record<string, unknown>, text: string): string {
  const name = typeof source.name === 'string' && source.name !== '' ? source.name : ''
  return [`injected skill${name === '' ? '' : ` ${name}`}`, countLines(text)].join(' · ')
}

/**
 * Count the entries a catalog published.
 *
 * The entry records are the published fact; the model-facing list is a frame
 * this row must not re-parse to learn how many items there were.
 */
function catalogLabel(source: Record<string, unknown>, text: string): string {
  const entries = Array.isArray(source.entries) ? source.entries : undefined
  const count = entries === undefined ? '' : `${entries.length} skills`
  const head = source.update === true ? 'injected skills updated' : 'injected skills'
  return [head, count, countLines(text)].filter(part => part !== '').join(' · ')
}

/** Name the sections one runtime snapshot assembled. */
function snapshotLabel(source: Record<string, unknown>, text: string): string {
  const producer = typeof source.plugin === 'string' && source.plugin !== '' ? source.plugin : 'plugin'
  const names = listOf(recordsOf(source.sections).map(section => section.name))
  return [`injected ${producer}`, names, countLines(text)].filter(part => part !== '').join(' · ')
}

/** Count the sessions a cross-session recall lifted. */
function recallLabel(source: Record<string, unknown>, text: string): string {
  const references = Array.isArray(source.references) ? source.references : undefined
  const count = references === undefined ? '' : `${references.length} session${references.length === 1 ? '' : 's'}`
  return ['injected session recall', count, countLines(text)].filter(part => part !== '').join(' · ')
}

/** Name the continuation round a goal message opened. */
function goalLabel(source: Record<string, unknown>, text: string): string {
  const round = typeof source.round === 'number' ? source.round : undefined
  const head = round === undefined ? 'injected goal' : `injected goal continuation · round ${round}`
  return [head, countLines(text)].join(' · ')
}

/** A relayed agent message carries no identifier worth a row; its size is the fact. */
function relayLabel(text: string): string {
  return ['injected agent message', countLines(text)].join(' · ')
}

/**
 * The label a source with no declared form gets.
 *
 * Unknown kinds keep their kind name so a merged-in producer still reads as
 * something, while the literal 'plugin' stays for the unnamed case old logs use.
 */
function legacyLabel(source: Record<string, unknown>, text: string): string {
  const plugin = typeof source.plugin === 'string' && source.plugin !== '' ? source.plugin : ''
  const kind = typeof source.kind === 'string' && source.kind !== '' && source.kind !== 'plugin' ? source.kind : ''
  const preview = previewOf(text)
  return `injected ${plugin !== '' ? plugin : kind !== '' ? kind : 'plugin'} · ${countLines(text)}${preview === '' ? '' : ` — ${preview}`}`
}

/**
 * Summarize one injected context block.
 *
 * Injected instructions can be thousands of lines and are rewritten by the
 * model, not read by the human, so the row names the producer and what it
 * touched and keeps one line of preview for sources that declare nothing.
 */
export function injectionSummary(data: Record<string, unknown>, text: string): string {
  const source = asRecord(data.source) ?? {}
  const kind = typeof source.kind === 'string' ? source.kind : ''
  const form = typeof source.form === 'string' ? source.form : ''
  const summary = typeof source.summary === 'string' ? source.summary.trim() : ''
  // A notice producer already wrote the one-line account this row exists to
  // show, and that account is bounded at the producer, so it passes through.
  if (form === 'notice' && summary !== '') return `injected ${summary}`
  if (kind === 'agent-instructions') return instructionLabel(source, text)
  if (kind === 'skill-invocation') return skillLabel(source, text)
  if (kind === 'skill-catalog') return catalogLabel(source, text)
  if (kind === 'agent-message') return relayLabel(text)
  if (kind === 'session-reference') return recallLabel(source, text)
  if (kind === 'goal') return goalLabel(source, text)
  if (form === 'snapshot') return snapshotLabel(source, text)
  return legacyLabel(source, text)
}
