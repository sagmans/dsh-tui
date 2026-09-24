import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const REPO_ROOT = join(__dirname, '..', '..')
export const SCRIPT = join(REPO_ROOT, 'scripts', 'dogfood', 'run-tui-from-worktree.sh')
export const GENERIC_SCRIPT = join(REPO_ROOT, '.agents', 'skills', 'dsh-tui-dogfood', 'scripts', 'run-plugin-from-worktree.sh')

export function createDogfoodFixture() {
  // macOS resolves /tmp to /private/tmp; the script uses 'pwd -P', so compare
  // against the resolved root everywhere.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-dogfood-spec-')))
  const sourceHome = join(root, 'source-home')
  const scratchHome = join(root, 'scratch-home')
  const checkout = join(root, 'checkout')

  // The legacy wrapper expects this name; generic tests replace it as needed.
  mkdirSync(checkout, { recursive: true })
  writeFileSync(join(checkout, 'package.json'), JSON.stringify({ name: '@sagmans/dsh-tui' }))

  // Two sibling bundles the profile links to, so the relink has more than one
  // link to rebuild and a dropped-bundle regression cannot pass.
  for (const name of ['bundle-a', 'bundle-b']) {
    mkdirSync(join(root, name), { recursive: true })
  }

  // A stub launcher: the script insists a dsh exists even when the profile is
  // present and no dsh command is run, and CI has none on PATH.
  const stubDsh = join(root, 'stub-dsh')
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
  return { root, sourceHome, scratchHome, checkout, stubDsh }
}
