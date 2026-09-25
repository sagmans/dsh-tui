/**
 * The workspace each file suite builds on disk: scratch directories it owns,
 * a signal it can abort, and the git fixtures a containment case needs.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Candidate } from '@/input/file-search.ts'

export const scratch: string[] = []
export function scratchDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-files-'))
  scratch.push(root)
  return root
}
export const signal: AbortSignal = new AbortController().signal
export const hasGit = (() => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true } catch { return false }
})()
export const file = (path: string): Candidate => ({ path, isDirectory: false })
export const directory = (path: string): Candidate => ({ path, isDirectory: true })
export /** Git's empty blob, which an index entry may name without an object behind it. */
const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'
export function gitRepo(): string {
  const root = scratchDir()
  execFileSync('git', ['init', '-q'], { cwd: root })
  return root
}
export function track(root: string, ...paths: string[]): void {
  execFileSync('git', ['add', '--', ...paths], { cwd: root })
}
export /**
 * Put a script on PATH as `git`, so the failure branches are reached without
 * waiting for a real repository to break in the same way.
 */
async function withFakeGit(script: string, run: () => Promise<void>): Promise<void> {
  const bin = scratchDir()
  writeFileSync(join(bin, 'git'), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
  const previous = process.env.PATH ?? ''
  process.env.PATH = `${bin}:${previous}`
  try {
    await run()
  } finally {
    process.env.PATH = previous
  }
}
export const NOT_A_REPOSITORY = 'echo "fatal: not a git repository (or any of the parent directories): .git" >&2; exit 128'
