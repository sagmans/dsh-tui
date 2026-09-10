#!/usr/bin/env node
/**
 * Package smoke test.
 *
 * A published bundle is only useful if the files a profile loader looks for are
 * inside the tarball and nothing that belongs to development is. This packs the
 * same artefact a publish would, then checks the layout the manifest promises,
 * so a packaging mistake fails here instead of in a user's profile.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** Entries a loader or a reader needs in the tarball. */
const REQUIRED = [
  'package/package.json',
  'package/cordis.patch.yml',
  'package/README.md',
  'package/LICENSE',
  'package/lib/index.js',
  'package/lib/startup.js',
  'package/lib/ask-user.js',
]

/** Entries that must never ship. */
const FORBIDDEN = [/^package\/src\//u, /^package\/tests\//u, /^package\/\.plans\//u, /^package\/node_modules\//u, /^package\/tools\//u]

/** Rows the bundle patch promises the composed profile. */
const PATCH_ROWS = ['@sagmans/dsh-tui/startup', '@sagmans/dsh-tui/ask-user', "name: '@sagmans/dsh-tui'"]

function walk(directory) {
  const found = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...walk(path))
    else found.push(path)
  }
  return found
}

const problems = []
const out = mkdtempSync(join(tmpdir(), 'dsh-tui-pack-'))
try {
  execFileSync('pnpm', ['pack', '--pack-destination', out], { cwd: ROOT, stdio: 'inherit' })
  const tarball = readdirSync(out).find(name => name.endsWith('.tgz'))
  if (tarball === undefined) throw new Error('pnpm pack produced no tarball')
  const entries = execFileSync('tar', ['-tzf', join(out, tarball)], { encoding: 'utf8' })
    .split('\n')
    .filter(entry => entry !== '')

  for (const entry of REQUIRED) {
    if (!entries.includes(entry)) problems.push(`missing from the tarball: ${entry}`)
  }
  for (const entry of entries) {
    if (FORBIDDEN.some(pattern => pattern.test(entry))) problems.push(`should not ship: ${entry}`)
  }

  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  for (const row of PATCH_ROWS) {
    if (!patch.includes(row)) problems.push(`the bundle patch no longer names ${row}`)
  }

  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const declared = manifest.dsh?.bundle?.patch
  if (typeof declared !== 'string' || !entries.includes(`package/${declared.replace(/^\.\//u, '')}`)) {
    problems.push('the manifest does not point at a patch file that ships')
  }

  const modules = walk(join(ROOT, 'lib')).filter(file => file.endsWith('.js'))
  for (const module of modules) execFileSync(process.execPath, ['--check', module], { stdio: 'inherit' })

  console.log(`\npacked ${entries.length} entries, ${modules.length} modules parse`)
  console.log(`tarball: ${join(out, tarball)}`)
} catch (error) {
  problems.push(error instanceof Error ? error.message : String(error))
} finally {
  rmSync(out, { recursive: true, force: true })
}

if (problems.length > 0) {
  console.error('\npack-smoke: the artefact is not shippable')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log('pack-smoke: ok')
