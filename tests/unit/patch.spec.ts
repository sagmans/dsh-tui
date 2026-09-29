import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { resolveConfig } from '@/config.ts'
import { DEFAULT_PRESET } from '@/host/roster.ts'
import { loadPresetDefinitions } from '@/host/preset-files.ts'
import { TUI_STARTUP_SERVICE, name as startupRowName } from '@/startup.ts'

/**
 * The bundle patch is a contract with the profile loader, and nothing else in
 * the test gate reads it: a row deleted by hand, a package renamed, or an option
 * added to the startup service but never forwarded all boot the surface on a
 * different composition than the one a user installs.
 */
const patch = readFileSync(new URL('../../cordis.patch.yml', import.meta.url), 'utf8')

/** Rows this bundle inserts, in patch order, and the package each one mounts. */
const INSERTED_ROWS = [
  ['agent-presets', '@sagmans/dsh-tui/host/roster'],
  ['cordis-host-runner', '@sagmans/dsh-tui/host/runner'],
  ['tui-startup', '@sagmans/dsh-tui/startup'],
  ['tui', '@sagmans/dsh-tui'],
  ['tui-todo-guard', '@sagmans/dsh-tui/todo-guard'],
  ['subagent-model-selection-settings', '@deepseek-ai/dsh-tool-subagent/model-selection-settings'],
] as const

/**
 * Rows whose package mounts other harness packages.
 *
 * The loader applies a patch row before any service exists, so a condition here
 * would be evaluated against an empty container: these rows name a shim of this
 * bundle instead, which mounts once the services it needs are up.
 */
const SHIM_ROWS = ['agent-presets', 'cordis-host-runner']

/** The mode a flagless run joins, which has to be one the roster actually ships. */
const ROSTER_DEFAULT = 'ptc'

/**
 * Row options no launch flag publishes.
 *
 * `theme` is pinned in a profile patch instead: a harness that keeps settings per
 * row has no document section to write a name into, so the row's own config is
 * where the choice travels — and deriving it from the startup service would
 * forward a flag this surface deliberately does not offer. Stash scope also
 * belongs to the profile row rather than the command-line startup service.
 */
const ROW_ONLY_OPTIONS = ['theme', 'stashScope']

interface InsertedRow {
  readonly id: string
  readonly name: string
  /** Everything the patch says about this row, for the option checks below. */
  readonly body: string
}

function insertedRows(text: string): InsertedRow[] {
  const block = text.slice(text.indexOf('\n- insert:'))
  const starts = [...block.matchAll(/^ {4}- id: (\S+)$/gmu)]
  return starts.map((start, index) => {
    const from = start.index ?? 0
    const to = starts[index + 1]?.index ?? block.length
    const body = block.slice(from, to)
    return { id: start[1] ?? '', name: /^ {6}name: '([^']+)'$/mu.exec(body)?.[1] ?? '', body }
  })
}

function requireRow(rows: readonly InsertedRow[], id: string): InsertedRow {
  const found = rows.find(row => row.id === id)
  if (found === undefined) throw new Error(`the patch no longer inserts the "${id}" row`)
  return found
}

/** Option names the row declares, which the loader passes to the plugin's config. */
function configKeys(row: InsertedRow): string[] {
  return [...row.body.matchAll(/^ {8}([A-Za-z][A-Za-z0-9]*): /gmu)].map(match => match[1] ?? '')
}

describe('the bundle patch', () => {
  it('leaves the agent plane the profile composes alone', () => {
    // This bundle serves the surface. Every agent-plane row belongs to the
    // bundle shipping that plugin, so the patch neither mounts nor disables one:
    // touching a row here is what registered a plugin the profile already had.
    expect(patch).not.toMatch(/^- id: /mu)
    expect(patch).not.toContain('disabled: true')
    expect(patch.indexOf('- insert:')).toBeGreaterThan(-1)
  })

  it('inserts the rows this bundle owns, each mounting its own package', () => {
    expect(insertedRows(patch).map(row => [row.id, row.name])).toEqual(INSERTED_ROWS.map(row => [...row]))
  })

  it('forwards every option the startup row publishes', () => {
    const rows = insertedRows(patch)
    const row = requireRow(rows, 'tui')
    expect(requireRow(rows, 'tui-startup').id).toBe(startupRowName)
    expect(row.body).toContain(`inject: [${TUI_STARTUP_SERVICE}]`)
    const keys = configKeys(row)
    const forwarded = Object.keys(resolveConfig({ sessionId: 'patch-spec' }))
      .filter(key => !ROW_ONLY_OPTIONS.includes(key))
    expect(keys.sort()).toEqual(forwarded.sort())
    for (const key of keys) {
      expect(row.body).toContain(`${key}: !!js ctx.${TUI_STARTUP_SERVICE}.${key}`)
    }
  })

  it('starts a flagless run in a mode the roster ships', () => {
    expect(DEFAULT_PRESET).toBe(ROSTER_DEFAULT)
    expect(loadPresetDefinitions().map(definition => definition.id)).toContain(ROSTER_DEFAULT)
  })

  it('leaves every shim row to the shim that mounts what the loader cannot', () => {
    const rows = insertedRows(patch)
    for (const id of SHIM_ROWS) {
      expect(requireRow(rows, id).name).toMatch(/^@sagmans\/dsh-tui\/host\//u)
    }
    // A condition here would be evaluated while no service is up, which is the
    // trap this shape exists to avoid: such a row is skipped and never revisited.
    expect(patch).not.toContain('!!js "typeof ctx.get')
  })

  it('mounts those rows before the surface, which needs the roster while it builds', () => {
    const ids = insertedRows(patch).map(row => row.id)
    for (const id of SHIM_ROWS) expect(ids.indexOf(id)).toBeLessThan(ids.indexOf('tui'))
  })

})
