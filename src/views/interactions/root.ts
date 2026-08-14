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
import type { TuiTheme } from '../../contracts/theme.js'
import { createFocusableAction } from '../action.js'
import type {
  InteractionsController,
  InteractionSnapshotView,
} from '../../features/interactions/model.js'

const OVERLAY_WIDTH = '88%'
const OVERLAY_HEIGHT = '82%'
const OVERLAY_LEFT = '6%'
const OVERLAY_TOP = '8%'
const OVERLAY_Z_INDEX = 110
const HEADER_HEIGHT = 1
const STATUS_HEIGHT = 1
const ACTION_HEIGHT = 1
const CUSTOM_HEIGHT = 3
const RETURN_KEY = 'return'
const ESCAPE_KEY = 'escape'
const TAB_KEY = 'tab'
const SELECT_ACTION_ID = 'interaction-select'
const APPROVE_ACTION_ID = 'interaction-approve'
const REJECT_ACTION_ID = 'interaction-reject'
const CANCEL_ACTION_ID = 'interaction-cancel'
const SUBMIT_ACTION_ID = 'interaction-submit'
function createAction(
  renderer: CliRenderer,
  theme: TuiTheme,
  id: string,
  label: string,
  enabled: boolean,
  run: () => void,
): TextRenderable {
  return createFocusableAction(renderer, {
    content: ` ${label} `,
    enabled,
    fg: theme.colors.focus,
    height: ACTION_HEIGHT,
    id,
    mutedFg: theme.colors.muted,
    run,
  })
}

function createActions(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: InteractionsController,
  snapshot: InteractionSnapshotView,
): BoxRenderable {
  const actions = new BoxRenderable(renderer, {
    id: 'interaction-actions',
    width: '100%',
    height: ACTION_HEIGHT,
    flexDirection: 'row',
  })
  const enabled = !snapshot.busy
  switch (snapshot.kind) {
    case 'approval':
      actions.add(createAction(renderer, theme, REJECT_ACTION_ID, 'REJECT', enabled, () => { void controller.reject() }))
      actions.add(createAction(renderer, theme, APPROVE_ACTION_ID, 'ALLOW ONCE', enabled, () => { void controller.approve() }))
      break
    case 'plan-review':
      actions.add(createAction(renderer, theme, CANCEL_ACTION_ID, 'DISCUSS', enabled, () => { void controller.cancel() }))
      actions.add(createAction(renderer, theme, REJECT_ACTION_ID, 'REFUSE', enabled && snapshot.canReject, () => { void controller.reject() }))
      actions.add(createAction(renderer, theme, APPROVE_ACTION_ID, 'APPROVE', enabled, () => { void controller.approve() }))
      break
    case 'question':
      actions.add(createAction(renderer, theme, 'interaction-previous', 'PREV', enabled, () => { controller.previousQuestion() }))
      actions.add(createAction(renderer, theme, SELECT_ACTION_ID, 'SELECT', enabled, () => { controller.chooseOption() }))
      actions.add(createAction(renderer, theme, 'interaction-next', 'NEXT', enabled, () => { controller.nextQuestion() }))
      actions.add(createAction(renderer, theme, 'interaction-skip', 'SKIP', enabled, () => { controller.skipQuestion() }))
      actions.add(createAction(renderer, theme, SUBMIT_ACTION_ID, 'SUBMIT', enabled, () => { void controller.submit() }))
      actions.add(createAction(renderer, theme, CANCEL_ACTION_ID, 'CANCEL', enabled, () => { void controller.cancel() }))
      break
    case 'unavailable':
      actions.add(createAction(renderer, theme, CANCEL_ACTION_ID, 'CANCEL REQUEST', enabled, () => { void controller.cancel() }))
      break
    case undefined:
      break
    default: {
      const exhaustive: never = snapshot.kind
      throw new Error(`unhandled interaction kind: ${String(exhaustive)}`)
    }
  }
  return actions
}

function handleEditorKey(
  key: KeyEvent,
  editor: TextareaRenderable,
  controller: InteractionsController,
  focusSubmit: () => void,
  focusCancel: () => void,
): void {
  if (key.name === TAB_KEY) {
    key.preventDefault()
    key.stopPropagation()
    editor.blur()
    if (key.shift) focusCancel()
    else focusSubmit()
    return
  }
  if (key.name === ESCAPE_KEY) {
    key.preventDefault()
    key.stopPropagation()
    editor.blur()
    void controller.cancel()
    return
  }
  if (key.ctrl && key.name === RETURN_KEY) {
    key.preventDefault()
    key.stopPropagation()
    void controller.submit()
  }
}

function createQuestionOptions(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: InteractionsController,
  snapshot: InteractionSnapshotView,
): ScrollBoxRenderable {
  const options = new ScrollBoxRenderable(renderer, {
    id: 'interaction-options',
    width: '100%',
    flexGrow: 1,
    scrollY: true,
    scrollX: false,
  })
  for (const option of snapshot.options) {
    const cursor = option.index === snapshot.optionIndex
    options.add(new TextRenderable(renderer, {
      id: `interaction-option-${option.index}`,
      content: `${cursor ? '›' : ' '} ${option.selected ? '[x]' : '[ ]'} ${option.label}${option.description === undefined ? '' : ` · ${option.description}`}`,
      fg: cursor ? theme.colors.focus : option.selected ? theme.colors.success : theme.colors.text,
      attributes: cursor ? TextAttributes.BOLD : TextAttributes.NONE,
      selectable: false,
      onMouseUp(event) {
        // OpenTUI publishes equivalent mouse-button values through separate enum declarations.
        // oxlint-disable-next-line typescript/no-unsafe-enum-comparison
        if (event.button !== MouseButton.LEFT || snapshot.busy) return
        event.preventDefault()
        event.stopPropagation()
        controller.selectOption(option.index)
        controller.chooseOption(option.index)
      },
    }))
  }
  return options
}
function createCustomEditor(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: InteractionsController,
  snapshot: InteractionSnapshotView,
  focusSubmit: () => void,
  focusCancel: () => void,
): TextareaRenderable {
  const editor = new TextareaRenderable(renderer, {
    id: 'interaction-custom',
    width: '100%',
    height: CUSTOM_HEIGHT,
    initialValue: snapshot.custom,
    placeholder: snapshot.options.length === 0 ? 'Type answer' : 'Optional custom answer',
    textColor: theme.colors.text,
    cursorColor: theme.colors.focus,
    focusedTextColor: theme.colors.text,
    focusedBackgroundColor: theme.colors.background,
    wrapMode: 'word',
    onContentChange() { controller.setCustom(editor.plainText) },
    onKeyDown(key) { handleEditorKey(key, editor, controller, focusSubmit, focusCancel) },
  })
  return editor
}
function createQuestionBody(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: InteractionsController,
  snapshot: InteractionSnapshotView,
  focusSubmit: () => void,
  focusCancel: () => void,
): BoxRenderable {
  const body = new BoxRenderable(renderer, {
    id: 'interaction-question-body',
    width: '100%',
    flexGrow: 1,
    flexDirection: 'column',
  })
  if (snapshot.body !== '') {
    body.add(new TextRenderable(renderer, {
      content: snapshot.body,
      fg: theme.colors.text,
      wrapMode: 'word',
      selectable: true,
      flexShrink: 0,
    }))
  }
  body.add(createQuestionOptions(renderer, theme, controller, snapshot))
  body.add(createCustomEditor(renderer, theme, controller, snapshot, focusSubmit, focusCancel))
  return body
}

function createBody(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: InteractionsController,
  snapshot: InteractionSnapshotView,
  focusSubmit: () => void,
  focusCancel: () => void,
): BoxRenderable | ScrollBoxRenderable {
  if (snapshot.kind === 'question') {
    return createQuestionBody(renderer, theme, controller, snapshot, focusSubmit, focusCancel)
  }
  const body = new ScrollBoxRenderable(renderer, {
    id: 'interaction-body',
    width: '100%',
    flexGrow: 1,
    scrollY: true,
    scrollX: false,
  })
  body.add(new TextRenderable(renderer, {
    content: snapshot.body,
    fg: snapshot.kind === 'unavailable' ? theme.colors.danger : theme.colors.text,
    wrapMode: 'word',
    selectable: true,
  }))
  return body
}

function createStatus(
  renderer: CliRenderer,
  theme: TuiTheme,
  snapshot: InteractionSnapshotView,
): TextRenderable {
  return new TextRenderable(renderer, {
    content: snapshot.error === undefined ? snapshot.status : `Error: ${snapshot.error}`,
    height: STATUS_HEIGHT,
    fg: snapshot.error === undefined ? theme.colors.muted : theme.colors.danger,
    truncate: true,
    selectable: false,
  })
}

function createFrame(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: InteractionsController,
  snapshot: InteractionSnapshotView,
): BoxRenderable {
  const frame = new BoxRenderable(renderer, {
    id: 'interaction-frame',
    title: snapshot.kind === 'approval' ? 'APPROVAL' : snapshot.kind === 'plan-review' ? 'PLAN REVIEW' : 'QUESTION',
    position: 'absolute',
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
    left: OVERLAY_LEFT,
    top: OVERLAY_TOP,
    border: true,
    borderStyle: 'rounded',
    borderColor: snapshot.kind === 'approval' ? theme.colors.warning : theme.colors.focus,
    backgroundColor: theme.colors.background,
    paddingX: 2,
    paddingY: 1,
    flexDirection: 'column',
    zIndex: OVERLAY_Z_INDEX,
  })
  const actions = createActions(renderer, theme, controller, snapshot)
  const focusSubmit = (): void => { actions.findDescendantById(SUBMIT_ACTION_ID)?.focus() }
  const focusCancel = (): void => { actions.findDescendantById(CANCEL_ACTION_ID)?.focus() }
  frame.add(new TextRenderable(renderer, {
    content: snapshot.title,
    height: HEADER_HEIGHT,
    fg: theme.colors.accent,
    attributes: TextAttributes.BOLD,
    truncate: true,
    selectable: false,
  }))
  frame.add(createBody(renderer, theme, controller, snapshot, focusSubmit, focusCancel))
  frame.add(createStatus(renderer, theme, snapshot))
  frame.add(actions)
  return frame
}

export function createInteractionsView(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: InteractionsController,
): BoxRenderable {
  const root = new BoxRenderable(renderer, {
    id: 'dsh-tui-interactions-view',
    width: '100%',
    height: '100%',
    backgroundColor: theme.colors.background,
  })
  let frame = createFrame(renderer, theme, controller, controller.getSnapshot())
  root.add(frame)
  const unsubscribe = controller.subscribe(() => {
    const next = createFrame(renderer, theme, controller, controller.getSnapshot())
    root.remove(frame)
    frame.destroyRecursively()
    frame = next
    root.add(frame)
  })
  root.once('destroyed', unsubscribe)
  return root
}
