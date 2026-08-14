import type { Context } from '@deepseek-ai/cordis'
import type { BaseRenderable, CliRenderer } from '@opentui/core'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { TuiCommandLayer } from '../../contracts/commands.js'
import type { TuiTheme } from '../../contracts/theme.js'
import { createConversationView } from '../../views/conversation/root.js'
import { loadTerminalImage } from '../attachments/index.js'
import { exportSessionArchive } from '../export/index.js'
import {
  createConversationController,
  type ConversationController,
  type ConversationControllerOptions,
  type ConversationPreferenceSection,
  type ConversationSessionBinding,
} from './model.js'
import {
  createConversationSubmissionPreferences,
  registerConversationSettings,
} from './submission.js'

const CONTRIBUTION_ID = 'dsh-tui-conversation'
const CONTRIBUTION_ORDER = 100
const COMMAND_LAYER_ID = 'dsh-tui-conversation'
const COMMAND_PRIORITY = 350
const BINDING_ERROR = 'selected session is not locally addressable'
const COMMAND_COMPLETION_ERROR = 'command completion failed'
const SKILL_COMPLETION_ERROR = 'skill completion failed'
const SETTINGS_COMMAND_PREFIX = 'settings.section.'
const MODEL_COMMAND_NAME = 'model'

export const name = 'tui-conversation'
export const inject: readonly string[] = ['tuiKernel', 'tuiClient', 'apiProxy', 'tuiModelSelection', 'tuiInputTrigger']

export interface ConversationSeams {
  readonly createController: (options: ConversationControllerOptions) => ConversationController
  readonly createView: (
    renderer: CliRenderer,
    theme: TuiTheme,
    controller: ConversationController,
  ) => BaseRenderable
}

const DEFAULT_SEAMS: ConversationSeams = {
  createController: createConversationController,
  createView: createConversationView,
}

function requireSession(ctx: Context, id: SessionId) {
  const session = ctx.tuiClient.sessions.binding(id)?.session
  if (session === undefined) throw new Error(`${BINDING_ERROR}: ${id}`)
  return session
}

function sessionBinding(ctx: Context, id: SessionId): ConversationSessionBinding | undefined {
  const session = ctx.tuiClient.sessions.binding(id)?.session
  let binding: ConversationSessionBinding | undefined
  if (session !== undefined) {
    binding = {
      getSnapshot: () => session.getSnapshot(),
      subscribe: listener => session.subscribe(listener),
      cancel: async () => {
        const result = await requireSession(ctx, id).cancel()
        if (!result.ok) throw new Error(`cancel failed: ${result.error.code}: ${result.error.message}`)
      },
      command: async (line) => {
        const result = await requireSession(ctx, id).command(line)
        if (!result.ok) throw new Error(`command failed: ${result.error.code}: ${result.error.message}`)
        return result.value.matched
      },
      loadOlder: () => requireSession(ctx, id).loadOlder(),
      prompt: async (content, mode) => {
        const result = await requireSession(ctx, id).prompt([...content], mode)
        if (!result.ok) throw new Error(`send failed: ${result.error.code}: ${result.error.message}`)
      },
      updateQueue: (itemId, action) => requireSession(ctx, id).updateQueue(itemId, action),
    }
  }
  return binding
}

function controllerOptions(ctx: Context): ConversationControllerOptions {
  const resources = ctx.tuiKernel.resources
  return {
    completion: {
      complete: async (sessionId, query) => {
        const [commands, skills] = await Promise.all([
          ctx.tuiClient.remote.commands.list(sessionId),
          ctx.tuiClient.api.skills.list({ sessionId }),
        ])
        if (!commands.ok) {
          throw new Error(`${COMMAND_COMPLETION_ERROR}: ${commands.error.code}: ${commands.error.message}`)
        }
        if (!skills.result.ok) {
          throw new Error(`${SKILL_COMPLETION_ERROR}: ${skills.result.error.code}: ${skills.result.error.message}`)
        }
        return [...new Set([
          MODEL_COMMAND_NAME,
          ...commands.value.map(command => command.name),
          ...skills.result.value.skills.map(skill => skill.name),
        ])].filter(candidateName => candidateName.startsWith(query)).toSorted((left, right) => left.localeCompare(right))
      },
    },
    openSettings: (section: ConversationPreferenceSection) => {
      resources.navigation.go('settings')
      queueMicrotask(() => { void resources.commands.run(`${SETTINGS_COMMAND_PREFIX}${section}`) })
    },
    models: ctx.tuiModelSelection,
    preferences: createConversationSubmissionPreferences(ctx.tuiClient),
    triggers: ctx.tuiInputTrigger,
    media: {
      exportSession: (sessionId, path, signal) => exportSessionArchive(
        ctx.apiProxy.downloads,
        sessionId,
        path,
        signal,
      ),
      loadImage: (path, signal) => loadTerminalImage(path, signal),
    },
    sessions: {
      list: ctx.tuiClient.sessions.list,
      binding: id => sessionBinding(ctx, id),
    },
  }
}

function commandLayer(controller: ConversationController, active: () => boolean): TuiCommandLayer {
  return {
    id: COMMAND_LAYER_ID,
    priority: COMMAND_PRIORITY,
    active,
    commands: [
      { name: 'conversation.cancel', description: 'Stop active turn', run: () => controller.cancel() },
      { name: 'conversation.older', description: 'Load older history', run: () => controller.loadOlder() },
      { name: 'conversation.scroll-up', description: 'Scroll transcript up', run: () => { controller.scroll(-1) } },
      { name: 'conversation.scroll-down', description: 'Scroll transcript down', run: () => { controller.scroll(1) } },
      { name: 'conversation.attach', description: 'Attach image from absolute local path', run: () => { controller.beginAttachment() } },
      { name: 'conversation.export', description: 'Export session archive to a new local file', run: () => { controller.beginExport() } },
      { name: 'conversation.clear-attachments', description: 'Clear staged image attachments', run: () => { controller.clearAttachments() } },
      { name: 'conversation.access', description: 'Open current and default access presets', run: () => { controller.openPreferences('access') } },
      { name: 'conversation.presets', description: 'Open current and default agent presets', run: () => { controller.openPreferences('presets') } },
    ],
    bindings: [
      { key: 'ctrl+x', command: 'conversation.cancel' },
      { key: 'pageup', command: 'conversation.older' },
      { key: 'ctrl+u', command: 'conversation.scroll-up' },
      { key: 'ctrl+d', command: 'conversation.scroll-down' },
      { key: 'ctrl+o', command: 'conversation.attach' },
      { key: 'ctrl+e', command: 'conversation.export' },
      { key: 'ctrl+delete', command: 'conversation.clear-attachments' },
      { key: 'alt+a', command: 'conversation.access' },
      { key: 'alt+p', command: 'conversation.presets' },
    ],
  }
}

export function mountConversation(ctx: Context, seams: ConversationSeams = DEFAULT_SEAMS): void {
  const resources = ctx.tuiKernel.resources
  const controller = seams.createController(controllerOptions(ctx))
  const disposers: Array<() => void> = []
  try {
    disposers.push(
      resources.slots.register(ctx, {
        id: CONTRIBUTION_ID,
        order: CONTRIBUTION_ORDER,
        slots: {
          'route.chat': () => seams.createView(resources.renderer, resources.theme, controller),
        },
      }),
      resources.commands.register(ctx, commandLayer(
        controller,
        () => resources.navigation.getSnapshot().route === 'chat'
          && (resources.renderer.currentFocusedEditor === null
            || resources.renderer.currentFocusedEditor === undefined),
      )),
    )
    ctx.effect(() => () => { controller.dispose() }, 'dsh-tui: conversation controller')
  } catch (error) {
    controller.dispose()
    for (const dispose of disposers.toReversed()) dispose()
    throw error
  }
}

export function apply(ctx: Context): void {
  registerConversationSettings(ctx)
  mountConversation(ctx)
}
