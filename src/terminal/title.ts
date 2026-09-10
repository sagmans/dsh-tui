/**
 * Terminal title.
 *
 * The window title is the one piece of terminal state a reader sees while the
 * surface is not on screen — in a tab bar, a window list, or a multiplexer — so
 * it says what this session is and whether it is working.
 */

const OSC_INTRODUCER = '\u001b]'
const STRING_TERMINATOR = '\u0007'
const TITLE_CODE = '0'

/** Characters that would end the sequence early and let the rest execute. */
const UNSAFE = /[\u0000-\u001f\u007f]/gu

/** How much of a directory name the title keeps. */
export const TITLE_DIR_LIMIT = 40

/**
 * Build the title sequence.
 *
 * Anything a terminal would read as the end of the title is removed rather than
 * escaped: this is a window label, and a hostile directory name has no business
 * reaching the terminal as a control character.
 */
export function titleSequence(title: string): string {
  return `${OSC_INTRODUCER}${TITLE_CODE};${title.replace(UNSAFE, '')}${STRING_TERMINATOR}`
}

/** The window title for a session, in the terms a tab bar can show. */
export function windowTitle(cwd: string, activity: 'ready' | 'working'): string {
  const segments = cwd.split('/').filter(segment => segment !== '')
  const tail = segments.slice(-2).join('/')
  const cut = tail.length > TITLE_DIR_LIMIT ? `…${tail.slice(-(TITLE_DIR_LIMIT - 1))}` : tail
  return titleSequence(`dsh-tui · ${cut === '' ? cwd : cut} · ${activity}`)
}

/** Hand the title back: the shell sets its own on the next prompt. */
export const CLEAR_TITLE = titleSequence('')
