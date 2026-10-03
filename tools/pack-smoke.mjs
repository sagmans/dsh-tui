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
import { registerHooks } from 'node:module'
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const INSTALL_LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall']
const SKILL_NAME = 'dsh-tui-dogfood'
const MODEL_SKILL_NAME = 'dsh-tui-update-models'
const SKILL_HELPER = join('scripts', 'run-plugin-from-worktree.sh')
const OPTIONAL_PROVIDER_PACKAGE = '@sagmans/dsh-provider-extra'
const CONFIG_SMOKE_INPUT = { sessionId: 'package-config-smoke', history: { enabled: false, ghost: false } }

/** Entries a loader or a reader needs in the tarball. */
const REQUIRED = [
  'package/package.json',
  'package/cordis.patch.yml',
  'package/README.md',
  'package/LICENSE',
  'package/lib/index.js',
  'package/lib/startup.js',
  'package/lib/install-skills.js',
  'package/lib/host/roster.js',
  'package/lib/host/runner.js',
  'package/lib/host/preset-files.js',
  'package/.agents/skills/dsh-tui-dogfood/SKILL.md',
  'package/.agents/skills/dsh-tui-dogfood/references/home-state.md',
  'package/.agents/skills/dsh-tui-dogfood/scripts/run-plugin-from-worktree.sh',
  `package/.agents/skills/${MODEL_SKILL_NAME}/SKILL.md`,
  `package/.agents/skills/${MODEL_SKILL_NAME}/references/model-wiring.md`,
  `package/.agents/skills/${MODEL_SKILL_NAME}/scripts/dump-model-catalog.mjs`,
]

// Derived rather than listed: the surface reads the built-in themes out of the
// installed package, so one the manifest forgets to pack is a name it offers and
// cannot draw.
for (const theme of readdirSync(join(ROOT, 'themes'))) {
  if (theme.endsWith('.yaml')) REQUIRED.push(`package/themes/${theme}`)
}

// Derived for the same reason: the host shim reads a mode out of its own packed
// file, so one the manifest forgets to pack is a mode the roster lists and the
// loader cannot compose.
for (const preset of readdirSync(join(ROOT, 'presets'))) {
  if (preset.endsWith('.patch.yml')) REQUIRED.push(`package/presets/${preset}`)
}

/** Entries that must never ship. */
const FORBIDDEN = [
  /^package\/src\//u,
  /^package\/tests\//u,
  /^package\/\.plans\//u,
  /^package\/node_modules\//u,
  /^package\/tools\//u,
  // A stale bundle-owned question tool would cross the profile-owned agent-plane boundary.
  /^package\/lib\/ask-user\.js$/u,
]

/** Rows the bundle patch promises the composed profile. */
const PATCH_ROWS = [
  '@sagmans/dsh-tui/startup',
  '@sagmans/dsh-tui/todo-guard',
  "name: '@sagmans/dsh-tui'",
  "name: '@sagmans/dsh-tui/host/roster'",
  "name: '@sagmans/dsh-tui/host/runner'",
]

/**
 * Sources whose dynamic imports are mounts too.
 *
 * A row this bundle inserts mounts its harness packages from inside a shim, so
 * the packages a profile ends up resolving are named in both places.
 */
const SHIM_SOURCES = ['src/host/roster.ts', 'src/host/runner.ts']

/**
 * Every file that mounts something: the patch, the shims, and the shipped modes.
 *
 * Each source can name a package the profile must resolve, including PTC's
 * presentation row. Checking only the patch would miss shim and mode mounts;
 * modes otherwise select an agent plane supplied by other bundles.
 */
const MOUNT_SOURCES = [
  'cordis.patch.yml',
  ...SHIM_SOURCES,
  ...readdirSync(join(ROOT, 'presets')).filter(name => name.endsWith('.patch.yml')).map(name => join('presets', name)),
]

/**
 * First-party packages the inserted rows mount, directly or through a shim.
 *
 * A bundle owns the rows it inserts, so naming anything here makes the profile
 * depend on a package that nothing would install unless this manifest declares
 * it — which the check below enforces.
 */
const NAMED_PACKAGES = [
  '@deepseek-ai/dsh-agent-preset',
  '@deepseek-ai/dsh-agent-preset-registry',
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

/**
 * First-party dependencies that are libraries rather than cordis plugins.
 *
 * They are imported by this plugin's own code, so nothing mounts them as a row;
 * the declared-against-mounted check below has to know them by name or it would
 * demand a patch row for a package that has no plugin to mount.
 */
const LIBRARY_PACKAGES = [
  '@deepseek-ai/schemastery',
]

/** Traverse built modules for syntax checks: tarball inventory alone cannot prove Node can parse them. */
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
  // Reuse frozen dependencies, but refuse the optional provider even if installed transitively.
  symlinkSync(join(ROOT, 'node_modules'), join(unpacked, 'package', 'node_modules'), 'dir')
  const standalone = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === OPTIONAL_PROVIDER_PACKAGE || specifier.startsWith(OPTIONAL_PROVIDER_PACKAGE + '/')) {
        throw new Error('the standalone TUI package must not load ' + OPTIONAL_PROVIDER_PACKAGE)
      }
      return nextResolve(specifier, context)
    },
  })
  try {
    const plugin = await import(pathToFileURL(join(unpacked, 'package', 'lib', 'index.js')).href)
    // The reader the surface uses, because a live preference travels wrapped in
    // the reference the loaded schema runtime makes: reading the wrapper's own
    // keys would report every field as absent.
    const { readRowSettings } = await import(pathToFileURL(join(unpacked, 'package', 'lib', 'config.js')).href)
    const validated = plugin.Config?.['~standard']?.validate(structuredClone(CONFIG_SMOKE_INPUT))
    const history = readRowSettings(validated?.value)?.history
    if (validated?.issues || history?.enabled !== false || history?.ghost !== false) {
      problems.push('the packaged Config does not preserve false history preferences')
    }
  } finally {
    standalone.deregister()
  }
  const { installBundledSkill } = await import(pathToFileURL(join(unpacked, 'package', 'lib', 'install-skills.js')).href)
  const destination = installBundledSkill(SKILL_NAME, join(out, 'home'))
  const helper = lstatSync(join(destination, SKILL_HELPER))
  if (!helper.isFile() || helper.isSymbolicLink() || (helper.mode & 0o111) === 0) {
    problems.push('installed dogfood helper is not executable')
  }
  // Replacement must discard stale skill files while retaining executable helpers.
  writeFileSync(join(destination, 'stale.txt'), 'old copy')
  const updated = installBundledSkill(SKILL_NAME, join(out, 'home'), true)
  if (updated !== destination || readdirSync(updated).includes('stale.txt')) {
    problems.push('updating the packaged skill left an old file behind')
  }
  const modelSkill = installBundledSkill(MODEL_SKILL_NAME, join(out, 'home'))
  if (!readFileSync(join(modelSkill, 'SKILL.md'), 'utf8').includes('name: ' + MODEL_SKILL_NAME)) {
    problems.push('the packaged model skill is not the one install-skills installs')
  }
  if ((lstatSync(join(modelSkill, 'scripts', 'dump-model-catalog.mjs')).mode & 0o111) === 0) {
    problems.push('the packaged model catalog dump is not executable')
  }
  if ((lstatSync(join(updated, SKILL_HELPER)).mode & 0o111) === 0) {
    problems.push('updated dogfood helper is not executable')
  }

  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  for (const row of PATCH_ROWS) {
    if (!patch.includes(row)) problems.push(`the bundle patch no longer names ${row}`)
  }
  const mounts = MOUNT_SOURCES.map(source => readFileSync(join(ROOT, source), 'utf8')).join('\n')
  // A subpath entry point belongs to its package, which is the name a profile
  // has to resolve and the name the manifest declares.
  const mounted = new Set(
    [...mounts.matchAll(/(?:name: |import\()'(@[^']+)'/gu)].map(match => match[1].split('/').slice(0, 2).join('/')),
  )
  const allowed = [...NAMED_PACKAGES, ...HOST_ROWS]
  for (const name of [...patch.matchAll(/name: '(@deepseek-ai\/[^']+)'/gu)].map(match => match[1])) {
    if (!allowed.includes(name)) problems.push(`the bundle patch mounts ${name}, which this plugin neither provides nor is documented as host machinery`)
  }
  for (const name of NAMED_PACKAGES) {
    if (!mounted.has(name)) problems.push(`no inserted row or shipped mode mounts ${name}`)
  }
  if (patch.includes('dsh-tui/ask-user')) {
    problems.push('the bundle patch still mounts the removed ask-user entry point')
  }

  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies })) {
    if (name === OPTIONAL_PROVIDER_PACKAGE) problems.push('the standalone package must not depend on ' + name)
  }
  if (patch.includes(OPTIONAL_PROVIDER_PACKAGE)) problems.push('the bundle patch must not require ' + OPTIONAL_PROVIDER_PACKAGE)
  // The agent plane belongs to the bundle shipping each of those plugins: a row
  // disabled here is one this bundle never owned, and the presets that used to
  // justify it mount no row at all.
  for (const [, id] of patch.matchAll(/- id: ([^\n]+)\n  disabled: true/gu)) {
    problems.push('the bundle must not disable host rows: ' + id)
  }
  // Skill installation requires explicit consent; npm installation must not perform it through install hooks.
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
  // The other direction: a first-party dependency the profile must resolve has
  // to have a row that mounts it, or the packaged bundle ships a dependency no
  // composition ever loads.
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    if (!name.startsWith('@deepseek-ai/')) continue
    if (LIBRARY_PACKAGES.includes(name)) continue
    if (!mounted.has(name)) problems.push(`the manifest depends on ${name}, but no row or mode mounts it`)
  }

  // Host-provided peers stay optional so npm need not supply missing harness
  // modules for this bundle. Consumer smoke checks selected copy counts, not
  // general deduplication across every consumer tree.
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
    // Accept open or declared-compatible peers for consumer-provided modules;
    // dsh.compatibility, not the peer declaration, owns the supported line.
    if (range !== compatibility && range !== '*') {
      problems.push(`peer ${name} accepts ${String(range)}, which is neither the harness compatibility range ${String(compatibility)} nor an open range`)
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
