import {
  BoxRenderable,
  MouseButton,
  ScrollBoxRenderable,
  TextAttributes,
  TextRenderable,
  type CliRenderer,
} from '@opentui/core'
import type { TuiTheme } from '../../contracts/theme.js'
import type {
  InputTriggerSnapshotView,
  InputTriggerSource,
} from '../../features/input-trigger/model.js'
import { createFocusableAction } from '../action.js'

const MENU_WIDTH = '82%'
const MENU_HEIGHT = '42%'
const MENU_LEFT = '9%'
const MENU_TOP = '38%'
const MENU_Z_INDEX = 180
const HEADER_HEIGHT = 1
const STATUS_HEIGHT = 1
const ROW_HEIGHT = 1
const SOURCE_LABELS: Readonly<Record<InputTriggerSource, string>> = Object.freeze({
  command: 'COMMAND',
  skill: 'SKILL',
  subagent: 'SUBAGENT',
})
const LOADING_COPY = 'Loading candidates…'
const EMPTY_COPY = 'No candidates.'

export interface InputTriggerViewActions {
  dismiss(): void
  pick(source: InputTriggerSource, index: number): void
}

function candidateContent(input: {
  readonly description?: string | undefined
  readonly hint?: string | undefined
  readonly name: string
}, highlighted: boolean): string {
  const cursor = highlighted ? '›' : ' '
  const hint = input.hint === undefined ? '' : `  ${input.hint}`
  const description = input.description === undefined ? '' : ` · ${input.description}`
  return `${cursor} ${input.name}${hint}${description}`
}

function createGroups(
  renderer: CliRenderer,
  theme: TuiTheme,
  snapshot: InputTriggerSnapshotView,
  actions: InputTriggerViewActions,
): ScrollBoxRenderable {
  const groups = new ScrollBoxRenderable(renderer, {
    id: 'input-trigger-groups',
    width: '100%',
    flexGrow: 1,
    scrollY: true,
    scrollX: false,
  })
  for (const group of snapshot.groups) {
    groups.add(new TextRenderable(renderer, {
      content: SOURCE_LABELS[group.source],
      height: HEADER_HEIGHT,
      fg: theme.colors.accent,
      attributes: TextAttributes.BOLD,
      selectable: false,
    }))
    group.items.forEach((candidate, index) => {
      const highlighted = snapshot.highlight?.source === group.source
        && snapshot.highlight.index === index
      groups.add(createFocusableAction(renderer, {
        content: candidateContent(candidate, highlighted),
        fg: highlighted ? theme.colors.focus : theme.colors.text,
        height: ROW_HEIGHT,
        id: `input-trigger-${group.source}-${index}`,
        mutedFg: theme.colors.muted,
        run: () => { actions.pick(group.source, index) },
      }))
    })
  }
  if (snapshot.groups.every(group => group.items.length === 0) && !snapshot.pending) {
    groups.add(new TextRenderable(renderer, {
      content: EMPTY_COPY,
      fg: theme.colors.muted,
      selectable: false,
    }))
  }
  const highlight = snapshot.highlight
  if (highlight !== undefined) {
    queueMicrotask(() => {
      if (groups.isDestroyed) return
      groups.scrollChildIntoView(`input-trigger-${highlight.source}-${highlight.index}`)
    })
  }
  return groups
}

export function createInputTriggerView(
  renderer: CliRenderer,
  theme: TuiTheme,
  snapshot: InputTriggerSnapshotView,
  actions: InputTriggerViewActions,
): BoxRenderable | undefined {
  if (!snapshot.open) return undefined
  const menu = new BoxRenderable(renderer, {
    id: 'input-trigger-menu',
    title: snapshot.launcher ? 'LAUNCH' : 'REFERENCES',
    position: 'absolute',
    width: MENU_WIDTH,
    height: MENU_HEIGHT,
    left: MENU_LEFT,
    top: MENU_TOP,
    border: true,
    borderStyle: 'rounded',
    borderColor: theme.colors.focus,
    backgroundColor: theme.colors.background,
    paddingX: 1,
    flexDirection: 'column',
    zIndex: MENU_Z_INDEX,
  })
  menu.add(createGroups(renderer, theme, snapshot, actions))
  menu.add(new TextRenderable(renderer, {
    id: 'input-trigger-dismiss',
    content: snapshot.pending ? LOADING_COPY : '↑↓ move · Enter choose · Esc close',
    height: STATUS_HEIGHT,
    fg: theme.colors.muted,
    attributes: TextAttributes.DIM,
    selectable: false,
    onMouseUp(event) {
      // OpenTUI publishes equivalent mouse-button values through separate enum declarations.
      // oxlint-disable-next-line typescript/no-unsafe-enum-comparison
      if (event.button !== MouseButton.LEFT) return
      event.preventDefault()
      event.stopPropagation()
      actions.dismiss()
    },
  }))
  return menu
}
