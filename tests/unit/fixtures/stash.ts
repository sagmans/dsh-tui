/**
 * The bank a stash suite drives: the sessions it names, a host that plays the
 * editor, and a writer that can fail where the case needs it to.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'vitest'
import { PromptStash, type StashHost } from '@/stash.ts'
import { type ResolvedEntry } from '@/stash/schema.ts'
import { writeStashFile, type StashWriter } from '@/stash/store.ts'

export const SESSION = 'tui-session-spec'
export const OTHER_SESSION = 'tui-session-other'
export const SESSION_CHANGED = 'the session changed; the stash stayed with the session it belonged to'
export const scratchDirs: string[] = []
export function scratchBase(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-stash-ops-'))
  scratchDirs.push(directory)
  return directory
}
export class FakeHost implements StashHost {
  editorText = ''
  readonly notices: string[] = []
  renders = 0
  confirmations = 0
  confirmResult = false
  editorAvailable = true
  picked: readonly ResolvedEntry[] = []
  pickedLabel = ''
  pickChooser: (entries: readonly ResolvedEntry[]) => string | undefined = () => undefined

  getEditorText(): string {
    return this.editorText
  }

  setEditorText(text: string): void {
    this.editorText = text
  }

  editorIsAvailable(): boolean {
    return this.editorAvailable
  }

  notice(message: string): void {
    this.notices.push(message)
  }

  async pick(entries: readonly ResolvedEntry[], label: string): Promise<string | undefined> {
    this.picked = entries
    this.pickedLabel = label
    return this.pickChooser(entries)
  }

  async confirm(): Promise<boolean> {
    this.confirmations += 1
    if (this.onConfirm !== undefined) await this.onConfirm()
    return this.confirmResult
  }

  onConfirm: (() => Promise<void>) | undefined

  render(): void {
    this.renders += 1
  }

  last(): string | undefined {
    return this.notices.at(-1)
  }
}
export function bank(
  host: FakeHost,
  overrides: { baseDir?: string; write?: StashWriter; sessionId?: () => string; scope?: 'path' | 'session'; directory?: string } = {},
): PromptStash {
  return new PromptStash(host, {
    sessionId: overrides.sessionId ?? (() => SESSION),
    scope: overrides.scope ?? 'session',
    directory: overrides.directory,
    baseDir: overrides.baseDir ?? scratchBase(),
    ...(overrides.write === undefined ? {} : { write: overrides.write }),
  })
}
export /**
/**
 * A writer that moves the surface before it lands, so a test can switch
 * sessions after one command has resolved its bank but before the commands
 * queued behind it are reached.
 */
function movingWriter(onWrite: () => void): StashWriter {
  return async (file, contents) => {
    onWrite()
    return await writeStashFile(file, contents)
  }
}
