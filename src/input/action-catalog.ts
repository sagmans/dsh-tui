import { ENTER_KEY, normalizeKey } from './key-press.ts'
import { TUI_KEYBINDINGS, type KeyId } from '@earendil-works/pi-tui'

/**
 * Every action a reader may bind, in one table.
 *
 * Two provenances meet here. The surface's own actions are rows written out
 * with the keys they ship with; the library's actions are read from the
 * library's own table, so a key pi-tui adds becomes bindable without a second
 * list to maintain. An action has exactly one spelling, which is the spelling
 * the layer that reads it uses: a `tui.` id belongs to pi-tui, everything else
 * to this surface.
 */
export type ActionLayer = 'prompt' | 'surface' | 'chord' | 'gate' | 'question' | 'picker' | 'library'

/** One bindable action: what it is called, what it ships with, and what a reader may do to it. */
export interface Action {
  readonly id: string
  readonly layer: ActionLayer
  readonly defaultKeys: readonly KeyId[]
  readonly label: string
  /**
   * Whether a bare character may be bound to it.
   *
   * A whole key the reader types with is only theirs while it is armed: the
   * approval gate owns the keyboard for one decision, and a chord's second key
   * is live only between the prefix and the key after it. Everywhere else the
   * reader is writing prose, so a bare letter would be taken from them.
   */
  readonly mayUseBare: boolean
  /** Whether the list may be emptied, which is only honest for a key the library already ships unbound. */
  readonly mayUnbind: boolean
  /**
   * A shape this action insists on beyond "a key the reader may write".
   *
   * `chord` is for the key that starts a chord: it has to be one simple chord,
   * because it is consumed before anything else looks at the press.
   */
  readonly keyShape?: 'chord'
}

/** The names the surface's own handler map is keyed by. */
export type SurfaceActionId = 'toolDetail' | 'subCalls' | 'reasoning' | 'effort' | 'history' | 'back' | 'interrupt' | 'quit'

const PROMPT_ACTIONS: readonly Action[] = [
  {
    id: 'prompt.submit',
    layer: 'prompt',
    defaultKeys: ['ctrl+enter', 'alt+enter', 'ctrl+s'],
    label: 'submit the prompt',
    mayUseBare: false,
    mayUnbind: false,
  },
  {
    id: 'prompt.newLine',
    layer: 'prompt',
    defaultKeys: [ENTER_KEY, 'shift+enter', 'ctrl+j'],
    label: 'break the line',
    mayUseBare: false,
    mayUnbind: false,
  },
]

/** The surface's own actions, each named as the handler map names it. */
export const SURFACE_ACTIONS: readonly (Action & { readonly name: SurfaceActionId })[] = [
  { id: 'surface.toolDetail', name: 'toolDetail', layer: 'surface', defaultKeys: ['ctrl+o'], label: 'tool detail', mayUseBare: false, mayUnbind: false },
  { id: 'surface.subCalls', name: 'subCalls', layer: 'surface', defaultKeys: ['ctrl+y'], label: 'nested calls', mayUseBare: false, mayUnbind: false },
  { id: 'surface.reasoning', name: 'reasoning', layer: 'surface', defaultKeys: ['shift+tab'], label: 'reasoning', mayUseBare: false, mayUnbind: false },
  { id: 'surface.effort', name: 'effort', layer: 'surface', defaultKeys: ['ctrl+t'], label: 'reasoning effort', mayUseBare: false, mayUnbind: false },
  { id: 'surface.history', name: 'history', layer: 'surface', defaultKeys: ['ctrl+r'], label: 'search prompt history', mayUseBare: false, mayUnbind: false },
  { id: 'surface.back', name: 'back', layer: 'surface', defaultKeys: ['ctrl+b'], label: 'back to this session', mayUseBare: false, mayUnbind: false },
  { id: 'surface.interrupt', name: 'interrupt', layer: 'surface', defaultKeys: ['ctrl+c'], label: 'cancel', mayUseBare: false, mayUnbind: false },
  { id: 'surface.quit', name: 'quit', layer: 'surface', defaultKeys: ['ctrl+d'], label: 'quit', mayUseBare: false, mayUnbind: false },
]

const CHORD_ACTIONS: readonly Action[] = [
  { id: 'chord.prefix', layer: 'chord', defaultKeys: ['ctrl+x'], label: 'start a chord', mayUseBare: false, mayUnbind: false, keyShape: 'chord' },
  { id: 'chord.model', layer: 'chord', defaultKeys: ['m'], label: 'model', mayUseBare: true, mayUnbind: false },
  { id: 'chord.plan', layer: 'chord', defaultKeys: ['p'], label: 'plan mode', mayUseBare: true, mayUnbind: false },
  { id: 'chord.copy', layer: 'chord', defaultKeys: ['y'], label: 'copy', mayUseBare: true, mayUnbind: false },
  { id: 'chord.stash', layer: 'chord', defaultKeys: ['s'], label: 'stash the draft', mayUseBare: true, mayUnbind: false },
  { id: 'chord.stashes', layer: 'chord', defaultKeys: ['l'], label: 'stashed drafts', mayUseBare: true, mayUnbind: false },
  { id: 'chord.editor', layer: 'chord', defaultKeys: ['e'], label: 'external editor', mayUseBare: true, mayUnbind: false },
  // The map is the one thing a reader needs while their hands are already on the
  // keys, so it earns a chord rather than only a command they have to spell.
  { id: 'chord.keys', layer: 'chord', defaultKeys: ['?'], label: 'key map', mayUseBare: true, mayUnbind: false },
  // Starting over is asked for while the bar still holds a draft, and a typed
  // `/new` would have taken that draft's place rather than kept it.
  { id: 'chord.new', layer: 'chord', defaultKeys: ['n'], label: 'new session', mayUseBare: true, mayUnbind: false },
  // Stepping back through prompts is a composer verb like stash and model, and
  // a reader asking for it is already at the bar with their hands on the keys.
  { id: 'chord.undo', layer: 'chord', defaultKeys: ['u'], label: 'undo the last prompt', mayUseBare: true, mayUnbind: false },
  { id: 'chord.redo', layer: 'chord', defaultKeys: ['r'], label: 'redo the undone prompt', mayUseBare: true, mayUnbind: false },
]

const GATE_ACTIONS: readonly Action[] = [
  { id: 'gate.allow', layer: 'gate', defaultKeys: ['y'], label: 'allow once', mayUseBare: true, mayUnbind: false },
  { id: 'gate.reject', layer: 'gate', defaultKeys: ['n'], label: 'reject', mayUseBare: true, mayUnbind: false },
  { id: 'gate.cancel', layer: 'gate', defaultKeys: ['escape', 'ctrl+c'], label: 'cancel', mayUseBare: false, mayUnbind: false },
]

const QUESTION_ACTIONS: readonly Action[] = [
  { id: 'question.up', layer: 'question', defaultKeys: ['up', 'ctrl+p'], label: 'previous option', mayUseBare: false, mayUnbind: false },
  { id: 'question.down', layer: 'question', defaultKeys: ['down', 'ctrl+n'], label: 'next option', mayUseBare: false, mayUnbind: false },
  { id: 'question.toggle', layer: 'question', defaultKeys: ['space'], label: 'toggle an option', mayUseBare: false, mayUnbind: false },
  { id: 'question.confirm', layer: 'question', defaultKeys: [ENTER_KEY], label: 'answer the question', mayUseBare: false, mayUnbind: false },
  { id: 'question.skip', layer: 'question', defaultKeys: ['escape'], label: 'skip this question', mayUseBare: false, mayUnbind: false },
  { id: 'question.cancel', layer: 'question', defaultKeys: ['ctrl+c'], label: 'abandon the questions', mayUseBare: false, mayUnbind: false },
]

const PICKER_ACTIONS: readonly Action[] = [
  { id: 'picker.up', layer: 'picker', defaultKeys: ['up', 'ctrl+p'], label: 'previous row', mayUseBare: false, mayUnbind: false },
  { id: 'picker.down', layer: 'picker', defaultKeys: ['down', 'ctrl+n'], label: 'next row', mayUseBare: false, mayUnbind: false },
  { id: 'picker.confirm', layer: 'picker', defaultKeys: [ENTER_KEY], label: 'take the row', mayUseBare: false, mayUnbind: false },
  { id: 'picker.cancel', layer: 'picker', defaultKeys: ['escape', 'ctrl+c'], label: 'leave the list', mayUseBare: false, mayUnbind: false },
]

/**
 * Library rows this surface adds a key to.
 *
 * A key that only works when the reader writes it into settings is a key the
 * surface can never reach: the transcript search owns the keyboard while it is
 * open, so its close row is the one seam through which the cancel key gets
 * there. The added row travels with the map, so /keys and the clash guards read
 * the key that is really installed rather than the one the library shipped.
 *
 * The select rows are the same seam for a different list: the completion menu a
 * reader navigates belongs to the library's editor, so the navigation aliases
 * have to be installed where that menu reads them rather than on a row this
 * surface answers.
 */
export const LIBRARY_KEY_ADDITIONS: Readonly<Record<string, readonly KeyId[]>> = {
  'tui.altScreen.searchClose': ['escape', 'ctrl+c'],
  'tui.select.up': ['up', 'ctrl+p'],
  'tui.select.down': ['down', 'ctrl+n'],
}

/**
 * Library ids whose meaning this surface owns.
 *
 * The prompt bar reads both through its own actions, because it adds a guard
 * the library cannot know: Enter is a line break unless a completion menu is
 * open, and a terminal that cannot report alt+enter spells it as a sequence the
 * library reads as a newline. Writing the library's spelling is refused with a
 * pointer at the action that does own it.
 */
export const KEYMAP_ALIASES: Readonly<Record<string, string>> = {
  'tui.input.submit': 'prompt.submit',
  'tui.input.newLine': 'prompt.newLine',
}

/** The library's own actions, read from the library rather than restated. */
function libraryActions(): readonly Action[] {
  return Object.entries(TUI_KEYBINDINGS)
    .filter(([id]) => KEYMAP_ALIASES[id] === undefined)
    .map(([id, definition]) => {
      const defaults = Array.isArray(definition.defaultKeys) ? definition.defaultKeys : [definition.defaultKeys]
      return {
        id,
        layer: 'library' as const,
        defaultKeys: defaults.map(key => normalizeKey(key)).filter((key): key is KeyId => key !== undefined),
        label: definition.description,
        mayUseBare: false,
        // Only a key the library ships unbound may be emptied: every other row
        // is one the reader would otherwise have to remember a command for.
        mayUnbind: defaults.length === 0,
      }
    })
}

/** Every action a reader may bind. */
export const ACTION_CATALOG: readonly Action[] = [
  ...PROMPT_ACTIONS,
  ...SURFACE_ACTIONS,
  ...CHORD_ACTIONS,
  ...GATE_ACTIONS,
  ...QUESTION_ACTIONS,
  ...PICKER_ACTIONS,
  ...libraryActions(),
]

export function actionOf(id: string): Action | undefined {
  return ACTION_CATALOG.find(entry => entry.id === id)
}

/** The keys one action ships with, this surface's own additions to a library row included. */
export function shippedKeys(action: Action): readonly KeyId[] {
  return LIBRARY_KEY_ADDITIONS[action.id] ?? action.defaultKeys
}
