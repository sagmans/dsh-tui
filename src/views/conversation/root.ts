import {
  BoxRenderable,
  ScrollBoxRenderable,
  TextAttributes,
  TextRenderable,
  type CliRenderer,
} from '@opentui/core'
import type { TuiTheme } from '../../contracts/theme.js'
import type {
  ConversationController,
  ConversationLine,
  ConversationSnapshotView,
} from '../../features/conversation/model.js'
import { createComposer, createConversationActions } from './composer.js'

const HEADER_HEIGHT = 1
const STATUS_HEIGHT = 1
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
    content: snapshot.title,
    height: HEADER_HEIGHT,
    fg: theme.colors.accent,
    attributes: TextAttributes.BOLD,
    truncate: true,
    selectable: false,
  }))
  frame.add(createTranscript(renderer, theme, snapshot))
  if (snapshot.suggestions.length > 0) {
    frame.add(new TextRenderable(renderer, {
      content: snapshot.suggestions.map(name => `/${name}`).join('  '),
      height: STATUS_HEIGHT,
      fg: theme.colors.focus,
      truncate: true,
      selectable: false,
    }))
  }
  frame.add(new TextRenderable(renderer, {
    content: snapshot.error === undefined ? snapshot.status : `Error: ${snapshot.error}`,
    height: STATUS_HEIGHT,
    fg: snapshot.error === undefined
      ? snapshot.running ? theme.colors.warning : theme.colors.muted
      : theme.colors.danger,
    truncate: true,
    selectable: false,
  }))
  frame.add(createComposer(renderer, theme, controller, snapshot))
  frame.add(createConversationActions(renderer, theme, controller, snapshot))
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
