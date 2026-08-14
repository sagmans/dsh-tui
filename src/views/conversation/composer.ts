import {
  BoxRenderable,
  MouseButton,
  TextareaRenderable,
  TextAttributes,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
} from '@opentui/core'
import type { TuiTheme } from '../../contracts/theme.js'
import type {
  ConversationController,
  ConversationSnapshotView,
} from '../../features/conversation/model.js'

const COMPOSER_HEIGHT = 4
const ACTION_HEIGHT = 1
const ESCAPE_KEY = 'escape'
const PAGE_UP_KEY = 'pageup'
const PAGE_DOWN_KEY = 'pagedown'
const RETURN_KEY = 'return'
const TAB_KEY = 'tab'
const CANCEL_KEY = 'x'
const COMPOSER_HINT = 'Meta+Enter queue · Ctrl+Enter steer · Enter newline · Tab complete · text-only attachments'
const SEND_ACTION = ' SEND '
const STEER_ACTION = ' STEER '
const STOP_ACTION = ' STOP '
const OLDER_ACTION = ' OLDER '
const SEND_ACTION_ID = 'conversation-send'
const STEER_ACTION_ID = 'conversation-steer'
const STOP_ACTION_ID = 'conversation-stop'
const OLDER_ACTION_ID = 'conversation-older'

function submit(
  editor: TextareaRenderable,
  controller: ConversationController,
  mode: 'queue' | 'steer',
): void {
  const sending = controller.sendDraft(mode)
  editor.setText('')
  void sending
}

function handleKey(
  key: KeyEvent,
  editor: TextareaRenderable,
  controller: ConversationController,
): void {
  if (key.ctrl && key.name === CANCEL_KEY) {
    key.preventDefault()
    key.stopPropagation()
    void controller.cancel()
    return
  }
  if (key.ctrl && key.name === RETURN_KEY) {
    key.preventDefault()
    key.stopPropagation()
    submit(editor, controller, 'steer')
    return
  }
  if (key.name === TAB_KEY) {
    key.preventDefault()
    key.stopPropagation()
    void controller.complete()
    return
  }
  if (key.name === ESCAPE_KEY) {
    key.preventDefault()
    key.stopPropagation()
    editor.blur()
    return
  }
  if (key.name === PAGE_UP_KEY) {
    key.preventDefault()
    key.stopPropagation()
    void controller.loadOlder()
    return
  }
  if (key.name === PAGE_DOWN_KEY) {
    key.preventDefault()
    key.stopPropagation()
    controller.scroll(1)
  }
}

function createEditor(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: ConversationController,
  snapshot: ConversationSnapshotView,
): TextareaRenderable {
  const editor = new TextareaRenderable(renderer, {
    id: 'conversation-composer',
    width: '100%',
    height: '100%',
    initialValue: snapshot.draft,
    placeholder: snapshot.sessionId === undefined ? 'Select a session first' : 'Message, /command, or /skill',
    textColor: theme.colors.text,
    cursorColor: theme.colors.focus,
    focusedTextColor: theme.colors.text,
    focusedBackgroundColor: theme.colors.background,
    wrapMode: 'word',
    keyBindings: [{ name: RETURN_KEY, meta: true, action: 'submit' }],
    onContentChange() { controller.setDraft(editor.plainText) },
    onKeyDown(key) { handleKey(key, editor, controller) },
  })
  editor.onSubmit = () => { submit(editor, controller, 'queue') }
  return editor
}

export function createComposer(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: ConversationController,
  snapshot: ConversationSnapshotView,
): BoxRenderable {
  const composer = new BoxRenderable(renderer, {
    id: 'conversation-composer-frame',
    width: '100%',
    height: COMPOSER_HEIGHT,
    border: true,
    borderStyle: 'single',
    borderColor: snapshot.running ? theme.colors.warning : theme.colors.border,
  })
  const editor = createEditor(renderer, theme, controller, snapshot)
  composer.add(editor)
  queueMicrotask(() => {
    if (editor.isDestroyed || snapshot.sessionId === undefined) return
    editor.cursorOffset = editor.plainText.length
    editor.focus()
  })
  return composer
}

function createAction(
  renderer: CliRenderer,
  theme: TuiTheme,
  id: string,
  content: string,
  enabled: boolean,
  run: () => void,
): TextRenderable {
  return new TextRenderable(renderer, {
    id,
    content,
    height: ACTION_HEIGHT,
    fg: enabled ? theme.colors.focus : theme.colors.muted,
    attributes: enabled ? TextAttributes.BOLD : TextAttributes.DIM,
    selectable: false,
    onMouseUp(event) {
      // OpenTUI publishes equivalent mouse-button values through separate enum declarations.
      // oxlint-disable-next-line typescript/no-unsafe-enum-comparison
      if (!enabled || event.button !== MouseButton.LEFT) return
      event.preventDefault()
      event.stopPropagation()
      run()
    },
  })
}

export function createConversationActions(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: ConversationController,
  snapshot: ConversationSnapshotView,
): BoxRenderable {
  const actions = new BoxRenderable(renderer, {
    id: 'conversation-actions',
    width: '100%',
    height: ACTION_HEIGHT,
    flexDirection: 'row',
  })
  actions.add(createAction(renderer, theme, SEND_ACTION_ID, SEND_ACTION, snapshot.sessionId !== undefined, () => {
    void controller.sendDraft('queue')
  }))
  actions.add(createAction(renderer, theme, STEER_ACTION_ID, STEER_ACTION, snapshot.running, () => {
    void controller.sendDraft('steer')
  }))
  actions.add(createAction(renderer, theme, STOP_ACTION_ID, STOP_ACTION, snapshot.running, () => {
    void controller.cancel()
  }))
  actions.add(createAction(renderer, theme, OLDER_ACTION_ID, OLDER_ACTION, snapshot.hasMore, () => {
    void controller.loadOlder()
  }))
  actions.add(new TextRenderable(renderer, {
    content: COMPOSER_HINT,
    height: ACTION_HEIGHT,
    fg: theme.colors.muted,
    attributes: TextAttributes.DIM,
    truncate: true,
    selectable: false,
    flexGrow: 1,
  }))
  return actions
}
