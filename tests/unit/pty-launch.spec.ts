import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const PROJECT_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const RELEASE_VERSION = '0.1.5-rc.3'
const SOURCE_VERSION = '0.1.7-alpha.2'
const POLICY_URL = pathToFileURL(join(PROJECT_ROOT, 'tools', 'pty-launch.mjs')).href
const ORIGINAL_PATH = process.env.PATH

type Launch = { home: string; cwd: string; command: string; argsPrefix: string[] }
type Prepare = (options: { home?: string; launcher?: string }) => Launch

let scratch: string
let preparePtyLaunch: Prepare

function launcher(version: string): string {
  const path = join(scratch, 'dsh-bin.mjs')
  writeFileSync(path, 'process.stdout.write(' + JSON.stringify(version + '\n') + ')\n')
  return path
}

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'dsh-pty-safety-'))
  const module = await import(POLICY_URL)
  preparePtyLaunch = module.preparePtyLaunch as Prepare
})

afterEach(() => {
  if (ORIGINAL_PATH === undefined) delete process.env.PATH
  else process.env.PATH = ORIGINAL_PATH
  rmSync(scratch, { recursive: true, force: true })
})

describe('PTY launcher safety', () => {
  it('uses the selected released launcher from the plugin checkout with an isolated home', () => {
    const selected = launcher(RELEASE_VERSION)
    expect(preparePtyLaunch({ home: scratch, launcher: selected })).toEqual({
      home: realpathSync(scratch),
      cwd: PROJECT_ROOT,
      command: process.execPath,
      argsPrefix: [selected],
    })
  })

  it('uses released dsh on PATH by default instead of a checkout launcher', () => {
    const executable = join(scratch, 'dsh')
    writeFileSync(executable, '#!/usr/bin/env node\nprocess.stdout.write(' + JSON.stringify(RELEASE_VERSION + '\n') + ')\n')
    chmodSync(executable, 0o755)
    process.env.PATH = scratch + delimiter + (ORIGINAL_PATH ?? '')
    expect(preparePtyLaunch({ home: scratch })).toEqual({
      home: realpathSync(scratch),
      cwd: PROJECT_ROOT,
      command: 'dsh',
      argsPrefix: [],
    })
  })

  it('refuses a run without an explicit scratch home', () => {
    expect(() => preparePtyLaunch({ launcher: launcher(RELEASE_VERSION) }))
      .toThrow(/--home.*isolated/)
  })

  it('refuses a home symlink into the live home', () => {
    const alias = join(scratch, 'home-link')
    symlinkSync(homedir(), alias)
    expect(() => preparePtyLaunch({ home: alias, launcher: launcher(RELEASE_VERSION) }))
      .toThrow(/--home.*live home/)
  })

  it('refuses a scratch home with a nested stash link into live state', () => {
    symlinkSync(join(homedir(), '.dsh', 'tui-stash'), join(scratch, 'tui-stash'))
    expect(() => preparePtyLaunch({ home: scratch, launcher: launcher(RELEASE_VERSION) }))
      .toThrow(/--home.*unsafe.*symlink/)
  })

  it('probes launcher versions in a disposable isolated home', () => {
    const trace = join(scratch, 'probe-home.txt')
    const selected = join(scratch, 'probe-bin.mjs')
    writeFileSync(selected, 'import { writeFileSync } from "node:fs"\nwriteFileSync(' + JSON.stringify(trace) + ', process.env.DSH_HOME ?? "")\nprocess.stdout.write(' + JSON.stringify(RELEASE_VERSION + '\n') + ')\n')
    preparePtyLaunch({ home: scratch, launcher: selected })
    const probeHome = readFileSync(trace, 'utf8')
    expect(probeHome.startsWith(realpathSync(scratch) + sep)).toBe(true)
    expect(existsSync(probeHome)).toBe(false)
  })

  it('refuses links that a launcher adds while reporting its version', () => {
    const selected = join(scratch, 'linking-bin.mjs')
    const alias = join(scratch, 'stash-link')
    writeFileSync(selected, 'import { symlinkSync } from "node:fs"\nsymlinkSync(' + JSON.stringify(join(homedir(), '.dsh', 'tui-stash')) + ', ' + JSON.stringify(alias) + ')\nprocess.stdout.write(' + JSON.stringify(RELEASE_VERSION + '\n') + ')\n')
    expect(() => preparePtyLaunch({ home: scratch, launcher: selected }))
      .toThrow(/--home.*unsafe.*symlink/)
  })

  it('refuses a source-host launcher even with an isolated home', () => {
    expect(() => preparePtyLaunch({ home: scratch, launcher: launcher(SOURCE_VERSION) }))
      .toThrow(/launcher.*0\.1\.5-rc\.3.*0\.1\.7-alpha\.2/)
  })
})
