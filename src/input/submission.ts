/** What one submitted editor line asks the surface to do. */
export type Submission =
  | { readonly kind: 'empty' }
  | { readonly kind: 'quit' }
  | { readonly kind: 'clear' }
  | { readonly kind: 'help' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'status' }
  | { readonly kind: 'model'; readonly argument: string }
  | { readonly kind: 'jobs'; readonly argument: string }
  | { readonly kind: 'rename'; readonly title: string }
  | { readonly kind: 'export'; readonly path: string }
  | { readonly kind: 'subagents'; readonly argument: string }
  | { readonly kind: 'fork'; readonly title: string }
  | { readonly kind: 'new'; readonly title: string }
  | { readonly kind: 'todo' }
  | { readonly kind: 'copy' }
  | { readonly kind: 'command'; readonly name: string; readonly line: string }
  | { readonly kind: 'prompt'; readonly text: string }

/** Commands the surface answers itself, without a model turn. */
export const LOCAL_COMMANDS = [
  '/help', '/status', '/model', '/todo', '/jobs', '/subagents', '/fork', '/new', '/rename', '/export', '/copy', '/clear', '/resume', '/quit', '/exit',
] as const

/** What each local command does, shown in the editor's completion menu. */
export const LOCAL_COMMAND_DESCRIPTIONS: Readonly<Record<string, string>> = {
  '/help': 'list registered and local commands',
  '/status': 'show the session, model, permissions, and context',
  '/model': 'show or switch the model for the next step',
  '/jobs': 'list background jobs, read one, or kill one',
  '/subagents': 'list delegations; /subagents open <id|last> reads one, /subagents kill <id> stops one',
  '/todo': 'show the list of tasks the agent is keeping',
  '/fork': 'branch this conversation and continue in the branch',
  '/new': 'start a fresh session without leaving the terminal',
  '/copy': 'copy the last answer to the clipboard through the terminal',
  '/rename': 'give this session a title the picker will show',
  '/export': 'write the visible transcript to a markdown file',
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
  if (trimmed === '/model' || trimmed.startsWith('/model ')) {
    return { kind: 'model', argument: trimmed.slice('/model'.length).trim() }
  }
  if (trimmed === '/jobs' || trimmed.startsWith('/jobs ')) {
    return { kind: 'jobs', argument: trimmed.slice('/jobs'.length).trim() }
  }
  if (trimmed === '/rename' || trimmed.startsWith('/rename ')) {
    return { kind: 'rename', title: trimmed.slice('/rename'.length).trim() }
  }
  if (trimmed === '/export' || trimmed.startsWith('/export ')) {
    return { kind: 'export', path: trimmed.slice('/export'.length).trim() }
  }
  if (trimmed === '/subagents' || trimmed.startsWith('/subagents ')) {
    return { kind: 'subagents', argument: trimmed.slice('/subagents'.length).trim() }
  }
  if (trimmed === '/fork' || trimmed.startsWith('/fork ')) {
    return { kind: 'fork', title: trimmed.slice('/fork'.length).trim() }
  }
  if (trimmed === '/todo') return { kind: 'todo' }
  if (trimmed === '/copy') return { kind: 'copy' }
  if (trimmed === '/new' || trimmed.startsWith('/new ')) {
    return { kind: 'new', title: trimmed.slice('/new'.length).trim() }
  }
  if (trimmed.startsWith('/')) {
    const [head = ''] = trimmed.slice(1).split(/\s+/u, 1)
    const name = head.toLowerCase()
    return name === '' ? { kind: 'empty' } : { kind: 'command', name, line: trimmed }
  }
  return { kind: 'prompt', text: trimmed }
}
