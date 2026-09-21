import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ExternalEditor,
  MAX_DRAFT_BYTES,
  parseEditorCommand,
  resolveEditorCommand,
  type EditorChild,
  type EditorSpawn,
  type EditorSpawnOptions,
  type EditorTerminalHost,
} from '@/terminal/external-editor.ts'

/** What the fake child may tell its parent. */
interface ChildSignals {
  error(error: Error): void
  exit(code: number | null, signal?: string | null): void
}

interface SpawnedCall {
  readonly file: string
  readonly args: readonly string[]
  readonly options: EditorSpawnOptions
}

interface FakeSpawn {
  readonly calls: SpawnedCall[]
  /** The draft path the child was handed, once it has been spawned. */
  draft(): string
  /** What the child does before it answers; the default edits the file and exits clean. */
  respond: (draft: string, signals: ChildSignals) => void
  readonly spawn: EditorSpawn
}

function fakeSpawn(): FakeSpawn {
  const calls: SpawnedCall[] = []
  const state: FakeSpawn = {
    calls,
    draft: () => calls.at(-1)?.args.at(-1) as string,
    respond: (draft, signals) => {
      writeFileSync(draft, 'edited in the child')
      signals.exit(0)
    },
    spawn: ((file: string, args: readonly string[], options: EditorSpawnOptions) => {
      calls.push({ file, args, options })
      const errors: ((error: Error) => void)[] = []
      const exits: ((code: number | null, signal: string | null) => void)[] = []
      const child = {
        on(event: string, listener: (...args: unknown[]) => void) {
          if (event === 'error') errors.push(listener as unknown as (error: Error) => void)
          else exits.push(listener as unknown as (code: number | null, signal: string | null) => void)
          return child
        },
      } as unknown as EditorChild
      // Listeners are attached synchronously after the spawn returns, and a real
      // child answers later, so the fake has to as well.
      setImmediate(() => state.respond(state.draft(), {
        error: error => {
          for (const listener of errors) listener(error)
        },
        exit: (code, signal = null) => {
          for (const listener of exits) listener(code, signal)
        },
      }))
      return child
    }) as EditorSpawn,
  }
  return state
}

/** The surface seam, recording the order the screen was handed over and taken back. */
class FakeHost implements EditorTerminalHost {
  readonly events: string[] = []
  readonly notices: string[] = []

  suspend(): void {
    this.events.push('suspend')
  }

  resume(): void {
    this.events.push('resume')
  }

  notice(message: string): void {
    this.notices.push(message)
  }

  last(): string | undefined {
    return this.notices.at(-1)
  }
}

const scratchDirs: string[] = []

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-editor-spec-'))
  scratchDirs.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of scratchDirs.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function editorOf(host: FakeHost, spawn: FakeSpawn, env: NodeJS.ProcessEnv = { EDITOR: 'nvim' }): ExternalEditor {
  return new ExternalEditor(host, { env, tempRoot: scratch(), spawn: spawn.spawn })
}

describe('parseEditorCommand', () => {
  it('reads a command with its arguments', () => {
    expect(parseEditorCommand('nvim')).toEqual(['nvim'])
    expect(parseEditorCommand('code --wait')).toEqual(['code', '--wait'])
    expect(parseEditorCommand('  nvim   -f  ')).toEqual(['nvim', '-f'])
  })

  it('groups a quoted path or argument into one word', () => {
    expect(parseEditorCommand('"/opt/My Editor/nvim" -f')).toEqual(['/opt/My Editor/nvim', '-f'])
    expect(parseEditorCommand("nvim -c 'set ft=markdown'")).toEqual(['nvim', '-c', 'set ft=markdown'])
  })

  it('takes the rest of an unterminated quote rather than refusing the editor', () => {
    expect(parseEditorCommand('"nvim -f')).toEqual(['nvim -f'])
  })

  it('names nothing when the line holds nothing', () => {
    expect(parseEditorCommand('')).toBeUndefined()
    expect(parseEditorCommand('   ')).toBeUndefined()
    expect(parseEditorCommand("''")).toBeUndefined()
  })
})

describe('resolveEditorCommand', () => {
  it('prefers the full-screen editor and falls back to the line one', () => {
    expect(resolveEditorCommand({ VISUAL: 'code --wait', EDITOR: 'nvim' })).toEqual(['code', '--wait'])
    expect(resolveEditorCommand({ EDITOR: 'nvim' })).toEqual(['nvim'])
  })

  it('skips an editor that was set to nothing', () => {
    expect(resolveEditorCommand({ VISUAL: '  ', EDITOR: 'vim' })).toEqual(['vim'])
    expect(resolveEditorCommand({})).toBeUndefined()
  })
})

describe('the external editor handoff', () => {
  it('hands the terminal over, edits the draft, and takes the screen back', async () => {
    const host = new FakeHost()
    const spawn = fakeSpawn()
    const editor = editorOf(host, spawn)
    const draftAtSeed: string[] = []
    spawn.respond = (draft, signals) => {
      draftAtSeed.push(readFileSync(draft, 'utf8'))
      writeFileSync(draft, 'edited in the child')
      signals.exit(0)
    }

    await expect(editor.edit('the draft so far')).resolves.toBe('edited in the child')
    expect(host.events).toEqual(['suspend', 'resume'])
    expect(draftAtSeed).toEqual(['the draft so far'])
    expect(spawn.calls[0]?.file).toBe('nvim')
    expect(spawn.calls[0]?.args.at(-1)).toBe(spawn.draft())
    expect(spawn.calls[0]?.options).toEqual({ stdio: 'inherit', cwd: process.cwd(), env: { EDITOR: 'nvim' } })
  })

  it('writes the draft into an owner-only scratch file and removes it afterwards', async () => {
    const host = new FakeHost()
    const spawn = fakeSpawn()
    const root = scratch()
    const editor = new ExternalEditor(host, { env: { EDITOR: 'nvim' }, tempRoot: root, spawn: spawn.spawn })
    const seen: number[] = []
    spawn.respond = (draft, signals) => {
      seen.push(statSync(draft).mode & 0o777)
      signals.exit(0)
    }

    await editor.edit('secret')
    expect(seen).toEqual([0o600])
    expect(readdirSync(root)).toEqual([])
  })

  it('appends the file to the configured arguments', async () => {
    const host = new FakeHost()
    const spawn = fakeSpawn()
    const editor = new ExternalEditor(host, { env: { EDITOR: 'nvim -f' }, tempRoot: scratch(), spawn: spawn.spawn })
    await editor.edit('draft')
    expect(spawn.calls[0]?.args.slice(0, -1)).toEqual(['-f'])
  })

  it('takes the screen back when the editor could not start', async () => {
    const host = new FakeHost()
    const spawn = fakeSpawn()
    const root = scratch()
    const editor = new ExternalEditor(host, { env: { EDITOR: 'nvim' }, tempRoot: root, spawn: spawn.spawn })
    spawn.respond = (_draft, signals) => signals.error(new Error('spawn nvim ENOENT'))

    await expect(editor.edit('draft')).resolves.toBeUndefined()
    expect(host.events).toEqual(['suspend', 'resume'])
    expect(host.last()).toBe('could not start nvim: spawn nvim ENOENT')
    expect(readdirSync(root)).toEqual([])
  })

  it('keeps what the editor saved even when it exited badly', async () => {
    const host = new FakeHost()
    const spawn = fakeSpawn()
    const editor = editorOf(host, spawn)
    spawn.respond = (draft, signals) => {
      writeFileSync(draft, 'saved before failing')
      signals.exit(1)
    }

    await expect(editor.edit('draft')).resolves.toBe('saved before failing')
    expect(host.notices).toEqual([])
  })

  it('refuses to hand the screen over when no editor is configured', async () => {
    const host = new FakeHost()
    const spawn = fakeSpawn()
    const editor = editorOf(host, spawn, {})

    await expect(editor.edit('draft')).resolves.toBeUndefined()
    expect(host.events).toEqual([])
    expect(spawn.calls).toEqual([])
    expect(host.last()).toContain('set $VISUAL or $EDITOR')
  })

  it('keeps the bar when the draft cannot be read back', async () => {
    const host = new FakeHost()
    const spawn = fakeSpawn()
    const editor = editorOf(host, spawn)
    spawn.respond = (draft, signals) => {
      rmSync(draft)
      signals.exit(0)
    }

    await expect(editor.edit('draft')).resolves.toBeUndefined()
    expect(host.last()).toContain('could not use the edited draft')
    expect(host.events).toEqual(['suspend', 'resume'])
  })

  it('leaves a draft too large for the bar where the reader can still take it', async () => {
    const host = new FakeHost()
    const spawn = fakeSpawn()
    const root = scratch()
    const editor = new ExternalEditor(host, { env: { EDITOR: 'nvim' }, tempRoot: root, spawn: spawn.spawn })
    spawn.respond = (draft, signals) => {
      writeFileSync(draft, 'x'.repeat(MAX_DRAFT_BYTES + 1))
      signals.exit(0)
    }

    await expect(editor.edit('draft')).resolves.toBeUndefined()
    expect(host.last()).toContain('larger than 1 MiB')
    const kept = readdirSync(root)
    expect(kept).toHaveLength(1)
    expect(host.last()).toContain(join(root, kept[0] as string))
  })

  it('strips the control characters an editor can return', async () => {
    const host = new FakeHost()
    const spawn = fakeSpawn()
    const editor = editorOf(host, spawn)
    spawn.respond = (draft, signals) => {
      // An escape sequence, a carriage return from a CRLF buffer, and a bidi
      // override: no control byte may reach the frame. The sequence's own
      // printable payload survives, because only the bytes that command the
      // terminal are what make it dangerous.
      writeFileSync(draft, 'a\u001b]0;pwned\u0007b\r\nc\u202ed')
      signals.exit(0)
    }

    await expect(editor.edit('draft')).resolves.toBe('a]0;pwnedb\ncd')
  })

  it('refuses a second handoff while a child owns the terminal', async () => {
    const host = new FakeHost()
    const spawn = fakeSpawn()
    const editor = editorOf(host, spawn)
    let release: (() => void) | undefined
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    spawn.respond = (draft, signals) => {
      void held.then(() => {
        writeFileSync(draft, 'edited')
        signals.exit(0)
      })
    }

    const first = editor.edit('draft')
    await expect(editor.edit('draft')).resolves.toBeUndefined()
    release?.()
    await expect(first).resolves.toBe('edited')
    expect(spawn.calls).toHaveLength(1)
    expect(host.events).toEqual(['suspend', 'resume'])
  })
})
