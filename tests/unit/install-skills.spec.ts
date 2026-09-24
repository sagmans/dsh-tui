import { afterEach, describe, expect, it } from 'vitest'
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installBundledSkill, SKILL_NAME } from '@/install-skills.ts'

const SCRATCH_PREFIX = 'dsh-tui-skill-test-'
const SKILL_HEADER = 'name: dsh-tui-dogfood'
const SCRATCH_HOMES: string[] = []

function scratchHome(): string {
  const home = mkdtempSync(join(tmpdir(), SCRATCH_PREFIX))
  SCRATCH_HOMES.push(home)
  return home
}

afterEach(() => {
  for (const home of SCRATCH_HOMES.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('installBundledSkill', () => {
  it('copies the packaged skill and executable workflow into a user home', () => {
    const home = scratchHome()
    const destination = installBundledSkill(home)

    expect(destination).toBe(join(home, '.agents', 'skills', SKILL_NAME))
    expect(readFileSync(join(destination, 'SKILL.md'), 'utf8')).toContain(SKILL_HEADER)
    const helper = lstatSync(join(destination, 'scripts', 'run-plugin-from-worktree.sh'))
    expect(helper.isFile()).toBe(true)
    expect(helper.mode & 0o111).not.toBe(0)
  })

  it('never overwrites an existing skill', () => {
    const home = scratchHome()
    const destination = join(home, '.agents', 'skills', SKILL_NAME)
    mkdirSync(destination, { recursive: true })
    writeFileSync(join(destination, 'SKILL.md'), 'keep me')

    expect(() => installBundledSkill(home)).toThrow(/already exists/)
    expect(readFileSync(join(destination, 'SKILL.md'), 'utf8')).toBe('keep me')
  })

  it('replaces an existing skill only when update is explicit', () => {
    const home = scratchHome()
    const destination = installBundledSkill(home)
    writeFileSync(join(destination, 'SKILL.md'), 'custom copy')
    writeFileSync(join(destination, 'stale.txt'), 'remove on update')

    expect(installBundledSkill(home, true)).toBe(destination)
    expect(readFileSync(join(destination, 'SKILL.md'), 'utf8')).toContain(SKILL_HEADER)
    expect(() => readFileSync(join(destination, 'stale.txt'), 'utf8')).toThrow()
    expect(lstatSync(join(destination, 'scripts', 'run-plugin-from-worktree.sh')).mode & 0o111).not.toBe(0)
    expect(readdirSync(join(home, '.agents', 'skills'))).toEqual([SKILL_NAME])
  })

  it('installs normally with update when no copy exists', () => {
    const home = scratchHome()
    const destination = installBundledSkill(home, true)
    expect(readFileSync(join(destination, 'SKILL.md'), 'utf8')).toContain(SKILL_HEADER)
  })

  it('rejects a non-directory copy even with update', () => {
    const home = scratchHome()
    const destination = join(home, '.agents', 'skills', SKILL_NAME)
    mkdirSync(join(home, '.agents', 'skills'), { recursive: true })
    writeFileSync(destination, 'preserve user data')

    expect(() => installBundledSkill(home, true)).toThrow(/not a directory/)
    expect(readFileSync(destination, 'utf8')).toBe('preserve user data')
  })

  it('rejects a symlink at the destination and preserves its target', () => {
    const home = scratchHome()
    const target = join(home, 'elsewhere')
    mkdirSync(join(home, '.agents', 'skills'), { recursive: true })
    mkdirSync(target)
    symlinkSync(target, join(home, '.agents', 'skills', SKILL_NAME))

    expect(() => installBundledSkill(home)).toThrow(/already exists/)
    expect(() => installBundledSkill(home, true)).toThrow()
    expect(lstatSync(target).isDirectory()).toBe(true)
  })

  it('rejects symlinked parent directories', () => {
    const home = scratchHome()
    const target = join(home, 'elsewhere')
    mkdirSync(target)
    symlinkSync(target, join(home, '.agents'))

    expect(() => installBundledSkill(home)).toThrow(/symbolic link/)
    expect(lstatSync(target).isDirectory()).toBe(true)
  })
})
