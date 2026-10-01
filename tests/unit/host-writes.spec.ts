import { describe, expect, it } from 'vitest'
import { HOST_WRITE_DROPPED, holdHostWrites, type HostWritable } from '@/terminal/host-writes.ts'

const UTF8_BYTE_BUDGET = 4
const OVERSIZE_BYTE_BUDGET = 3
const INVALID_BYTE_BUDGETS = [-1, NaN, Infinity, 1.5]
const ZERO_BYTE_BUDGET = 0
const ZERO_BUDGET_DIAGNOSTIC = 'diagnostic'

/** A stream that remembers what reached it. */
interface FakeStream extends HostWritable {
  readonly written: string[]
}

const stream = (): FakeStream => {
  const written: string[] = []
  return { written, write: (chunk: unknown) => { written.push(String(chunk)); return true } }
}

describe('holdHostWrites', () => {
  it('holds a host write until the screen is given back', () => {
    const screen = stream()
    const errors = stream()
    const terminal = stream()
    const guard = holdHostWrites({ terminal, targets: [screen, errors] })
    // The surface's own frame goes through the terminal object and must arrive.
    terminal.write('frame\n')
    screen.write('a log line\n')
    errors.write('an error line\n')
    expect(terminal.written).toEqual(['frame\n'])
    expect(screen.written).toEqual([])
    expect(errors.written).toEqual([])
    guard.release()
    expect(screen.written).toEqual(['a log line\n'])
    expect(errors.written).toEqual(['an error line\n'])
    // Once the screen is the shell's again, a host write is nobody's to hold.
    screen.write('after\n')
    expect(screen.written.at(-1)).toBe('after\n')
  })

  it('passes a sequence the terminal writes without going through its own write', () => {
    const screen = stream()
    const terminal = {
      write: (chunk: unknown) => screen.write(chunk),
      hideCursor: () => screen.write('\x1b[?25l'),
    }
    const guard = holdHostWrites({ terminal, targets: [screen] })
    // A terminal's start-up and frame control reach the stream directly, and a
    // reader watches for them while the screen is up.
    terminal.write('frame\n')
    terminal.hideCursor()
    screen.write('a log line\n')
    expect(screen.written).toEqual(['frame\n', '\x1b[?25l'])
    guard.release()
    expect(screen.written).toEqual(['frame\n', '\x1b[?25l', 'a log line\n'])
  })

  it('does not leave the surface mark up across an awaiting terminal call', async () => {
    const screen = stream()
    const terminal = {
      write: (chunk: unknown) => screen.write(chunk),
      async drain(): Promise<void> {
        await new Promise(resolve => setTimeout(resolve, 0))
      },
    }
    const guard = holdHostWrites({ terminal, targets: [screen] })
    const drained = terminal.drain()
    screen.write('a log line during the drain\n')
    expect(screen.written).toEqual([])
    await drained
    guard.release()
    expect(screen.written).toEqual(['a log line during the drain\n'])
  })

  it('drops the oldest writes past the budget and says how many', () => {
    const screen = stream()
    const terminal = stream()
    const guard = holdHostWrites({ terminal, targets: [screen], limit: 8 })
    screen.write('12345')
    screen.write('67890')
    guard.release()
    const flushed = screen.written.at(-1) ?? ''
    expect(flushed).toContain('67890')
    expect(flushed).toBe(`${HOST_WRITE_DROPPED} (1 writes)\n67890`)
    expect(flushed).not.toContain('12345')
  })

  it('reports dropped writes even when the retention budget is zero', () => {
    const screen = stream()
    const terminal = stream()
    const guard = holdHostWrites({ terminal, targets: [screen], limit: ZERO_BYTE_BUDGET })
    screen.write(ZERO_BUDGET_DIAGNOSTIC)
    expect(screen.written).toEqual([])
    guard.release()
    expect(screen.written).toEqual([`${HOST_WRITE_DROPPED} (1 writes)\n`])
  })

  it('drops a single over-budget write whole and reports its loss', () => {
    const screen = stream()
    const terminal = stream()
    const guard = holdHostWrites({ terminal, targets: [screen], limit: 8 })
    const oversized = 'x'.repeat(32)
    // A single diagnostic must not bypass the byte bound or reach the shell cut in half.
    screen.write(oversized)
    guard.release()
    expect(screen.written).toEqual([`${HOST_WRITE_DROPPED} (1 writes)\n`])
  })

  it('preserves earlier bounded messages when a later write is oversized', () => {
    const screen = stream()
    const terminal = stream()
    const guard = holdHostWrites({ terminal, targets: [screen], limit: 8 })
    const oversized = 'x'.repeat(32)
    screen.write('12345')
    screen.write(oversized)
    guard.release()
    // An oversized record must not evict useful bounded diagnostics that still fit.
    expect(screen.written).toEqual([`${HOST_WRITE_DROPPED} (1 writes)\n12345`])
  })

  it('gives every stream its own write back, exactly as it found it', () => {
    const screen = stream()
    const terminal = stream()
    const before = Object.getOwnPropertyDescriptor(screen, 'write')
    const guard = holdHostWrites({ terminal, targets: [screen] })
    expect(screen.write).not.toBe(before?.value)
    guard.release()
    // The descriptor, not only the function: a stream that owned its write must
    // end writable and enumerable exactly as it started.
    expect(Object.getOwnPropertyDescriptor(screen, 'write')).toEqual(before)
    guard.release()
    expect(Object.getOwnPropertyDescriptor(screen, 'write')).toEqual(before)

    // A write that came from the prototype was never the stream's own, so the
    // restore has to remove this seam rather than pin the prototype's function.
    const inherited = Object.create(stream()) as FakeStream
    const inheritedGuard = holdHostWrites({ terminal: stream(), targets: [inherited] })
    expect(Object.getOwnPropertyDescriptor(inherited, 'write')).toBeDefined()
    inheritedGuard.release()
    expect(Object.getOwnPropertyDescriptor(inherited, 'write')).toBeUndefined()
  })

  it('answers a host write the way the stream would have', () => {
    const screen = stream()
    const terminal = stream()
    const guard = holdHostWrites({ terminal, targets: [screen] })
    let settled = 0
    screen.write('held', () => { settled += 1 })
    expect(settled).toBe(1)
    guard.release()
  })

  it('budgets UTF-8 bytes rather than UTF-16 code units', () => {
    const screen = stream()
    const terminal = stream()
    const guard = holdHostWrites({ terminal, targets: [screen], limit: UTF8_BYTE_BUDGET })
    screen.write('😀')
    screen.write('😀')
    guard.release()
    expect(screen.written.at(-1)).toBe(`${HOST_WRITE_DROPPED} (1 writes)\n😀`)
  })

  it('drops an oversized whole write while retaining smaller messages and callbacks', () => {
    const screen = stream()
    const terminal = stream()
    const guard = holdHostWrites({ terminal, targets: [screen], limit: OVERSIZE_BYTE_BUDGET })
    let completed = 0
    screen.write('ok')
    screen.write('😀', () => { completed += 1 })
    guard.release()
    expect(completed).toBe(1)
    expect(screen.written.at(-1)).toBe(`${HOST_WRITE_DROPPED} (1 writes)\nok`)
  })

  it.each(INVALID_BYTE_BUDGETS)('rejects invalid byte budget %s before replacing any stream', limit => {
    const screen = stream()
    const terminal = stream()
    const original = screen.write
    expect(() => holdHostWrites({ terminal, targets: [screen], limit })).toThrow(RangeError)
    expect(screen.write).toBe(original)
  })
})
