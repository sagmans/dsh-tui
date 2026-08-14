import type { TuiTheme } from '../contracts/theme.js'
import {
  BoxRenderable,
  MouseButton,
  RenderableEvents,
  TextAttributes,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
  type Renderable,
} from '@opentui/core'

const RETURN_KEY = 'return'
const SPACE_KEY = 'space'
const TAB_KEY = 'tab'
const INPUT_ACTION_HEIGHT = 1
const INPUT_SAVE_LABEL = '[SAVE]'
const INPUT_CANCEL_LABEL = '[CANCEL]'

type ActionWidth = number | 'auto' | `${number}%`

export interface FocusableActionOptions {
  readonly content: string
  readonly enabled?: boolean
  readonly fg: string
  readonly handleKey?: (key: KeyEvent) => boolean
  readonly height?: number
  readonly id: string
  readonly mutedFg: string
  readonly nextFocus?: () => Renderable | undefined
  readonly previousFocus?: () => Renderable | undefined
  readonly run: () => void
  readonly width?: ActionWidth
}

export interface InputActions {
  readonly root: BoxRenderable
  focusForTab(key: KeyEvent): boolean
}

export interface InputActionsOptions {
  readonly cancel: () => void
  readonly idPrefix: string
  readonly input: Renderable
  readonly save: () => void
}

function focusTarget(key: KeyEvent, options: FocusableActionOptions): Renderable | undefined {
  return key.shift ? options.previousFocus?.() : options.nextFocus?.()
}

function configureActionFocus(action: TextRenderable, enabled: boolean, attributes: number): void {
  action.focusable = enabled
  action.on(RenderableEvents.FOCUSED, () => {
    if (!action.isDestroyed) action.attributes = attributes | TextAttributes.INVERSE
  })
  action.on(RenderableEvents.BLURRED, () => {
    if (!action.isDestroyed) action.attributes = attributes
  })
}

export function createFocusableAction(
  renderer: CliRenderer,
  options: FocusableActionOptions,
): TextRenderable {
  const enabled = options.enabled ?? true
  const attributes = enabled ? TextAttributes.BOLD : TextAttributes.DIM
  const action = new TextRenderable(renderer, {
    id: options.id,
    content: options.content,
    ...options.width === undefined ? {} : { width: options.width },
    ...options.height === undefined ? {} : { height: options.height },
    fg: enabled ? options.fg : options.mutedFg,
    attributes,
    selectable: false,
    onMouseDown(event) {
      // OpenTUI publishes equivalent mouse-button values through separate enum declarations.
      // oxlint-disable-next-line typescript/no-unsafe-enum-comparison
      if (!enabled || event.button !== MouseButton.LEFT) return
      this.focus()
    },
    onMouseUp(event) {
      // OpenTUI publishes equivalent mouse-button values through separate enum declarations.
      // oxlint-disable-next-line typescript/no-unsafe-enum-comparison
      if (!enabled || event.button !== MouseButton.LEFT) return
      event.preventDefault()
      event.stopPropagation()
      options.run()
    },
    onKeyDown(key) {
      if (options.handleKey?.(key) === true) {
        key.preventDefault()
        key.stopPropagation()
        return
      }
      if (key.name === TAB_KEY) {
        const target = focusTarget(key, options)
        if (target === undefined) return
        key.preventDefault()
        key.stopPropagation()
        target.focus()
        return
      }
      if (!enabled || (key.name !== RETURN_KEY && key.name !== SPACE_KEY)) return
      key.preventDefault()
      key.stopPropagation()
      options.run()
    },
  })
  configureActionFocus(action, enabled, attributes)
  return action
}

export function createInputActions(
  renderer: CliRenderer,
  theme: TuiTheme,
  options: InputActionsOptions,
): InputActions {
  const saveAction = createFocusableAction(renderer, {
    content: INPUT_SAVE_LABEL,
    fg: theme.colors.focus,
    height: INPUT_ACTION_HEIGHT,
    id: `${options.idPrefix}-save`,
    mutedFg: theme.colors.muted,
    nextFocus: () => cancelAction,
    previousFocus: () => options.input,
    run: options.save,
    width: '50%',
  })
  const cancelAction = createFocusableAction(renderer, {
    content: INPUT_CANCEL_LABEL,
    fg: theme.colors.muted,
    height: INPUT_ACTION_HEIGHT,
    id: `${options.idPrefix}-cancel`,
    mutedFg: theme.colors.muted,
    nextFocus: () => options.input,
    previousFocus: () => saveAction,
    run: options.cancel,
    width: '50%',
  })
  const root = new BoxRenderable(renderer, {
    id: `${options.idPrefix}-actions`,
    width: '100%',
    height: INPUT_ACTION_HEIGHT,
    flexDirection: 'row',
  })
  root.add(saveAction)
  root.add(cancelAction)
  return {
    root,
    focusForTab(key) {
      if (key.name !== TAB_KEY) return false
      key.preventDefault()
      key.stopPropagation()
      options.input.blur()
      if (key.shift) cancelAction.focus()
      else saveAction.focus()
      return true
    },
  }
}
