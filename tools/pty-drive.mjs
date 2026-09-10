#!/usr/bin/env node
/**
 * Drive the terminal surface inside a real PTY.
 *
 * The surface refuses to start without a TTY, so an automated check has to
 * allocate one. This harness answers the questions a unit test cannot: does the
 * profile boot, does submitted text reach the agent, and what does the human
 * actually see on screen.
 *
 * Usage:
 *   node tools/pty-drive.mjs --prompt "Reply with exactly: pong" [--home DIR] [--seconds 30]
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pty from 'node-pty'

/**
 * Rebuild before driving.
 *
 * A linked profile loads the package's built entry point, so edits under src/
 * are invisible until the build runs: without this step the harness would
 * happily verify the previous release of the surface.
 */
function build() {
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  const result = spawnSync('pnpm', ['build'], { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) {
    console.error('pty-drive: build failed; refusing to drive a stale surface')
    process.exit(1)
  }
}

build()

/**
 * node-pty ships its macOS spawn helper without the executable bit, and a PTY
 * cannot be allocated without it. Repairing the packaged file here keeps the
 * harness runnable without patching a dependency for a dev-only tool.
 */
function ensureSpawnHelper() {
  if (process.platform !== 'darwin') return
  const require = createRequire(import.meta.url)
  const root = dirname(require.resolve('node-pty/package.json'))
  const helper = join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
  try {
    const mode = statSync(helper).mode
    if ((mode & 0o111) === 0) chmodSync(helper, mode | 0o755)
  } catch {
    // A missing prebuild means node-pty built from source; nothing to repair.
  }
}

ensureSpawnHelper()

const DSH_CHECKOUT = '/Users/dev/source/opensource/deepseek-harness/master'
const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const prompt = option('prompt', 'Reply with exactly: pong')
const home = option('home', undefined)
const seconds = Number.parseInt(option('seconds', '45'), 10)
const keep = option('log', join(tmpdir(), `dsh-tui-pty-${Date.now()}.log`))

const child = pty.spawn('pnpm', ['dsh', '--profile', 'tui'], {
  name: 'xterm-256color',
  cols: 100,
  rows: 30,
  cwd: DSH_CHECKOUT,
  env: { ...process.env, TERM: 'xterm-256color', ...(home === undefined ? {} : { DSH_HOME: home }) },
})

let raw = ''
child.onData(chunk => {
  raw += chunk
})

const strip = text => text
  .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/gu, '')
  .replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/gu, '')
  .replace(/\u001B[@-Z\\-_]/gu, '')

const at = (ms, action) => setTimeout(action, ms)
at(6000, () => child.write(`${prompt}\r`))
at(6000 + seconds * 1000, () => child.write('\u0003'))
at(6500 + seconds * 1000, () => child.write('/quit\r'))
at(9000 + seconds * 1000, () => {
  child.kill()
  mkdirSync(join(keep, '..'), { recursive: true })
  writeFileSync(keep, raw)
  const screen = strip(raw).split('\n').map(line => line.trimEnd()).filter((line, index, all) => line !== '' || all[index - 1] !== '')
  console.log(screen.join('\n').slice(-6000))
  console.log(`\n--- raw log: ${keep} (${raw.length} bytes) ---`)
  process.exit(0)
})