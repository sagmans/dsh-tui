/** What one submitted editor line asks the surface to do. */
export type Submission =
  | { readonly kind: 'empty' }
  | { readonly kind: 'quit' }
  | { readonly kind: 'clear' }
  | { readonly kind: 'help' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'status' }
  | { readonly kind: 'model'; readonly argument: string }
  | { readonly kind: 'preset'; readonly argument: string }
  | { readonly kind: 'jobs'; readonly argument: string }
  | { readonly kind: 'rename'; readonly title: string }
  | { readonly kind: 'export'; readonly path: string }
  | { readonly kind: 'subagents'; readonly argument: string }
  | { readonly kind: 'fork'; readonly title: string }
  | { readonly kind: 'new'; readonly title: string }
  | { readonly kind: 'todo' }
  | { readonly kind: 'theme' }
  | { readonly kind: 'keys'; readonly argument: string }
  | { readonly kind: 'copy' }
  | { readonly kind: 'plan' }
  | { readonly kind: 'history'; readonly argument: string }
  | { readonly kind: 'stash'; readonly argument: string }
  /** The chord: park whatever the editor is holding, which a typed command cannot do. */
  | { readonly kind: 'stash-draft' }
  /**
   * The chord: edit the draft in the reader's own editor.
   *
   * Typed, this would be a command whose own line is already consumed by the
   * time it runs, so the chord is the only way to hand over the draft in hand.
   */
  | { readonly kind: 'editor' }
  | { readonly kind: 'stash-pop'; readonly selector: string }
  | { readonly kind: 'stash-apply'; readonly selector: string }
  | { readonly kind: 'stash-list' }
  | { readonly kind: 'stash-drop'; readonly selector: string }
  | { readonly kind: 'stash-clear' }
  | { readonly kind: 'command'; readonly name: string; readonly line: string }
  | { readonly kind: 'prompt'; readonly text: string }

/** Commands the surface answers itself, without a model turn. */
export const LOCAL_COMMANDS = [
  '/help', '/status', '/model', '/preset', '/todo', '/theme', '/keys', '/jobs', '/subagents', '/fork', '/new', '/rename', '/export', '/copy', '/history', '/clear', '/resume', '/quit', '/exit',
  '/stash', '/stash-pop', '/stash-apply', '/stash-list', '/stash-drop', '/stash-clear',
] as const

/** What each local command does, shown in the editor's completion menu. */
export const LOCAL_COMMAND_DESCRIPTIONS: Readonly<Record<string, string>> = {
  '/help': 'list registered and local commands',
  '/status': 'show the session, model, permissions, and context',
  '/model': 'open the model picker (type to filter); /model <provider>/<model> switches directly',
  '/preset': 'choose the agent preset (mode) this session runs',
  '/jobs': 'list background jobs, read one, or kill one',
  '/subagents': 'list delegations; /subagents open <id|last> reads one, /subagents kill <id> stops one',
  '/todo': 'show the list of tasks the agent is keeping',
  '/theme': 'list every styled element and the value in force',
  '/keys': 'list every action and the keys in force; /keys <layer> narrows it',
  '/fork': 'branch this conversation and continue in the branch',
  '/new': 'start a fresh session without leaving the terminal',
  '/copy': 'copy the last answer to the clipboard through the terminal',
  '/history': 'show where prompt history is kept; /history clear forgets every prompt',
  '/rename': 'give this session a title the picker will show',
  '/export': 'write the visible transcript to a markdown file',
  '/clear': 'clear the visible transcript',
  '/resume': 'open another stored session',
  '/stash': 'store the draft typed after it; ctrl+x then s parks the editor',
  '/stash-pop': 'put a stashed draft (newest by default) into the editor and remove it',
  '/stash-apply': 'put a stashed draft (newest by default) into the editor and keep it',
  '/stash-list': "open this session's stashes; enter pops one",
  '/stash-drop': 'delete a stashed draft (newest by default) without using it',
  '/stash-clear': 'delete every draft stashed in this session after a confirmation',
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
  if (trimmed === '/preset' || trimmed.startsWith('/preset ')) {
    return { kind: 'preset', argument: trimmed.slice('/preset'.length).trim() }
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
  if (trimmed === '/theme') return { kind: 'theme' }
  if (trimmed === '/keys' || trimmed.startsWith('/keys ')) {
    return { kind: 'keys', argument: trimmed.slice('/keys'.length).trim() }
  }
  if (trimmed === '/copy') return { kind: 'copy' }
  if (trimmed === '/history' || trimmed.startsWith('/history ')) {
    return { kind: 'history', argument: trimmed.slice('/history'.length).trim() }
  }
  if (trimmed === '/new' || trimmed.startsWith('/new ')) {
    return { kind: 'new', title: trimmed.slice('/new'.length).trim() }
  }
  if (trimmed === '/stash-pop' || trimmed.startsWith('/stash-pop ')) {
    return { kind: 'stash-pop', selector: trimmed.slice('/stash-pop'.length).trim() }
  }
  if (trimmed === '/stash-apply' || trimmed.startsWith('/stash-apply ')) {
    return { kind: 'stash-apply', selector: trimmed.slice('/stash-apply'.length).trim() }
  }
  if (trimmed === '/stash-list') return { kind: 'stash-list' }
  if (trimmed === '/stash-drop' || trimmed.startsWith('/stash-drop ')) {
    return { kind: 'stash-drop', selector: trimmed.slice('/stash-drop'.length).trim() }
  }
  if (trimmed === '/stash-clear') return { kind: 'stash-clear' }
  if (trimmed === '/stash' || trimmed.startsWith('/stash ')) {
    return { kind: 'stash', argument: trimmed.slice('/stash'.length).trim() }
  }
  if (trimmed.startsWith('/')) {
    const [head = ''] = trimmed.slice(1).split(/\s+/u, 1)
    const name = head.toLowerCase()
    return name === '' ? { kind: 'empty' } : { kind: 'command', name, line: trimmed }
  }
  return { kind: 'prompt', text: trimmed }
}
