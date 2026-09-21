import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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
    expect(readFileSync(moved, 'utf8')).toBe('corrupt')
  })

  it('steps aside when the first quarantine name is taken', async () => {
    const path = join(scratch(), 'bank.json')
    await writePrivateFileExclusive(path, 'corrupt')
    writeFileSync(`${path}.corrupt-1`, 'earlier')
    const source = await readPrivateTextFile(path)
    const moved = await quarantinePrivateFile(path, source.identity, 'corrupt-1')
    expect(moved).toBe(`${path}.corrupt-1-1`)
    expect(readFileSync(`${path}.corrupt-1`, 'utf8')).toBe('earlier')
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
