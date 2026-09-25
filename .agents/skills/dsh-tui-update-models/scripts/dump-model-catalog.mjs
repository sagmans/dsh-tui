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
 * entry, "template:<id>" for a clone, "route" for the protocol a sourceless
 * route declares once for every model it serves, "metadata" for what the
 * catalog declares.
 *
 * An entry the catalog spells out completely needs no installed entry at all,
 * so a missing harness install must not hide it. A `filter` route is the
 * exception: its membership is the installed catalog's, so it cannot be read
 * without that install. A declaration the plugin's resolver would refuse is
 * reported as a refusal here too, because a catalog that cannot compose serves
 * nothing.
 *
 * Usage: dump-model-catalog.mjs [--home <dsh home>] [--profile <name>]
 *                               [--data <pi-ai data dir>] [--json]
 *
 * `--data` names the installed provider-data directory to inherit from, which
 * is how a reading is checked where no harness is installed - a `filter` route
 * and every template clone need one.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
/** Fields a catalog entry may inherit, and the layer each value came from. */
const INHERITED_FIELDS = ['contextWindow', 'maxTokens', 'cost', 'input', 'reasoning', 'thinkingLevelMap', 'api']
/** What a model with no installed sibling and no template must state itself. */
const REQUIRED_METADATA = ['api', 'reasoning', 'input', 'cost', 'contextWindow', 'maxTokens']
const COST_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite']
const INSTALLED = 'installed'
const METADATA = 'metadata'
const ROUTE = 'route'
const ABSENT = 'none'
/** The only wildcard a `filter` pattern carries; every other character is itself. */
const WILDCARD = '*'

/** The levels pi-ai offers: a null mapping removes one, and xhigh/max need one. */
export function supportedLevels(levelMap) {
  return LEVELS.filter((level) => {
    const mapped = levelMap?.[level]
    if (mapped === null) return false
    if (level === 'xhigh' || level === 'max') return mapped !== undefined
    return true
  })
}

function parseArgs(argv) {
  const options = { home: process.env.DSH_HOME ?? join(homedir(), '.dsh'), profile: 'tui', data: undefined, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--json') options.json = true
    else if (flag === '--home') options.home = argv[++index]
    else if (flag === '--profile') options.profile = argv[++index]
    else if (flag === '--data') options.data = argv[++index]
    else throw new Error('unknown argument ' + flag)
  }
  return options
}

/** The pi-ai data directory of the harness install the launcher belongs to. */
function dataDirectory() {
  try {
    const bin = execFileSync('sh', ['-c', 'command -v dsh'], { encoding: 'utf8' }).trim()
    const root = join(realpathSync(bin), '..', '..')
    return join(root, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'data')
  } catch {
    // No harness install is a supported reading: declared entries still resolve.
    return undefined
  }
}

/** Every JSON patch entry that configures the owned catalog, last one winning. */
export function catalogConfig(patch) {
  const lines = readFileSync(patch, 'utf8').split('\n')
  let catalog
  for (const line of lines) {
    if (!line.startsWith('- {') || !line.includes('"catalog"')) continue
    const entry = JSON.parse(line.slice(2))
    if (entry.config?.catalog !== undefined) catalog = entry.config.catalog
  }
  return catalog
}

export function providerData(directory, source) {
  if (directory === undefined || source === undefined) return undefined
  try {
    return JSON.parse(readFileSync(join(directory, source + '.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/** Installed models in the order the source publishes them, one api map at a time. */
function installedModels(data) {
  if (data === undefined) return []
  return Object.entries(data).flatMap(([api, models]) => Object.entries(models)
    .map(([id, model]) => ({ ...model, id, api: model.api ?? api })))
}

/** Mirror the resolver's pattern rule so a filter reads the same here and there. */
function patternToRegExp(pattern) {
  const escaped = pattern.split(WILDCARD).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp('^' + escaped.join('.*') + '$')
}

/** A filter keeps installed facts and order, then drops what exclude names. */
export function expandFilter(data, filter) {
  const include = filter?.include === undefined ? undefined : filter.include.map(patternToRegExp)
  const exclude = filter?.exclude === undefined ? [] : filter.exclude.map(patternToRegExp)
  return installedModels(data)
    .filter(model => (include === undefined || include.some(pattern => pattern.test(model.id)))
      && !exclude.some(pattern => pattern.test(model.id)))
}

/** Look one id up across a provider's api maps; an api in the spec disambiguates. */
function lookup(data, id, api) {
  if (data === undefined) return undefined
  for (const [key, models] of Object.entries(data)) {
    if ((api === undefined || key === api) && models[id] !== undefined) return { ...models[id], api: models[id].api ?? key }
  }
  return undefined
}

function costOf(cost) {
  if (cost === undefined) return undefined
  return '$' + COST_FIELDS.map(field => cost[field]).join('/') + ' per 1M'
}

/** Resolve one catalog entry against the installed data it may inherit from. */
export function resolve(spec, data, routeApi) {
  const metadata = spec.metadata ?? {}
  const declared = Object.keys(metadata).length > 0
  const cloneOf = spec.template ?? spec.id
  const base = lookup(data, cloneOf, metadata.api)
  if (base === undefined && !declared) {
    return { error: 'no source entry for ' + cloneOf + '; declare a template or metadata' }
  }
  const merged = { ...base, ...metadata, id: spec.id, name: spec.name ?? base?.name ?? spec.id }
  // A route that names no source states its protocol once, for every model.
  if (merged.api === undefined && routeApi !== undefined) merged.api = routeApi
  // Capacity and the request default are different numbers, and the resolver
  // caps one by the other: folding them would hide the mistake it refuses.
  const capacity = metadata.maxTokens ?? base?.maxTokens
  const missing = base === undefined
    ? REQUIRED_METADATA.filter(field => field === 'api' ? merged.api === undefined : metadata[field] === undefined)
    : []
  if (missing.length > 0) return { error: 'unknown model requires complete metadata: missing ' + missing.join(', ') }
  if (spec.defaultMaxTokens !== undefined && capacity !== undefined && spec.defaultMaxTokens > capacity) {
    return { error: 'defaultMaxTokens ' + spec.defaultMaxTokens + ' exceeds model maxTokens ' + capacity }
  }
  const origins = {}
  for (const field of INHERITED_FIELDS) {
    if (metadata[field] !== undefined) origins[field] = METADATA
    else if (field === 'api' && base === undefined && routeApi !== undefined) origins[field] = ROUTE
    else if (base === undefined) origins[field] = ABSENT
    else origins[field] = spec.template === undefined ? INSTALLED : 'template:' + spec.template
  }
  return {
    model: { ...merged, maxTokens: capacity },
    origins,
    levels: supportedLevels(merged.thinkingLevelMap),
    ...(spec.defaultMaxTokens === undefined ? {} : { requestMax: spec.defaultMaxTokens }),
    ...(spec.aliases === undefined ? {} : { aliases: spec.aliases.join(',') }),
    ...(metadata.cost?.tiers === undefined ? {} : {
      tiers: metadata.cost.tiers.map(tier => 'above ' + tier.inputTokensAbove + ': ' + costOf(tier)).join('; '),
    }),
  }
}

function rowsOf(catalog, directory) {
  const rows = []
  for (const provider of catalog.providers ?? []) {
    const data = providerData(directory, provider.source)
    const hasModels = 'models' in provider
    const hasFilter = 'filter' in provider
    // The resolver refuses both and neither; saying so here beats serving half.
    if (hasModels === hasFilter) {
      rows.push({ route: provider.id, error: 'declare exactly one of models or filter' })
      continue
    }
    if (hasFilter) {
      if (data === undefined) {
        rows.push({
          route: provider.id,
          error: 'filter expands the installed catalog of source "' + provider.source + '"; no harness install found',
        })
        continue
      }
      for (const model of expandFilter(data, provider.filter)) {
        rows.push({
          route: provider.id + '/' + model.id,
          name: model.name ?? model.id,
          api: model.api,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          cost: costOf(model.cost),
          levels: supportedLevels(model.thinkingLevelMap).join(','),
          origins: 'filter:' + (provider.filter.include ?? [WILDCARD]).join(',') + ' all installed',
        })
      }
      continue
    }
    for (const spec of provider.models ?? []) {
      const result = resolve(spec, data, provider.api)
      const route = provider.id + '/' + spec.id
      if (result.error !== undefined) {
        rows.push({ route, error: result.error })
        continue
      }
      rows.push({
        route,
        name: result.model.name,
        api: result.model.api,
        contextWindow: result.model.contextWindow,
        maxTokens: result.model.maxTokens,
        cost: costOf(result.model.cost),
        levels: result.levels.join(','),
        ...(result.requestMax === undefined ? {} : { requestMax: result.requestMax }),
        ...(result.aliases === undefined ? {} : { aliases: result.aliases }),
        ...(result.tiers === undefined ? {} : { tiers: result.tiers }),
        origins: INHERITED_FIELDS
          .map(field => [field, result.origins[field]])
          .filter(([, origin]) => origin !== INSTALLED)
          .map(([field, origin]) => field + '=' + origin)
          .join(' ') || 'all installed',
      })
    }
  }
  return rows
}

/**
 * The default is part of the catalog, not a comment beside it: the resolver
 * refuses a selection nothing serves, so a reading that skipped it would call a
 * broken catalog readable.
 */
export function checkDefault(catalog, rows) {
  const served = rows.filter(row => row.error === undefined)
  const selection = catalog.default ?? null
  if (served.length === 0) {
    return selection === null ? [] : [{ route: 'default', error: 'an empty catalog requires default null' }]
  }
  if (selection === null || typeof selection !== 'object') {
    return [{ route: 'default', error: 'a served catalog requires a default selection' }]
  }
  const alias = new Map()
  for (const provider of catalog.providers ?? []) {
    for (const model of provider.models ?? []) {
      for (const name of [model.id, ...(model.aliases ?? [])]) alias.set(provider.id + '/' + name, model.id)
    }
  }
  const route = selection.provider + '/' + selection.model
  const canonical = alias.get(route)
  const row = served.find(candidate => candidate.route === selection.provider + '/' + (canonical ?? selection.model))
  if (row === undefined) {
    return [{ route: 'default', error: 'provider/model is outside the managed selection: ' + route }]
  }
  const effort = selection.reasoningEffort
  if (effort !== undefined && !String(row.levels).split(',').includes(effort)) {
    return [{ route: 'default', error: 'effort is not supported by the selected model: ' + effort }]
  }
  return []
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
  const directory = options.data ?? dataDirectory()
  if (directory === undefined) {
    process.stderr.write('no harness install found; entries that inherit from it cannot be checked\n')
  }
  const served = rowsOf(catalog, directory)
  const rows = [...served, ...checkDefault(catalog, served)]
  const unresolved = rows.filter(row => row.error !== undefined).length
  if (options.json) {
    process.stdout.write(JSON.stringify({ default: catalog.default ?? null, rows }, null, 2) + '\n')
  } else {
    for (const row of rows) {
      if (row.error !== undefined) {
        process.stdout.write(row.route + '\n  UNRESOLVED: ' + row.error + '\n')
        continue
      }
      process.stdout.write(row.route + '\n  ' + row.name + ' | ' + row.api + ' | ctx ' + row.contextWindow
        + ' | max ' + row.maxTokens
        + (row.requestMax === undefined ? '' : ' | req ' + row.requestMax)
        + ' | ' + row.cost
        + (row.tiers === undefined ? '' : ' | tiers ' + row.tiers)
        + ' | efforts ' + row.levels
        + (row.aliases === undefined ? '' : ' | aliases ' + row.aliases) + '\n  inherited: ' + row.origins + '\n')
    }
    process.stdout.write('default: ' + JSON.stringify(catalog.default ?? null) + '\n')
  }
  process.exit(unresolved === 0 ? 0 : 1)
}

// Importing the resolver must not run the CLI: the spec reads it that way.
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main()
