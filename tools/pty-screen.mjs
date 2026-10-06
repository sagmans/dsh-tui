/** Decode current PTY cells so historical redraws cannot satisfy live assertions. */
import { visibleWidth } from '@earendil-works/pi-tui'

const ESC = '\x1b'
const TAB_WIDTH = 8
const CSI = /^\x1b\[([0-?]*)([ -/]*)([@-~])/u
const CONTROL_STRING = new Set([']', 'P', '_', '^', 'X'])
const SGR_RESET = 0
const SGR_REVERSE = 7
const SGR_REVERSE_OFF = 27
const COLOR_SGR = new Set([38, 48, 58])
const RGB_COLOR_MODE = 2
const RGB_CHANNELS = 3
const INDEX_COLOR_MODE = 5
const CURSOR_VISIBLE_MODE = 25

/** Inverse-video readback proves software cursor phases, not emulator hardware blinking or palette pixels. */
export class PtyScreen {
  constructor(cols, rows) {
    this.cols = cols
    this.rows = rows
    this.cells = Array.from({ length: rows }, () => Array(cols).fill(' '))
    this.inverseCells = Array.from({ length: rows }, () => Array(cols).fill(false))
    this.inverse = false
    this.cursorVisible = true
    this.x = 0
    this.y = 0
    this.top = 0
    this.bottom = rows - 1
    this.saved = [0, 0, false]
    this.pending = ''
    this.main = undefined
    this.synchronized = false
  }

  /** Preserve both text and cursor styling when the application receives a real resize. */
  resize(cols, rows) {
    const resize = (cells, blank) => Array.from({ length: rows }, (_, y) =>
      Array.from({ length: cols }, (_, x) => cells[y]?.[x] ?? blank))
    this.cells = resize(this.cells, ' ')
    this.inverseCells = resize(this.inverseCells, false)
    if (this.main) {
      this.main.cells = resize(this.main.cells, ' ')
      this.main.inverseCells = resize(this.main.inverseCells, false)
      this.main.x = Math.min(this.main.x, cols - 1)
      this.main.y = Math.min(this.main.y, rows - 1)
    }
    this.cols = cols
    this.rows = rows
    this.top = 0
    this.bottom = rows - 1
    this.x = Math.min(this.x, cols - 1)
    this.y = Math.min(this.y, rows - 1)
  }

  /** Keep whitespace inside rows so prompt prefixes and Unicode remain observable. */
  text() {
    return this.cells.map(row => row.join('').trimEnd()).join('\n')
  }

  /** A styled blank can be the cursor, so its text alone is insufficient evidence. */
  inverseAt(x, y) {
    return this.inverseCells[y]?.[x] ?? false
  }

  /** Read DEC mode 25 independently of a terminal emulator's blink timer. */
  hardwareCursorVisible() {
    return this.cursorVisible
  }

  /** Cell operations must never move text without its inverse-video evidence. */
  mutateCells(operation) {
    operation(this.cells, ' ')
    operation(this.inverseCells, false)
  }

  scroll(amount) {
    this.mutateCells((cells, blank) => {
      const region = cells.slice(this.top, this.bottom + 1)
      for (let n = 0; n < Math.min(Math.abs(amount), region.length); n++) {
        const row = Array(this.cols).fill(blank)
        if (amount > 0) { region.shift(); region.push(row) }
        else { region.pop(); region.unshift(row) }
      }
      cells.splice(this.top, region.length, ...region)
    })
  }

  lineFeed() {
    if (this.y === this.bottom) this.scroll(1)
    else this.y = Math.min(this.y + 1, this.rows - 1)
  }

  /** PTY chunk boundaries can split both controls and graphemes. */
  write(chunk) {
    this.pending += chunk
    while (this.pending !== '') {
      if (this.pending[0] === ESC) {
        if (this.pending.length < 2) return
        const next = this.pending[1]
        if (next === '[') {
          const match = CSI.exec(this.pending)
          if (match === null) return
          this.sequence(match[1], match[3])
          this.pending = this.pending.slice(match[0].length)
          continue
        }
        if (CONTROL_STRING.has(next)) {
          const end = this.pending.indexOf(ESC + '\\', 2)
          const bell = next === ']' ? this.pending.indexOf('\x07', 2) : -1
          if (end < 0 && bell < 0) return
          const useBell = bell >= 0 && (end < 0 || bell < end)
          this.pending = this.pending.slice(useBell ? bell + 1 : end + 2)
          continue
        }
        if (next === '(' || next === ')') {
          if (this.pending.length < 3) return
          this.pending = this.pending.slice(3)
          continue
        }
        if (next === '7') this.saved = [this.x, this.y, this.inverse]
        else if (next === '8') [this.x, this.y, this.inverse] = this.saved
        else if (next === 'D') this.lineFeed()
        else if (next === 'M') { if (this.y === this.top) this.scroll(-1); else this.y = Math.max(0, this.y - 1) }
        else if (next === 'E') { this.x = 0; this.lineFeed() }
        else if (!['=', '>', 'N', 'O', '\\'].includes(next)) throw new Error('dogfood: unsupported cell-affecting ESC ' + JSON.stringify(next))
        this.pending = this.pending.slice(2)
        continue
      }
      const char = String.fromCodePoint(this.pending.codePointAt(0))
      this.pending = this.pending.slice(char.length)
      if (char === '\r') { this.x = 0; continue }
      if (char === '\n') { this.lineFeed(); continue }
      if (char === '\b') { this.x = Math.max(0, this.x - 1); continue }
      if (char === '\t') { this.x = Math.min(this.cols - 1, (Math.floor(this.x / TAB_WIDTH) + 1) * TAB_WIDTH); continue }
      if (char < ' ') continue
      const width = visibleWidth(char)
      if (width === 0) {
        if (this.x > 0) this.cells[this.y][this.x - 1] += char
        continue
      }
      if (this.x + width > this.cols) { this.x = 0; this.lineFeed() }
      this.cells[this.y][this.x] = char
      this.inverseCells[this.y][this.x] = this.inverse
      for (let i = 1; i < width && this.x + i < this.cols; i++) {
        this.cells[this.y][this.x + i] = ''
        this.inverseCells[this.y][this.x + i] = this.inverse
      }
      this.x += width
    }
  }

  /** Color operands may contain 0, 7, or 27 without requesting cursor styling. */
  rendition(raw) {
    const fields = raw.split(';')
    for (let index = 0; index < fields.length; index++) {
      const field = fields[index]
      const code = Number.parseInt(field, 10) || SGR_RESET
      if (COLOR_SGR.has(code)) {
        if (!field.includes(':')) {
          const mode = Number.parseInt(fields[++index], 10)
          if (mode === RGB_COLOR_MODE) index += RGB_CHANNELS
          else if (mode === INDEX_COLOR_MODE) index += 1
        }
      } else if (code === SGR_RESET || code === SGR_REVERSE_OFF) this.inverse = false
      else if (code === SGR_REVERSE) this.inverse = true
    }
  }

  sequence(raw, final) {
    const privateMode = /^[?><=]/u.test(raw)
    const values = raw.replace(/^[?><=]/u, '').split(';').map(value => Number.parseInt(value, 10) || 0)
    const first = values[0] || 1
    if (privateMode) {
      if (values.includes(2026) && (final === 'h' || final === 'l')) this.synchronized = final === 'h'
      if (values.includes(CURSOR_VISIBLE_MODE) && (final === 'h' || final === 'l')) this.cursorVisible = final === 'h'
      if (values.includes(1049) && final === 'h' && !this.main) {
        this.main = { cells: this.cells, inverseCells: this.inverseCells, inverse: this.inverse, x: this.x, y: this.y }
        this.mutateCells((cells, blank) => {
          const cleared = cells.map(() => Array(this.cols).fill(blank))
          if (cells === this.cells) this.cells = cleared
          else this.inverseCells = cleared
        })
        this.x = 0; this.y = 0
      } else if (values.includes(1049) && final === 'l' && this.main) {
        this.cells = this.main.cells; this.inverseCells = this.main.inverseCells; this.inverse = this.main.inverse
        this.x = this.main.x; this.y = this.main.y; this.main = undefined
      }
      return
    }
    switch (final) {
      case 'A': this.y = Math.max(0, this.y - first); break
      case 'B': this.y = Math.min(this.rows - 1, this.y + first); break
      case 'C': this.x = Math.min(this.cols - 1, this.x + first); break
      case 'D': this.x = Math.max(0, this.x - first); break
      case 'E': this.x = 0; this.y = Math.min(this.rows - 1, this.y + first); break
      case 'F': this.x = 0; this.y = Math.max(0, this.y - first); break
      case 'G': case '`': this.x = Math.min(this.cols - 1, first - 1); break
      case 'd': this.y = Math.min(this.rows - 1, first - 1); break
      case 'H': case 'f': this.y = Math.min(this.rows - 1, first - 1); this.x = Math.min(this.cols - 1, (values[1] || 1) - 1); break
      case 'J': case 'K': case 'X': case 'P': case '@': case 'L': case 'M':
        this.mutateCells((cells, value) => {
          const blank = () => Array(this.cols).fill(value)
          switch (final) {
            case 'J':
              if (values[0] === 2 || values[0] === 3) { for (let y = 0; y < this.rows; y++) cells[y] = blank() }
              else if (values[0] === 1) { for (let y = 0; y < this.y; y++) cells[y] = blank(); cells[this.y].fill(value, 0, this.x + 1) }
              else { cells[this.y].fill(value, this.x); for (let y = this.y + 1; y < this.rows; y++) cells[y] = blank() }
              break
            case 'K': cells[this.y].fill(value, values[0] === 1 || values[0] === 2 ? 0 : this.x, values[0] === 1 ? this.x + 1 : this.cols); break
            case 'X': cells[this.y].fill(value, this.x, Math.min(this.cols, this.x + first)); break
            case 'P': cells[this.y].splice(this.x, first); while (cells[this.y].length < this.cols) cells[this.y].push(value); break
            case '@': cells[this.y].splice(this.x, 0, ...Array(first).fill(value)); cells[this.y].length = this.cols; break
            case 'L': cells.splice(this.y, 0, ...Array.from({ length: first }, blank)); cells.length = this.rows; break
            case 'M': cells.splice(this.y, Math.min(first, this.rows - this.y)); while (cells.length < this.rows) cells.push(blank()); break
          }
        })
        break
      case 'S': this.scroll(first); break
      case 'T': this.scroll(-first); break
      case 'r': this.top = first - 1; this.bottom = Math.min(this.rows - 1, (values[1] || this.rows) - 1); this.x = 0; this.y = 0; break
      case 's': this.saved = [this.x, this.y, this.inverse]; break
      case 'u': [this.x, this.y, this.inverse] = this.saved; break
      case 'm': this.rendition(raw); break
      // Negotiation is accepted without claiming emulator-dependent visual behavior.
      case 'h': case 'l': case 'n': case 'c': case 'q': case 't': break
      default: throw new Error('dogfood: unsupported cell-affecting CSI ' + JSON.stringify(raw + final))
    }
  }
}
