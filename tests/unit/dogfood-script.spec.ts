import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDogfoodFixture, GENERIC_SCRIPT, REPO_ROOT, SCRIPT } from './dogfood-fixture.js'

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

const readLink = (path: string): string => readlinkSync(path)

describe('dogfood worktree plugin relink', () => {
  let root: string
  let sourceHome: string
  let scratchHome: string
  let checkout: string
  let stubDsh: string

  beforeEach(() => {
    ({ root, sourceHome, scratchHome, checkout, stubDsh } = createDogfoodFixture())
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const generic = (args: string[] = [], cwd = checkout) => spawnSync('bash', [GENERIC_SCRIPT, '--source-home', sourceHome, '--dsh', stubDsh, '--no-build', '--no-launch', ...args], { cwd, encoding: 'utf8' })

  const run = () =>
    execFileSync(
      'bash',
      [SCRIPT, '--home', scratchHome, '--source-home', sourceHome, '--dsh', stubDsh, '--no-build', '--no-launch', checkout],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )

  it('rejects an unsupported TUI host before seeding the clone', () => {
    const trace = join(root, 'rejected-probe-home.txt')
    writeFileSync(stubDsh, '#!/bin/sh\nprintf %s "$DSH_HOME" > ' + JSON.stringify(trace) + '\necho 0.1.7-alpha.2\n')
    const result = generic(['--home', scratchHome])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('requires compatible installed dsh')
    expect(existsSync(scratchHome)).toBe(false)
    const probeHome = readFileSync(trace, 'utf8')
    expect(probeHome).not.toBe('')
    expect(existsSync(probeHome)).toBe(false)
  })

  it('probes the helper launcher without exposing the live home', () => {
    const trace = join(root, 'probe-home.txt')
    writeFileSync(stubDsh, '#!/bin/sh\nif [ "$1" = "--version" ]; then printf %s "$DSH_HOME" > ' + JSON.stringify(trace) + '; echo 0.1.5-rc.3; fi\n')
    const result = generic(['--home', scratchHome])
    expect(result.status, result.stderr).toBe(0)
    const probeHome = readFileSync(trace, 'utf8')
    expect(probeHome).not.toBe('')
    expect(probeHome).not.toBe(sourceHome)
    expect(probeHome).not.toBe(scratchHome)
    expect(probeHome.startsWith(realpathSync(homedir()) + sep)).toBe(false)
    expect(existsSync(probeHome)).toBe(false)
  })

  it.each(['0.1.5-rc.1', '0.1.5-rc.2'])('accepts compatible installed TUI host %s', (version) => {
    writeFileSync(stubDsh, '#!/bin/sh\necho ' + version + '\n')
    const result = generic(['--home', scratchHome])
    expect(result.status, result.stderr).toBe(0)
  })

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

  it('keeps legacy default checkout anchored to wrapper from another cwd', () => {
    const result = spawnSync('bash', [SCRIPT, '--home', scratchHome, '--source-home', sourceHome, '--dsh', stubDsh, '--no-build', '--no-launch'], { cwd: root, encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    expect(readLink(join(scratchHome, 'profiles', 'tui', 'node_modules', '@sagmans', 'dsh-tui'))).toBe(realpathSync(REPO_ROOT))
  })

  it('keeps legacy prelisted bundle requirement', () => {
    const manifestPath = join(sourceHome, 'profiles', 'tui', 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((name: string) => name !== '@sagmans/dsh-tui')
    writeFileSync(manifestPath, JSON.stringify(manifest))
    const result = spawnSync('bash', [SCRIPT, '--home', scratchHome, '--source-home', sourceHome, '--dsh', stubDsh, '--no-build', '--no-launch', checkout], { cwd: root, encoding: 'utf8' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('does not list @sagmans/dsh-tui')
  })

  it('adds an absent plugin to the clone without changing source profile', () => {
    const plugin = '@example/new-plugin'
    writeFileSync(join(checkout, 'package.json'), JSON.stringify({ name: plugin }))
    const result = generic(['--home', scratchHome])
    expect(result.status, result.stderr).toBe(0)
    const cloned = JSON.parse(readFileSync(join(scratchHome, 'profiles', 'tui', 'package.json'), 'utf8'))
    const source = JSON.parse(readFileSync(join(sourceHome, 'profiles', 'tui', 'package.json'), 'utf8'))
    expect(source.dsh.profile.bundles).not.toContain(plugin)
    expect(cloned.dsh.profile.bundles).toEqual([...source.dsh.profile.bundles, plugin])
    expect(cloned.dependencies[plugin]).toBe('link:' + checkout)
    expect(readLink(join(scratchHome, 'profiles', 'tui', 'node_modules', '@example', 'new-plugin'))).toBe(checkout)
  })

  it('detects another plugin checkout and replaces only its bundle', () => {
    const plugin = '@example/my-plugin'
    writeFileSync(join(checkout, 'package.json'), JSON.stringify({ name: plugin }))
    const manifestPath = join(sourceHome, 'profiles', 'tui', 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.dsh.profile.bundles.push(plugin)
    manifest.dependencies[plugin] = 'link:' + join(root, 'old-plugin')
    writeFileSync(manifestPath, JSON.stringify(manifest))
    const result = generic(['--home', scratchHome])
    expect(result.status, result.stderr).toBe(0)
    const cloned = JSON.parse(readFileSync(join(scratchHome, 'profiles', 'tui', 'package.json'), 'utf8'))
    expect(cloned.dependencies[plugin]).toBe('link:' + checkout)
    expect(cloned.dependencies['@sagmans/dsh-tui']).toBe('link:' + checkout)
    expect(readLink(join(scratchHome, 'profiles', 'tui', 'node_modules', '@example', 'my-plugin'))).toBe(checkout)
    expect(cloned.dsh.profile.bundles).toEqual(manifest.dsh.profile.bundles)
  })

  it('reads checkout and profile paths containing apostrophes without evaluating them', () => {
    const quoted = join(root, "it's a plugin")
    mkdirSync(quoted)
    writeFileSync(join(quoted, 'package.json'), JSON.stringify({ name: '@example/quoted' }))
    const manifestPath = join(sourceHome, 'profiles', 'tui', 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.dsh.profile.bundles.push('@example/quoted')
    writeFileSync(manifestPath, JSON.stringify(manifest))
    const result = generic(['--home', scratchHome, quoted])
    expect(result.status, result.stderr).toBe(0)
    const cloned = JSON.parse(readFileSync(join(scratchHome, 'profiles', 'tui', 'package.json'), 'utf8'))
    expect(cloned.dependencies['@example/quoted']).toBe('link:' + quoted)
  })

  it('resolves relative local link specs against the original profile directory', () => {
    const manifestPath = join(sourceHome, 'profiles', 'tui', 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.dependencies['@sagmans/dsh-bundle-a'] = 'link:../../../bundle-a'
    writeFileSync(manifestPath, JSON.stringify(manifest))
    const result = generic(['--home', scratchHome])
    expect(result.status, result.stderr).toBe(0)
    expect(readLink(join(scratchHome, 'profiles', 'tui', 'node_modules', '@sagmans', 'dsh-bundle-a'))).toBe(join(root, 'bundle-a'))
  })

  it('uses a plugin without a build script or node_modules', () => {
    const result = spawnSync('bash', [GENERIC_SCRIPT, '--home', scratchHome, '--source-home', sourceHome, '--dsh', stubDsh, '--no-launch'], { cwd: checkout, encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    expect(readLink(join(scratchHome, 'profiles', 'tui', 'node_modules', '@sagmans', 'dsh-tui'))).toBe(checkout)
  })

  it('treats absent source sessions as empty with --with-sessions', () => {
    const result = generic(['--home', scratchHome, '--with-sessions'])
    expect(result.status, result.stderr).toBe(0)
  })

  it('copies source sessions when --with-sessions finds them', () => {
    mkdirSync(join(sourceHome, 'sessions'))
    writeFileSync(join(sourceHome, 'sessions', 'saved-session'), 'history')
    const result = generic(['--home', scratchHome, '--with-sessions'])
    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(join(scratchHome, 'sessions', 'saved-session'), 'utf8')).toBe('history')
  })

  it('falls back to plugin add when dsh help did not create a profile', () => {
    rmSync(join(sourceHome, 'profiles', 'tui'), { recursive: true })
    writeFileSync(stubDsh, `#!/usr/bin/env bash
if [[ "$1" == --version ]]; then
  echo 0.1.5-rc.3
  exit 0
fi
if [[ "$1" == plugin ]]; then
  mkdir -p "$DSH_HOME/profiles/tui"
  printf '%s\n' '{"dsh":{"profile":{"bundles":["@sagmans/dsh-tui"]}},"dependencies":{}}' > "$DSH_HOME/profiles/tui/package.json"
fi
`)
    const result = generic(['--home', scratchHome])
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(readFileSync(join(scratchHome, 'profiles', 'tui', 'package.json'), 'utf8')).dependencies['@sagmans/dsh-tui']).toBe('link:' + checkout)
  })

  it('separates default scratch homes for checkouts sharing a basename', () => {
    const other = join(root, 'second', 'checkout')
    mkdirSync(other, { recursive: true })
    writeFileSync(join(other, 'package.json'), JSON.stringify({ name: '@sagmans/dsh-tui' }))
    const first = spawnSync('bash', [GENERIC_SCRIPT, '--dry-run', '--source-home', sourceHome], { cwd: checkout, env: { ...process.env, TMPDIR: root }, encoding: 'utf8' })
    const second = spawnSync('bash', [GENERIC_SCRIPT, '--dry-run', '--source-home', sourceHome], { cwd: other, env: { ...process.env, TMPDIR: root }, encoding: 'utf8' })
    expect(first.status, first.stderr).toBe(0)
    expect(second.status, second.stderr).toBe(0)
    expect(first.stdout.match(/^home:\s+(.+)$/m)?.[1]).not.toBe(second.stdout.match(/^home:\s+(.+)$/m)?.[1])
  })
})
