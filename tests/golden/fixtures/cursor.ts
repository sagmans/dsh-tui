/** Fixed phases pin grapheme, ghost, and masked cursor output without timer-dependent snapshots. */
import { type TUI } from '@earendil-works/pi-tui'
import { defaultKeymap } from '@/input/actions.ts'
import { SOFTWARE_CURSOR_MODE, NATIVE_CURSOR_MODE, type CursorPresentation } from '@/terminal/cursor.ts'
import { createTheme } from '@/theme.ts'
import { BoxedEditor, type GhostBrush } from '@/ui/editor.ts'
import { GateInputBar } from '@/ui/gate-input.ts'

const WIDTHS = [24, 10]
const CURSOR_ON = '\u001b[7m'
const RESET = '\u001b[0m'
const LEFT = '\u001b[D'
const CURSOR_CELL = 'cursor'
const SECRET_MODE = 'secret'
const PLAIN_COLOR_MODE = 'none'
const STYLED_COLOR_MODE = 'truecolor'
const GHOST_TOKEN = 'editor.ghost'
const CASE_SEPARATOR = ' / '
const VISIBLE_PHASE = 'visible'
const HIDDEN_PHASE = 'hidden'
const UNFOCUSED_TEXT = 'unfocused'
const STUB_TUI = { requestRender: () => {}, terminal: { rows: 24, columns: 80 } } as unknown as TUI
/** Cursor positions stay explicit so masked-middle coverage cannot drift to a readable tail. */
interface CursorFrameCase {
  readonly name: string
  readonly text: string
  readonly left?: number
  readonly suffix?: string
  readonly question?: boolean
  readonly secret?: boolean
  readonly color?: boolean
}

const CASES: readonly CursorFrameCase[] = [
  { name: 'empty', text: '' },
  { name: 'end padding', text: 'draft' },
  { name: 'wide grapheme', text: 'draft 中', left: 1 },
  { name: 'combining grapheme', text: 'draft ä', left: 1 },
  { name: 'joined emoji', text: 'draft 👩‍💻', left: 1 },
  { name: 'wrapped line', text: 'one two three four five six 中 ä' },
  { name: 'ghost', text: 'deploy ', suffix: '中 staging' },
  { name: 'styled ghost', text: 'deploy ', suffix: '中 staging', color: true },
  { name: 'question', text: 'custom answer', question: true },
  { name: 'masked answer', text: 'abcdPRIVATEVALUEwxyz', secret: true, left: 9 },
]

/** Every case keeps a real editor; only the owner's phase is fixed for an output artifact. */
export function cursorFrames(): Record<string, string[]> {
  const theme = createTheme(PLAIN_COLOR_MODE)
  const frames: Record<string, string[]> = {}
  for (const spec of CASES) {
    const settings = spec
    const face = spec.color ? createTheme(STYLED_COLOR_MODE) : theme
    const ghost: GhostBrush | undefined = settings.suffix === undefined ? undefined : {
      enabled: () => true,
      suggestion: () => settings.suffix,
      paint: (text, cell) => {
        const styled = face.style(GHOST_TOKEN, text)
        return cell === CURSOR_CELL ? CURSOR_ON + styled + RESET : styled
      },
    }
    for (const width of WIDTHS) {
      for (const phase of [true, false]) {
        const cursor: CursorPresentation = { mode: SOFTWARE_CURSOR_MODE, visible: () => phase, activity: () => {} }
        const editor = new GateInputBar(STUB_TUI, face.editor, defaultKeymap, ghost, cursor)
        editor.focused = true
        editor.disableSubmit = settings.question === true || settings.secret === true
        if (settings.secret) editor.setMode(SECRET_MODE)
        editor.setText(spec.text)
        for (let step = 0; step < (settings.left ?? 0); step++) editor.handleInput(LEFT)
        frames[spec.name + CASE_SEPARATOR + width + CASE_SEPARATOR + (phase ? VISIBLE_PHASE : HIDDEN_PHASE)] = editor.render(width)
      }
    }
  }
  for (const mode of [SOFTWARE_CURSOR_MODE, NATIVE_CURSOR_MODE] as const) {
    const cursor: CursorPresentation = { mode, visible: () => true, activity: () => {} }
    const editor = new BoxedEditor(STUB_TUI, theme.editor, defaultKeymap, undefined, cursor)
    editor.focused = false
    editor.setText(UNFOCUSED_TEXT)
    frames[mode + CASE_SEPARATOR + UNFOCUSED_TEXT] = editor.render(WIDTHS[0]!)
  }
  return frames
}
