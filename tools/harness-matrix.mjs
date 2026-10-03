#!/usr/bin/env node
/**
 * Harness matrix guard.
 *
 * This bundle mounts harness packages and peers on harness modules, so it is
 * built against one verified harness release while its peers accept the whole
 * compatible line. A tree where the sources compile against one release and the
 * mounted packages name another is how the 0.5.0 install drifted into an
 * unresolvable npm tree. The default mode checks the matrix offline;
 * --check-registry also reads the registry's latest and fails when the harness
 * has moved past the verified list.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const compatibility = manifest.dsh?.compatibility?.dsh
const releases = Object.keys(manifest.dsh?.compatibility?.dshReleases ?? {})
const problems = []

/** Numeric prerelease-aware bounds keep verified RCs inside the declared compatibility range. */
function compareVersions(left, right) {
  // Bounds need an ordering this comparator can represent; unsupported version forms
  // must fail rather than produce a misleading compatibility result.
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

const lineOf = (version) => String(version).split('-')[0].split('.').slice(0, 2).join('.')

const range = /^>=(\S+) <(\S+)$/u.exec(compatibility ?? '')
if (range === null) {
  problems.push('dsh.compatibility.dsh must declare a ">=lower <upper" range, found ' + String(compatibility))
}
if (releases.length === 0) {
  problems.push('dsh.compatibility.dshReleases must name at least one verified release')
}
const supportedLine = range === null ? '' : lineOf(range[1])
if (range !== null) {
  for (const release of releases) {
    if (compareVersions(release, range[1]) < 0 || compareVersions(release, range[2]) >= 0) {
      problems.push('verified release ' + release + ' lies outside the compatible range ' + compatibility)
    }
    // One line is supported at a time: a verified release from another line is
    // where a second copy of a mounted package enters a consumer's tree, which
    // is the tree the install smoke counts copies in.
    if (lineOf(release) !== supportedLine) {
      problems.push('verified release ' + release + ' is not on the ' + supportedLine + ' line')
    }
  }
}

const harnessPackages = ([name]) => name.startsWith('@deepseek-ai/dsh-')
const mounted = Object.entries(manifest.dependencies ?? {}).filter(harnessPackages)
const compiled = Object.entries(manifest.devDependencies ?? {}).filter(harnessPackages)
if (mounted.length === 0) problems.push('the manifest mounts no harness package')
if (compiled.length === 0) problems.push('the manifest compiles against no harness package')

// A mounted package names a verified release on the supported line. An alias is
// what serves more than one line from one artefact, and the profile installs one
// copy per alias — the shape that ends with two copies of a package the base
// mounts as well, so an alias here is a relapse rather than a choice.
for (const [name, declared] of mounted) {
  if (String(declared).startsWith('npm:')) {
    problems.push('mounted package ' + name + ' is an alias of ' + String(declared)
      + ', and a single supported line needs no alias')
    continue
  }
  if (!releases.includes(declared)) {
    problems.push('mounted package ' + name + ' declares ' + declared + ', which is not a verified release')
    continue
  }
  if (lineOf(declared) !== supportedLine) {
    problems.push('mounted package ' + name + ' belongs to the ' + lineOf(declared) + ' line, not ' + supportedLine)
  }
}

// Accept open or declared-compatible peers so host modules can resolve from the
// consumer tree. pack-smoke separately requires optional peer metadata; neither
// declaration guarantees deduplication, which consumer smoke checks on selected paths.
for (const [name, declared] of Object.entries(manifest.peerDependencies ?? {})) {
  if (!name.startsWith('@deepseek-ai/dsh-')) continue
  if (declared !== '*' && declared !== compatibility) {
    problems.push('harness peer ' + name + ' declares ' + declared
      + ', which is neither "*" nor the compatible range ' + String(compatibility))
  }
}

// The sources compile against one release, and that release is one the gates saw.
const compiledVersions = new Set(compiled.map(([, declared]) => declared))
if (compiledVersions.size !== 1) {
  problems.push('the harness devDependencies name ' + compiledVersions.size + ' versions, not one')
}
for (const version of compiledVersions) {
  if (!releases.includes(version)) {
    problems.push('the harness devDependencies compile against ' + version + ', which is not a verified release')
  } else if (lineOf(version) !== supportedLine) {
    problems.push('the harness devDependencies compile against the ' + lineOf(version) + ' line, not ' + supportedLine)
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
console.log('harness-matrix: ok (' + releases.length + ' verified, compiled ' + [...compiledVersions].join(', ')
  + ', mounted ' + mounted.length + ' packages on the ' + supportedLine + ' line)')
