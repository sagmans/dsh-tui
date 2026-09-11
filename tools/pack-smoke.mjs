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
]

/** Entries that must never ship. */
const FORBIDDEN = [
  /^package\/src\//u,
  /^package\/tests\//u,
  /^package\/\.plans\//u,
  /^package\/node_modules\//u,
  /^package\/tools\//u,
  /^package\/lib\/ask-user\.js$/u,
]

/** Rows the bundle patch promises the composed profile. */
const PATCH_ROWS = [
  '@sagmans/dsh-tui/startup',
  "name: '@sagmans/dsh-tui'",
  "name: '@deepseek-ai/dsh-agent-presets'",
  "name: '@deepseek-ai/dsh-code-runtime-worker-thread'",
]

/**
 * Base rows this bundle takes out of the global agent plane.
 *
 * The list is derived rather than chosen: it is exactly the set of base rows
 * the shipped agent presets supply, so every one of them must be owned per
 * session instead of globally. A missing entry silently double-registers what
 * the preset mounts.
 */
const DISABLED_ROWS = [
  'agent-instructions',
  'command-compact',
  'command-goal',
  'compaction-basic',
  'plan-mode',
  'skill-filesystem',
  'tool-bash',
  'tool-fs',
  'tool-fs-search',
  'tool-goal',
  'tool-jobs',
  'tool-pwsh',
  'tool-ralph',
  'tool-result-pruner',
  'tool-skill',
  'tool-subagent',
  'tool-subagent-control',
  'tool-subagent-fork',
  'tool-subagent-list-agents',
  'tool-todo',
  'tool-web',
  'tool-workflow',
  'workflow-worker-thread',
]

/**
 * First-party packages the patch may name.
 *
 * A bundle owns the rows it inserts, so naming anything else would make the
 * profile depend on a package this plugin never declared.
 */
const NAMED_PACKAGES = [
  '@deepseek-ai/dsh-agent-presets',
  '@deepseek-ai/dsh-code-runtime-worker-thread',
]

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
  for (const id of DISABLED_ROWS) {
    if (!patch.includes(`- id: ${id}\n  disabled: true`)) {
      problems.push(`the bundle patch no longer disables ${id}, which a preset supplies`)
    }
  }
  const named = new Set([...patch.matchAll(/name: '(@deepseek-ai\/[^']+)'/gu)].map(match => match[1]))
  for (const name of named) {
    if (!NAMED_PACKAGES.includes(name)) problems.push(`the bundle patch mounts ${name}, which it does not depend on`)
  }
  for (const name of NAMED_PACKAGES) {
    if (!named.has(name)) problems.push(`the bundle patch no longer mounts ${name}`)
  }
  if (patch.includes('dsh-tui/ask-user')) {
    problems.push('the bundle patch still mounts the removed ask-user entry point')
  }

  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const declared = manifest.dsh?.bundle?.patch
  if (typeof declared !== 'string' || !entries.includes(`package/${declared.replace(/^\.\//u, '')}`)) {
    problems.push('the manifest does not point at a patch file that ships')
  }
  for (const name of NAMED_PACKAGES) {
    if (manifest.dependencies?.[name] === undefined) {
      problems.push(`the patch mounts ${name} but the manifest does not depend on it`)
    }
  }

  // Every entry point a consumer or a type checker resolves must be inside the
  // artefact: a missing lib/types file breaks TypeScript consumers only after
  // they have installed the package.
  const shipped = (target) => typeof target === 'string' && entries.includes(`package/${target.replace(/^\.\//u, '')}`)
  const declaredTargets = [
    ['main', manifest.main],
    ['types', manifest.types],
    ...Object.entries(manifest.exports ?? {}).flatMap(([key, value]) => typeof value === 'string'
      ? [[`exports["${key}"]`, value]]
      : Object.entries(value).map(([condition, path]) => [`exports["${key}"].${condition}`, path])),
  ]
  for (const [label, target] of declaredTargets) {
    if (!shipped(target)) problems.push(`${label} points at ${String(target)}, which is not in the tarball`)
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
