#!/usr/bin/env node
/**
 * Link policy for the dogfood clone.
 *
 * A cloned home is a sandbox: a dogfood run may write only inside it. Two kinds
 * of link are legitimate there — a package entry that resolves to an installed
 * package or another checkout, and a link that stays inside the clone. Every
 * other link (a dotfile linked into a shared prompt tree is the common case)
 * reaches a path the run could write through, so it is copied in as a regular
 * file before the run starts and the link is dropped.
 *
 * Usage: clone-links.mjs check|materialize <home> <source>
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Paths whose whole purpose is to point at an installed package, which may live
 * outside the clone. A link here is expected; a link anywhere else is not.
 */
export const packageEntry = (parts) => parts[0] === 'profiles' && (
  parts[1] === 'node_modules' && parts.length > 2 ||
  parts[2] === 'node_modules' && parts.length > 3 ||
  parts[2] === '.dsh-module-fallback' && parts[3] === 'node_modules' && parts.length > 4
)

export const inside = (root, file) => file === root || file.startsWith(root + path.sep)

/**
 * Absolute path a link target will occupy once it exists. A clone may hold a
 * link to a file an install has not created yet, and the missing leaf can still
 * sit under a link that crosses the clone boundary.
 */
export function destination(file) {
  let ancestor = file
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor)
    if (parent === ancestor) throw Error('cannot resolve cloned link: ' + file)
    ancestor = parent
  }
  return path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, file))
}

const entries = (root) => fs.readdirSync(root, { withFileTypes: true })
const partsOf = (home, file) => path.relative(home, file).split(path.sep)

/** Every reason the clone cannot be run as a sandbox, in the order they are met. */
export function problems(home, source) {
  const found = []
  const visit = (dir) => {
    for (const entry of entries(dir)) {
      const file = path.join(dir, entry.name)
      const parts = partsOf(home, file)
      if (entry.isSymbolicLink()) {
        const target = destination(path.resolve(dir, fs.readlinkSync(file)))
        const allowed = packageEntry(parts) ? !inside(source, target) : inside(home, target)
        if (!allowed) found.push('unsafe cloned symlink escaping scratch or entering source home: ' + file)
      } else if (entry.isDirectory()) {
        visit(file)
      } else if (entry.isFile() && !packageEntry(parts) && fs.lstatSync(file).nlink > 1) {
        found.push('unsafe cloned hardlink outside package modules: ' + file)
      }
    }
  }
  visit(home)
  return found
}

/** Replace every escaping link with a copy of what it points at. */
export function materialize(home) {
  const report = { copied: 0, dropped: 0 }
  const visit = (dir) => {
    for (const entry of entries(dir)) {
      const file = path.join(dir, entry.name)
      const parts = partsOf(home, file)
      if (entry.isSymbolicLink()) {
        if (packageEntry(parts)) continue
        const target = destination(path.resolve(dir, fs.readlinkSync(file)))
        if (inside(home, target)) continue
        if (!fs.existsSync(target)) {
          fs.rmSync(file)
          console.log('materialize: dropped dangling link ' + path.relative(home, file))
          report.dropped += 1
          continue
        }
        const stat = fs.statSync(target)
        fs.rmSync(file, { recursive: true, force: true })
        if (stat.isDirectory()) {
          fs.cpSync(target, file, { recursive: true, dereference: true })
        } else {
          fs.copyFileSync(target, file)
          fs.chmodSync(file, stat.mode & 0o777)
        }
        console.log('materialize: copied ' + path.relative(home, file))
        report.copied += 1
        continue
      }
      if (entry.isDirectory()) visit(file)
    }
  }
  visit(home)
  return report
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, home, source] = process.argv.slice(2)
  if (mode === 'check') {
    const found = problems(home, source)
    for (const problem of found) console.error(problem)
    process.exitCode = found.length ? 1 : 0
  } else if (mode === 'materialize') {
    const report = materialize(home)
    console.log('materialize: ' + report.copied + ' external link(s) copied, ' + report.dropped + ' dangling link(s) dropped')
  } else {
    console.error('usage: clone-links.mjs check|materialize <home> <source>')
    process.exitCode = 2
  }
}
