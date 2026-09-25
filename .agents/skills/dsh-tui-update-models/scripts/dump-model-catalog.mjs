#!/usr/bin/env node
/**
 * Print the model directory a dsh profile resolves, with the provenance of
 * every field.
 *
 * The surface reads prices, context windows, and reasoning levels from the
 * composition, not from the vendor's page, so an inherited or stale value is
 * invisible in the UI. This reads the same two inputs the resolver does - the
 * owned catalog in the profile patch, and the installed pi-ai provider data -
 * and names where each number came from: "installed" for the source's own
 * entry, "template:<id>" for a clone, "metadata" for what the catalog declares.
 *
 * Usage: dump-model-catalog.mjs [--home <dsh home>] [--profile <name>] [--json]
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** The levels pi-ai offers: a null mapping removes one, and xhigh/max need one. */
function supportedLevels(levelMap) {
  return LEVELS.filter((level) => {
    const mapped = levelMap?.[level]
    if (mapped === null) return false
    if (level === 'xhigh' || level === 'max') return mapped !== undefined
    return true
  })
}

function parseArgs(argv) {
  const options = { home: process.env.DSH_HOME ?? join(homedir(), '.dsh'), profile: 'tui', json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--json') options.json = true
    else if (flag === '--home') options.home = argv[++index]
    else if (flag === '--profile') options.profile = argv[++index]
    else throw new Error('unknown argument ' + flag)
  }
  return options
}

/** The pi-ai data directory of the harness install the launcher belongs to. */
function dataDirectory() {
  const bin = execFileSync('sh', ['-c', 'command -v dsh'], { encoding: 'utf8' }).trim()
  const root = join(realpathSync(bin), '..', '..')
  return join(root, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'data')
}

/** Every JSON patch entry that configures the owned catalog, last one winning. */
function catalogConfig(patch) {
  const lines = readFileSync(patch, 'utf8').split('\n')
  let catalog
  for (const line of lines) {
    if (!line.startsWith('- {') || !line.includes('"catalog"')) continue
    const entry = JSON.parse(line.slice(2))
    if (entry.config?.catalog !== undefined) catalog = entry.config.catalog
  }
  return catalog
}

function providerData(directory, source) {
  try {
    return JSON.parse(readFileSync(join(directory, source + '.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/** Look one id up across a provider's api maps; an api in the spec disambiguates. */
function lookup(data, id, api) {
  if (data === undefined) return undefined
  const maps = api === undefined ? Object.entries(data) : Object.entries(data).filter(([key]) => key === api)
  for (const [, models] of maps) if (models[id] !== undefined) return models[id]
  for (const [key, models] of Object.entries(data)) if (api === undefined && models[id] !== undefined) return { ...models[id], api: key }
  return undefined
}

function resolve(spec, data) {
  const api = spec.metadata?.api
  const cloneOf = spec.template ?? spec.id
  const base = lookup(data, cloneOf, api)
  if (base === undefined) {
    return { error: 'no source entry for ' + cloneOf + (spec.template === undefined ? '; declare a template or metadata' : '') }
  }
  const metadata = spec.metadata ?? {}
  const merged = { ...base, ...metadata, id: spec.id, name: spec.name ?? base.name }
  const maxTokens = metadata.maxTokens ?? spec.defaultMaxTokens ?? base.maxTokens
  const origins = {}
  for (const field of ['contextWindow', 'maxTokens', 'cost', 'input', 'reasoning', 'thinkingLevelMap', 'api']) {
    const declared = field === 'maxTokens' ? metadata.maxTokens ?? spec.defaultMaxTokens : metadata[field]
    origins[field] = declared !== undefined ? 'metadata' : spec.template !== undefined ? 'template:' + spec.template : 'installed'
  }
  return { model: merged, maxTokens, origins, levels: supportedLevels(merged.thinkingLevelMap) }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const patch = join(options.home, 'profiles', options.profile, 'cordis.patch.yml')
  const catalog = catalogConfig(patch)
  if (catalog === undefined) {
    process.stderr.write('no owned catalog in ' + patch + '\n'
      + 'this profile wires models another way; see references/model-wiring.md\n')
    process.exit(1)
  }
  const directory = dataDirectory()
  const rows = []
  let unresolved = 0
  for (const provider of catalog.providers) {
    const data = providerData(directory, provider.source)
    for (const spec of provider.models) {
      const result = resolve(spec, data)
      if (result.error !== undefined) {
        unresolved += 1
        rows.push({ route: provider.id + '/' + spec.id, error: result.error })
        continue
      }
      const cost = result.model.cost ?? {}
      rows.push({
        route: provider.id + '/' + spec.id,
        name: result.model.name,
        api: result.model.api,
        contextWindow: result.model.contextWindow,
        maxTokens: result.maxTokens,
        cost: '$' + [cost.input, cost.output, cost.cacheRead, cost.cacheWrite].join('/') + ' per 1M',
        levels: result.levels.join(','),
        origins: Object.entries(result.origins).filter(([, origin]) => origin !== 'installed').map(([field, origin]) => field + '=' + origin).join(' ') || 'all installed',
      })
    }
  }
  if (options.json) process.stdout.write(JSON.stringify({ default: catalog.default, rows }, null, 2) + '\n')
  else {
    for (const row of rows) {
      if (row.error !== undefined) process.stdout.write(row.route + '\n  UNRESOLVED: ' + row.error + '\n')
      else process.stdout.write(row.route + '\n  ' + row.name + ' | ' + row.api + ' | ctx ' + row.contextWindow
        + ' | max ' + row.maxTokens + ' | ' + row.cost + ' | efforts ' + row.levels + '\n  inherited: ' + row.origins + '\n')
    }
    process.stdout.write('default: ' + JSON.stringify(catalog.default) + '\n')
  }
  process.exit(unresolved === 0 ? 0 : 1)
}

main()
