import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertPrivateDirectory,
  ensurePrivateDirectory,
  FileTooLargeError,
  hasErrorCode,
  readPrivateTextFile,
  removePrivateDirectory,
  writePrivateFileExclusive,
  quarantinePrivateFile,
} from '@/stash/private-fs.ts'

const scratchDirs: string[] = []

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-stash-fs-'))
  scratchDirs.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of scratchDirs.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const modeOf = (path: string): number => statSync(path).mode & 0o777

describe('ensurePrivateDirectory', () => {
  it('creates a directory only its owner can enter', async () => {
    const directory = join(scratch(), 'nested', 'stash')
    await ensurePrivateDirectory(directory)
    expect(modeOf(directory)).toBe(0o700)
    await expect(assertPrivateDirectory(directory, 'stash directory')).resolves.toBeDefined()
  })

  /**
   * The no-follow open protects the last component only, so an ancestor that
   * another user can rewrite is enough to name a different directory by the same
   * path. The check has to fail closed, because every later operation trusts the
   * path it was given.
   */
  it('refuses to store under a directory other users can rewrite', async () => {
    const open = join(scratch(), 'open')
    mkdirSync(open, { recursive: true })
    chmodSync(open, 0o777)
    await expect(ensurePrivateDirectory(join(open, 'stash'), 'stash directory')).rejects.toThrow(
      /writable by other users/,
    )
  })

  it('accepts a sticky directory such as a shared temporary one', async () => {
    const shared = join(scratch(), 'shared')
    mkdirSync(shared, { recursive: true })
    chmodSync(shared, 0o1777)
    const directory = join(shared, 'stash')
    await ensurePrivateDirectory(directory, 'stash directory')
    expect(modeOf(directory)).toBe(0o700)
  })

  /**
   * The check reads every prefix, and it has to read it as the filesystem would:
   * a directory that only looks private because a link points somewhere open is
   * a directory another user writes in.
   */
  it('rejects an ancestor whose link leads to a directory others can rewrite', async () => {
    const open = join(scratch(), 'open')
    mkdirSync(open, { recursive: true })
    chmodSync(open, 0o777)
    const link = join(scratch(), 'link')
    symlinkSync(open, link)
    await expect(ensurePrivateDirectory(join(link, 'stash'), 'stash directory')).rejects.toThrow(
      /writable by other users/,
    )
  })

  /**
   * A group member can rename an entry exactly as a stranger can, so a shared
   * directory is only safe when its sticky bit keeps renaming to the owner.
   */
  it('rejects a group-writable ancestor without the sticky bit', async () => {
    const shared = join(scratch(), 'shared')
    mkdirSync(shared, { recursive: true })
    chmodSync(shared, 0o775)
    await expect(ensurePrivateDirectory(join(shared, 'stash'), 'stash directory')).rejects.toThrow(
      /writable by other users/,
    )
  })

  it('accepts a group-writable ancestor that is sticky', async () => {
    const shared = join(scratch(), 'shared')
    mkdirSync(shared, { recursive: true })
    chmodSync(shared, 0o1775)
    await expect(ensurePrivateDirectory(join(shared, 'stash'), 'stash directory')).resolves.toBeUndefined()
  })

  /**
   * A link resolves to a chain of its own, and a writable directory anywhere in
   * that chain can redirect the link just as well as one on the path as typed.
   */
  it('rejects an ancestor of what a link resolves to', async () => {
    const root = scratch()
    const open = join(root, 'open')
    const target = join(open, 'target')
    mkdirSync(target, { recursive: true })
    chmodSync(open, 0o777)
    chmodSync(target, 0o700)
    const link = join(scratch(), 'link')
    symlinkSync(target, link)
    await expect(ensurePrivateDirectory(join(link, 'stash'), 'stash directory')).rejects.toThrow(
      /writable by other users/,
    )
  })

  /**
   * A chain is not one link: a trusted alias can point at a link that lives in a
   * shared directory, and that shared directory decides who can repoint the
   * second hop. Resolving the chain in one step would land on the private
   * directory at its end and never look at the directory it jumped through.
   */
  it('rejects a link whose own link passes through a directory others can rewrite', async () => {
    const root = scratch()
    const shared = join(root, 'shared')
    const privateTarget = join(root, 'private')
    mkdirSync(shared, { recursive: true })
    mkdirSync(privateTarget, { recursive: true })
    chmodSync(shared, 0o777)
    chmodSync(privateTarget, 0o700)
    const jump = join(shared, 'jump')
    symlinkSync(privateTarget, jump)
    const alias = join(scratch(), 'alias')
    symlinkSync(jump, alias)
    await expect(ensurePrivateDirectory(join(alias, 'stash'), 'stash directory')).rejects.toThrow(
      /writable by other users/,
    )
  })

  it('refuses a link chain that never ends', async () => {
    const root = scratch()
    const first = join(root, 'first')
    const second = join(root, 'second')
    symlinkSync(second, first)
    symlinkSync(first, second)
    // Either the walk bounds the chain or the filesystem does; both refuse.
    await expect(ensurePrivateDirectory(join(first, 'stash'), 'stash directory')).rejects.toThrow(
      /too many (symbolic )?links/,
    )
  })

  /**
   * A directory that names a new child is the only record of it, so every
   * directory this call created has to be flushed through its parent; otherwise
   * the drafts survive a crash and the storage that holds them does not.
   */
  it('flushes each directory it created through the directory that names it', async () => {
    const root = scratch()
    const synced: string[] = []
    await ensurePrivateDirectory(join(root, 'nested', 'stash'), 'stash directory', async parent => {
      synced.push(parent)
    })
    expect(synced).toEqual([join(root, 'nested'), root])
  })

  it('flushes nothing when the directories were already there', async () => {
    const root = scratch()
    const directory = join(root, 'stash')
    await ensurePrivateDirectory(directory, 'stash directory')
    const synced: string[] = []
    await ensurePrivateDirectory(directory, 'stash directory', async parent => {
      synced.push(parent)
    })
    expect(synced).toEqual([])
  })

  /**
   * A flush that fails must not leave the directories behind: the next attempt
   * would find nothing left to flush and could report a save whose storage a
   * power loss is free to drop.
   */
  it('takes the created directories away again when the flush fails', async () => {
    const root = scratch()
    let calls = 0
    const failing = async (): Promise<void> => {
      calls += 1
      if (calls === 2) throw new Error('fsync failed')
    }
    await expect(
      ensurePrivateDirectory(join(root, 'nested', 'stash'), 'stash directory', failing),
    ).rejects.toThrow('fsync failed')
    expect(existsSync(join(root, 'nested'))).toBe(false)
    expect(existsSync(root)).toBe(true)
  })
})

describe('writePrivateFileExclusive', () => {
  it('writes a file only its owner can read, and refuses to overwrite one', async () => {
    const path = join(scratch(), 'draft.json')
    await writePrivateFileExclusive(path, '{"a":1}\n')
    expect(modeOf(path)).toBe(0o600)
    expect(readFileSync(path, 'utf8')).toBe('{"a":1}\n')
    await expect(writePrivateFileExclusive(path, 'x')).rejects.toSatisfy(error => hasErrorCode(error, 'EEXIST'))
  })
})

describe('readPrivateTextFile', () => {
  it('reads a file and repairs a mode that drifted', async () => {
    const path = join(scratch(), 'draft.json')
    writeFileSync(path, 'hello', { mode: 0o644 })
    const source = await readPrivateTextFile(path)
    expect(source.text).toBe('hello')
    expect(modeOf(path)).toBe(0o600)
    expect(source.identity.ino).toBeGreaterThan(0)
  })

  it('refuses a symlink, which could point anywhere', async () => {
    const directory = scratch()
    const target = join(directory, 'real.json')
    writeFileSync(target, 'secret')
    const link = join(directory, 'link.json')
    symlinkSync(target, link)
    await expect(readPrivateTextFile(link)).rejects.toThrow(/symbolic link/)
  })

  it('refuses a file past the byte budget rather than reading part of it', async () => {
    const path = join(scratch(), 'big.json')
    writeFileSync(path, 'x'.repeat(64))
    await expect(readPrivateTextFile(path, 'stash file', 16)).rejects.toBeInstanceOf(FileTooLargeError)
  })

  it('reports a missing file to the caller instead of inventing one', async () => {
    await expect(readPrivateTextFile(join(scratch(), 'absent.json'))).rejects.toSatisfy(error =>
      hasErrorCode(error, 'ENOENT'),
    )
  })
})

describe('quarantinePrivateFile', () => {
  it('keeps the bytes under a new name and removes the original', async () => {
    const path = join(scratch(), 'bank.json')
    await writePrivateFileExclusive(path, 'corrupt')
    const source = await readPrivateTextFile(path)
    const moved = await quarantinePrivateFile(path, source.identity, 'corrupt-1')
    expect(existsSync(path)).toBe(false)
    expect(readFileSync(moved.path, 'utf8')).toBe('corrupt')
  })

  it('steps aside when the first quarantine name is taken', async () => {
    const path = join(scratch(), 'bank.json')
    await writePrivateFileExclusive(path, 'corrupt')
    writeFileSync(`${path}.corrupt-1`, 'earlier')
    const source = await readPrivateTextFile(path)
    const moved = await quarantinePrivateFile(path, source.identity, 'corrupt-1')
    expect(moved.path).toBe(`${path}.corrupt-1-1`)
    expect(readFileSync(`${path}.corrupt-1`, 'utf8')).toBe('earlier')
  })

  /**
   * The copy is already the only copy once the original is unlinked, so the
   * caller still has to be told where it is: a failed sync must not turn a
   * recoverable bank into a silent one.
   */
  it('names the recovery path even when its directory cannot be synced', async () => {
    const path = join(scratch(), 'bank.json')
    await writePrivateFileExclusive(path, 'corrupt')
    const source = await readPrivateTextFile(path)
    const moved = await quarantinePrivateFile(
      path,
      source.identity,
      'corrupt-1',
      async () => {
        throw new Error('fsync failed')
      },
    )
    expect(moved.path).toBe(`${path}.corrupt-1`)
    expect(moved.syncError).toBeInstanceOf(Error)
    expect(existsSync(moved.path)).toBe(true)
    expect(readFileSync(moved.path, 'utf8')).toBe('corrupt')
    expect(existsSync(path)).toBe(false)
  })
})

describe('removePrivateDirectory', () => {
  it('removes a tree it owns and is quiet about one already gone', async () => {
    const directory = join(scratch(), 'gone')
    await ensurePrivateDirectory(directory)
    await writePrivateFileExclusive(join(directory, 'x'), 'x')
    await removePrivateDirectory(directory)
    expect(existsSync(directory)).toBe(false)
    await expect(removePrivateDirectory(directory)).resolves.toBeUndefined()
  })
})
