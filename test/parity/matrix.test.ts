import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'vitest'

const PARITY_DOCUMENT = new URL('../../docs/parity.md', import.meta.url)
const REQUIRED_CAPABILITIES = Object.freeze([
  'attachments.images',
  'deliverables.files',
  'conversation.export',
  'locale.chrome',
  'workspace.directory-selection',
  'runtime.browser-surface',
  'browser.rich-content',
  'notifications.status',
] as const)
const UNRESOLVED_MARKER = /\b(?:TBD|UNKNOWN)\b|TODO:/u
const GENERATED_NOTICE = '<!-- Generated from docs/parity.json. Edit the manifest, then update this file. -->'

test('summarizes renderer-specific parity decisions from the capability manifest', async () => {
  const document = await readFile(PARITY_DOCUMENT, 'utf8')

  for (const capability of REQUIRED_CAPABILITIES) assert.equal(document.includes(`\`${capability}\``), true)
  assert.doesNotMatch(document, UNRESOLVED_MARKER)
  assert.equal(document.startsWith(GENERATED_NOTICE), true)
  assert.match(document, /Implemented/u)
  assert.match(document, /Terminal alternative/u)
  assert.match(document, /Web-only exclusion/u)
})
