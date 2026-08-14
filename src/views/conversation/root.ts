import {
  BoxRenderable,
  ScrollBoxRenderable,
  TextAttributes,
  TextRenderable,
  type CliRenderer,
  type Renderable,
} from '@opentui/core'
import type { TuiTheme } from '../../contracts/theme.js'
import type {
  ConversationController,
  ConversationLine,
  ConversationSnapshotView,
} from '../../features/conversation/model.js'
import { imageFallback } from '../../features/attachments/presentation.js'
import { createFocusableAction } from '../action.js'
import { createInputTriggerView } from '../input-trigger/root.js'
import { createComposer, createConversationActions, createConversationInput } from './composer.js'
import {
  createConversationInformation,
  createConversationInformationDock,
} from './information.js'
import { createConversationQueue, type ConversationQueueDock } from './queue.js'

const HEADER_HEIGHT = 1
const STATUS_HEIGHT = 1
const ATTACHMENTS_HEIGHT = 1
const ATTACHMENT_PADDING = 1
const COMPOSER_ID = 'conversation-composer'
const ATTACHMENT_DELETE_KEY = 'delete'
const ATTACHMENT_BACKSPACE_KEY = 'backspace'
const ATTACHMENT_ESCAPE_KEY = 'escape'
const ATTACHMENT_LEFT_KEY = 'left'
const ATTACHMENT_RIGHT_KEY = 'right'
const BUSY_COPY = 'Working…'
const PRESET_LABEL = 'PRESET'
const CHAT_LINE_PREFIX: Readonly<Record<ConversationLine['kind'], string>> = Object.freeze({
  assistant: 'AI',
  command: 'CMD',
  context: 'CTX',
  error: 'ERR',
  system: 'SYS',
  tool: 'TOOL',
  user: 'YOU',
})

function colorFor(theme: TuiTheme, kind: ConversationLine['kind']): string {
  switch (kind) {
    case 'assistant': return theme.colors.text
    case 'command': return theme.colors.accent
    case 'context': return theme.colors.muted
    case 'error': return theme.colors.danger
    case 'system': return theme.colors.warning
    case 'tool': return theme.colors.focus
    case 'user': return theme.colors.success
    default: {
      const exhaustive: never = kind
      return String(exhaustive)
    }
  }
}

function createLine(renderer: CliRenderer, theme: TuiTheme, line: ConversationLine): TextRenderable {
  return new TextRenderable(renderer, {
    id: `conversation-line-${line.key}`,
    content: `${CHAT_LINE_PREFIX[line.kind]}  ${line.text}`,
    fg: colorFor(theme, line.kind),
    selectable: true,
    wrapMode: 'word',
    flexShrink: 0,
  })
}

function createTranscript(
  renderer: CliRenderer,
  theme: TuiTheme,
  snapshot: ConversationSnapshotView,
): ScrollBoxRenderable {
  const transcript = new ScrollBoxRenderable(renderer, {
    id: 'conversation-transcript',
    flexGrow: 1,
    width: '100%',
    scrollY: true,
    scrollX: false,
    stickyScroll: true,
    stickyStart: 'bottom',
  })
  if (snapshot.lines.length === 0) {
    transcript.add(new TextRenderable(renderer, {
      content: snapshot.phase === 'empty' ? 'No active session.' : snapshot.status,
      fg: theme.colors.muted,
      selectable: false,
    }))
  } else {
    for (const line of snapshot.lines) transcript.add(createLine(renderer, theme, line))
  }
  return transcript
}

interface AttachmentStrip {
  readonly root: BoxRenderable
  focusLast(): boolean
}

function createAttachments(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: ConversationController,
  snapshot: ConversationSnapshotView,
  focusComposer: () => Renderable | undefined,
): AttachmentStrip {
  const attachments = new BoxRenderable(renderer, {
    id: 'conversation-attachments',
    width: '100%',
    height: ATTACHMENTS_HEIGHT,
    flexDirection: 'row',
  })
  const nodes: TextRenderable[] = []
  snapshot.attachments.forEach((attachment, index) => {
    const content = `[×]${imageFallback(attachment)}`
    const remove = (): void => { controller.removeAttachment(index) }
    const previous = (): Renderable | undefined => nodes[index - 1] ?? focusComposer()
    const next = (): Renderable | undefined => nodes[index + 1] ?? focusComposer()
    const node = createFocusableAction(renderer, {
      content,
      fg: theme.colors.focus,
      handleKey(key) {
        if (key.name === ATTACHMENT_DELETE_KEY || key.name === ATTACHMENT_BACKSPACE_KEY) {
          remove()
          return true
        }
        if (key.name === ATTACHMENT_ESCAPE_KEY) {
          focusComposer()?.focus()
          return true
        }
        if (key.name === ATTACHMENT_LEFT_KEY) {
          previous()?.focus()
          return true
        }
        if (key.name === ATTACHMENT_RIGHT_KEY) {
          next()?.focus()
          return true
        }
        return false
      },
      height: ATTACHMENTS_HEIGHT,
      id: `conversation-attachment-${index}`,
      mutedFg: theme.colors.muted,
      nextFocus: next,
      previousFocus: previous,
      run: remove,
      width: content.length + ATTACHMENT_PADDING,
    })
    nodes.push(node)
    attachments.add(node)
  })
  return {
    root: attachments,
    focusLast() {
      const last = nodes.at(-1)
      if (last === undefined) return false
      last.focus()
      return true
    },
  }
}

function createFrame(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: ConversationController,
  snapshot: ConversationSnapshotView,
): BoxRenderable {
  const frame = new BoxRenderable(renderer, {
    id: 'conversation-root',
    width: '100%',
    height: '100%',
    flexDirection: 'column',
    backgroundColor: theme.colors.background,
  })
  frame.add(new TextRenderable(renderer, {
    content: snapshot.agentPreset === undefined
      ? snapshot.title
      : `${snapshot.title} · ${PRESET_LABEL} ${snapshot.agentPreset}`,
    height: HEADER_HEIGHT,
    fg: theme.colors.accent,
    attributes: TextAttributes.BOLD,
    truncate: true,
    selectable: false,
  }))
  frame.add(createTranscript(renderer, theme, snapshot))
  let attachmentStrip: AttachmentStrip | undefined
  const composer = createComposer(
    renderer,
    theme,
    controller,
    snapshot,
    () => attachmentStrip?.focusLast() ?? false,
    () => queueDock?.focusFirst() ?? false,
  )
  if (snapshot.attachments.length > 0) {
    attachmentStrip = createAttachments(
      renderer,
      theme,
      controller,
      snapshot,
      () => composer.findDescendantById(COMPOSER_ID),
    )
    frame.add(attachmentStrip.root)
  }
  if (snapshot.suggestions.length > 0) {
    frame.add(new TextRenderable(renderer, {
      content: snapshot.suggestions.map(name => `/${name}`).join('  '),
      height: STATUS_HEIGHT,
      fg: theme.colors.focus,
      truncate: true,
      selectable: false,
    }))
  }
  const informationDock = createConversationInformationDock(renderer, theme, controller, snapshot)
  if (informationDock !== undefined) frame.add(informationDock)
  const queueDock: ConversationQueueDock | undefined = createConversationQueue(
    renderer,
    theme,
    controller,
    snapshot,
    () => composer.findDescendantById(COMPOSER_ID),
  )
  if (queueDock !== undefined) frame.add(queueDock.root)
  frame.add(new TextRenderable(renderer, {
    content: snapshot.error === undefined ? snapshot.busy ? BUSY_COPY : snapshot.status : `Error: ${snapshot.error}`,
    height: STATUS_HEIGHT,
    fg: snapshot.error === undefined
      ? snapshot.running ? theme.colors.warning : theme.colors.muted
      : theme.colors.danger,
    truncate: true,
    selectable: false,
  }))
  frame.add(composer)
  frame.add(createConversationActions(renderer, theme, controller, snapshot))
  if (snapshot.trigger !== undefined) {
    const trigger = createInputTriggerView(renderer, theme, snapshot.trigger, {
      dismiss: () => { controller.dismissTrigger() },
      pick: (source, index) => { controller.pickTrigger(source, index) },
    })
    if (trigger !== undefined) frame.add(trigger)
  }
  const input = createConversationInput(renderer, theme, controller, snapshot)
  if (input !== undefined) frame.add(input)
  const information = createConversationInformation(renderer, theme, controller, snapshot)
  if (information !== undefined) frame.add(information)
  return frame
}

export function createConversationView(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: ConversationController,
): BoxRenderable {
  const root = new BoxRenderable(renderer, {
    id: 'dsh-tui-conversation-view',
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
