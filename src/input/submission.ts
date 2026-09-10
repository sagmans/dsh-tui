/** What one submitted editor line asks the surface to do. */
export type Submission =
  | { readonly kind: 'empty' }
  | { readonly kind: 'quit' }
  | { readonly kind: 'clear' }
  | { readonly kind: 'help' }
  | { readonly kind: 'command'; readonly name: string; readonly line: string }
  | { readonly kind: 'prompt'; readonly text: string }

/** Commands the surface answers itself, without a model turn. */
export const LOCAL_COMMANDS = ['/help', '/clear', '/quit', '/exit'] as const

/**
 * Classify one submitted line.
 *
 * Deciding this in one pure place keeps the plugin's wiring a switch instead of
 * a chain of string comparisons, and a slash line that is not a local command
 * is still routed as a command rather than guessed at by the model.
 */
export function classifySubmission(text: string): Submission {
  const trimmed = text.trim()
  if (trimmed === '') return { kind: 'empty' }
  if (trimmed === '/quit' || trimmed === '/exit') return { kind: 'quit' }
  if (trimmed === '/clear') return { kind: 'clear' }
  if (trimmed === '/help') return { kind: 'help' }
  if (trimmed.startsWith('/')) {
    const [head = ''] = trimmed.slice(1).split(/\s+/u, 1)
    const name = head.toLowerCase()
    return name === '' ? { kind: 'empty' } : { kind: 'command', name, line: trimmed }
  }
  return { kind: 'prompt', text: trimmed }
}
