/**
 * Terminal title.
 *
 * The window title is the one piece of terminal state a reader sees while the
 * surface is not on screen — in a tab bar, a window list, or a multiplexer — so
 * it says what this session is and whether it is working.
 */

import { stripControlCharacters } from '../text.ts'

const OSC_INTRODUCER = '\u001b]'
const STRING_TERMINATOR = '\u0007'
const TITLE_CODE = '0'

/**
 * What a one-row label drops on top of the shared strip.
 *
 * The sanitizer is not repeated here: `stripControlCharacters` is the one list of
 * characters text can never carry back to a terminal, and it already removes the
 * bidi overrides — which draw nothing, so the reader cannot see or remove them —
 * along with the carriage return. A title written through a second range would
 * become the hole that list exists to close. What the editor boundary keeps is
 * the tab and the line feed it lays text out with, and a title has one row for
 * neither: a tab moves the cursor inside a tab bar and a line feed splits it.
 */
const TITLE_BREAKS = /[\t\n]/gu

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
  return `${OSC_INTRODUCER}${TITLE_CODE};${stripControlCharacters(title).replace(TITLE_BREAKS, '')}${STRING_TERMINATOR}`
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

