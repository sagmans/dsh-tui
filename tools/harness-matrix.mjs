#!/usr/bin/env node
/**
 * Harness matrix guard.
 *
 * This bundle mounts harness packages and peers on harness modules, so it is
 * built against one verified harness release while its peers accept the whole
 * compatible line. A tree where the sources compile against one release, the
 * mounted packages name another, and the verified list names a third is how the
 * 0.5.0 install drifted into an unresolvable npm tree. The default mode checks
 * the matrix offline; --check-registry also reads the registry's latest and
 * fails when the harness has moved past the verified list.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const compatibility = manifest.dsh?.compatibility?.dsh
const releases = Object.keys(manifest.dsh?.compatibility?.dshReleases ?? {})
const problems = []

/** Orders X.Y.Z[-tag.N] with semver's rule that a prerelease precedes its release. */
function compareVersions(left, right) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?$/u.exec(value ?? '')
    if (match === null) throw new Error('unsupported version: ' + String(value))
    return {
      numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
      prerelease: match[4] === undefined ? null : [match[4], Number(match[5])],
    }
  }
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < a.numbers.length; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] - b.numbers[index]
  }
  if (a.prerelease === null) return b.prerelease === null ? 0 : 1
  if (b.prerelease === null) return -1
  if (a.prerelease[0] !== b.prerelease[0]) return a.prerelease[0] < b.prerelease[0] ? -1 : 1
  return a.prerelease[1] - b.prerelease[1]
}

const range = /^>=(\S+) <(\S+)$/u.exec(compatibility ?? '')
if (range === null) {
  problems.push('dsh.compatibility.dsh must declare a ">=lower <upper" range, found ' + String(compatibility))
}
if (releases.length === 0) {
  problems.push('dsh.compatibility.dshReleases must name at least one verified release')
}
if (range !== null) {
  for (const release of releases) {
    if (compareVersions(release, range[1]) < 0 || compareVersions(release, range[2]) >= 0) {
      problems.push('verified release ' + release + ' lies outside the compatible range ' + compatibility)
    }
  }
}

const mounted = Object.entries(manifest.dependencies ?? {})
  .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
const compiled = Object.entries(manifest.devDependencies ?? {})
  .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
if (mounted.length === 0) problems.push('the manifest mounts no harness package')
if (compiled.length === 0) problems.push('the manifest compiles against no harness package')

// A mounted package must accept the same line the peers accept: an exact pin
// leaves the host's newer copy in place and resolves a private duplicate.
for (const [name, declared] of mounted) {
  if (declared !== compatibility) {
    problems.push('mounted package ' + name + ' declares ' + declared + ', not the compatible range ' + String(compatibility))
  }
}

const compiledVersions = new Set(compiled.map(([, declared]) => declared))
if (compiledVersions.size !== 1) {
  problems.push('the harness devDependencies name ' + compiledVersions.size + ' versions, not one')
}
for (const version of compiledVersions) {
  if (!releases.includes(version)) {
    problems.push('the harness devDependencies compile against ' + version + ', which is not a verified release')
  }
}

if (process.argv.includes('--check-registry')) {
  const response = await fetch('https://registry.npmjs.org/@deepseek-ai%2Fdsh')
  if (!response.ok) {
    problems.push('the registry read failed with HTTP ' + response.status)
  } else {
    const metadata = await response.json()
    const latest = metadata['dist-tags']?.latest
    if (typeof latest !== 'string') {
      problems.push('the registry answered no latest dist-tag')
    } else if (!releases.includes(latest)) {
      problems.push('the harness publishes ' + latest + ' as latest, which is not a verified release')
      console.error('harness-matrix: add it to dsh.compatibility.dshReleases, raise the harness devDependencies and mounted packages, then dogfood; RELEASE.md owns the procedure')
    } else {
      console.log('harness-matrix: registry latest ' + latest + ' is verified')
    }
  }
}

if (problems.length > 0) {
  console.error('harness-matrix: the matrix is inconsistent')
  for (const problem of problems) console.error('  - ' + problem)
  process.exit(1)
}
console.log('harness-matrix: ok (' + releases.length + ' verified, compiled ' + [...compiledVersions].join(', ') + ', mounted ' + String(compatibility) + ')')
