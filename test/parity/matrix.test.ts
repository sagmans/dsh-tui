import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'vitest'

const PARITY_DOCUMENT = new URL('../../docs/parity.md', import.meta.url)
const REQUIRED_CAPABILITIES = Object.freeze([
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-ui-deliverables',
  '@deepseek-ai/dsh-session-log-export',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-host-directory-picker',
  'React client halves',
  'HTML/SVG',
  'notifications',
] as const)
const UNRESOLVED_MARKER = /\b(?:TBD|TODO|UNKNOWN)\b/iu

test('documents every renderer-specific parity decision without unresolved gaps', async () => {
  const document = await readFile(PARITY_DOCUMENT, 'utf8')

  for (const capability of REQUIRED_CAPABILITIES) assert.match(document, new RegExp(capability.replaceAll('/', '\\/'), 'u'))
  assert.doesNotMatch(document, UNRESOLVED_MARKER)
  assert.match(document, /Implemented/u)
  assert.match(document, /Terminal alternative/u)
  assert.match(document, /Web-only exclusion/u)
})
