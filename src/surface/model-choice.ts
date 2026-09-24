import type { Context } from '@deepseek-ai/cordis'
import {
  ModelSwitch,
  createModelCatalog,
  parseModelArgument,
  readModelRouteKey,
  // agent/model.ts names the reader's choice `ModelChoice`, which is this
  // module's own owner; the type arrives here as the route it describes.
  type ModelChoice as ChosenRoute,
  type ModelRoute,
} from '../agent/model.ts'
import type { Keymap } from '../input/actions.ts'
import { EffortPicker, ModelPicker, PROVIDER_DEFAULT_EFFORT_ID, effortChoices } from '../ui/picker.ts'
import type { StatusFacts } from '../ui/status.ts'
import type { Picker } from './modal-input.ts'

/**
 * What the route owner needs from the surface that composes it.
 *
 * The facts are settings-backed and read at call time: the composition default
 * this owner adopts before the first turn, and reports when the reader named no
 * route, exists only once the settings document has been read. The keys move
 * with a settings edit, so they are read per press, and the screen, the notice
 * and the keyboard lifetime belong to the surface that owns them.
 */
export interface ModelChoicePorts {
  readonly statusFacts: () => StatusFacts
  readonly keymap: () => Keymap
  /** Take the keyboard for a list and answer with the pick id it settled on. */
  readonly openPicker: (picker: Picker) => Promise<string | undefined>
  readonly notice: (message: string) => void
  readonly render: () => void
}

/** The reads and operations the composing surface routes to the route owner. */
export interface ModelChoice {
  /** The route the next step would use, which is what the status line states. */
  readonly current: () => ChosenRoute | undefined
  /**
   * Compose the switch into an agent's own scope, where its waterfalls dispatch.
   *
   * The scope arrives as an argument because it belongs to the agent being
   * opened: the surface has no handle to it until that agent has started, and
   * the route has to be in force from its first step.
   */
  readonly setup: (agentCtx: Context) => void
  /** Put the deployment default in force, unless the reader already named a route. */
  readonly adoptDefault: () => void
  /** Show the route in force, or switch to another one. */
  readonly runModelCommand: (argument: string) => void
  /** Offer the levels the route in force advertises. */
  readonly openEffortPicker: () => void
}

/**
 * Which model and reasoning effort this session runs with, and the two pickers
 * that change them.
 *
 * The switch and the catalog are one owner because a choice only means
 * something against the directory it was read from: the rows of the model list
 * stream in as each provider's adapter answers, and the levels belong to the
 * exact route. The route in force is resolved against the status facts as much
 * as against the switch, because a session that has chosen nothing runs the
 * settings-backed default the footer states.
 */
export function createModelChoice(ctx: Context, ports: ModelChoicePorts): ModelChoice {
  const modelSwitch = new ModelSwitch()
  const catalog = createModelCatalog(ctx)

  const runModelCommand = (argument: string): void => {
    if (catalog === undefined) {
      ports.notice('this profile has no llm service, so models cannot be listed or switched')
      ports.render()
      return
    }
    const command = parseModelArgument(argument, catalog.providers(), modelSwitch.current())
    switch (command.kind) {
      case 'current':
        // Choosing by eye is the point of a terminal selector; the picker
        // heads itself with the route the next step will actually use.
        void openModelPicker()
        return
      case 'list-models':
        void catalog.models(command.provider).then(entries => {
          ports.notice(entries.length === 0
            ? `${command.provider} advertises no models; an id may still work`
            : `${command.provider}: ${entries.map(entry => entry.id).join(' ')}`)
          ports.render()
        }).catch((error: unknown) => {
          ports.notice(`could not list models: ${error instanceof Error ? error.message : String(error)}`)
          ports.render()
        })
        return
      case 'switch': {
        const choice = command.choice
        if (choice.reasoningEffort === undefined) {
          modelSwitch.choose(choice)
          ports.notice(`model set to ${choice.provider}/${choice.model} for the next step`)
          ports.render()
          return
        }
        // The route decides which efforts exist, so an explicit one is checked
        // against the adapter before it is put in force: a typo must not become
        // a request the provider rejects.
        void (async () => {
          try {
            const info = await catalog.efforts(choice.provider, choice.model)
            const efforts = info?.efforts ?? []
            if (!efforts.some(effort => effort.id === choice.reasoningEffort)) {
              ports.notice(efforts.length === 0
                ? `/model: ${choice.provider}/${choice.model} advertises no reasoning efforts`
                : `/model: ${choice.provider}/${choice.model} does not offer reasoning effort "${choice.reasoningEffort}" — offers: ${efforts.map(effort => effort.id).join(' ')}`)
              ports.render()
              return
            }
            modelSwitch.choose(choice)
            ports.notice(`model set to ${choice.provider}/${choice.model} (${choice.reasoningEffort}) for the next step`)
          } catch (error) {
            ports.notice(`/model: could not read reasoning efforts: ${error instanceof Error ? error.message : String(error)}`)
          }
          ports.render()
        })()
        return
      }
      case 'invalid':
        ports.notice(`/model: ${command.reason}`)
        ports.render()
        return
    }
  }

  /** Whether a route's effort list is being read, so a second key cannot race it. */
  let openingEfforts = false

  /** Put the reader's effort choice in force for the next step. */
  const applyEffort = (provider: string, modelId: string, effortId: string): void => {
    modelSwitch.choose(effortId === PROVIDER_DEFAULT_EFFORT_ID
      ? { provider, model: modelId }
      : { provider, model: modelId, reasoningEffort: effortId })
    ports.notice(`reasoning effort for ${provider}/${modelId} set to ${effortId === PROVIDER_DEFAULT_EFFORT_ID ? 'provider default' : effortId} for the next step`)
    ports.render()
  }

  /** Whether a model picker's catalog is being read, so a second key cannot race it. */
  let openingModels = false

  /** One route, as the picker names it; the effort is not part of the choice here. */
  type PickedRoute = { readonly provider: string; readonly model: string }

  /**
   * The route the next step would actually use.
   *
   * Without a choice of its own the surface reports the composition default,
   * not that it has no opinion: the picker's heading and its marked row have to
   * agree with the status line about the route in force.
   */
  const effectiveRoute = (): ChosenRoute | undefined => {
    const chosen = modelSwitch.current()
    if (chosen !== undefined) return chosen
    const facts = ports.statusFacts()
    if (facts.provider === undefined || facts.model === undefined) return undefined
    return {
      provider: facts.provider,
      model: facts.model,
      ...facts.effort === undefined ? {} : { reasoningEffort: facts.effort },
    }
  }

  /** Put the reader's route choice in force for the next step. */
  const applyRoute = (route: PickedRoute): void => {
    const current = effectiveRoute()
    // The levels belong to the route, so a switch clears an explicit effort
    // while re-picking the route already in force is not a switch.
    const keep = current !== undefined && current.provider === route.provider && current.model === route.model
      ? current.reasoningEffort
      : undefined
    modelSwitch.choose({
      provider: route.provider,
      model: route.model,
      ...keep === undefined ? {} : { reasoningEffort: keep },
    })
    ports.notice(`model set to ${route.provider}/${route.model} for the next step`)
    ports.render()
  }

  /**
   * Offer the levels a route advertises, after the route is already in force.
   *
   * Cancelling the list is a real choice — the reader keeps the model with the
   * provider's own default — which is why the route is applied first. The list
   * is read before the picker opens because the rows are the route's own
   * metadata; a menu painted before that arrived could offer a level the
   * request would then be refused for.
   */
  const offerRouteEfforts = async (route: PickedRoute): Promise<void> => {
    if (catalog === undefined) return
    try {
      const info = await catalog.efforts(route.provider, route.model)
      const efforts = info?.efforts ?? []
      if (efforts.length === 0) return
      const current = effectiveRoute()
      const effective = current !== undefined && current.provider === route.provider && current.model === route.model
        ? current.reasoningEffort
        : undefined
      const picked = await ports.openPicker(new EffortPicker(
        () => effortChoices(efforts, effective),
        `reasoning effort · ${route.provider}/${route.model}`,
        ports.keymap,
      ))
      if (picked !== undefined) applyEffort(route.provider, route.model, picked)
    } catch (error) {
      ports.notice(`could not read reasoning efforts: ${error instanceof Error ? error.message : String(error)}`)
    }
    ports.render()
  }

  /**
   * Offer every model the configured routes advertise.
   *
   * Rows come from the routes the llm service registered — the providers this
   * deployment configured — and each provider's models join the open list as
   * its catalog resolves, so the picker is filterable before the slowest
   * adapter answers. A route whose catalog cannot be read stays reachable by
   * name through the text form rather than by an explanation in the list.
   */
  const openModelPicker = async (): Promise<void> => {
    if (catalog === undefined) {
      ports.notice('this profile has no llm service, so models cannot be listed or switched')
      ports.render()
      return
    }
    const providers = catalog.providers()
    if (providers.length === 0) {
      ports.notice('no provider is configured; add one before choosing a model')
      ports.render()
      return
    }
    if (openingModels) return
    openingModels = true
    try {
      const routes: ModelRoute[] = []
      for (const provider of providers) {
        void catalog.models(provider.id).then(entries => {
          if (entries.length === 0) return
          routes.push(...entries.map(entry => ({ provider: provider.id, model: entry.id, name: entry.name })))
          ports.render()
        }).catch(() => {
          // One adapter's discovery failure is not the list's to explain.
        })
      }
      const picked = await ports.openPicker(new ModelPicker(() => routes, effectiveRoute, ports.keymap))
      if (picked === undefined) return
      const route = readModelRouteKey(picked)
      if (route === undefined) return
      applyRoute(route)
      await offerRouteEfforts(route)
    } finally {
      openingModels = false
      ports.render()
    }
  }

  /**
   * Offer the efforts the route in force advertises.
   *
   * The list is read before the picker opens because the rows are the route's
   * own metadata; a menu painted before that arrived could offer a level the
   * request would then be refused for.
   */
  const openEffortPicker = async (): Promise<void> => {
    if (catalog === undefined) {
      ports.notice('this profile has no llm service, so reasoning efforts cannot be read')
      ports.render()
      return
    }
    const facts = ports.statusFacts()
    if (facts.provider === undefined || facts.model === undefined) {
      ports.notice('no model route is in use; /model <provider>/<model> picks one first')
      ports.render()
      return
    }
    if (openingEfforts) return
    openingEfforts = true
    try {
      const info = await catalog.efforts(facts.provider, facts.model)
      const efforts = info?.efforts ?? []
      if (efforts.length === 0) {
        ports.notice(`${facts.provider}/${facts.model} advertises no reasoning efforts`)
        return
      }
      const picked = await ports.openPicker(new EffortPicker(
        () => effortChoices(efforts, facts.effort),
        `reasoning effort · ${facts.provider}/${facts.model}`,
        ports.keymap,
      ))
      if (picked !== undefined) applyEffort(facts.provider, facts.model, picked)
    } catch (error) {
      ports.notice(`could not read reasoning efforts: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      openingEfforts = false
      ports.render()
    }
  }

  /**
   * Put the deployment default in force before the first turn.
   *
   * The agent is created before the settings file has been read, so the route
   * its loop captured is the composition placeholder; the reader's default —
   * effort included — only exists by the time they can type. Adopting it here
   * is what makes the status line's route the one the request actually uses.
   */
  const adoptDefault = (): void => {
    if (modelSwitch.current() !== undefined) return
    const facts = ports.statusFacts()
    if (facts.provider === undefined || facts.model === undefined) return
    modelSwitch.adopt({
      provider: facts.provider,
      model: facts.model,
      ...(facts.effort === undefined ? {} : { reasoningEffort: facts.effort }),
    })
  }

  return {
    current: () => modelSwitch.current(),
    setup: agentCtx => modelSwitch.install(agentCtx),
    adoptDefault,
    runModelCommand,
    openEffortPicker: () => {
      void openEffortPicker()
    },
  }
}
