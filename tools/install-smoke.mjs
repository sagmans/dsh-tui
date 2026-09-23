#!/usr/bin/env node
/**
 * Consumer install smoke.
 *
 * A manifest can pass every local gate and still fail in a user's install: the
 * 0.5.0 release pinned its harness peers so npm refused the tree with ERESOLVE.
 * This packs the candidate and installs it inside the smallest supported image,
 * once with npm beside the harness and once as a plugin profile, so a resolution
 * failure, a wrong mounted version, or a duplicated host package fails CI rather
 * than a user's terminal. The container half lives in install-smoke.container.sh.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const IMAGE = 'node:24-alpine'

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const bundled = Object.keys(manifest.dependencies ?? {}).filter(name => name.startsWith('@deepseek-ai/dsh-'))
const releases = Object.keys(manifest.dsh?.compatibility?.dshReleases ?? {})
// Numeric collation keeps rc.10 after rc.9, which plain string order does not.
const harness = releases.sort((left, right) => left.localeCompare(right, 'en', { numeric: true })).at(-1)
if (harness === undefined) throw new Error('the manifest declares no verified harness release')
if (bundled.length === 0) throw new Error('the manifest mounts no harness package')

try {
  execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'ignore' })
} catch {
  console.error('install-smoke: docker with a running daemon is required; CI provides it')
  process.exit(1)
}

const out = mkdtempSync(join(tmpdir(), 'dsh-tui-install-'))
try {
  execFileSync('pnpm', ['pack', '--pack-destination', out], { cwd: ROOT, stdio: 'inherit' })
  const tarball = readdirSync(out).find(name => name.endsWith('.tgz'))
  if (tarball === undefined) throw new Error('pnpm pack produced no tarball')

  const template = readFileSync(join(ROOT, 'tools', 'install-smoke.container.sh'), 'utf8')
  const script = template
    .replaceAll('@HARNESS@', harness)
    .replaceAll('@VERSION@', manifest.version)
    .replaceAll('@BUNDLED@', bundled.join(' '))
    .replaceAll('@TARBALL@', tarball)

  execFileSync('docker', ['run', '--rm', '-i', '-v', out + ':/pkg:ro', IMAGE, 'sh', '-s'], {
    input: script,
    stdio: ['pipe', 'inherit', 'inherit'],
  })
} finally {
  rmSync(out, { recursive: true, force: true })
}
console.log('install-smoke: ok')
