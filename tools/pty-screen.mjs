/** Decode the PTY's current cells so historical redraws cannot satisfy live assertions. */
import { visibleWidth } from '@earendil-works/pi-tui'

const ESC = '\x1b'
const TAB_WIDTH = 8
const CSI = /^\x1b\[([0-?]*)([ -/]*)([@-~])/u
const CONTROL_STRING = new Set([']', 'P', '_', '^', 'X'])

/** This decoder tracks cells, not styling or emulator-dependent hardware behavior. */
export class PtyScreen {
  constructor(cols, rows) {
    this.cols = cols
    this.rows = rows
    this.cells = Array.from({ length: rows }, () => Array(cols).fill(' '))
    this.x = 0
    this.y = 0
    this.top = 0
    this.bottom = rows - 1
    this.saved = [0, 0]
    this.pending = ''
    this.main = undefined
    this.synchronized = false
  }

  /** Preserve the viewport while the application receives a real resize event. */
  resize(cols, rows) {
    this.cells = Array.from({ length: rows }, (_, y) =>
      Array.from({ length: cols }, (_, x) => this.cells[y]?.[x] ?? ' '))
    if (this.main) {
      this.main.cells = Array.from({ length: rows }, (_, y) => Array.from({ length: cols }, (_, x) => this.main.cells[y]?.[x] ?? ' '))
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

  /** Keep whitespace inside rows; prompt prefixes and Unicode remain observable. */
  text() {
    return this.cells.map(row => row.join('').trimEnd()).join('\n')
  }

  scroll(amount) {
    const region = this.cells.slice(this.top, this.bottom + 1)
    for (let n = 0; n < Math.min(Math.abs(amount), region.length); n++) {
      const blank = Array(this.cols).fill(' ')
      if (amount > 0) { region.shift(); region.push(blank) }
      else { region.pop(); region.unshift(blank) }
    }
    this.cells.splice(this.top, region.length, ...region)
  }

  lineFeed() {
    if (this.y === this.bottom) this.scroll(1)
    else this.y = Math.min(this.y + 1, this.rows - 1)
  }

  /** Buffer partial escape sequences because a PTY splits output at arbitrary bytes. */
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
        if (next === '7') this.saved = [this.x, this.y]
        else if (next === '8') [this.x, this.y] = this.saved
        else if (next === 'D') this.lineFeed()
        else if (next === 'M') { if (this.y === this.top) this.scroll(-1); else this.y = Math.max(0, this.y - 1) }
        else if (next === 'E') { this.x = 0; this.lineFeed() }
        else if (!['=', '>', 'N', 'O', '\\'].includes(next)) throw new Error(`dogfood: unsupported cell-affecting ESC ${JSON.stringify(next)}`)
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
      for (let i = 1; i < width && this.x + i < this.cols; i++) this.cells[this.y][this.x + i] = ''
      this.x += width
    }
  }

  sequence(raw, final) {
    const privateMode = /^[?><=]/u.test(raw)
    const values = raw.replace(/^[?><=]/u, '').split(';').map(value => Number.parseInt(value, 10) || 0)
    const first = values[0] || 1
    const blank = () => Array(this.cols).fill(' ')
    if (privateMode) {
      if (values.includes(2026) && (final === 'h' || final === 'l')) this.synchronized = final === 'h'
      if (values.includes(1049) && final === 'h' && !this.main) {
        this.main = { cells: this.cells, x: this.x, y: this.y }
        this.cells = this.cells.map(blank); this.x = 0; this.y = 0
      } else if (values.includes(1049) && final === 'l' && this.main) {
        this.cells = this.main.cells; this.x = this.main.x; this.y = this.main.y; this.main = undefined
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
      case 'J':
        if (values[0] === 2 || values[0] === 3) this.cells = this.cells.map(blank)
        else if (values[0] === 1) { for (let y = 0; y < this.y; y++) this.cells[y] = blank(); this.cells[this.y].fill(' ', 0, this.x + 1) }
        else { this.cells[this.y].fill(' ', this.x); for (let y = this.y + 1; y < this.rows; y++) this.cells[y] = blank() }
        break
      case 'K': this.cells[this.y].fill(' ', values[0] === 1 || values[0] === 2 ? 0 : this.x, values[0] === 1 ? this.x + 1 : this.cols); break
      case 'S': this.scroll(first); break
      case 'T': this.scroll(-first); break
      case 'r': this.top = first - 1; this.bottom = Math.min(this.rows - 1, (values[1] || this.rows) - 1); this.x = 0; this.y = 0; break
      case 's': this.saved = [this.x, this.y]; break
      case 'u': [this.x, this.y] = this.saved; break
      case 'X': this.cells[this.y].fill(' ', this.x, Math.min(this.cols, this.x + first)); break
      case 'P': this.cells[this.y].splice(this.x, first); while (this.cells[this.y].length < this.cols) this.cells[this.y].push(' '); break
      case '@': this.cells[this.y].splice(this.x, 0, ...Array(first).fill(' ')); this.cells[this.y].length = this.cols; break
      case 'L': this.cells.splice(this.y, 0, ...Array.from({ length: first }, blank)); this.cells.length = this.rows; break
      case 'M': this.cells.splice(this.y, Math.min(first, this.rows - this.y)); while (this.cells.length < this.rows) this.cells.push(blank()); break
      // Styling and terminal negotiation do not move cells; accepting them avoids inventing visual evidence.
      case 'm': case 'h': case 'l': case 'n': case 'c': case 'q': case 't': break
      default: throw new Error(`dogfood: unsupported cell-affecting CSI ${JSON.stringify(raw + final)}`)
    }
  }
}
