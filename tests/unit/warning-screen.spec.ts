import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Terminal } from '@earendil-works/pi-tui'
import { WarningSafeTui } from '@/terminal/warning-screen.ts'

const FIXTURE = fileURLToPath(new URL('../fixtures/warning-screen.mjs', import.meta.url))
const ENTER = '\x1b[?1049h'
const EXIT = '\x1b[?1049l'
/** The shell restore the class writes when the exit transcript cannot be rendered. */
const RESTORE_SHELL = '\x1b[?1049l\x1b[0m\x1b[?7h\x1b[?25h'
const BEFORE = 'warning-before-screen'
const DURING = 'warning-during-screen'
const AFTER = 'warning-after-screen'
const DIRECT_ERROR = 'ordinary-stderr-still-visible'
const TIMEOUT_MS = 10_000

function run(flags: string[] = [], mode = ''): string {
  const env = { ...process.env }
  delete env.NODE_OPTIONS
  delete env.NODE_NO_WARNINGS
  const result = spawnSync(process.execPath, [...flags, FIXTURE, mode], {
    env, encoding: 'utf8', timeout: TIMEOUT_MS,
  })
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
  return result.stderr
}

function expectAfterScreen(output: string, warning: string): void {
  expect(output).toContain(ENTER)
  expect(output).toContain(EXIT)
  expect(output.indexOf(warning)).toBeGreaterThan(output.indexOf(EXIT))
  expect(output.split(warning)).toHaveLength(2)
}

describe('WarningSafeTui', () => {
  it('defers native and application warnings until the screen closes, without losing details', () => {
    const output = run()
    expect(output).toContain(BEFORE)
    expect(output.indexOf(BEFORE)).toBeLessThan(output.indexOf(ENTER))
    expectAfterScreen(output, 'ExperimentalWarning: stripTypeScriptTypes')
    expectAfterScreen(output, DURING)
    expect(output).toContain('[DSH_TEST_WARNING]')
    expect(output).toContain('warning-detail-preserved')
    expect(output.indexOf(AFTER)).toBeGreaterThan(output.indexOf(DURING))
    // Host writing waits for the shell now: a stray log line that landed inside
    // a frame would be painted over and then skipped as unchanged.
    expect(output.indexOf(DIRECT_ERROR)).toBeGreaterThan(output.indexOf(EXIT))
    expect(output.split(DIRECT_ERROR)).toHaveLength(2)
  })

  it('preserves Node trace formatting and the original warning location', () => {
    const output = run(['--trace-warnings'])
    expectAfterScreen(output, 'ExperimentalWarning: stripTypeScriptTypes')
    expect(output).toContain('warning-screen.mjs:')
  })

  it('buffers again when the same screen restarts', () => {
    const output = run([], 'restart')
    expect(output.split(ENTER)).toHaveLength(3)
    expect(output.indexOf('warning-second-screen')).toBeGreaterThan(output.lastIndexOf(EXIT))
  })

  it('preserves explicit warning file redirection', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-warning-test-'))
    const file = join(directory, 'warnings.log')
    try {
      const output = run(['--redirect-warnings=' + file])
      expect(output).not.toContain(DURING)
      const warnings = readFileSync(file, 'utf8')
      expect(warnings).toContain(BEFORE)
      expect(warnings).toContain('ExperimentalWarning: stripTypeScriptTypes')
      expect(warnings).toContain(DURING)
      expect(warnings).toContain(AFTER)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('respects explicit warning suppression', () => {
    const output = run(['--no-warnings'])
    expect(output).not.toContain(BEFORE)
    expect(output).not.toContain(DURING)
    expect(output).not.toContain(AFTER)
    expect(output).not.toContain('ExperimentalWarning')
    expect(output).toContain(DIRECT_ERROR)
  })

  it('releases warnings and process hooks after a partial startup failure', () => {
    expectAfterScreen(run([], 'start-failure'), DURING)
  })

  it('keeps the screen and reports a component that cannot draw', () => {
    const output = run([], 'frame-failure')
    expectAfterScreen(output, 'frame-error-reported:frame-failed')
    // The held host line still reaches the reader, behind the exit sequence.
    expect(output).toContain(DIRECT_ERROR)
  })

  it('hands the shell back even when rendering the exit transcript fails', () => {
    expectAfterScreen(run([], 'stop-failure'), DURING)
  })
})

/** A terminal that records what the screen writes, so one process can be driven in-process. */
function fakeTerminal(writes: string[] = []): Terminal {
  return {
    writes,
    start: () => {},
    stop: () => {},
    drainInput: async () => {},
    write: (data: string) => {
      writes.push(data)
    },
    columns: 80,
    rows: 24,
    kittyProtocolActive: false,
    moveBy: () => {},
    hideCursor: () => {},
    showCursor: () => {},
    clearLine: () => {},
    clearFromCursor: () => {},
    clearScreen: () => {},
    setTitle: () => {},
    setProgress: () => {},
  } as unknown as Terminal
}

/**
 * The class in this process, where the warning hold it takes can be observed.
 *
 * The subprocess cases above prove the reader sees the ordering; these prove the
 * hold itself is released on every path that ends the screen, including the two
 * failures that never reach a normal stop.
 */
describe('WarningSafeTui warning hold', () => {
  it('defers a warning while the screen is up and delivers it as the screen closes', () => {
    const originalEmit = process.emit
    const tui = new WarningSafeTui(fakeTerminal())
    const seen: unknown[] = []
    const observe = (warning: unknown): void => {
      seen.push(warning)
    }
    process.on('warning', observe)
    tui.start()
    try {
      const warning = new Error('deferred while the screen is up')
      expect(process.emit('warning', warning)).toBe(true)
      // Nothing reaches a listener while the alternate screen owns the terminal:
      // a warning printed there would be painted over by the next frame.
      expect(seen).toEqual([])
    } finally {
      tui.stop()
      tui.stop()
      process.removeListener('warning', observe)
    }
    expect(seen).toEqual([expect.any(Error)])
    expect(process.emit).toBe(originalEmit)
  })

  it('lets an event that is not a warning through while the hold is active', () => {
    const tui = new WarningSafeTui(fakeTerminal())
    const seen: number[] = []
    const observe = (value: number): void => {
      seen.push(value)
    }
    const event: string = 'dsh-pass-through'
    process.on(event, observe)
    tui.start()
    try {
      // Only warnings wait for the shell; an event the surface emits for its own
      // listeners must not be swallowed by the hold. The cast reads the emit slot
      // at call time, which is the patched one while the screen is up.
      const emit = process.emit as unknown as (this: NodeJS.Process, event: string, ...args: unknown[]) => boolean
      expect(emit.call(process, event, 7)).toBe(true)
    } finally {
      tui.stop()
      process.removeListener(event, observe)
    }
    expect(seen).toEqual([7])
  })

  it('surfaces a warning listener that throws and still gives the emit slot back', () => {
    const originalEmit = process.emit
    const tui = new WarningSafeTui(fakeTerminal())
    const boom = new Error('listener-failed')
    const listener = (): void => {
      throw boom
    }
    process.on('warning', listener)
    tui.start()
    try {
      process.emit('warning', new Error('deferred while the screen is up'))
      expect(() => tui.stop()).toThrow(boom)
    } finally {
      process.removeListener('warning', listener)
      tui.stop()
    }
    expect(process.emit).toBe(originalEmit)
  })

  it('releases the held host streams even when a warning listener throws at close', () => {
    const tui = new WarningSafeTui(fakeTerminal())
    const stdoutWrite = process.stdout.write
    const stderrWrite = process.stderr.write
    const boom = new Error('listener-failed-at-close')
    const listener = (): void => {
      throw boom
    }
    process.on('warning', listener)
    tui.start()
    try {
      process.emit('warning', new Error('deferred while the screen is up'))
      expect(() => tui.stop()).toThrow(boom)
      // The hold is the terminal's own, so it must already be gone here: a
      // reader's stdout and stderr cannot stay captive to a broken listener
      // until some later stop() happens to release them.
      expect(process.stdout.write).toBe(stdoutWrite)
      expect(process.stderr.write).toBe(stderrWrite)
    } finally {
      process.removeListener('warning', listener)
      tui.stop()
    }
  })

  it('reports the first frame that cannot draw and stays quiet about the next', () => {
    const tui = new WarningSafeTui(fakeTerminal())
    const errors: unknown[] = []
    tui.start()
    try {
      tui.onFrameError = error => {
        errors.push(error)
      }
      tui.addChild({
        render: () => {
          throw new Error('frame-failed')
        },
        invalidate: () => {},
      })

      // A repaint the same broken component fails again is the same news:
      // repeating it would only loop on the timer that asked for the frame.
      expect(() => tui.doRender()).not.toThrow()
      expect(() => tui.doRender()).not.toThrow()
    } finally {
      tui.stop({ preserveScreen: true })
    }
    expect((errors[0] as Error).message).toBe('frame-failed')
    expect(errors).toHaveLength(1)
  })

  it('writes the shell restore itself when the exit transcript cannot be rendered', () => {
    const writes: string[] = []
    const tui = new WarningSafeTui(fakeTerminal(writes))
    tui.start()
    tui.render = () => {
      throw new Error('render-failed-at-exit')
    }

    expect(() => tui.stop()).toThrow('render-failed-at-exit')
    expect(writes.join('')).toContain(RESTORE_SHELL)
  })

  it('releases the warning hold when the terminal itself fails to start', () => {
    const originalEmit = process.emit
    const terminal = fakeTerminal()
    terminal.start = () => {
      throw new Error('terminal-start-failed')
    }
    const tui = new WarningSafeTui(terminal)

    // A startup that threw before any screen existed still owes the process its
    // own emit back; a held slot would defer every later warning forever.
    expect(() => tui.start()).toThrow('terminal-start-failed')
    expect(process.emit).toBe(originalEmit)
  })
})
