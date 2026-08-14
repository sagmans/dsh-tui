import {
  BoxRenderable,
  MouseButton,
  ScrollBoxRenderable,
  TextareaRenderable,
  TextAttributes,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
} from '@opentui/core'
import type { TuiActionSpec } from '../../contracts/actions.js'
import type { TuiTheme } from '../../contracts/theme.js'
import { createInputActions } from '../action.js'
import { SecretInputRenderable } from './secret-input.js'

const OVERLAY_WIDTH = '94%'
const OVERLAY_HEIGHT = '100%'
const OVERLAY_LEFT = '3%'
const OVERLAY_TOP = '0%'
const OVERLAY_Z_INDEX = 105
const ROW_HEIGHT = 1
const TABS_HEIGHT = 1
const DETAILS_HEIGHT = 3
const STATUS_HEIGHT = 1
const INPUT_HEIGHT = 5
const INPUT_EDITOR_HEIGHT = 2
const RETURN_KEY = 'return'
const ESCAPE_KEY = 'escape'
const DEFAULT_CONFIRM_LABEL = 'CONFIRM'
const DEFAULT_DETAILS_TITLE = 'DETAILS'
const DEFAULT_EMPTY_COPY = 'No data for current session.'
const DEFAULT_ERROR_LABEL = 'Error'
const STATE_LABELS: Readonly<Record<CatalogRowState, string>> = Object.freeze({
  error: 'ERR',
  idle: '·',
  running: 'RUN',
  success: 'OK',
  warning: 'WARN',
})

export type CatalogRowState = 'error' | 'idle' | 'running' | 'success' | 'warning'

export type CatalogAction<ActionId extends string> = TuiActionSpec<ActionId>

export interface CatalogRow<ActionId extends string> {
  readonly actions: readonly CatalogAction<ActionId>[]
  readonly details: string
  readonly id: string
  readonly state: CatalogRowState
  readonly summary: string
  readonly title: string
}

export interface CatalogInput {
  readonly title: string
  readonly value: string
  readonly secret?: boolean | undefined
}

export interface CatalogSnapshot<ActionId extends string, Section extends string> {
  readonly busy: boolean
  readonly confirmation: ActionId | undefined
  readonly error: string | undefined
  readonly input: CatalogInput | undefined
  readonly rowIndex: number
  readonly rows: readonly CatalogRow<ActionId>[]
  readonly section: Section
  readonly selectedActionId: ActionId | undefined
  readonly sections: readonly Section[]
  readonly status: string
}

export interface CatalogController<ActionId extends string, Section extends string> {
  cancelInput(): void
  getSnapshot(): CatalogSnapshot<ActionId, Section>
  perform(action?: ActionId): Promise<boolean>
  selectRow(index: number): void
  selectSection(section: Section): void
  setInput(value: string): void
  submitInput(): Promise<boolean>
  subscribe(listener: () => void): () => void
}

export interface CatalogViewConfig<Section extends string> {
  readonly confirmLabel?: string
  readonly detailsTitle?: string
  readonly emptyCopy?: string
  readonly errorLabel?: string
  readonly idPrefix: string
  readonly sectionLabels: Readonly<Record<Section, string>>
  readonly title: string
}

function stateColor(theme: TuiTheme, state: CatalogRowState): string {
  switch (state) {
    case 'error': return theme.colors.danger
    case 'running': return theme.colors.warning
    case 'success': return theme.colors.success
    case 'warning': return theme.colors.warning
    case 'idle': return theme.colors.muted
    default: {
      const exhaustive: never = state
      return String(exhaustive)
    }
  }
}

function createTabs<ActionId extends string, Section extends string>(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: CatalogController<ActionId, Section>,
  snapshot: CatalogSnapshot<ActionId, Section>,
  config: CatalogViewConfig<Section>,
): BoxRenderable {
  const tabs = new BoxRenderable(renderer, {
    id: `${config.idPrefix}-tabs`, width: '100%', height: TABS_HEIGHT, flexDirection: 'row', flexShrink: 0,
  })
  for (const section of snapshot.sections) {
    const selected = section === snapshot.section
    tabs.add(new TextRenderable(renderer, {
      id: `${config.idPrefix}-tab-${section}`,
      content: ` ${config.sectionLabels[section]} `,
      fg: selected ? theme.colors.focus : theme.colors.muted,
      attributes: selected ? TextAttributes.BOLD : TextAttributes.DIM,
      selectable: false,
      onMouseUp(event) {
        // OpenTUI publishes equivalent mouse-button values through separate enum declarations.
        // oxlint-disable-next-line typescript/no-unsafe-enum-comparison
        if (event.button !== MouseButton.LEFT || snapshot.busy) return
        event.preventDefault()
        event.stopPropagation()
        controller.selectSection(section)
      },
    }))
  }
  return tabs
}

function createRows<ActionId extends string, Section extends string>(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: CatalogController<ActionId, Section>,
  snapshot: CatalogSnapshot<ActionId, Section>,
  config: CatalogViewConfig<Section>,
): ScrollBoxRenderable {
  const list = new ScrollBoxRenderable(renderer, {
    id: `${config.idPrefix}-list`, width: '100%', flexGrow: 1, scrollY: true, scrollX: false,
  })
  if (snapshot.rows.length === 0) {
    list.add(new TextRenderable(renderer, {
      content: config.emptyCopy ?? DEFAULT_EMPTY_COPY,
      fg: theme.colors.muted,
      selectable: false,
    }))
    return list
  }
  for (const [index, row] of snapshot.rows.entries()) {
    const selected = index === snapshot.rowIndex
    list.add(new TextRenderable(renderer, {
      id: `${config.idPrefix}-row-${index}`,
      content: `${selected ? '›' : ' '} ${STATE_LABELS[row.state]} ${row.title} · ${row.summary}`,
      height: ROW_HEIGHT,
      fg: selected ? theme.colors.focus : stateColor(theme, row.state),
      attributes: selected ? TextAttributes.BOLD : TextAttributes.NONE,
      truncate: true,
      selectable: false,
      onMouseUp(event) {
        // OpenTUI publishes equivalent mouse-button values through separate enum declarations.
        // oxlint-disable-next-line typescript/no-unsafe-enum-comparison
        if (event.button !== MouseButton.LEFT || snapshot.busy) return
        event.preventDefault()
        event.stopPropagation()
        controller.selectRow(index)
      },
    }))
  }
  return list
}

function createDetails<ActionId extends string, Section extends string>(
  renderer: CliRenderer,
  theme: TuiTheme,
  snapshot: CatalogSnapshot<ActionId, Section>,
  config: CatalogViewConfig<Section>,
): BoxRenderable {
  const row = snapshot.rows[snapshot.rowIndex]
  const frame = new BoxRenderable(renderer, {
    id: `${config.idPrefix}-details`,
    title: row?.title ?? config.detailsTitle ?? DEFAULT_DETAILS_TITLE,
    width: '100%',
    height: DETAILS_HEIGHT,
    flexShrink: 0,
    border: true,
    borderStyle: 'single',
    borderColor: theme.colors.border,
    paddingX: 1,
  })
  const scroll = new ScrollBoxRenderable(renderer, { width: '100%', height: '100%', scrollY: true, scrollX: false })
  scroll.add(new TextRenderable(renderer, {
    content: row?.details ?? config.emptyCopy ?? DEFAULT_EMPTY_COPY,
    fg: theme.colors.text,
    wrapMode: 'word',
    selectable: true,
  }))
  frame.add(scroll)
  return frame
}

function actionColor(theme: TuiTheme, action: CatalogAction<string>): string {
  switch (action.tone) {
    case 'danger': return theme.colors.danger
    case 'positive': return theme.colors.success
    case 'default': return theme.colors.focus
    default: {
      const exhaustive: never = action.tone
      return String(exhaustive)
    }
  }
}

function createActions<ActionId extends string, Section extends string>(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: CatalogController<ActionId, Section>,
  snapshot: CatalogSnapshot<ActionId, Section>,
  config: CatalogViewConfig<Section>,
): BoxRenderable {
  const actions = new BoxRenderable(renderer, {
    id: `${config.idPrefix}-actions`, width: '100%', height: ROW_HEIGHT, minHeight: ROW_HEIGHT,
    flexDirection: 'row', flexShrink: 0,
  })
  const row = snapshot.rows[snapshot.rowIndex]
  for (const action of row?.actions ?? []) {
    const confirming = snapshot.confirmation === action.id
    const selected = snapshot.selectedActionId === action.id
    const unavailable = snapshot.busy || !action.enabled
    actions.add(new TextRenderable(renderer, {
      id: `${config.idPrefix}-action-${action.id}`,
      content: ` ${selected ? '› ' : ''}${confirming ? `${config.confirmLabel ?? DEFAULT_CONFIRM_LABEL} ` : ''}${action.label} `,
      fg: unavailable ? theme.colors.muted : actionColor(theme, action),
      attributes: unavailable ? TextAttributes.DIM : TextAttributes.BOLD,
      selectable: false,
      onMouseUp(event) {
        // OpenTUI publishes equivalent mouse-button values through separate enum declarations.
        // oxlint-disable-next-line typescript/no-unsafe-enum-comparison
        if (event.button !== MouseButton.LEFT || unavailable) return
        event.preventDefault()
        event.stopPropagation()
        void controller.perform(action.id)
      },
    }))
  }
  actions.add(new TextRenderable(renderer, {
    content: snapshot.error === undefined
      ? `  ${snapshot.status}`
      : `  ${config.errorLabel ?? DEFAULT_ERROR_LABEL}: ${snapshot.error}`,
    height: STATUS_HEIGHT,
    fg: snapshot.error === undefined ? theme.colors.muted : theme.colors.danger,
    truncate: true,
    selectable: false,
  }))
  return actions
}

function handleInputKey<ActionId extends string, Section extends string>(
  key: KeyEvent,
  editor: TextareaRenderable,
  controller: CatalogController<ActionId, Section>,
  focusActions: (key: KeyEvent) => boolean,
): void {
  if (focusActions(key)) return
  if (key.name === ESCAPE_KEY) {
    key.preventDefault()
    key.stopPropagation()
    editor.blur()
    controller.cancelInput()
    return
  }
  if (key.ctrl && key.name === RETURN_KEY) {
    key.preventDefault()
    key.stopPropagation()
    void controller.submitInput()
  }
}

function createInput<ActionId extends string, Section extends string>(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: CatalogController<ActionId, Section>,
  snapshot: CatalogSnapshot<ActionId, Section>,
  config: CatalogViewConfig<Section>,
): BoxRenderable | undefined {
  if (snapshot.input === undefined) return undefined
  const frame = new BoxRenderable(renderer, {
    id: `${config.idPrefix}-input-frame`, title: snapshot.input.title,
    width: '100%', height: INPUT_HEIGHT, border: true, flexShrink: 0, flexDirection: 'column',
  })
  const commonOptions = {
    id: `${config.idPrefix}-input`,
    width: '100%' as const,
    cursorColor: theme.colors.focus,
    textColor: theme.colors.text,
    focusedTextColor: theme.colors.text,
    focusedBackgroundColor: theme.colors.background,
  }
  const editor: TextareaRenderable = snapshot.input.secret === true
    ? new SecretInputRenderable(renderer, {
        ...commonOptions,
        onSecretChange(value) { controller.setInput(value) },
        onKeyDown(key) { handleInputKey(key, editor, controller, event => inputActions.focusForTab(event)) },
      })
    : new TextareaRenderable(renderer, {
        ...commonOptions,
        height: INPUT_EDITOR_HEIGHT,
        initialValue: snapshot.input.value,
        wrapMode: 'word',
        onContentChange() { controller.setInput(editor.plainText) },
        onKeyDown(key) { handleInputKey(key, editor, controller, event => inputActions.focusForTab(event)) },
      })
  const inputActions = createInputActions(renderer, theme, {
    cancel: () => { controller.cancelInput() },
    idPrefix: `${config.idPrefix}-input`,
    input: editor,
    save: () => { void controller.submitInput() },
  })
  frame.add(editor)
  frame.add(inputActions.root)
  queueMicrotask(() => {
    if (editor.isDestroyed) return
    editor.cursorOffset = editor.plainText.length
    editor.focus()
  })
  return frame
}

function createFrame<ActionId extends string, Section extends string>(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: CatalogController<ActionId, Section>,
  snapshot: CatalogSnapshot<ActionId, Section>,
  config: CatalogViewConfig<Section>,
): BoxRenderable {
  const frame = new BoxRenderable(renderer, {
    id: `${config.idPrefix}-frame`, title: config.title, position: 'absolute',
    width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT, left: OVERLAY_LEFT, top: OVERLAY_TOP,
    border: true, borderStyle: 'rounded', borderColor: theme.colors.focus,
    backgroundColor: theme.colors.background, paddingX: 2, paddingY: 1,
    flexDirection: 'column', zIndex: OVERLAY_Z_INDEX,
  })
  frame.add(createTabs(renderer, theme, controller, snapshot, config))
  frame.add(createRows(renderer, theme, controller, snapshot, config))
  frame.add(createDetails(renderer, theme, snapshot, config))
  const input = createInput(renderer, theme, controller, snapshot, config)
  if (input !== undefined) frame.add(input)
  frame.add(createActions(renderer, theme, controller, snapshot, config))
  return frame
}

export function createCatalogView<ActionId extends string, Section extends string>(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: CatalogController<ActionId, Section>,
  config: CatalogViewConfig<Section>,
): BoxRenderable {
  const root = new BoxRenderable(renderer, {
    id: `dsh-tui-${config.idPrefix}-view`, width: '100%', height: '100%', backgroundColor: theme.colors.background,
  })
  let frame = createFrame(renderer, theme, controller, controller.getSnapshot(), config)
  root.add(frame)
  const unsubscribe = controller.subscribe(() => {
    const next = createFrame(renderer, theme, controller, controller.getSnapshot(), config)
    root.remove(frame)
    frame.destroyRecursively()
    frame = next
    root.add(frame)
  })
  root.once('destroyed', unsubscribe)
  return root
}
