import { describe, expect, it } from 'vitest'
import { HOST_WRITE_DROPPED, holdHostWrites, type HostWritable } from '@/terminal/host-writes.ts'

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

  it('bounds what it holds and says what it had to drop', () => {
    const screen = stream()
    const terminal = stream()
    const guard = holdHostWrites({ terminal, targets: [screen], limit: 8 })
    screen.write('12345')
    screen.write('67890')
    guard.release()
    const flushed = screen.written.at(-1) ?? ''
    expect(flushed).toContain('67890')
    expect(flushed).toContain(HOST_WRITE_DROPPED)
    expect(flushed).not.toContain('12345')
  })

  it('gives every stream its own write back, exactly as it found it', () => {
    const screen = stream()
    const terminal = stream()
    const before = screen.write
    const guard = holdHostWrites({ terminal, targets: [screen] })
    expect(screen.write).not.toBe(before)
    guard.release()
    expect(screen.write).toBe(before)
    guard.release()
    expect(screen.write).toBe(before)
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
})
