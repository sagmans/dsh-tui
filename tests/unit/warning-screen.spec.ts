import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const FIXTURE = fileURLToPath(new URL('../fixtures/warning-screen.mjs', import.meta.url))
const ENTER = '\x1b[?1049h'
const EXIT = '\x1b[?1049l'
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
    expect(output.indexOf(DIRECT_ERROR)).toBeGreaterThan(output.indexOf(ENTER))
    expect(output.indexOf(DIRECT_ERROR)).toBeLessThan(output.indexOf(EXIT))
  })

  it('preserves Node trace formatting and the original warning location', () => {
    const output = run(['--trace-warnings'])
    expectAfterScreen(output, 'ExperimentalWarning: stripTypeScriptTypes')
    expect(output).toContain('warning-screen.mjs:')
  })

  it('restores warning listeners, including once listeners, without duplicating delivery', () => {
    expect(run()).toContain(AFTER)
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

  it('hands the shell back even when rendering the exit transcript fails', () => {
    expectAfterScreen(run([], 'stop-failure'), DURING)
  })
})
