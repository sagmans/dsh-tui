// The themes on disk.
//
// Two places, two owners: the package ships the built-ins, and `$DSH_HOME/themes`
// holds the reader's own. The split is what makes "a reader cannot override a
// built-in" true by construction rather than by a rule — a built-in is not in a
// directory the reader is invited to open, and a reader's file cannot take its
// name. `/theme export` is the sanctioned way across.
//
// Synchronous loading makes the complete library available before settings are
// applied at startup and after debounced home-directory changes. Both directories
// are re-read, but only the home directory is watched; filesystem and parsing work
// can block the surface.

import { mkdirSync, readFileSync, readdirSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load as parseYaml } from 'js-yaml'
import { dshHomeDir } from './stash/paths.ts'
import {
  asRecord,
  PALETTE_NAME_SET,
  TOKEN_NAME_SET,
  unknownNames,
  writtenPalette,
  writtenTokens,
} from './theme-schema.ts'
import type { PaletteName, ThemedSpecs } from './theme-tokens.ts'

/** The directory under `DSH_HOME` the reader's own themes live in. */
const THEMES_DIR_NAME = 'themes'

/**
 * The theme the surface draws until the reader names another.
 *
 * A name rather than the table underneath, because the default look should be one
 * a reader can read, list, and copy: the package's own theme takes its place in
 * the list beside every other, so no default hides behind an absence.
 */
export const DEFAULT_THEME = 'violet-orbit'

/** Keep each selectable name bound to one file regardless of directory enumeration
 * order; the preferred suffix also matches the copies produced by export. */
const THEME_EXTENSIONS = ['.yaml', '.yml'] as const

/** The only keys a theme file may hold; a misspelled section would otherwise do nothing. */
const THEME_SECTIONS: ReadonlySet<string> = new Set(['palette', 'tokens'])

/**
 * Limit obviously oversized inputs before theme parsing.
 *
 * Reject files whose stat size exceeds the cap to limit the obvious large-input
 * case before reading and parsing. This check does not bound parser resource use
 * or protect against a file growing between the size check and the read.
 */
const MAX_THEME_FILE_BYTES = 64 * 1024

/** How long a burst of writes to the theme directory is allowed to settle. */
const WATCH_DEBOUNCE_MS = 150
/** Missing homes are normal before setup; other failures need an actionable deferred notice. */
const MISSING_THEME_HOME_CODE = 'ENOENT'
/** Avoid exposing filesystem exception details through the terminal notice. */
const WATCH_SETUP_NOTICE = 'theme live reload could not start; restart the surface after checking filesystem access and watcher limits'

/** Keep provenance with sparse overrides so settings can merge over this layer
 * without replacing unspecified shipped defaults. */
export interface LoadedTheme {
  /** The name it answers to, which is the file's stem. */
  readonly name: string
  /** The file it was read from. */
  readonly path: string
  /** Whether the package ships it, which is what a reader may not edit. */
  readonly builtin: boolean
  /** The shades it moves, over the shipped palette. */
  readonly palette: Readonly<Partial<Record<PaletteName, string>>>
  /** The elements it draws its own way. */
  readonly tokens: ThemedSpecs
}

/** Share one loaded snapshot between lookup, picker rows, and diagnostics so
 * consumers agree on which themes are available. */
export interface ThemeLibrary {
  /** Where the reader's own themes live, whether or not the directory exists. */
  readonly home: string
  /** Every theme: the built-ins, then the reader's, each in name order. */
  list(): readonly LoadedTheme[]
  /** Every name, in {@link ThemeLibrary.list} order. */
  names(): readonly string[]
  /** One theme by name, or undefined when nothing answers to it. */
  get(name: string | undefined): LoadedTheme | undefined
  /** Everything that could not be read, each phrased for the reader. */
  problems(): readonly string[]
}

/** Give command notices both the copy location and its selectable name; expected
 * export failures become notices rather than ending the session. */
export type ExportOutcome =
  | { readonly ok: true; readonly path: string; readonly select: string }
  | { readonly ok: false; readonly problem: string }

/** A theme file found on disk, before anything has read it. */
interface ThemeFile {
  /** The name it would answer to. */
  readonly stem: string
  readonly path: string
  /** Index into {@link THEME_EXTENSIONS}: lower is the one a name prefers. */
  readonly rank: number
}

/**
 * The themes directory inside the installed package.
 *
 * Resolved from this module's own URL so the answer survives installation:
 * `lib/` and `themes/` are siblings in the tarball and `src/` and `themes/` are
 * siblings in the checkout, so the same relative step lands in both.
 */
export function builtinThemesDir(): string {
  return fileURLToPath(new URL('../themes', import.meta.url))
}

/**
 * The directory the reader's own themes live in.
 *
 * The harness home comes from the stash's helper rather than from another copy of
 * the same precedence rule — "where is DSH_HOME" has more than one answer in this
 * tree already, and a third would be one more to keep in step.
 */
export function themesHomeDir(): string {
  return path.join(dshHomeDir(), THEMES_DIR_NAME)
}

/** Create the editable directory before watching it; return failures for deferred
 * notices because the alternate screen obscures stderr. */
export function ensureThemesHome(dir: string): readonly string[] {
  try {
    mkdirSync(dir, { recursive: true })
    return []
  } catch (error) {
    return [`themes: cannot create ${dir}: ${message(error)}`]
  }
}

/** The names the package ships a file for, which are the ones an export can copy. */
export function builtinNames(library: ThemeLibrary): string[] {
  return library.list()
    .filter(theme => theme.builtin && theme.path !== '')
    .map(theme => theme.name)
}

/**
 * The name a copy of `name` takes, given the names already in use.
 *
 * Numbered rather than overwritten: a second export is a reader asking for a fresh
 * copy of a built-in that has moved on since the first, and the file they have been
 * editing is the one thing that must survive the request.
 */
function exportName(name: string, taken: ReadonlySet<string>): string {
  for (let n = 1; ; n += 1) {
    const candidate = `${name}_export_${n}`
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * Write a built-in out as a theme of the reader's own.
 *
 * The bytes are copied rather than re-serialized, so the comments a built-in
 * carries — which is where a port records why a shade is the shade it is — arrive
 * with it. The one line added says where the copy came from, because a fork nobody
 * can date is a fork nobody can rebase onto a later reference.
 */
export function exportTheme(library: ThemeLibrary, name: string): ExportOutcome {
  const theme = library.get(name)
  if (theme === undefined) {
    return { ok: false, problem: `themes: no theme named "${name}"; the surface ships ${library.names().join(', ')}` }
  }
  if (!theme.builtin) {
    return { ok: false, problem: `themes: "${name}" is already yours (${theme.path}); this command copies a built-in` }
  }
  if (theme.path === '') {
    return { ok: false, problem: `themes: "${name}" has no file to copy; the package does not ship one` }
  }
  const select = exportName(name, new Set(library.names()))
  const target = path.join(library.home, `${select}.yaml`)
  let source: string
  try {
    source = readFileSync(theme.path, 'utf8')
  } catch (error) {
    return { ok: false, problem: `themes: cannot read ${theme.path}: ${message(error)}` }
  }
  try {
    mkdirSync(library.home, { recursive: true })
    // Exclusive, so a file that appeared between the listing and this write is
    // never the one that gets clobbered.
    writeFileSyncExclusive(target, provenance(name) + source)
  } catch (error) {
    return { ok: false, problem: `themes: cannot write ${target}: ${message(error)}` }
  }
  return { ok: true, path: target, select }
}

/**
 * Read every theme the surface can draw.
 *
 * Hand-edited files can be malformed during a save. Omit unreadable or invalid
 * themes and collect notices so other valid themes remain usable; settings can
 * fall back when the selected theme no longer loads. No previous snapshot is kept.
 */
export function loadThemes(homeDir: string, builtinDir: string): ThemeLibrary {
  const problems: string[] = []
  const themes = new Map<string, LoadedTheme>()
  const builtinFiles = readThemeFiles(builtinDir, problems)
  for (const file of builtinFiles) {
    const theme = readThemeFile(file, true, problems)
    if (theme !== undefined) themes.set(theme.name, theme)
  }
  // Reserved from the files the package ships, not from the ones that parsed: a
  // broken built-in must not hand its name to a reader's file for the session it
  // takes to fix it.
  const reserved = new Set(builtinFiles.map(file => file.stem))
  for (const file of readThemeFiles(homeDir, problems)) {
    if (reserved.has(file.stem)) {
      problems.push(
        `themes: ${file.path}: "${file.stem}" is a built-in theme; rename the file and select that name`
        + ` — for example "${file.stem}_export_1.yaml"`,
      )
      continue
    }
    const theme = readThemeFile(file, false, problems)
    if (theme !== undefined) themes.set(theme.name, theme)
  }
  // Group copyable package starting points before user layers for easier scanning
  // in pickers and notices. Name ordering serves readers, not cross-locale stability.
  const list = [...themes.values()].sort((left, right) =>
    (left.builtin === right.builtin ? 0 : left.builtin ? -1 : 1) || left.name.localeCompare(right.name))
  return {
    home: homeDir,
    list: () => list,
    names: () => list.map(theme => theme.name),
    get: name => (name === undefined ? undefined : themes.get(name)),
    problems: () => problems,
  }
}

/**
 * Call `onChange` after a burst of changes settles in a theme directory.
 *
 * The surface owns this watcher through the returned disposer, which closes it
 * and cancels pending reloads at teardown. The watcher uses Node's default
 * persistent lifetime, so disposal is needed to release its process handle.
 */
export function watchThemes(dir: string, onChange: () => void, onNotice: (text: string) => void): () => void {
  let pending: NodeJS.Timeout | undefined
  let watcher: FSWatcher
  try {
    watcher = watch(dir, () => {
      // An editor writes a file more than once — truncate, write, chmod, rename —
      // and each step is an event. Letting the burst finish is what keeps one save
      // from repainting the screen four times.
      if (pending !== undefined) clearTimeout(pending)
      pending = setTimeout(() => {
        pending = undefined
        onChange()
      }, WATCH_DEBOUNCE_MS)
    })
  } catch (error) {
    // Keep the loaded snapshot usable; deferred notices remain readable after startup.
    if (asRecord(error)?.code !== MISSING_THEME_HOME_CODE) onNotice(WATCH_SETUP_NOTICE)
    return () => {}
  }
  // A directory removed under a running session stops the watcher; reloading once
  // is what lets the library drop the themes that went with it.
  watcher.on('error', () => { onChange() })
  return () => {
    if (pending !== undefined) clearTimeout(pending)
    watcher.close()
  }
}

/** The theme files one directory holds, one per name, in name order. */
function readThemeFiles(dir: string, problems: string[]): ThemeFile[] {
  let names: string[]
  try {
    // Linked themes can live outside this directory without requiring a local copy.
    names = readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile() || entry.isSymbolicLink())
      .map(entry => entry.name)
  } catch (error) {
    // The reader's directory is created at start-up and the package's is shipped,
    // so a missing one draws the built-in table and says nothing: reporting it
    // would greet every reader who has never written a theme with a fault.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') problems.push(`themes: ${dir}: ${message(error)}`)
    return []
  }
  // Resolve each name once so lookup and preview cannot disagree over duplicate
  // suffixes; report the unused file without making the chosen file unavailable.
  const byStem = new Map<string, ThemeFile>()
  for (const name of names) {
    // Keep private dotfiles out of the selectable theme-name namespace.
    if (name.startsWith('.')) continue
    const stem = stemOf(name)
    if (stem === undefined) continue
    const file: ThemeFile = { stem, path: path.join(dir, name), rank: extensionRank(name) }
    const held = byStem.get(stem)
    if (held === undefined || file.rank < held.rank) {
      if (held !== undefined) problems.push(`themes: ${held.path}: ignored; ${file.path} is the file in use`)
      byStem.set(stem, file)
    } else {
      problems.push(`themes: ${file.path}: ignored; ${held.path} is the file in use`)
    }
  }
  return [...byStem.values()].sort((left, right) => left.stem.localeCompare(right.stem))
}

/** Read and validate one theme file, or say what is wrong with it. */
function readThemeFile(file: ThemeFile, builtin: boolean, problems: string[]): LoadedTheme | undefined {
  let source: string
  try {
    if (statSync(file.path).size > MAX_THEME_FILE_BYTES) {
      problems.push(`themes: ${file.path}: larger than ${MAX_THEME_FILE_BYTES} bytes; not read`)
      return undefined
    }
    source = readFileSync(file.path, 'utf8')
  } catch (error) {
    problems.push(`themes: ${file.path}: ${message(error)}`)
    return undefined
  }
  let document: unknown
  try {
    document = parseYaml(source)
  } catch (error) {
    problems.push(`themes: ${file.path}: ${message(error)}`)
    return undefined
  }
  // An empty document supplies no overrides: as a valid empty layer it leaves
  // the shipped appearance and higher-priority settings in force.
  if (document === null || document === undefined) {
    return { name: file.stem, path: file.path, builtin, palette: {}, tokens: {} }
  }
  const body = asRecord(document)
  if (body === undefined) {
    problems.push(`themes: ${file.path}: a theme is a mapping of "palette" and "tokens"`)
    return undefined
  }
  // Refuse unknown names before shared value validation: the schema preserves
  // undeclared keys, so typos would otherwise parse without affecting the screen.
  // Shared validators keep drawable styles consistent with settings.
  const unknownSections = Object.keys(body).filter(key => !THEME_SECTIONS.has(key))
  if (unknownSections.length > 0) {
    problems.push(`themes: ${file.path}: unknown ${plural('section', unknownSections)}: ${unknownSections.join(', ')}`)
    return undefined
  }
  const unknownTokens = unknownNames(body.tokens, TOKEN_NAME_SET)
  if (unknownTokens.length > 0) {
    problems.push(`themes: ${file.path}: unknown ${plural('element', unknownTokens)}: ${unknownTokens.join(', ')}`)
    return undefined
  }
  const unknownPalette = unknownNames(body.palette, PALETTE_NAME_SET)
  if (unknownPalette.length > 0) {
    problems.push(`themes: ${file.path}: unknown ${plural('palette entry', unknownPalette, 'palette entries')}: ${unknownPalette.join(', ')}`)
    return undefined
  }
  try {
    return {
      name: file.stem,
      path: file.path,
      builtin,
      palette: writtenPalette(body.palette),
      tokens: writtenTokens(body.tokens),
    }
  } catch (error) {
    problems.push(`themes: ${file.path}: ${message(error)}`)
    return undefined
  }
}

/** The reference line an exported copy carries. */
function provenance(name: string): string {
  const version = packageVersion()
  const release = version === undefined ? '' : ` ${version}`
  return `# exported from ${name} by dsh-tui${release} — this file is yours: edit it, then select it by name.\n`
}

/**
 * This package's version, read rather than compiled in.
 *
 * A fork of a built-in is only diagnosable against the release that produced it,
 * and the version is the one thing the sources do not know. An unreadable manifest
 * is not a failure: the line just says less.
 */
function packageVersion(): string | undefined {
  try {
    const manifest = asRecord(JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')))
    return typeof manifest?.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

/** Write a file only if nothing is at that path already. */
function writeFileSyncExclusive(target: string, body: string): void {
  writeFileSync(target, body, { flag: 'wx' })
}

/** The name a file would answer to, or undefined when it is not a theme file. */
function stemOf(fileName: string): string | undefined {
  const rank = extensionRank(fileName)
  const extension = THEME_EXTENSIONS[rank]
  if (extension === undefined) return undefined
  const stem = fileName.slice(0, -extension.length)
  return stem === '' ? undefined : stem
}

/** Where a file name sits among the extensions a theme may carry; -1 when it has none. */
function extensionRank(fileName: string): number {
  return THEME_EXTENSIONS.findIndex(extension => fileName.endsWith(extension))
}

/** One sentence out of an error, for a notice that has one line. */
function message(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0] ?? String(error) : String(error)
}

/** A count and its noun, so a refusal reads as a sentence either way. */
function plural(noun: string, names: readonly string[], many = `${noun}s`): string {
  return names.length === 1 ? noun : many
}
