import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SKILL_UPDATE_COMMAND, describeSkillDrift, driftedSkillNames } from '@/install-skills.ts'

/**
 * A startup line earns its place by being true: a reader who sees it and runs
 * the command must get a copy that matches, and a reader whose copy already
 * matches must not be told otherwise. Both directions are the test.
 */

const SCRATCH: string[] = []

function scratch(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  SCRATCH.push(path)
  return path
}

/** A bundled skill tree: one document, one helper, one nested reference. */
function bundleSkill(bundled: string, name: string, body = 'original'): string {
  const root = join(bundled, name)
  mkdirSync(join(root, 'scripts'), { recursive: true })
  mkdirSync(join(root, 'references'), { recursive: true })
  writeFileSync(join(root, 'SKILL.md'), `---\nname: ${name}\n---\n${body}\n`)
  writeFileSync(join(root, 'scripts', 'helper.mjs'), `// ${body}\n`)
  writeFileSync(join(root, 'references', 'detail.md'), `# ${body}\n`)
  return root
}

function installCopy(home: string, name: string, body = 'original'): string {
  const destination = join(home, '.agents', 'skills', name)
  mkdirSync(join(destination, 'scripts'), { recursive: true })
  mkdirSync(join(destination, 'references'), { recursive: true })
  writeFileSync(join(destination, 'SKILL.md'), `---\nname: ${name}\n---\n${body}\n`)
  writeFileSync(join(destination, 'scripts', 'helper.mjs'), `// ${body}\n`)
  writeFileSync(join(destination, 'references', 'detail.md'), `# ${body}\n`)
  return destination
}

function fixture(names: readonly string[] = ['dsh-tui-dogfood']): { home: string; bundled: string } {
  const home = scratch('dsh-tui-drift-home-')
  const bundled = scratch('dsh-tui-drift-bundle-')
  for (const name of names) bundleSkill(bundled, name)
  return { home, bundled }
}

afterEach(() => {
  for (const path of SCRATCH.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('bundled skill drift', () => {
  it('stays silent when every installed copy matches', () => {
    const { home, bundled } = fixture(['dsh-tui-dogfood', 'dsh-tui-update-models'])
    installCopy(home, 'dsh-tui-dogfood')
    installCopy(home, 'dsh-tui-update-models')

    expect(driftedSkillNames(home, bundled)).toEqual([])
    expect(describeSkillDrift(home, bundled)).toBeUndefined()
  })

  it('names the skill and the command that replaces it, on one line', () => {
    const { home, bundled } = fixture()
    installCopy(home, 'dsh-tui-dogfood', 'edited by the reader')

    const line = describeSkillDrift(home, bundled)
    expect(line).toBe(`bundled skills changed since they were installed: dsh-tui-dogfood · run ${SKILL_UPDATE_COMMAND}`)
    expect(line).not.toContain('\n')
    expect(SKILL_UPDATE_COMMAND).toBe('dsh --profile tui install-skills --update')
  })

  it('reads a file this build added as drift', () => {
    const { home, bundled } = fixture()
    const destination = installCopy(home, 'dsh-tui-dogfood')
    rmSync(join(destination, 'references', 'detail.md'))

    expect(driftedSkillNames(home, bundled)).toEqual(['dsh-tui-dogfood'])
  })

  it('leaves a file the reader added beside a skill alone', () => {
    const { home, bundled } = fixture()
    const destination = installCopy(home, 'dsh-tui-dogfood')
    writeFileSync(join(destination, 'my-notes.md'), 'mine')

    expect(describeSkillDrift(home, bundled)).toBeUndefined()
  })

  it('leaves a mode-only difference alone, because the installer sets it', () => {
    const { home, bundled } = fixture()
    const source = bundleSkill(bundled, 'mode-skill')
    const destination = installCopy(home, 'mode-skill')
    chmodSync(join(source, 'scripts', 'helper.mjs'), 0o755)
    chmodSync(join(destination, 'scripts', 'helper.mjs'), 0o644)

    expect(describeSkillDrift(home, bundled)).toBeUndefined()
  })

  it('reads a skill that was never installed as nothing to update', () => {
    const { home, bundled } = fixture(['dsh-tui-dogfood', 'dsh-tui-update-models'])
    installCopy(home, 'dsh-tui-dogfood')

    expect(driftedSkillNames(home, bundled)).toEqual([])
    expect(describeSkillDrift(home, bundled)).toBeUndefined()
  })

  it('refuses to judge a symlinked copy the installer would not replace', () => {
    const { home, bundled } = fixture()
    const elsewhere = installCopy(scratch('dsh-tui-drift-elsewhere-'), 'dsh-tui-dogfood', 'edited by the reader')
    mkdirSync(join(home, '.agents', 'skills'), { recursive: true })
    symlinkSync(elsewhere, join(home, '.agents', 'skills', 'dsh-tui-dogfood'))

    expect(describeSkillDrift(home, bundled)).toBeUndefined()
  })

  it('names every drifted skill in the one line it prints', () => {
    const { home, bundled } = fixture(['dsh-tui-dogfood', 'dsh-tui-update-models'])
    installCopy(home, 'dsh-tui-dogfood', 'stale')
    installCopy(home, 'dsh-tui-update-models', 'stale')

    const line = describeSkillDrift(home, bundled)
    expect(line).toContain('dsh-tui-dogfood · dsh-tui-update-models')
    expect(line?.split('\n')).toHaveLength(1)
  })

  it('answers silence instead of throwing when the bundled tree is unreadable', () => {
    const home = scratch('dsh-tui-drift-home-')
    installCopy(home, 'dsh-tui-dogfood')

    expect(describeSkillDrift(home, join(home, 'no-such-bundled-skills'))).toBeUndefined()
  })

  it('reports the copy an install-skills --update run leaves behind as matching', () => {
    const { home, bundled } = fixture()
    installCopy(home, 'dsh-tui-dogfood', 'stale')
    expect(describeSkillDrift(home, bundled)).toBeDefined()

    // The command the line names replaces the copy with the bundled tree, so
    // the very next start must find nothing to report.
    const destination = join(home, '.agents', 'skills', 'dsh-tui-dogfood')
    rmSync(destination, { recursive: true, force: true })
    cpSync(join(bundled, 'dsh-tui-dogfood'), destination, { recursive: true })

    expect(describeSkillDrift(home, bundled)).toBeUndefined()
  })
})
