import type { Context } from '@deepseek-ai/cordis'
import { createModelCatalog } from './agent/model.ts'

/**
 * Column separator between the route and the display name.
 *
 * A tab keeps the route column machine-splittable for a caller that pipes the
 * output, and a display name is free to contain spaces.
 */
const FIELD_SEPARATOR = '\t'

/** Prefix every refusal carries, so a piped run names the command that failed. */
const FAILURE_PREFIX = 'dsh --profile tui list-models: '

/**
 * The directory slice a listing reads.
 *
 * Structural rather than the catalog's own type so formatting stays free of the
 * llm service; the order and the entries are exactly what the picker reads. A
 * name is optional here because an adapter may advertise a route without one,
 * while the id is always the value a request would name.
 */
export interface ModelListCatalog {
  providers(): readonly { readonly id: string; readonly name: string }[]
  models(provider: string): Promise<readonly { readonly id: string; readonly name?: string }[]>
}

/**
 * Format one line per reachable route, in the picker's own order.
 *
 * The order — registered providers in turn, then each provider's models in the
 * order its adapter answered — is read from the catalog and never re-sorted, so
 * any disagreement with the picker is a catalog disagreement, never a
 * formatting one.
 */
export async function modelListLines(catalog: ModelListCatalog): Promise<string[]> {
  const lines: string[] = []
  for (const provider of catalog.providers()) {
    for (const model of await catalog.models(provider.id)) {
      lines.push(`${provider.id}/${model.id}${FIELD_SEPARATOR}${model.name ?? model.id}`)
    }
  }
  return lines
}

/**
 * Print the model directory to stdout and exit, without touching the terminal.
 *
 * The exit code is the command's contract for a caller that pipes the output:
 * zero only after a line was printed, so a deployment that advertises nothing
 * cannot pass for one that was enumerated.
 */
export async function runModelList(ctx: Context, exit: (code: number) => void): Promise<void> {
  const fail = (message: string): void => {
    process.stderr.write(`${FAILURE_PREFIX}${message}\n`)
    exit(1)
  }
  const catalog = createModelCatalog(ctx)
  if (catalog === undefined) {
    fail('this profile has no llm service, so models cannot be listed')
    return
  }
  let lines: string[]
  try {
    lines = await modelListLines(catalog)
  } catch (error) {
    fail(`could not list models: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  if (lines.length === 0) {
    fail('no configured provider advertises a model')
    return
  }
  process.stdout.write(`${lines.join('\n')}\n`)
  exit(0)
}
