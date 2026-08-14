import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'vitest'

const LOCKFILE_URL = new URL('../pnpm-lock.yaml', import.meta.url)
const PACKAGE_URL = new URL('../package.json', import.meta.url)
const WORKSPACE_URL = new URL('../pnpm-workspace.yaml', import.meta.url)
const EXPECTED_NAME = '@sagmans/dsh-tui'
const EXPECTED_PACKAGE_MANAGER = 'pnpm@11.7.0'
const EXPECTED_NODE_RANGE = '>=26.4.0'
const EXPECTED_CORDIS_VERSION = '4.0.1'
const EXPECTED_OPENTUI_VERSION = '0.5.1'
const SAFE_MARKED_VERSION = '17.0.5'
const SAFE_NANOID_VERSION = '3.3.18'

interface PackageMetadata {
  readonly dependencies?: Readonly<Record<string, string>>
  readonly engines?: { readonly node?: string }
  readonly exports?: Readonly<Record<string, unknown>>
  readonly files?: readonly string[]
  readonly name?: string
  readonly packageManager?: string
  readonly publishConfig?: { readonly access?: string }
  readonly scripts?: Readonly<Record<string, string>>
  readonly type?: string
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null
}

function readMetadata(): PackageMetadata | undefined {
  try {
    const metadata: unknown = JSON.parse(readFileSync(PACKAGE_URL, 'utf8'))

    return isRecord(metadata) ? metadata : undefined
  } catch {
    return undefined
  }
}

test('declares the publishable package and runtime floor', () => {
  const metadata = readMetadata()

  assert.equal(metadata?.name, EXPECTED_NAME)
  assert.equal(metadata?.type, 'module')
  assert.equal(metadata?.packageManager, EXPECTED_PACKAGE_MANAGER)
  assert.equal(metadata?.engines?.node, EXPECTED_NODE_RANGE)
  assert.equal(metadata?.publishConfig?.access, 'public')
})

test('pins compatible runtime dependencies and the audited Markdown fix', () => {
  const metadata = readMetadata()

  assert.equal(metadata?.dependencies?.['@opentui/core'], EXPECTED_OPENTUI_VERSION)
  assert.equal(metadata?.dependencies?.['@opentui/keymap'], EXPECTED_OPENTUI_VERSION)
  assert.equal(metadata?.dependencies?.['@deepseek-ai/cordis'], EXPECTED_CORDIS_VERSION)
})

test('resolves the audited Markdown fix under the supply-chain policy', () => {
  const lockfile = readFileSync(LOCKFILE_URL, 'utf8')
  const workspace = readFileSync(WORKSPACE_URL, 'utf8')

  assert.match(workspace, new RegExp(`marked: '${SAFE_MARKED_VERSION}'`, 'u'))
  assert.match(lockfile, new RegExp(`marked@${SAFE_MARKED_VERSION.replaceAll('.', '\\.')}`, 'u'))
  assert.doesNotMatch(lockfile, /marked@17\.0\.1/u)
  assert.match(workspace, new RegExp(`nanoid: '${SAFE_NANOID_VERSION}'`, 'u'))
  assert.match(lockfile, new RegExp(`nanoid@${SAFE_NANOID_VERSION.replaceAll('.', '\\.')}`, 'u'))
  assert.doesNotMatch(lockfile, /nanoid@3\.3\.17/u)
  assert.match(workspace, /minimumReleaseAge: 10080/u)
  assert.doesNotMatch(workspace, /@deepseek-ai\/\*/u)
})

test('publishes only built entrypoints and the profile patch', () => {
  const metadata = readMetadata()

  assert.deepEqual(metadata?.files, ['lib', 'cordis.patch.yml', 'docs', 'README.md', 'LICENSE'])
  assert.deepEqual(Object.keys(metadata?.exports ?? {}), [
    '.',
    './startup',
    './service/client',
    './feature/shell',
    './feature/sessions',
    './feature/conversation',
    './feature/model-selection',
    './feature/input-trigger',
    './feature/tools',
    './feature/deliverables',
    './feature/interactions',
    './feature/operations',
    './feature/trajectory',
    './feature/settings',
    './contracts',
    './testing',
    './cordis.patch.yml',
    './package.json',
  ])
  assert.equal(metadata?.scripts?.test, 'vitest run')
  assert.equal(
    metadata?.scripts?.check,
    'pnpm run typecheck && pnpm run lint && pnpm run test && pnpm run build',
  )
})
