import {
  BoxRenderable,
  SlotRenderable,
  TextAttributes,
  TextRenderable,
  type CliRenderer,
} from '@opentui/core'
import type { ShellController, ShellSnapshot } from '../../features/shell/model.js'
import type { TuiSlots } from '../../contracts/slots.js'
import type { TuiTheme } from '../../contracts/theme.js'
import type { LocaleKey } from '../../locales/en.js'
import type { TuiLocale } from '../../services/locale.js'
import { createFooterActions } from './footer.js'
import { createHelp } from './help.js'
import { createPalette } from './palette.js'
import { createStatusLine } from './status.js'
import { createRouteTabs } from './tabs.js'

const SLOT_ROW_HEIGHT = 1
const ROUTE_SLOT_NAMES = {
  chat: 'route.chat',
  inspect: 'route.inspect',
  sessions: 'route.sessions',
  settings: 'route.settings',
} as const
const ROUTE_LABEL_KEYS = {
  chat: 'shell.route.chat',
  inspect: 'shell.route.inspect',
  sessions: 'shell.route.sessions',
  settings: 'shell.route.settings',
} as const satisfies Readonly<Record<keyof typeof ROUTE_SLOT_NAMES, LocaleKey>>

export interface ShellView {
  readonly root: BoxRenderable
  dispose(): void
}

export interface ShellViewOptions {
  readonly controller: ShellController
  readonly locale: TuiLocale
  readonly renderer: CliRenderer
  readonly slots: TuiSlots
  readonly theme: TuiTheme
}

function createRouteFallback(
  renderer: CliRenderer,
  theme: TuiTheme,
  locale: TuiLocale,
  snapshot: ShellSnapshot,
): BoxRenderable {
  const content = new BoxRenderable(renderer, {
    id: 'shell-route-fallback',
    flexDirection: 'column',
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
  })
  const title = snapshot.activeSessionTitle ?? locale.t(ROUTE_LABEL_KEYS[snapshot.route])
  content.add(new TextRenderable(renderer, {
    content: title,
    fg: theme.colors.text,
    attributes: TextAttributes.BOLD,
    selectable: false,
  }))
  if (snapshot.route === 'chat' && snapshot.activeSessionTitle === undefined) {
    content.add(new TextRenderable(renderer, {
      content: locale.t('shell.emptyChat'),
      fg: theme.colors.muted,
      selectable: false,
    }))
  }
  return content
}

function createChromeSlot(options: ShellViewOptions, snapshot: ShellSnapshot) {
  const registry = options.slots.registry
  if (registry === undefined) throw new Error('TUI core slot registry unavailable')
  return new SlotRenderable(options.renderer, {
    id: 'shell-chrome-slot',
    registry,
    name: 'chrome',
    mode: 'append',
    data: { focused: snapshot.overlay === undefined },
    fallback: () => createRouteTabs(options.renderer, options.theme, options.locale, options.controller),
    height: SLOT_ROW_HEIGHT,
    width: '100%',
  })
}

function createFooterSlot(options: ShellViewOptions) {
  const registry = options.slots.registry
  if (registry === undefined) throw new Error('TUI core slot registry unavailable')
  return new SlotRenderable(options.renderer, {
    id: 'shell-footer-slot',
    registry,
    name: 'footer',
    mode: 'append',
    data: { focused: false },
    fallback: () => createFooterActions(options.renderer, options.theme, options.locale, options.controller),
    flexDirection: 'row',
    height: SLOT_ROW_HEIGHT,
    width: '100%',
  })
}

function createOverlaySlot(options: ShellViewOptions, snapshot: ShellSnapshot) {
  const registry = options.slots.registry
  if (registry === undefined) throw new Error('TUI core slot registry unavailable')
  return new SlotRenderable(options.renderer, {
    id: 'shell-overlay-slot',
    registry,
    name: 'overlay',
    mode: 'append',
    data: { focused: snapshot.overlay !== undefined },
    position: 'absolute',
    width: '100%',
    height: '100%',
  })
}

function createGenericRouteSlot(options: ShellViewOptions, snapshot: ShellSnapshot) {
  const registry = options.slots.registry
  if (registry === undefined) throw new Error('TUI core slot registry unavailable')
  return new SlotRenderable(options.renderer, {
    id: 'shell-generic-route-slot',
    registry,
    name: 'route',
    mode: 'single_winner',
    data: { focused: snapshot.overlay === undefined },
    fallback: () => createRouteFallback(options.renderer, options.theme, options.locale, snapshot),
    width: '100%',
    height: '100%',
  })
}

function createFrame(options: ShellViewOptions): BoxRenderable {
  const { controller, locale, renderer, slots, theme } = options
  const registry = slots.registry
  if (registry === undefined) throw new Error('TUI core slot registry unavailable')
  const snapshot = controller.getSnapshot()
  const frame = new BoxRenderable(renderer, {
    id: 'shell-frame',
    width: '100%',
    height: '100%',
    flexDirection: 'column',
    backgroundColor: theme.colors.background,
  })

  if (!snapshot.zen) frame.add(createChromeSlot(options, snapshot))
  frame.add(createStatusLine(renderer, theme, locale, snapshot, controller))
  frame.add(new SlotRenderable(renderer, {
    id: 'shell-route-slot',
    registry,
    name: ROUTE_SLOT_NAMES[snapshot.route],
    mode: 'single_winner',
    data: { focused: snapshot.overlay === undefined },
    fallback: () => createGenericRouteSlot(options, snapshot),
    flexGrow: 1,
    width: '100%',
  }))
  frame.add(createFooterSlot(options))
  if (snapshot.overlay !== undefined) frame.add(createOverlaySlot(options, snapshot))
  if (snapshot.overlay === 'palette') frame.add(createPalette(renderer, theme, locale, controller))
  if (snapshot.overlay === 'help') frame.add(createHelp(renderer, theme, locale, controller))
  return frame
}

export function mountShellView(options: ShellViewOptions): ShellView {
  const root = new BoxRenderable(options.renderer, {
    id: 'dsh-tui-root',
    width: '100%',
    height: '100%',
    backgroundColor: options.theme.colors.background,
  })
  let frame = createFrame(options)
  root.add(frame)
  const rerender = (): void => {
    const next = createFrame(options)
    root.remove(frame)
    frame.destroyRecursively()
    frame = next
    root.add(frame)
  }
  const unsubscribers = [
    options.controller.subscribe(rerender),
    options.locale.subscribe(rerender),
    options.theme.subscribe(rerender),
  ]
  let disposed = false
  return {
    root,
    dispose() {
      if (disposed) return
      disposed = true
      for (const unsubscribe of unsubscribers.toReversed()) unsubscribe()
      root.destroyRecursively()
    },
  }
}
