// Hand the prompt draft to the reader's own editor.
//
// A full-screen editor cannot run under this surface's alternate screen: it
// needs the terminal itself. The surface gives the screen up, waits for the
// child, and takes it back, the same handoff a shell performs for a commit
// message. Only the terminal side is delegated — the caller owns the alternate
// screen, so this module runs and is tested without one.
//
// Two invariants keep that handoff safe, and both live with the code that would
// break them: the child is always awaited before anything restores the terminal,
// and nothing in this surface writes to the tty while the child owns it.

import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { chmod, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripControlCharacters } from '../text.ts'

/**
 * Where a reader's editor is configured, most specific first.
 *
 * VISUAL is the full-screen editor and EDITOR the line one, which is the
 * distinction a surface that gives up the whole screen cares about; a reader
 * who set only one of them still gets it.
 */
export const EDITOR_ENV_KEYS = ['VISUAL', 'EDITOR'] as const

/** The buffer's name, so the editor's filetype, syntax, and wrap settings see prose. */
const DRAFT_FILE_NAME = 'draft.md'
/** A directory the reader's draft is written into must not be readable by others. */
const DRAFT_DIR_MODE = 0o700
const DRAFT_FILE_MODE = 0o600
const DRAFT_DIR_PREFIX = 'dsh-tui-draft-'

/** A draft larger than this is left where it is rather than handed to the bar. */
export const MAX_DRAFT_BYTES = 1_048_576

/** The same budget as a word, so the notice reads as a size and cannot drift from it. */
const MAX_DRAFT_LABEL = `${Math.round(MAX_DRAFT_BYTES / 1024 / 1024)} MiB`

const NO_EDITOR_MESSAGE = 'no editor configured: set $VISUAL or $EDITOR to open the draft in one'
const launchFailureMessage = (command: string, error: Error): string => `could not start ${command}: ${error.message}`
const useFailureMessage = (error: unknown): string =>
  `could not use the edited draft: ${error instanceof Error ? error.message : 'unknown error'}`
const tooLargeMessage = (file: string): string =>
  `the edited draft is larger than ${MAX_DRAFT_LABEL}; it was left at ${file}`
const NOT_A_FILE_MESSAGE = 'the edited draft is no longer a plain file; nothing was taken back'
const retainedMessage = (directory: string): string =>
  `could not remove the scratch directory; the draft is still at ${directory}`
const resumeFailureMessage = (error: unknown): string =>
  `the screen did not come back cleanly: ${error instanceof Error ? error.message : 'unknown error'}`

/** The quote a command line is currently inside, if any. */
const QUOTES: ReadonlySet<string> = new Set(["'", '"'])

/** Whitespace that separates one argument from the next. */
const SEPARATORS: ReadonlySet<string> = new Set([' ', '\t', '\n', '\r'])

/**
 * One configured command line as argv, or undefined when it names nothing.
 *
 * A reader writes an editor the way a shell would take it — `code --wait`,
 * `emacsclient -t` — so the line is split the way a shell would split it:
 * quotes group, and nothing else is special. No shell ever sees the result,
 * because an environment value is data and a shell would execute a typo. An
 * unterminated quote takes the rest of the line rather than refusing the whole
 * binding: a missing quote should not leave the reader with no editor at all.
 */
export function parseEditorCommand(value: string): readonly string[] | undefined {
  const argv: string[] = []
  let token = ''
  let started = false
  let quote: string | undefined
  for (const character of value) {
    if (quote !== undefined) {
      if (character === quote) quote = undefined
      else token += character
      continue
    }
    if (QUOTES.has(character)) {
      quote = character
      started = true
      continue
    }
    if (SEPARATORS.has(character)) {
      if (started && token !== '') argv.push(token)
      token = ''
      started = false
      continue
    }
    token += character
    started = true
  }
  if (started && token !== '') argv.push(token)
  return argv.length === 0 ? undefined : argv
}

/** The editor this environment configures, or undefined when none is usable. */
export function resolveEditorCommand(env: NodeJS.ProcessEnv = process.env): readonly string[] | undefined {
  for (const name of EDITOR_ENV_KEYS) {
    const configured = env[name]
    if (configured === undefined) continue
    const argv = parseEditorCommand(configured)
    if (argv !== undefined) return argv
  }
  return undefined
}

/**
 * What this module needs from the surface while a child owns the terminal.
 *
 * `suspend` and `resume` are the whole reason the handoff is safe — the
 * alternate screen has to leave before the child starts and be asked for again
 * after it ends — and only the surface owns that object. `notice` is how a
 * refusal or a failure reaches the reader, who is looking at the transcript.
 */
export interface EditorTerminalHost {
  suspend(): void
  resume(): void
  notice(message: string): void
}

/** The slice of a spawned child this module waits on. */
export interface EditorChild {
  on(event: 'error', listener: (error: Error) => void): void
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): void
}

export interface EditorSpawnOptions {
  readonly stdio: 'inherit'
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
}

/** The one process call this module makes, so a spec can drive it without a terminal. */
export type EditorSpawn = (file: string, args: readonly string[], options: EditorSpawnOptions) => EditorChild

/**
 * The real spawn, wrapped rather than passed.
 *
 * `child_process.spawn` carries overloads that do not narrow to a single
 * callable signature, and a wrapper keeps the injectable seam honest about
 * which call this module actually makes.
 */
const SPAWN: EditorSpawn = (file, args, options) => spawn(file, [...args], options)

/** What one bounded read of the editor's file produced. */
type DraftRead =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'too-large' }
  | { readonly kind: 'not-a-file' }

/** How the handoff runs; every part a spec would otherwise have to fake is overridable. */
export interface ExternalEditorOptions {
  readonly env?: NodeJS.ProcessEnv | undefined
  /** Where the scratch directory is made; tests keep theirs out of the real tmpdir. */
  readonly tempRoot?: string | undefined
  readonly spawn?: EditorSpawn | undefined
}

/**
 * The reader's editor, opened over one draft.
 *
 * Every failure is reported through the host and answered with `undefined`
 * ("keep what the bar had") rather than thrown, because the caller is a key
 * press with nowhere to put an error.
 */
export class ExternalEditor {
  private readonly env: NodeJS.ProcessEnv
  private readonly tempRoot: string
  private readonly spawn: EditorSpawn
  /** Whether a child holds the terminal; a second handoff would stop it twice. */
  private running = false

  constructor(
    private readonly host: EditorTerminalHost,
    options: ExternalEditorOptions = {},
  ) {
    this.env = options.env ?? process.env
    this.tempRoot = options.tempRoot ?? tmpdir()
    this.spawn = options.spawn ?? SPAWN
  }

  /** Edit `text` in the reader's editor, and return what was saved, or undefined to keep the bar. */
  async edit(text: string): Promise<string | undefined> {
    if (this.running) return undefined
    const argv = resolveEditorCommand(this.env)
    const command = argv?.[0]
    if (argv === undefined || command === undefined) {
      this.host.notice(NO_EDITOR_MESSAGE)
      return undefined
    }
    this.running = true
    let directory: string | undefined
    // A draft too large for the bar is left on disk rather than deleted with the
    // scratch directory: a refusal must not also be a way to lose the work.
    let keepDirectory = false
    // The screen goes before the first await, so no key can be read between the
    // chord that asked for this and the child that owns the terminal. A stop that
    // failed leaves the screen ours, so the flag behind it has to come back down:
    // left up, this surface would suppress every later title and defer every exit.
    try {
      this.host.suspend()
    } catch (error) {
      this.running = false
      this.host.notice(useFailureMessage(error))
      return undefined
    }
    try {
      directory = await mkdtemp(join(this.tempRoot, DRAFT_DIR_PREFIX))
      // mkdtemp makes the directory owner-only on POSIX; setting it here makes
      // the guarantee this module's rather than the platform's.
      await chmod(directory, DRAFT_DIR_MODE)
      const file = join(directory, DRAFT_FILE_NAME)
      await writeFile(file, text, { encoding: 'utf8', mode: DRAFT_FILE_MODE, flag: 'wx' })
      const failure = await this.run(command, argv.slice(1), file)
      if (failure !== undefined) {
        this.host.notice(launchFailureMessage(command, failure))
        return undefined
      }
      const draft = await this.readDraft(file)
      if (draft.kind === 'too-large') {
        keepDirectory = true
        this.host.notice(tooLargeMessage(file))
        return undefined
      }
      if (draft.kind === 'not-a-file') {
        this.host.notice(NOT_A_FILE_MESSAGE)
        return undefined
      }
      return draft.text
    } catch (error) {
      this.host.notice(useFailureMessage(error))
      return undefined
    } finally {
      const scratch = directory
      if (scratch !== undefined && !keepDirectory) {
        // Best effort, but not silent: a directory the reader believes was swept
        // still holds what they typed, and only they can decide what to do with it.
        await rm(scratch, { recursive: true, force: true }).catch(() => {
          this.host.notice(retainedMessage(scratch))
        })
      }
      // Cleared before the screen comes back, so a `resume` that throws cannot
      // leave a surface that refuses every later handoff.
      this.running = false
      // A resume that failed must not reject this promise: the caller is a key
      // press with nobody to catch it, and the exit it deferred still has to run.
      try {
        this.host.resume()
      } catch (error) {
        this.host.notice(resumeFailureMessage(error))
      }
    }
  }

  /**
   * What the editor saved, read through one handle.
   *
   * The file is opened without following a link and read through that same
   * handle, so a replacement between a check and a read cannot slip past it, a
   * fifo left in the draft's place cannot block the surface, and the read stops
   * one byte past the cap so a file that grows while it is read cannot exhaust
   * memory.
   */
  private async readDraft(file: string): Promise<DraftRead> {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      if (!(await handle.stat()).isFile()) return { kind: 'not-a-file' }
      const buffer = Buffer.allocUnsafe(MAX_DRAFT_BYTES + 1)
      let filled = 0
      while (filled < buffer.length) {
        const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled)
        if (bytesRead === 0) break
        filled += bytesRead
      }
      if (filled > MAX_DRAFT_BYTES) return { kind: 'too-large' }
      return { kind: 'text', text: stripControlCharacters(buffer.subarray(0, filled).toString('utf8')) }
    } finally {
      await handle.close().catch(() => undefined)
    }
  }

  /**
   * Run the editor over one file, and report only whether it could be started.
   *
   * A non-zero exit is not a failure: an editor that refused to save its buffer
   * already told the reader why, and whatever it did save is what they meant to
   * keep. A child that never started emits `error` and no `exit`, so either one
   * settling the wait is the answer.
   */
  private run(command: string, args: readonly string[], file: string): Promise<Error | undefined> {
    return new Promise(resolve => {
      const child = this.spawn(command, [...args, file], {
        stdio: 'inherit',
        cwd: process.cwd(),
        env: this.env,
      })
      let settled = false
      const settle = (error: Error | undefined): void => {
        if (settled) return
        settled = true
        resolve(error)
      }
      child.on('error', error => settle(error))
      child.on('exit', () => settle(undefined))
    })
  }
}
