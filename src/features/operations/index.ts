import type { Context } from '@deepseek-ai/cordis'
import { BoxRenderable, type BaseRenderable, type CliRenderer } from '@opentui/core'
import type { TuiClientFacade } from '../../client/context.js'
import type { TuiTheme } from '../../contracts/theme.js'
import { createOperationsView } from '../../views/operations/root.js'
import {
  createOperationsController,
  type FeedbackItemView,
  type GoalMutationRequest,
  type OperationsActions,
  type OperationsController,
  type OperationsControllerOptions,
  type OperationsListState,
  type OperationsResult,
  type OperationsSessionsSource,
} from './model.js'
import { operationsOverlayCommands } from './commands.js'

const CONTRIBUTION_ID = 'dsh-tui-operations'
const CONTRIBUTION_ORDER = 300
const GLOBAL_LAYER_ID = 'dsh-tui-operations-global'
const GLOBAL_PRIORITY = 120
const HIDDEN_SIZE = 0
const OPEN_BINDING = '<leader>o'

export const name = 'tui-operations'
export const inject: readonly string[] = ['tuiKernel', 'tuiClient']

export interface OperationsSeams {
  readonly createController: (options: OperationsControllerOptions) => OperationsController
  readonly createView: (
    renderer: CliRenderer,
    theme: TuiTheme,
    controller: OperationsController,
  ) => BaseRenderable
}

const DEFAULT_SEAMS: OperationsSeams = {
  createController: createOperationsController,
  createView: createOperationsView,
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null
}

function listState(client: TuiClientFacade): OperationsListState {
  const state = client.sessions.list.getSnapshot()
  const byId: Record<string, OperationsListState['byId'][string]> = {}
  for (const summary of Object.values(state.byId)) {
    if (summary === undefined) continue
    const values: unknown = summary.projectionValues
    byId[String(summary.id)] = {
      displayTitle: summary.displayTitle,
      running: summary.running,
      ...summary.origin === undefined ? {} : { origin: summary.origin },
      ...summary.parentId === undefined ? {} : { parentId: summary.parentId },
      ...record(values) ? { projectionValues: values } : {},
    }
  }
  return {
    byId,
    current: state.current,
    jobsBySession: Object.fromEntries(Object.entries(state.jobsBySession)),
    subagentsByParent: Object.fromEntries(Object.entries(state.subagentsByParent)),
  }
}

function sessionsSource(client: TuiClientFacade): OperationsSessionsSource {
  return {
    list: {
      getSnapshot: () => listState(client),
      subscribe: listener => client.sessions.list.subscribe(listener),
    },
    binding(id) {
      const session = client.sessions.binding(id)?.session
      return session === undefined
        ? undefined
        : {
            getSnapshot: () => session.getSnapshot(),
            subscribe: listener => session.subscribe(listener),
            loadOlder: () => session.loadOlder(),
          }
    },
    open: id => { client.sessions.open(id) },
    openSubagent: address => { client.sessions.openSubagent(address) },
    refreshSubagents: id => client.sessions.refreshSubagents(id),
  }
}

function failure(error: { readonly code: string; readonly message: string }): OperationsResult<never> {
  return { ok: false, error: { code: error.code, message: error.message } }
}

function businessFailure(value: unknown): OperationsResult<never> {
  if (!record(value)) return { ok: false, error: { code: 'operation-failed', message: 'Operation failed.' } }
  const code = typeof value.code === 'string' ? value.code : 'operation-failed'
  const current = value.current === null ? null : feedbackItem(value.current)
  return {
    ok: false,
    error: {
      code,
      message: typeof value.message === 'string' ? value.message : code,
      ...current === undefined ? {} : { current },
    },
  }
}

function feedbackItem(value: unknown): FeedbackItemView | undefined {
  if (!record(value)
    || typeof value.messageId !== 'string'
    || (value.rating !== 'positive' && value.rating !== 'negative')
    || typeof value.version !== 'string'
    || typeof value.createdAt !== 'number'
    || typeof value.updatedAt !== 'number'
    || (value.note !== undefined && typeof value.note !== 'string')) {
    return undefined
  }
  // Generated feedback values preserve their opaque wire identities after structural validation.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as unknown as FeedbackItemView
}

async function mutateGoal(
  client: TuiClientFacade,
  request: GoalMutationRequest,
): Promise<OperationsResult<GoalMutationRequest['ref']>> {
  switch (request.kind) {
    case 'edit': return request.objective === undefined
      ? { ok: false, error: { code: 'objective-required', message: 'Goal objective is required.' } }
      : client.remote.goals.edit(request.sessionId, request.ref, { objective: request.objective })
    case 'pause': return client.remote.goals.pause(request.sessionId, request.ref)
    case 'resume': return client.remote.goals.resume(request.sessionId, request.ref)
    case 'complete': return client.remote.goals.complete(request.sessionId, request.ref)
    case 'clear': {
      const result = await client.remote.goals.clear(request.sessionId, request.ref)
      return result.ok ? { ok: true, value: request.ref } : result
    }
    default: {
      const exhaustive: never = request.kind
      return exhaustive
    }
  }
}

function feedbackActions(client: TuiClientFacade): Pick<
  OperationsActions,
  'deleteFeedback' | 'listFeedback' | 'putFeedback'
> {
  return {
    async listFeedback(sessionId) {
      const carried = await client.remote.messageFeedback.list({ sessionId })
      if (!carried.ok) return failure(carried.error)
      if (!carried.value.ok) return businessFailure(carried.value.error)
      const items: FeedbackItemView[] = []
      for (const item of carried.value.value.items) {
        const projected = feedbackItem(item)
        if (projected === undefined) {
          return { ok: false, error: { code: 'invalid-response', message: 'Host returned malformed feedback.' } }
        }
        items.push(projected)
      }
      return { ok: true, value: items }
    },
    async putFeedback(request) {
      const carried = await client.remote.messageFeedback.put({
        sessionId: request.sessionId,
        messageId: request.messageId,
        rating: request.rating,
        ...request.note === undefined ? {} : { note: request.note },
        ifVersion: request.ifVersion,
      })
      if (!carried.ok) return failure(carried.error)
      if (!carried.value.ok) return businessFailure(carried.value.error)
      const item = feedbackItem(carried.value.value)
      return item === undefined
        ? { ok: false, error: { code: 'invalid-response', message: 'Host returned malformed feedback.' } }
        : { ok: true, value: item }
    },
    async deleteFeedback(request) {
      const carried = await client.remote.messageFeedback.delete({
        sessionId: request.sessionId,
        messageId: request.messageId,
        ifVersion: request.version,
      })
      if (!carried.ok) return failure(carried.error)
      return carried.value.ok
        ? { ok: true, value: undefined }
        : businessFailure(carried.value.error)
    },
  }
}

function operationsActions(client: TuiClientFacade): OperationsActions {
  return {
    ...feedbackActions(client),
    mutateGoal: request => mutateGoal(client, request),
    async planOff(sessionId) {
      const session = client.sessions.binding(sessionId)?.session
      if (session === undefined) return { ok: false, error: { code: 'session-unavailable', message: 'Session unavailable.' } }
      const result = await session.command('/plan off')
      return result.ok && result.value.matched
        ? { ok: true, value: undefined }
        : result.ok
          ? { ok: false, error: { code: 'unknown-command', message: '/plan off is unavailable.' } }
          : failure(result.error)
    },
  }
}

function hiddenOverlay(renderer: CliRenderer): BaseRenderable {
  return new BoxRenderable(renderer, { id: 'dsh-tui-operations-hidden', width: HIDDEN_SIZE, height: HIDDEN_SIZE })
}

export function mountOperations(ctx: Context, seams: OperationsSeams = DEFAULT_SEAMS): void {
  const resources = ctx.tuiKernel.resources
  const controller = seams.createController({
    actions: operationsActions(ctx.tuiClient),
    navigation: resources.navigation,
    sessions: sessionsSource(ctx.tuiClient),
  })
  const active = (): boolean => controller.getSnapshot().overlayId !== undefined
    && resources.navigation.getSnapshot().overlays.at(-1)?.id === controller.getSnapshot().overlayId
  const commandActive = (): boolean => active()
    && (resources.renderer.currentFocusedEditor === null || resources.renderer.currentFocusedEditor === undefined)
  const disposers: Array<() => void> = []
  try {
    disposers.push(
      resources.slots.register(ctx, {
        id: CONTRIBUTION_ID,
        order: CONTRIBUTION_ORDER,
        slots: {
          overlay: () => active()
            ? seams.createView(resources.renderer, resources.theme, controller)
            : hiddenOverlay(resources.renderer),
        },
      }),
      resources.commands.register(ctx, {
        id: GLOBAL_LAYER_ID,
        priority: GLOBAL_PRIORITY,
        active: () => !active()
          && (resources.renderer.currentFocusedEditor === null || resources.renderer.currentFocusedEditor === undefined),
        commands: [{ name: 'operations.open', description: 'Open operations', run: () => controller.open() }],
        bindings: [{ key: OPEN_BINDING, command: 'operations.open' }],
      }),
      resources.commands.register(ctx, operationsOverlayCommands(controller, commandActive)),
    )
    ctx.effect(() => () => { controller.dispose() }, 'dsh-tui: operations controller')
  } catch (error) {
    controller.dispose()
    for (const dispose of disposers.toReversed()) dispose()
    throw error
  }
}

export function apply(ctx: Context): void {
  mountOperations(ctx)
}
