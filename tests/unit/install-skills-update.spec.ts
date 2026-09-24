import { cpSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installBundledSkill, SKILL_NAME } from '@/install-skills.ts'

const SCRATCH_PREFIX = 'dsh-tui-update-test-'
const OLD_COPY = 'user-edited skill'
const SCRATCH_HOMES: string[] = []

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, cpSync: vi.fn(actual.cpSync), renameSync: vi.fn(actual.renameSync), rmSync: vi.fn(actual.rmSync) }
})

afterEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  vi.mocked(cpSync).mockImplementation(actual.cpSync)
  vi.mocked(renameSync).mockImplementation(actual.renameSync)
  vi.mocked(rmSync).mockImplementation(actual.rmSync)
  vi.mocked(cpSync).mockClear()
  vi.mocked(renameSync).mockClear()
  vi.mocked(rmSync).mockClear()
  for (const home of SCRATCH_HOMES.splice(0)) rmSync(home, { recursive: true, force: true })
})

function existingSkill(): { home: string; destination: string } {
  const home = mkdtempSync(join(tmpdir(), SCRATCH_PREFIX))
  SCRATCH_HOMES.push(home)
  const destination = installBundledSkill(home)
  writeFileSync(join(destination, 'SKILL.md'), OLD_COPY)
  return { home, destination }
}

describe('installBundledSkill update rollback', () => {
  it('removes a failed first installation so an unflagged retry succeeds', async () => {
    const home = mkdtempSync(join(tmpdir(), SCRATCH_PREFIX))
    SCRATCH_HOMES.push(home)
    vi.mocked(cpSync).mockImplementationOnce(() => { throw new Error('initial copy failed') })

    expect(() => installBundledSkill(home)).toThrow('initial copy failed')
    expect(readdirSync(join(home, '.agents', 'skills'))).toEqual([])

    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    vi.mocked(cpSync).mockImplementation(actual.cpSync)
    expect(installBundledSkill(home)).toBe(join(home, '.agents', 'skills', SKILL_NAME))
  })

  it('keeps the old copy when staging the new skill fails', async () => {
    const { home, destination } = existingSkill()
    vi.mocked(cpSync).mockImplementationOnce(() => { throw new Error('staging failed') })

    expect(() => installBundledSkill(home, true)).toThrow('staging failed')
    expect(readFileSync(join(destination, 'SKILL.md'), 'utf8')).toBe(OLD_COPY)
    expect(readdirSync(join(home, '.agents', 'skills'))).toEqual([SKILL_NAME])
    expect(renameSync).not.toHaveBeenCalled()
  })

  it('reports a completed update when old backup cleanup fails', async () => {
    const { home, destination } = existingSkill()
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    vi.mocked(rmSync).mockImplementation((path, options) => {
      if (String(path).includes('-update-')) throw new Error('cleanup failed')
      actual.rmSync(path, options)
    })

    expect(() => installBundledSkill(home, true)).toThrow(/skill updated;.*backup cleanup failed/)
    expect(readFileSync(join(destination, 'SKILL.md'), 'utf8')).not.toBe(OLD_COPY)
    const skills = join(home, '.agents', 'skills')
    const backup = readdirSync(skills).find(name => name !== SKILL_NAME)
    expect(backup).toBeDefined()
    expect(readFileSync(join(skills, backup!, 'previous', 'SKILL.md'), 'utf8')).toBe(OLD_COPY)
  })

  it('restores the old copy when replacement fails after moving it aside', async () => {
    const { home, destination } = existingSkill()
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    let moves = 0
    vi.mocked(renameSync).mockImplementation((from, to) => {
      if (++moves === 2) throw new Error('replacement failed')
      actual.renameSync(from, to)
    })

    expect(() => installBundledSkill(home, true)).toThrow('replacement failed')
    expect(readFileSync(join(destination, 'SKILL.md'), 'utf8')).toBe(OLD_COPY)
    expect(readdirSync(join(home, '.agents', 'skills'))).toEqual([SKILL_NAME])
    expect(renameSync).toHaveBeenCalledTimes(3)
  })
})
