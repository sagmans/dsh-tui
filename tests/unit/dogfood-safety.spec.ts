import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDogfoodFixture, GENERIC_SCRIPT } from './dogfood-fixture.js'

/**
 * Scratch homes contain copied credentials and mutable profile state, so tests
 * use synthetic source homes and assert that unsafe clone links never escape.
 */
describe('dogfood cloned-home boundaries', () => {
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

  it('keeps copied credentials private even when source home is public', () => {
    chmodSync(sourceHome, 0o755)
    writeFileSync(join(sourceHome, '.credentials.yaml'), 'test-secret')
    chmodSync(join(sourceHome, '.credentials.yaml'), 0o644)
    const result = generic(['--home', scratchHome])
    expect(result.status, result.stderr).toBe(0)
    expect(statSync(scratchHome).mode & 0o777).toBe(0o700)
    expect(statSync(join(scratchHome, '.credentials.yaml')).mode & 0o777).toBe(0o600)
  })

  it.each(['--clean', '--reseed'])('refuses %s on source home with a copied marker', (action) => {
    writeFileSync(join(sourceHome, '.dsh-dogfood'), 'source=' + sourceHome + '\ntarget=' + checkout + '\nprofile=tui\n')
    const result = generic(['--home', sourceHome, action])
    expect(result.status).not.toBe(0)
    expect(statSync(sourceHome).isDirectory()).toBe(true)
  })

  it('refuses unsafe package names in cloned dependency links', () => {
    const manifestPath = join(sourceHome, 'profiles', 'tui', 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.dependencies['../escape'] = 'link:' + checkout
    writeFileSync(manifestPath, JSON.stringify(manifest))
    const result = generic(['--home', scratchHome])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/invalid|unsafe/)
  })

  it('keeps a real node_modules directory instead of deleting it during relink', () => {
    const modulePath = join(sourceHome, 'profiles', 'tui', 'node_modules', '@sagmans', 'dsh-bundle-a')
    rmSync(modulePath)
    mkdirSync(modulePath)
    writeFileSync(join(modulePath, 'keep'), 'safe')
    const result = generic(['--home', scratchHome])
    expect(result.status).not.toBe(0)
    expect(readFileSync(join(scratchHome, 'profiles', 'tui', 'node_modules', '@sagmans', 'dsh-bundle-a', 'keep'), 'utf8')).toBe('safe')
  })

  it.each(['--clean', '--reseed'])('refuses %s when marker belongs to another checkout', (action) => {
    mkdirSync(scratchHome)
    writeFileSync(join(scratchHome, '.dsh-dogfood'), 'home=' + scratchHome + '\nsource=' + sourceHome + '\ntarget=/different-checkout\nprofile=tui\n')
    writeFileSync(join(scratchHome, 'keep'), 'safe')
    const result = generic(['--home', scratchHome, action])
    expect(result.status).not.toBe(0)
    expect(readFileSync(join(scratchHome, 'keep'), 'utf8')).toBe('safe')
  })

  it('refuses a cloned manifest symlink before writing outside the clone', () => {
    const manifestPath = join(sourceHome, 'profiles', 'tui', 'package.json')
    const external = join(root, 'external-manifest.json')
    const original = readFileSync(manifestPath, 'utf8')
    writeFileSync(external, original)
    rmSync(manifestPath)
    symlinkSync(external, manifestPath)
    const result = generic(['--home', scratchHome])
    expect(result.status).not.toBe(0)
    expect(readFileSync(external, 'utf8')).toBe(original)
  })

  it('refuses a credentials symlink added to a reused clone', () => {
    writeFileSync(join(sourceHome, '.credentials.yaml'), 'source-secret')
    const seeded = generic(['--home', scratchHome])
    expect(seeded.status, seeded.stderr).toBe(0)
    rmSync(join(scratchHome, '.credentials.yaml'))
    symlinkSync(join(sourceHome, '.credentials.yaml'), join(scratchHome, '.credentials.yaml'))
    const result = generic(['--home', scratchHome])
    expect(result.status).not.toBe(0)
    expect(readFileSync(join(sourceHome, '.credentials.yaml'), 'utf8')).toBe('source-secret')
  })

  it('refuses hardlinked clone credentials without changing source permissions', () => {
    const credentials = join(sourceHome, '.credentials.yaml')
    writeFileSync(credentials, 'source-secret')
    chmodSync(credentials, 0o644)
    const seeded = generic(['--home', scratchHome])
    expect(seeded.status, seeded.stderr).toBe(0)
    rmSync(join(scratchHome, '.credentials.yaml'))
    linkSync(credentials, join(scratchHome, '.credentials.yaml'))
    const result = generic(['--home', scratchHome])
    expect(result.status).not.toBe(0)
    expect(statSync(credentials).mode & 0o777).toBe(0o644)
  })

  it('refuses scratch homes directly inside the user home', () => {
    const scratch = join(root, 'direct-child')
    const result = spawnSync('bash', [GENERIC_SCRIPT, '--dry-run', '--source-home', sourceHome, '--home', scratch], { cwd: checkout, env: { ...process.env, HOME: root }, encoding: 'utf8' })
    expect(result.status).not.toBe(0)
    expect(existsSync(scratch)).toBe(false)
  })

  it('refuses scratch homes inside the target checkout', () => {
    const scratch = join(checkout, 'scratch')
    const result = generic(['--home', scratch])
    expect(result.status).not.toBe(0)
    expect(existsSync(scratch)).toBe(false)
  })

  it.each(['storages', 'settings.yaml'])('rejects cloned %s symlinks that escape scratch', (entry) => {
    const external = join(root, 'outside')
    mkdirSync(external)
    symlinkSync(external, join(sourceHome, entry))
    const result = generic(['--home', scratchHome])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/symlink|escape/)
  })

  const extraModuleRoots = [
    ['profiles', 'node_modules'],
    ['profiles', 'tui', '.dsh-module-fallback', 'node_modules'],
  ]

  it.each(extraModuleRoots)('preserves external package links under %s', (...parts) => {
    const packageDir = join(root, 'global-dsh', 'node_modules', 'yaml')
    mkdirSync(packageDir, { recursive: true })
    const modules = join(sourceHome, ...parts)
    mkdirSync(modules, { recursive: true })
    symlinkSync(packageDir, join(modules, 'yaml'))
    const result = generic(['--home', scratchHome])
    expect(result.status, result.stderr).toBe(0)
    expect(readlinkSync(join(scratchHome, ...parts, 'yaml'))).toBe(packageDir)
  })

  it.each(extraModuleRoots)('rejects package links into source home under %s', (...parts) => {
    const modules = join(sourceHome, ...parts)
    mkdirSync(modules, { recursive: true })
    symlinkSync(sourceHome, join(modules, 'unsafe'))
    const result = generic(['--home', scratchHome])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/symlink|escape/)
  })

  it('rejects dangling settings links chained through a module link into source', () => {
    const modules = join(sourceHome, 'profiles', 'tui', 'node_modules')
    symlinkSync(sourceHome, join(modules, 'local'))
    symlinkSync('profiles/tui/node_modules/local/new-settings.yaml', join(sourceHome, 'settings.yaml'))
    const result = generic(['--home', scratchHome])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/symlink|escape/)
    expect(existsSync(join(sourceHome, 'new-settings.yaml'))).toBe(false)
  })

  it('rejects reused mutable settings hardlinked to source home', () => {
    const sourceSettings = join(sourceHome, 'settings.yaml')
    writeFileSync(sourceSettings, 'safe: true')
    expect(generic(['--home', scratchHome]).status).toBe(0)
    const cloneSettings = join(scratchHome, 'settings.yaml')
    rmSync(cloneSettings)
    linkSync(sourceSettings, cloneSettings)
    const original = readFileSync(sourceSettings, 'utf8')
    const result = generic(['--home', scratchHome])
    expect(result.status).not.toBe(0)
    expect(readFileSync(sourceSettings, 'utf8')).toBe(original)
  })

  it('rejects manifest links into source home after relinking', () => {
    const manifestPath = join(sourceHome, 'profiles', 'tui', 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.dependencies['@sagmans/dsh-bundle-a'] = 'link:' + sourceHome
    writeFileSync(manifestPath, JSON.stringify(manifest))
    const result = generic(['--home', scratchHome])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/symlink|escape/)
  })

  it('permits package dependency hardlinks in cloned node_modules', () => {
    expect(generic(['--home', scratchHome]).status).toBe(0)
    const modules = join(scratchHome, 'profiles', 'node_modules', 'package-files')
    mkdirSync(modules, { recursive: true })
    const external = join(root, 'package-file')
    writeFileSync(external, 'package data')
    linkSync(external, join(modules, 'package-file'))
    const result = generic(['--home', scratchHome])
    expect(result.status, result.stderr).toBe(0)
  })

  it('keeps relative symlinks that resolve within the cloned home', () => {
    writeFileSync(join(sourceHome, 'internal-settings.yaml'), 'safe: true')
    symlinkSync('internal-settings.yaml', join(sourceHome, 'settings.yaml'))
    const result = generic(['--home', scratchHome])
    expect(result.status, result.stderr).toBe(0)
    expect(readlinkSync(join(scratchHome, 'settings.yaml'))).toBe('internal-settings.yaml')
  })

  it('rejects a reused profile manifest hardlinked to the source', () => {
    expect(generic(['--home', scratchHome]).status).toBe(0)
    const sourceManifest = join(sourceHome, 'profiles', 'tui', 'package.json')
    const cloneManifest = join(scratchHome, 'profiles', 'tui', 'package.json')
    const original = readFileSync(sourceManifest, 'utf8')
    rmSync(cloneManifest)
    linkSync(sourceManifest, cloneManifest)
    const result = generic(['--home', scratchHome])
    expect(result.status).not.toBe(0)
    expect(readFileSync(sourceManifest, 'utf8')).toBe(original)
  })

  it('cleans a marked clone with explicit --home after checkout disappears', () => {
    expect(generic(['--home', scratchHome]).status).toBe(0)
    rmSync(checkout, { recursive: true })
    const result = spawnSync('bash', [GENERIC_SCRIPT, '--clean', '--home', scratchHome, '--source-home', sourceHome], { cwd: root, encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(scratchHome)).toBe(false)
  })

  it('cleans a marked clone when its original source home was removed', () => {
    expect(generic(['--home', scratchHome]).status).toBe(0)
    rmSync(sourceHome, { recursive: true })
    const result = spawnSync('bash', [GENERIC_SCRIPT, '--clean', '--home', scratchHome, '--source-home', sourceHome], { cwd: checkout, encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(scratchHome)).toBe(false)
  })

  it('cleans an orphan clone when both source home and checkout were removed', () => {
    expect(generic(['--home', scratchHome]).status).toBe(0)
    rmSync(sourceHome, { recursive: true })
    rmSync(checkout, { recursive: true })
    const result = spawnSync('bash', [GENERIC_SCRIPT, '--clean', '--home', scratchHome, '--source-home', sourceHome], { cwd: root, encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(scratchHome)).toBe(false)
  })

  it('does not launch from a clone when the source home is missing', () => {
    expect(generic(['--home', scratchHome]).status).toBe(0)
    rmSync(sourceHome, { recursive: true })
    const result = generic(['--home', scratchHome])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('no home to clone')
    expect(existsSync(scratchHome)).toBe(true)
  })

  it('refuses missing-source cleanup when the marker names another source', () => {
    expect(generic(['--home', scratchHome]).status).toBe(0)
    rmSync(sourceHome, { recursive: true })
    const otherMissing = join(root, 'other-missing-home')
    const result = spawnSync('bash', [GENERIC_SCRIPT, '--clean', '--home', scratchHome, '--source-home', otherMissing], { cwd: checkout, encoding: 'utf8' })
    expect(result.status).not.toBe(0)
    expect(existsSync(scratchHome)).toBe(true)
  })

  it('cleans orphan clone from a different valid plugin checkout', () => {
    expect(generic(['--home', scratchHome]).status).toBe(0)
    rmSync(checkout, { recursive: true })
    const unrelated = join(root, 'unrelated-checkout')
    mkdirSync(unrelated)
    writeFileSync(join(unrelated, 'package.json'), JSON.stringify({ name: '@example/unrelated' }))
    const result = spawnSync('bash', [GENERIC_SCRIPT, '--clean', '--home', scratchHome, '--source-home', sourceHome], { cwd: unrelated, encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(scratchHome)).toBe(false)
  })

  it('refuses a cloned marker hardlinked outside scratch before rewriting it', () => {
    expect(generic(['--home', scratchHome]).status).toBe(0)
    const external = join(root, 'external-marker')
    const cloneMarker = join(scratchHome, '.dsh-dogfood')
    const original = readFileSync(cloneMarker, 'utf8')
    writeFileSync(external, original)
    rmSync(cloneMarker)
    linkSync(external, cloneMarker)
    const result = generic(['--home', scratchHome])
    expect(result.status).not.toBe(0)
    expect(readFileSync(external, 'utf8')).toBe(original)
  })

  it('refuses orphan cleanup when the source differs from its marker', () => {
    expect(generic(['--home', scratchHome]).status).toBe(0)
    rmSync(checkout, { recursive: true })
    const alternateSource = join(root, 'alternate-source')
    mkdirSync(alternateSource)
    const result = spawnSync('bash', [GENERIC_SCRIPT, '--clean', '--home', scratchHome, '--source-home', alternateSource], { cwd: root, encoding: 'utf8' })
    expect(result.status).not.toBe(0)
    expect(existsSync(scratchHome)).toBe(true)
  })
})
