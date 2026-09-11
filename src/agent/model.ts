import { installModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'

/** The route a reader chose for the next step. */
export interface ModelChoice {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** One provider a session may route through. */
export interface ProviderEntry {
  readonly id: string
  readonly name: string
}

/** What a `/model` argument asks the surface to do. */
export type ModelCommand =
  | { readonly kind: 'current' }
  | { readonly kind: 'list-models'; readonly provider: string }
  | { readonly kind: 'switch'; readonly choice: ModelChoice }
  | { readonly kind: 'invalid'; readonly reason: string }

/**
 * Read a `/model` argument.
 *
 * The forms are deliberately unambiguous: a bare argument that names a provider
 * lists that provider's models, `provider/model` switches, and anything else is
 * taken as a model id inside the route already in use, because a reader
 * switching between two models of one provider should not have to repeat it.
 */
export function parseModelArgument(
  argument: string,
  providers: readonly ProviderEntry[],
  current: ModelChoice | undefined,
): ModelCommand {
  const trimmed = argument.trim()
  if (trimmed === '') return { kind: 'current' }
  const slash = trimmed.indexOf('/')
  if (slash > 0 && slash < trimmed.length - 1) {
    return { kind: 'switch', choice: { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) } }
  }
  if (providers.some(provider => provider.id === trimmed)) return { kind: 'list-models', provider: trimmed }
  if (current === undefined) {
    const names = providers.map(provider => provider.id).join(', ')
    return {
      kind: 'invalid',
      reason: `no route in use; say /model <provider>/${trimmed}${names === '' ? '' : ` — providers: ${names}`}`,
    }
  }
  return { kind: 'switch', choice: { provider: current.provider, model: trimmed } }
}

/**
 * Own the reader's model choice for one session.
 *
 * The choice is applied through the agent's own scoped waterfalls, so it takes
 * effect on the next step rather than splitting an in-flight request, and the
 * loop logs its own durable notice when the route actually changes.
 */
export class ModelSwitch {
  private readonly selection: ModelSelectionRef = { current: undefined, assembled: undefined }
  private installed: (() => void) | undefined

  /** Compose the switch into the agent's scope, where the waterfalls are dispatched. */
  install(agentCtx: Context): void {
    this.installed?.()
    this.installed = installModelSelection(agentCtx, this.selection)
  }

  choose(choice: ModelChoice): void {
    this.selection.current = {
      provider: choice.provider,
      model: choice.model,
      ...choice.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: ReasoningEffortId(choice.reasoningEffort) },
    }
  }

  current(): ModelChoice | undefined {
    const current = this.selection.current
    if (current === undefined) return undefined
    return {
      provider: current.provider,
      model: current.model,
      ...current.reasoningEffort === undefined ? {} : { reasoningEffort: String(current.reasoningEffort) },
    }
  }

  /** Forget the choice, so the session returns to the composition default. */
  reset(): void {
    this.selection.current = undefined
    this.selection.assembled = undefined
  }

  dispose(): void {
    this.installed?.()
    this.installed = undefined
  }
}

/** The model directory, described structurally. */
interface LlmDirectory {
  listProviders?(): readonly { readonly id?: string; readonly name?: string }[]
  listModels?(provider: string): Promise<readonly { readonly id?: string; readonly name?: string }[]>
}

/** Read the advisory catalog of routes this composition can reach. */
export function createModelCatalog(ctx: Context): {
  providers(): readonly ProviderEntry[]
  models(provider: string): Promise<readonly { readonly id: string; readonly name: string }[]>
} | undefined {
  const llm = ctx.get('llm') as LlmDirectory | undefined
  if (typeof llm?.listProviders !== 'function') return undefined
  const providers = (): readonly ProviderEntry[] => (llm.listProviders?.() ?? []).flatMap(entry =>
    typeof entry.id === 'string' ? [{ id: entry.id, name: typeof entry.name === 'string' ? entry.name : entry.id }] : [])
  return {
    providers,
    models: async provider => {
      if (typeof llm.listModels !== 'function') return []
      const models = await llm.listModels(provider)
      return models.flatMap(entry => typeof entry.id === 'string'
        ? [{ id: entry.id, name: typeof entry.name === 'string' ? entry.name : entry.id }]
        : [])
    },
  }
}
