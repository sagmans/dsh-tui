import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, chmodSync, lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * The dogfood script clones a developer's home to a different depth.
 *
 * A profile installs its local bundles as relative symlinks computed from the
 * home they were installed in, so a clone at another depth leaves every one
 * dangling and dsh refuses to mount the profile. The script has to rebuild each
 * link from the absolute 'link:' spec its package.json carries, and it must do
 * so without dropping the other bundles the profile had -- which is what
 * 'dsh plugin add' did. These specs pin both halves on a synthetic home, with no
 * dsh and no developer home involved.
 */

const REPO_ROOT = join(__dirname, '..', '..')
const SCRIPT = join(REPO_ROOT, 'scripts', 'dogfood', 'run-tui-from-worktree.sh')

const readLink = (path: string): string => readlinkSync(path)

describe('dogfood run-tui-from-worktree relink', () => {
  let root: string
  let sourceHome: string
  let scratchHome: string
  let checkout: string
  let stubDsh: string

  beforeEach(() => {
    // macOS resolves /tmp to /private/tmp; the script uses 'pwd -P', so compare
    // against the resolved root everywhere.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-dogfood-spec-')))
    sourceHome = join(root, 'source-home')
    scratchHome = join(root, 'scratch-home')
    checkout = join(root, 'checkout')

    // A checkout the script will accept: it must be named @sagmans/dsh-tui.
    mkdirSync(checkout, { recursive: true })
    writeFileSync(join(checkout, 'package.json'), JSON.stringify({ name: '@sagmans/dsh-tui' }))

    // Two sibling bundles the profile links to, so the relink has more than one
    // link to rebuild and a dropped-bundle regression cannot pass.
    for (const name of ['bundle-a', 'bundle-b']) {
      mkdirSync(join(root, name), { recursive: true })
    }

    // A stub launcher: the script insists a dsh exists even when the profile is
    // present and no dsh command is run, and CI has none on PATH.
    stubDsh = join(root, 'stub-dsh')
    writeFileSync(stubDsh, '#!/usr/bin/env bash\nexit 0\n')
    chmodSync(stubDsh, 0o755)

    // The source home's profile declares absolute 'link:' specs, exactly as a
    // real home does, but its node_modules carry relative symlinks that only
    // resolve at this depth -- the state a clone-inherits bug produces.
    const profileDir = join(sourceHome, 'profiles', 'tui')
    mkdirSync(join(profileDir, 'node_modules', '@sagmans'), { recursive: true })
    writeFileSync(
      join(profileDir, 'package.json'),
      JSON.stringify(
        {
          name: 'dsh-profile-tui',
          private: true,
          dsh: {
            profile: {
              bundles: [
                '@deepseek-ai/dsh-base',
                '@sagmans/dsh-tui',
                '@sagmans/dsh-bundle-a',
                '@sagmans/dsh-bundle-b',
              ],
              patchReload: 'live',
            },
          },
          dependencies: {
            '@deepseek-ai/dsh-base': '0.1.5-rc.3',
            '@sagmans/dsh-tui': 'link:' + checkout,
            '@sagmans/dsh-bundle-a': 'link:' + join(root, 'bundle-a'),
            '@sagmans/dsh-bundle-b': 'link:' + join(root, 'bundle-b'),
          },
        },
        null,
        2,
      ),
    )
    // Relative links that dangle once the home is copied elsewhere.
    symlinkSync('../../../../nowhere', join(profileDir, 'node_modules', '@sagmans', 'dsh-tui'))
    symlinkSync('../../../../nowhere', join(profileDir, 'node_modules', '@sagmans', 'dsh-bundle-a'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const run = () =>
    execFileSync(
      'bash',
      [SCRIPT, '--home', scratchHome, '--source-home', sourceHome, '--dsh', stubDsh, '--no-build', '--no-launch', checkout],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )

  it('rebuilds every local link as an absolute path that resolves', () => {
    run()
    const links = join(scratchHome, 'profiles', 'tui', 'node_modules', '@sagmans')
    const tui = join(links, 'dsh-tui')
    const bundleA = join(links, 'dsh-bundle-a')

    expect(readLink(tui)).toBe(realpathSync(checkout))
    expect(readLink(bundleA)).toBe(realpathSync(join(root, 'bundle-a')))
    // A dangling link is a plain 'lstat' that 'realpathSync' cannot follow.
    expect(realpathSync(tui)).toBe(realpathSync(checkout))
    expect(realpathSync(bundleA)).toBe(realpathSync(join(root, 'bundle-a')))
    expect(lstatSync(tui).isSymbolicLink()).toBe(true)
  })

  it('keeps every bundle the profile listed', () => {
    run()
    const manifest = JSON.parse(
      require('node:fs').readFileSync(join(scratchHome, 'profiles', 'tui', 'package.json'), 'utf8'),
    )
    expect(manifest.dsh.profile.bundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@sagmans/dsh-tui',
      '@sagmans/dsh-bundle-a',
      '@sagmans/dsh-bundle-b',
    ])
    expect(manifest.dependencies['@sagmans/dsh-tui']).toBe('link:' + realpathSync(checkout))
  })
})
