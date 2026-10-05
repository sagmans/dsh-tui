import { Buffer } from 'node:buffer'
import { Editor, TuiAltScreen, type TuiAltScreenOptions, type Terminal, type TuiStopOptions, type TuiInputListener, type Component } from '@earendil-works/pi-tui'
import { createCursorController, SOFTWARE_CURSOR_MODE, NATIVE_CURSOR_MODE, type CursorController, type CursorMode } from './cursor.ts'
import { holdHostWrites, HOST_WRITE_LIMIT, HOST_WRITE_TARGETS, type HostWriteGuard } from './host-writes.ts'

const FOCUS_IN = '\x1b[I'
const FOCUS_OUT = '\x1b[O'
/** Preserve shell preferences across both cursor presentations without changing the native shape. */
const SAVE_CURSOR_MODES = '\x1b[?12s\x1b[?1004s'
const ENABLE_CURSOR_MODES = '\x1b[?12h\x1b[?1004h'
const ENABLE_FOCUS_REPORTS = '\x1b[?1004h'
const RESTORE_CURSOR_MODES = '\x1b[?1004r\x1b[?12r'
const WARNING_EVENT = 'warning'
const FATAL_EVENT = 'uncaughtExceptionMonitor'
const EXIT_EVENT = 'exit'
const WARNING_EVENT_LIMIT = 256
const ERROR_STACK_FIELD = 'stack'
const WARNING_TEXT_FIELDS = ['name', 'message', ERROR_STACK_FIELD, 'code', 'detail']
const HIGH_SURROGATE = /^[\ud800-\udbff]$/u
const LOW_SURROGATE = /^[\udc00-\udfff]$/u
const WARNING_DROPPED = '… warnings dropped'
const FRAME_REPORTER_FAILURE = 'frame error reporter failed'
const NATIVE_ERROR_STACK = Object.getOwnPropertyDescriptor(new Error(), ERROR_STACK_FIELD)
const RESTORE_SHELL = '\x1b[?1049l\x1b[0m\x1b[?7h\x1b[?25h'

/** Budget standard warning text without replacing the producer's retained event identity. */
function warningBytes(args: readonly unknown[]): number {
  let bytes = 0
  try {
    for (const argument of args) {
      const values: unknown[] = []
      if (argument instanceof Error) {
        // Retaining identity also retains every own metadata graph, not just the text Node prints.
        for (const field of new Set<PropertyKey>([...WARNING_TEXT_FIELDS, ...Reflect.ownKeys(argument)])) {
          const descriptor = Object.getOwnPropertyDescriptor(argument, field)
          // Native lazy stacks preserve trace locations; custom accessors can hide an unbounded closure.
          if (descriptor !== undefined && (descriptor.get !== undefined || descriptor.set !== undefined)
            && !(field === ERROR_STACK_FIELD && descriptor.get === NATIVE_ERROR_STACK?.get && descriptor.set === NATIVE_ERROR_STACK?.set)) {
            return HOST_WRITE_LIMIT + 1
          }
          bytes += Buffer.byteLength(String(field))
          values.push(Reflect.get(argument, field))
        }
      } else values.push(argument)
      for (const value of values) {
        if ((value !== null && typeof value === 'object') || typeof value === 'function') return HOST_WRITE_LIMIT + 1
        if (value !== undefined) bytes += Buffer.byteLength(String(value))
        if (bytes > HOST_WRITE_LIMIT) return bytes
      }
    }
  } catch {
    // Opaque metadata or throwing getters cannot establish a safe retention budget.
    return HOST_WRITE_LIMIT + 1
  }
  return bytes
}

/** Node's default warning listener writes outside the renderer, so delivery must wait for the shell. */
function deferWarnings(): () => void {
  const emit = process.emit
  const pending: unknown[][] = []
  let bytes = 0
  let dropped = 0
  let active = true
  const deferredEmit = function (this: NodeJS.Process, event: string | symbol, ...args: unknown[]): boolean {
    if (active && this === process && event === WARNING_EVENT) {
      // Root-cause warnings survive a burst; later repetitions must not grow the hold or repeatedly format stacks.
      if (pending.length >= WARNING_EVENT_LIMIT || bytes >= HOST_WRITE_LIMIT) dropped += 1
      else {
        const size = warningBytes(args)
        if (size > HOST_WRITE_LIMIT - bytes) dropped += 1
        else {
          pending.push(args)
          bytes += size
        }
      }
      return process.listenerCount(WARNING_EVENT) > 0
    }
    return Reflect.apply(emit, this, [event, ...args]) as boolean
  } as typeof process.emit
  process.emit = deferredEmit
  return () => {
    if (!active) return
    active = false
    // A later wrapper may own the slot; its retained reference must become a pass-through instead.
    if (process.emit === deferredEmit) process.emit = emit
    const failures: unknown[] = []
    bytes = 0
    for (const args of pending.splice(0)) {
      try {
        Reflect.apply(emit, process, [WARNING_EVENT, ...args])
      } catch (error) {
        failures.push(error)
      }
    }
    // One-shot consumers need the original root cause before an aggregate loss notification.
    if (dropped > 0) {
      try {
        Reflect.apply(emit, process, [WARNING_EVENT, new Error(`${WARNING_DROPPED}: ${dropped}`)])
      } catch (error) {
        failures.push(error)
      }
    }
    // Keep the first listener error intact for stop()'s post-cleanup rethrow;
    // later failures must not prevent remaining warnings from replaying.
    if (failures.length > 0) throw failures[0]
  }
}

/**
 * Terminal safety follows screen ownership, including partial startup and
 * repeated disposal: warnings wait for the shell, the host's own writing waits
 * with them, and a frame that cannot be drawn keeps the last good screen.
 */
export class WarningSafeTui extends TuiAltScreen {
  private releaseWarnings: (() => void) | undefined
  private hostWrites: HostWriteGuard | undefined
  private frameFailed = false
  private highSurrogate: string | undefined
  /** A stopped surface must never alter the cursor of an external editor. */
  private cursorModesActive = false
  /** Initialization follows super(): only the native constructor listener needs interception. */
  private readonly applicationListenersReady = true
  /** Fatal cleanup must preserve Node's original diagnostic and nonzero exit rather than claiming the exception. */
  private readonly restoreAfterCrash = (): void => {
    try {
      this.stop({ preserveScreen: true })
    } catch {
      // A restoration failure cannot replace the fatal error Node is already reporting.
    }
  }

  /** The terminal lifetime owns the clock; editors only consume its presentation. */
  readonly cursor: CursorController

  /** Each failure episode deserves a report, but repeated retries must not flood the surface. */
  onFrameError: ((error: unknown) => void) | undefined

  /**
   * The screen as this surface runs it, with the framework's other two parameters
   * out of the way: this owner supplies cursor presentation and writes no
   * drawing log of its own. Native mode remains available for shape and IME compatibility.
   */
  constructor(terminal: Terminal, options?: TuiAltScreenOptions, cursorMode: CursorMode = SOFTWARE_CURSOR_MODE) {
    super(terminal, cursorMode === NATIVE_CURSOR_MODE, undefined, options)
    this.cursor = createCursorController(cursorMode, () => this.requestRender())
    // The pinned stdin buffer splits legacy text into UTF-16 units; filters must receive complete Unicode scalars.
    this.addInputListener(data => {
      if (HIGH_SURROGATE.test(data)) {
        this.highSurrogate = data
        return { consume: true }
      }
      const previous = this.highSurrogate
      this.highSurrogate = undefined
      if (LOW_SURROGATE.test(data)) {
        return previous === undefined ? { consume: true } : { data: previous + data }
      }
      return undefined
    })
  }

  /** The native viewport listener consumes focus reports, so observation must precede that listener's cleanup. */
  override addInputListener(listener: TuiInputListener): () => void {
    if (this.applicationListenersReady) return super.addInputListener(listener)
    return super.addInputListener(data => {
      if (this.cursorModesActive && (data === FOCUS_IN || data === FOCUS_OUT)) {
        this.cursor.setTerminalFocused(data === FOCUS_IN)
        if (this.cursor.mode === NATIVE_CURSOR_MODE) this.setShowHardwareCursor(data === FOCUS_IN)
      }
      return listener(data)
    })
  }

  /** Editing focus can disappear while a picker owns input, without losing terminal focus. */
  override setFocus(component: Component | null): void {
    super.setFocus(component)
    this.cursor.setEditorFocused(component instanceof Editor && component.focused)
  }

  override start(): void {
    this.releaseWarnings ??= deferWarnings()
    this.hostWrites ??= holdHostWrites({ terminal: this.terminal, targets: HOST_WRITE_TARGETS })
    try {
      if (!this.cursorModesActive) {
        this.cursorModesActive = true
        process.on(FATAL_EVENT, this.restoreAfterCrash)
        process.on(EXIT_EVENT, this.restoreAfterCrash)
        this.terminal.write(SAVE_CURSOR_MODES + (this.cursor.mode === NATIVE_CURSOR_MODE ? ENABLE_CURSOR_MODES : ENABLE_FOCUS_REPORTS))
      }
      this.setShowHardwareCursor(this.cursor.mode === NATIVE_CURSOR_MODE)
      this.cursor.start()
      super.start()
    } catch (error) {
      this.stop({ preserveScreen: true })
      throw error
    }
  }

  /**
   * Draw a frame, keeping the last good one when drawing fails.
   *
   * A frame is composed before it is written, so a component that throws leaves
   * the previous screen intact; without this the throw would reach the timer that
   * asked for the frame, end the process, and take the terminal down with it.
   * The first failure is reported and later ones stay silent: a repaint a broken
   * component fails again is the same news, and repeating it would only loop.
   */
  override doRender(): void {
    try {
      super.doRender()
      this.frameFailed = false
    } catch (error) {
      if (this.frameFailed) return
      this.frameFailed = true
      try {
        this.onFrameError?.(error)
      } catch {
        // A broken reporter cannot replace a contained frame failure with an uncaught render-timer exception.
        process.emitWarning(FRAME_REPORTER_FAILURE)
      }
    }
  }

  override stop(options?: TuiStopOptions): void {
    // Cancel before any final frame or child-editor handoff can relinquish terminal ownership.
    this.cursor.stop()
    // A stopped or restarting owner must leave no fatal hooks pointing at its former terminal.
    process.removeListener(FATAL_EVENT, this.restoreAfterCrash)
    process.removeListener(EXIT_EVENT, this.restoreAfterCrash)
    this.highSurrogate = undefined
    try {
      super.stop(options)
    } catch (error) {
      // Rendering the final transcript can fail before pi-tui writes its alternate-screen exit.
      this.terminal.write(RESTORE_SHELL)
      throw error
    } finally {
      try {
        // Native stop disables focus reporting; restore saved modes only after its final write.
        if (this.cursorModesActive) {
          this.cursorModesActive = false
          this.terminal.write(RESTORE_CURSOR_MODES)
        }
      } finally {
        // Replay warnings before releasing host writes, so direct host-stream output
        // remains buffered until cleanup releases diagnostics. Replay cannot recover
        // the warnings' original positions among host writes.
        const release = this.releaseWarnings
        this.releaseWarnings = undefined
        let warningFailure: { readonly error: unknown } | undefined
        try {
          release?.()
        } catch (error) {
          // A listener that throws must not strand the host's own writing: the
          // hold below is the terminal's, and it goes back on every path out of
          // stop() — only then is the listener's failure surfaced again.
          warningFailure = { error }
        }
        const writes = this.hostWrites
        this.hostWrites = undefined
        writes?.release()
        if (warningFailure !== undefined) throw warningFailure.error
      }
    }
  }
}
