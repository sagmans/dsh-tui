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
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const INSTALL_LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall']
const SKILL_HELPER = join('scripts', 'run-plugin-from-worktree.sh')

/** Entries a loader or a reader needs in the tarball. */
const REQUIRED = [
  'package/package.json',
  'package/cordis.patch.yml',
  'package/README.md',
  'package/LICENSE',
  'package/lib/index.js',
  'package/lib/startup.js',
  'package/lib/install-skills.js',
  'package/.agents/skills/dsh-tui-dogfood/SKILL.md',
  'package/.agents/skills/dsh-tui-dogfood/references/home-state.md',
  'package/.agents/skills/dsh-tui-dogfood/scripts/run-plugin-from-worktree.sh',
]

// Derived rather than listed: the surface reads the built-in themes out of the
// installed package, so one the manifest forgets to pack is a name it offers and
// cannot draw.
for (const theme of readdirSync(join(ROOT, 'themes'))) {
  if (theme.endsWith('.yaml')) REQUIRED.push(`package/themes/${theme}`)
}

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
  '@sagmans/dsh-tui/todo-guard',
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
 * First-party packages the patch names for rows this plugin provides.
 *
 * A bundle owns the rows it inserts, so naming anything here makes the profile
 * depend on a package that nothing would install unless this manifest declares
 * it — which the check below enforces.
 */
const NAMED_PACKAGES = [
  '@deepseek-ai/dsh-agent-presets',
  '@deepseek-ai/dsh-code-runtime-worker-thread',
  '@deepseek-ai/dsh-cordis-host-runner',
]

/**
 * First-party packages the patch names for HOST machinery instead.
 *
 * These rows are not part of the agent plane: a preset's own rows require them
 * in the host scope, and the harness install already ships each package (the
 * base bundle mounts them), so the profile resolves them without this plugin
 * depending on them.
 */
const HOST_ROWS = [
  '@deepseek-ai/dsh-tool-subagent/model-selection-settings',
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

  // npm normalizes packaged file modes, so test the helper after copying from the tarball.
  const unpacked = mkdtempSync(join(out, 'unpacked-'))
  execFileSync('tar', ['-xzf', join(out, tarball), '-C', unpacked], { stdio: 'inherit' })
  const { installBundledSkill } = await import(pathToFileURL(join(unpacked, 'package', 'lib', 'install-skills.js')).href)
  const destination = installBundledSkill(join(out, 'home'))
  const helper = lstatSync(join(destination, SKILL_HELPER))
  if (!helper.isFile() || helper.isSymbolicLink() || (helper.mode & 0o111) === 0) {
    problems.push('installed dogfood helper is not executable')
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
  const allowed = [...NAMED_PACKAGES, ...HOST_ROWS]
  for (const name of named) {
    if (!allowed.includes(name)) problems.push(`the bundle patch mounts ${name}, which this plugin neither provides nor is documented as host machinery`)
  }
  for (const name of NAMED_PACKAGES) {
    if (!named.has(name)) problems.push(`the bundle patch no longer mounts ${name}`)
  }
  if (patch.includes('dsh-tui/ask-user')) {
    problems.push('the bundle patch still mounts the removed ask-user entry point')
  }

  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  for (const script of INSTALL_LIFECYCLE_SCRIPTS) {
    if (manifest.scripts?.[script] !== undefined) {
      problems.push(`the package must never use the ${script} install hook`)
    }
  }
  const declared = manifest.dsh?.bundle?.patch
  if (typeof declared !== 'string' || !entries.includes(`package/${declared.replace(/^\.\//u, '')}`)) {
    problems.push('the manifest does not point at a patch file that ships')
  }
  for (const name of NAMED_PACKAGES) {
    if (manifest.dependencies?.[name] === undefined) {
      problems.push(`the patch mounts ${name} but the manifest does not depend on it`)
    }
  }

  // npm resolves a required peer by installing a private copy. Against the
  // harness's floating prerelease peers that copy is what made npm refuse the
  // install, and a duplicate singleton is wrong even when it resolves: the host
  // profile supplies these modules, so the manifest names the range it accepts
  // without ever owning the package.
  const compatibility = manifest.dsh?.compatibility?.dsh
  if (typeof compatibility !== 'string') {
    problems.push('the manifest does not declare dsh.compatibility.dsh for its peers to follow')
  }
  const harnessPeers = Object.entries(manifest.peerDependencies ?? {})
    .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
  if (harnessPeers.length === 0) {
    problems.push('the manifest no longer declares the harness packages this bundle consumes')
  }
  for (const [name, range] of harnessPeers) {
    if (range !== compatibility) {
      problems.push(`peer ${name} accepts ${String(range)}, not the harness compatibility range ${String(compatibility)}`)
    }
    if (manifest.peerDependenciesMeta?.[name]?.optional !== true) {
      problems.push(`peer ${name} is required, which makes npm install a private harness copy`)
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
