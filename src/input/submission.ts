/** What one submitted editor line asks the surface to do. */
export type Submission =
  | { readonly kind: 'empty' }
  | { readonly kind: 'quit' }
  | { readonly kind: 'clear' }
  | { readonly kind: 'help' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'status' }
  | { readonly kind: 'command'; readonly name: string; readonly line: string }
  | { readonly kind: 'prompt'; readonly text: string }

/** Commands the surface answers itself, without a model turn. */
export const LOCAL_COMMANDS = ['/help', '/status', '/clear', '/resume', '/quit', '/exit'] as const

/** What each local command does, shown in the editor's completion menu. */
export const LOCAL_COMMAND_DESCRIPTIONS: Readonly<Record<string, string>> = {
  '/help': 'list registered and local commands',
  '/status': 'show the session, model, permissions, and context',
  '/clear': 'clear the visible transcript',
  '/resume': 'open another stored session',
  '/quit': 'leave and print the resume command',
  '/exit': 'leave and print the resume command',
}

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
  if (trimmed === '/resume') return { kind: 'resume' }
  if (trimmed === '/status') return { kind: 'status' }
  if (trimmed.startsWith('/')) {
    const [head = ''] = trimmed.slice(1).split(/\s+/u, 1)
    const name = head.toLowerCase()
    return name === '' ? { kind: 'empty' } : { kind: 'command', name, line: trimmed }
  }
  return { kind: 'prompt', text: trimmed }
}
