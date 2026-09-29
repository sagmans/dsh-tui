import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'

const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const VITEST_CLI = fileURLToPath(new URL('../../node_modules/vitest/vitest.mjs', import.meta.url))
const SPEC = 'tests/unit/herdr-test-isolation.spec.ts'
const LIFECYCLE_SPEC = 'tests/unit/surface-terminal-lifecycle.spec.ts'
const HERDR_PREFIX = 'HERDR_'
const PROBE_FLAG = 'DSH_HERDR_ISOLATION_PROBE'
const RETAINED_VALUE = 'keep-unrelated-environment'
const CHILD_TIMEOUT_MS = 20_000
const TEST_TIMEOUT_MS = 25_000

// A separate runner must receive the unsafe environment: changing this worker
// after startup would miss the config-loading boundary that protects fixtures.
if (process.env[PROBE_FLAG] === RETAINED_VALUE) {
  const inheritedKeys = Object.keys(process.env).filter(key => key.startsWith(HERDR_PREFIX))

  it('starts workers without pane identity and keeps fake env overrides reversible', () => {
    expect(inheritedKeys).toEqual([])
    expect(process.env[PROBE_FLAG]).toBe(RETAINED_VALUE)
    try {
      vi.stubEnv('HERDR_ENV', '1')
      expect(process.env.HERDR_ENV).toBe('1')
    } finally {
      vi.unstubAllEnvs()
    }
    expect(process.env.HERDR_ENV).toBeUndefined()
  })
} else {
  it('keeps real lifecycle fixtures from releasing the pane that launched Vitest', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'dsh-herdr-test-isolation-'))
    const calls = join(scratch, 'herdr-calls.jsonl')
    const executable = join(scratch, 'herdr')
    // Even the failing regression may contact only this recorder, never a live
    // socket or executable inherited from the developer's containing pane.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith(HERDR_PREFIX)))
    try {
      writeFileSync(executable, '#!' + process.execPath + '\n' +
        'require("node:fs").appendFileSync(' + JSON.stringify(calls) + ', JSON.stringify(process.argv.slice(2)) + "\\n")\n')
      chmodSync(executable, 0o755)
      const result = spawnSync(process.execPath, [VITEST_CLI, 'run', SPEC, LIFECYCLE_SPEC], {
        cwd: PROJECT_ROOT,
        env: {
          ...env,
          PATH: scratch + delimiter + (env.PATH ?? ''),
          [PROBE_FLAG]: RETAINED_VALUE,
          HERDR_ENV: '1',
          HERDR_PANE_ID: 'isolation-probe-pane',
          HERDR_WORKSPACE_ID: 'isolation-probe-workspace',
          HERDR_TAB_ID: 'isolation-probe-tab',
          HERDR_SOCKET_PATH: join(scratch, 'absent.sock'),
          HERDR_BIN_PATH: executable,
          HERDR_FUTURE_COORDINATE: 'must-not-survive',
        },
        encoding: 'utf8',
        timeout: CHILD_TIMEOUT_MS,
      })
      expect(result.error).toBeUndefined()
      expect(existsSync(calls) ? readFileSync(calls, 'utf8') : '', result.stdout + result.stderr).toBe('')
      expect(result.status, result.stdout + result.stderr).toBe(0)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }, TEST_TIMEOUT_MS)
}
