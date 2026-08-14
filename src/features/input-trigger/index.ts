import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import {
  createInputTriggerController,
  type InputTriggerController,
  type InputTriggerControllerOptions,
  type InputTriggerPort,
  type InputTriggerSessionState,
} from './model.js'

export const name = 'tui-input-trigger'
export const inject: readonly string[] = ['tuiClient']

declare module '@deepseek-ai/cordis' {
  interface Context {
    readonly tuiInputTrigger: InputTriggerController
  }
}

function listState(ctx: Context): InputTriggerSessionState {
  const state = ctx.tuiClient.sessions.list.getSnapshot()
  const byId: Record<SessionId, InputTriggerSessionState['byId'][SessionId]> = {}
  for (const summary of Object.values(state.byId)) {
    if (summary === undefined) continue
    byId[summary.id] = {
      displayTitle: summary.displayTitle,
      ...summary.parentId === undefined ? {} : { parentId: summary.parentId },
      running: summary.running,
    }
  }
  return { byId, current: state.current }
}

function port(ctx: Context): InputTriggerPort {
  return {
    async commands(sessionId) {
      const result = await ctx.tuiClient.remote.commands.list(sessionId)
      return result.ok
        ? {
            ok: true,
            value: result.value.map(command => ({
              description: command.description,
              ...command.input === undefined ? {} : { inputHint: command.input.hint },
              name: command.name,
            })),
          }
        : { ok: false, error: result.error }
    },
    serializeReference(source, reference, signal) {
      if (signal.aborted) {
        return Promise.reject(signal.reason instanceof Error
          ? signal.reason
          : new Error('reference serialization aborted'))
      }
      switch (source) {
        case 'subagent': return Promise.resolve(`@${reference}`)
        case 'command':
        case 'skill': return Promise.reject(new Error(`${source} does not own serializable references`))
        default: {
          const exhaustive: never = source
          return Promise.reject(new Error(`unknown reference source: ${String(exhaustive)}`))
        }
      }
    },
    async skills(sessionId) {
      const response = await ctx.tuiClient.api.skills.list({ sessionId })
      return response.result.ok
        ? {
            ok: true,
            value: response.result.value.skills.map(skill => ({
              description: skill.description,
              modelInvocable: skill.modelInvocable,
              name: skill.name,
            })),
          }
        : { ok: false, error: response.result.error }
    },
  }
}

function options(ctx: Context): InputTriggerControllerOptions {
  return {
    modelAvailable: sessionId => ctx.tuiClient.sessions.subagentAddress(sessionId) === undefined,
    port: port(ctx),
    sessions: {
      getSnapshot: () => listState(ctx),
      subscribe: listener => ctx.tuiClient.sessions.list.subscribe(listener),
    },
  }
}

export function mountInputTrigger(ctx: Context): InputTriggerController {
  const controller = createInputTriggerController(options(ctx))
  ctx.provide('tuiInputTrigger', controller)
  const disposers = [
    ctx.tuiClient.remote.$on('commands/change', () => { controller.invalidate() }),
    ctx.tuiClient.remote.$on('agent-preset/selected', sessionId => { controller.invalidate(sessionId) }),
    ctx.tuiClient.context.on('connection/reset', () => { controller.invalidate() }),
  ]
  ctx.effect(() => () => {
    for (const dispose of disposers.toReversed()) dispose()
    controller.dispose()
  }, 'dsh-tui: input trigger resources')
  return controller
}

export function apply(ctx: Context): void {
  mountInputTrigger(ctx)
}
