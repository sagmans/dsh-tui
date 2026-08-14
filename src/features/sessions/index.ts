import type { Context } from '@deepseek-ai/cordis'
import type { BaseRenderable, CliRenderer } from '@opentui/core'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { TuiCommandLayer } from '../../contracts/commands.js'
import type { TuiTheme } from '../../contracts/theme.js'
import { createSessionsView } from '../../views/sessions/root.js'
import {
  createSessionsController,
  type SessionsController,
  type SessionsControllerOptions,
} from './model.js'

const SESSIONS_CONTRIBUTION_ID = 'dsh-tui-sessions'
const SESSIONS_CONTRIBUTION_ORDER = 100
const SESSIONS_COMMAND_LAYER_ID = 'dsh-tui-sessions'
const SESSIONS_CONFIRM_LAYER_ID = 'dsh-tui-sessions-confirm'
const SESSIONS_COMMAND_PRIORITY = 300
const SESSIONS_CONFIRM_PRIORITY = 400
const SESSION_BINDING_ERROR = 'selected session is not locally addressable'
const SESSIONS_BINDINGS: TuiCommandLayer['bindings'] = Object.freeze([
  { key: 'j', command: 'sessions.next' },
  { key: 'down', command: 'sessions.next' },
  { key: 'ctrl+n', command: 'sessions.next' },
  { key: 'k', command: 'sessions.previous' },
  { key: 'up', command: 'sessions.previous' },
  { key: 'ctrl+p', command: 'sessions.previous' },
  { key: 'return', command: 'sessions.accept' },
  { key: 'g', command: 'sessions.group-mode' },
  { key: 's', command: 'sessions.order-mode' },
  { key: 'u', command: 'sessions.unread' },
  { key: 'n', command: 'sessions.new' },
  { key: '/', command: 'sessions.search' },
  { key: 'r', command: 'sessions.rename' },
  { key: 'f', command: 'sessions.fork' },
  { key: 'x', command: 'sessions.archive' },
  { key: 'c', command: 'sessions.close' },
  { key: 'h', command: 'sessions.load-older' },
  { key: 'shift+up', command: 'sessions.move-up' },
  { key: 'shift+down', command: 'sessions.move-down' },
  { key: 'a', command: 'sessions.add-workspace' },
  { key: 'delete', command: 'sessions.delete-workspace' },
  { key: 'escape', command: 'sessions.escape' },
])

export const name = 'tui-sessions'
export const inject: readonly string[] = ['tuiKernel', 'tuiClient']

export interface SessionsSeams {
  readonly createController: (options: SessionsControllerOptions) => SessionsController
  readonly createView: (
    renderer: CliRenderer,
    theme: TuiTheme,
    controller: SessionsController,
  ) => BaseRenderable
}

const DEFAULT_SEAMS: SessionsSeams = {
  createController: createSessionsController,
  createView: createSessionsView,
}

function controllerOptions(ctx: Context): SessionsControllerOptions {
  return {
    navigation: ctx.tuiKernel.resources.navigation,
    sessions: {
      list: ctx.tuiClient.sessions.list,
      clear: () => { ctx.tuiClient.sessions.clear() },
      open: id => { ctx.tuiClient.sessions.open(id) },
      search: (query, signal) => ctx.tuiClient.sessions.search(query, signal),
      fork: options => ctx.tuiClient.sessions.fork(options),
      loadOlder: async (id) => {
        const session = ctx.tuiClient.sessions.binding(id)?.session
        if (session === undefined) throw new Error(`${SESSION_BINDING_ERROR}: ${id}`)
        await session.loadOlder()
      },
      rename: async (id, title) => {
        const session = ctx.tuiClient.sessions.binding(id)?.session
        if (session === undefined) throw new Error(`${SESSION_BINDING_ERROR}: ${id}`)
        const result = await session.rename(title)
        if (!result.ok) throw new Error(`session rename failed: ${result.error.code}: ${result.error.message}`)
      },
    },
    workspaces: {
      list: ctx.tuiClient.workspaces.list,
      startSession: id => { ctx.tuiClient.workspaces.startSession(id) },
      create: input => ctx.tuiClient.workspaces.create(input),
      rename: (id, title) => ctx.tuiClient.workspaces.rename(id, title),
      delete: id => ctx.tuiClient.workspaces.delete(id),
      insertBefore: (id, before) => ctx.tuiClient.workspaces.insertBefore(id, before),
      insertSessionBefore: (workspaceId, sessionId, beforeSessionId) => {
        return ctx.tuiClient.workspaces.insertSessionBefore(workspaceId, sessionId, beforeSessionId)
      },
      archiveSession: (id: SessionId) => ctx.tuiClient.workspaces.archiveSession(id),
    },
  }
}

function command(
  commandName: string,
  description: string,
  run: () => void | Promise<void>,
): TuiCommandLayer['commands'][number] {
  return { name: commandName, description, run }
}

function toggleGroupMode(controller: SessionsController): void {
  controller.setGroupMode(controller.getSnapshot().groupMode === 'workspace' ? 'flat' : 'workspace')
}

function toggleOrderMode(controller: SessionsController): void {
  controller.setOrderMode(controller.getSnapshot().orderMode === 'updated' ? 'manual' : 'updated')
}

function confirmationLayer(controller: SessionsController, active: () => boolean): TuiCommandLayer {
  return {
    id: SESSIONS_CONFIRM_LAYER_ID,
    priority: SESSIONS_CONFIRM_PRIORITY,
    active,
    commands: [
      command('sessions.confirm-delete', 'Confirm workspace removal', () => controller.confirmDelete()),
      command('sessions.cancel-delete', 'Cancel workspace removal', () => { controller.cancel() }),
    ],
    bindings: [
      { key: 'return', command: 'sessions.confirm-delete' },
      { key: 'escape', command: 'sessions.cancel-delete' },
    ],
  }
}

function commandLayer(controller: SessionsController, active: () => boolean): TuiCommandLayer {
  return {
    id: SESSIONS_COMMAND_LAYER_ID,
    priority: SESSIONS_COMMAND_PRIORITY,
    active,
    commands: [
      command('sessions.next', 'Select next row', () => { controller.move(1) }),
      command('sessions.previous', 'Select previous row', () => { controller.move(-1) }),
      command('sessions.accept', 'Open or toggle selected row', () => { controller.accept() }),
      command('sessions.group-mode', 'Toggle grouped or flat sessions', () => { toggleGroupMode(controller) }),
      command('sessions.order-mode', 'Toggle manual or last-updated ordering', () => { toggleOrderMode(controller) }),
      command('sessions.unread', 'Select next unread session', () => { controller.moveUnread(1) }),
      command('sessions.new', 'Start session', () => { controller.startSession() }),
      command('sessions.search', 'Search sessions', () => { controller.openInput('search') }),
      command('sessions.rename', 'Rename selected row', () => { controller.openInput('rename') }),
      command('sessions.fork', 'Fork selected session', () => controller.fork()),
      command('sessions.archive', 'Archive selected session', () => controller.archive()),
      command('sessions.close', 'Close current session view', () => { controller.close() }),
      command('sessions.load-older', 'Load older selected-session history', () => controller.loadOlder()),
      command('sessions.move-up', 'Move selected row up', () => controller.moveSelected(-1)),
      command('sessions.move-down', 'Move selected row down', () => controller.moveSelected(1)),
      command('sessions.add-workspace', 'Add workspace path', () => { controller.openInput('create-workspace') }),
      command('sessions.delete-workspace', 'Remove workspace registration', () => { controller.requestDelete() }),
      command('sessions.escape', 'Close input or return to chat', () => { controller.cancel() }),
    ],
    bindings: SESSIONS_BINDINGS,
  }
}

export function mountSessions(ctx: Context, seams: SessionsSeams = DEFAULT_SEAMS): void {
  const resources = ctx.tuiKernel.resources
  const controller = seams.createController(controllerOptions(ctx))
  const disposers: Array<() => void> = []
  try {
    disposers.push(
      resources.slots.register(ctx, {
        id: SESSIONS_CONTRIBUTION_ID,
        order: SESSIONS_CONTRIBUTION_ORDER,
        slots: {
          'route.sessions': () => seams.createView(resources.renderer, resources.theme, controller),
        },
      }),
      resources.commands.register(ctx, commandLayer(
        controller,
        () => resources.navigation.getSnapshot().route === 'sessions'
          && !controller.getSnapshot().confirmDelete
          && (resources.renderer.currentFocusedEditor === null
            || resources.renderer.currentFocusedEditor === undefined),
      )),
      resources.commands.register(ctx, confirmationLayer(
        controller,
        () => resources.navigation.getSnapshot().route === 'sessions'
          && controller.getSnapshot().confirmDelete,
      )),
    )
    ctx.effect(() => () => { controller.dispose() }, 'dsh-tui: sessions controller')
  } catch (error) {
    controller.dispose()
    for (const dispose of disposers.toReversed()) dispose()
    throw error
  }
}

export function apply(ctx: Context): void {
  mountSessions(ctx)
}
