/** A real editor subprocess proves terminal handoff without opening a human editor. */
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, sep } from 'node:path'

const DRAFT_NAME = 'draft.md'
const INSERTED_LINE = 'external-editor-line'
const PRIVATE_MODE = 0o600
const file = process.argv[2]
const scratch = realpathSync(process.env.TMPDIR)
const parent = realpathSync(dirname(file))
const stat = lstatSync(file)
if (!parent.startsWith(scratch + sep) || basename(file) !== DRAFT_NAME || !stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== PRIVATE_MODE) {
  throw new Error('dogfood-editor: refusing a file outside the private draft handoff')
}
writeFileSync(file, readFileSync(file, 'utf8') + '\n' + INSERTED_LINE, { mode: PRIVATE_MODE })
