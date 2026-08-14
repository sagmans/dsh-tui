import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'vitest'

const MANIFEST_URL = new URL('../docs/parity.json', import.meta.url)
const DOCUMENT_URL = new URL('../docs/parity.md', import.meta.url)
const TARGET_VERSION = '0.1.0-rc.6'
const ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u
const CLASSIFICATIONS = new Set(['parity', 'terminal-alternative', 'web-only'] as const)
const STATUSES = new Set(['complete', 'partial', 'missing', 'excluded'] as const)
const INCOMPLETE_PROOF_PATTERN = /^(?:pending|planned):/u
const WEB_ONLY_UNAVAILABLE_PATTERN = /^Not applicable — browser-only/u
const GENERATED_NOTICE = '<!-- Generated from docs/parity.json. Edit the manifest, then update this file. -->'
const EXPECTED_WEB_PATCH_ROWS = new Set<string>([
  'system-prompt',
  'hmr',
  'session-query-sqlite',
  'tools',
  'code-runtime',
  'storage',
  'storage-json',
  'storage-domain',
  'message-feedback',
  'session-log-download',
  'workspace',
  'session-projection-cache',
  'session-stats',
  'directory-picker',
  'plugin-inventory',
  'api-gateway',
  'cordis-host-runner',
  'web-startup',
  'webserver',
  'web-runtime',
  'client-hmr',
  'modules',
  'connection',
  'api-remotes',
  'client-runtime',
  'cordis-client-runner',
  'ui-theme',
  'locale',
  'ui-layout',
  'ui-sidebar',
  'ui-settings',
  'ui-settings-general',
  'ui-settings-models',
  'ui-settings-plugin-inventory',
  'ui-conversation',
  'ui-tool',
  'ui-cordis',
  'ui-workflow-run',
  'ui-deliverables',
  'ui-workspace',
  'ui-input-trigger',
  'ui-commands',
  'ui-skill',
  'ui-subagent',
  'ui-jobs',
  'ui-goal',
  'ui-message-feedback',
  'ui-model-selection',
  'ui-permission',
  'ui-agent-preset',
  'ui-settings-plugins',
  'ui-plan',
  'ui-user-questions',
  'ui-trajectory',
  'tool-bash',
  'tool-pwsh',
  'tool-jobs',
  'tool-fs',
  'tool-fs-search',
  'tool-str-replace-editor',
  'skill-filesystem',
  'tool-skill',
  'tool-goal',
  'plan-mode',
  'compaction-basic',
  'command-compact',
  'tool-result-pruner',
  'tool-subagent-control',
  'tool-subagent-list-agents',
  'tool-subagent',
  'tool-subagent-fork',
  'workflow-worker-thread',
  'tool-workflow',
  'tool-ralph',
  'agent-instructions',
  'tool-todo',
  'tool-web',
  'agent-presets',
])

interface Capability {
  readonly id: string
  readonly title: string
  readonly webRows: readonly string[]
  readonly webPackages: readonly string[]
  readonly evidence: readonly string[]
  readonly classification: 'parity' | 'terminal-alternative' | 'web-only'
  readonly owner: string
  readonly keyboard: string
  readonly mouse: string
  readonly automatedProof: readonly string[]
  readonly dogfoodProof: string
  readonly status: 'complete' | 'partial' | 'missing' | 'excluded'
  readonly notes: string
}

interface Manifest {
  readonly target: string
  readonly sourceOfTruth: readonly string[]
  readonly capabilities: readonly Capability[]
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value)
}

function isStringArray(value: unknown): value is readonly string[] {
  return isUnknownArray(value) && value.every(item => typeof item === 'string')
}

function isClassification(value: unknown): value is Capability['classification'] {
  return value === 'parity' || value === 'terminal-alternative' || value === 'web-only'
}

function isStatus(value: unknown): value is Capability['status'] {
  return value === 'complete' || value === 'partial' || value === 'missing' || value === 'excluded'
}

function assertCapability(value: unknown): asserts value is Capability {
  assert.ok(isRecord(value))
  assert.equal(typeof value.id, 'string')
  assert.equal(typeof value.title, 'string')
  assert.ok(isStringArray(value.webRows))
  assert.ok(isStringArray(value.webPackages))
  assert.ok(isStringArray(value.evidence))
  assert.ok(isClassification(value.classification))
  assert.equal(typeof value.owner, 'string')
  assert.equal(typeof value.keyboard, 'string')
  assert.equal(typeof value.mouse, 'string')
  assert.ok(isStringArray(value.automatedProof))
  assert.equal(typeof value.dogfoodProof, 'string')
  assert.ok(isStatus(value.status))
  assert.equal(typeof value.notes, 'string')
}

function assertManifest(value: unknown): asserts value is Manifest {
  assert.ok(isRecord(value))
  assert.equal(typeof value.target, 'string')
  assert.ok(isStringArray(value.sourceOfTruth))
  assert.ok(isUnknownArray(value.capabilities))
  for (const capability of value.capabilities) assertCapability(capability)
}

function manifest(): Manifest | undefined {
  if (!existsSync(MANIFEST_URL)) return undefined
  const value: unknown = JSON.parse(readFileSync(MANIFEST_URL, 'utf8'))
  assertManifest(value)
  return value
}

function assertNonEmpty(value: string, label: string): void {
  assert.equal(typeof value, 'string', label)
  assert.notEqual(value.trim(), '', label)
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ')
}

function renderRows(capabilities: readonly Capability[]): string {
  if (capabilities.length === 0) return '_None._'
  return [
    '| Capability | Disposition | Status | Owner |',
    '| --- | --- | --- | --- |',
    ...capabilities.map(capability => [
      `\`${capability.id}\` — ${capability.title}`,
      capability.classification,
      capability.status,
      capability.owner,
    ].map(value => escapeCell(value)).join(' | ')).map(row => `| ${row} |`),
  ].join('\n')
}

function renderDocument(value: Manifest): string {
  const implemented = value.capabilities.filter(capability => capability.status === 'complete')
  const alternatives = value.capabilities.filter(capability => capability.classification === 'terminal-alternative')
  const exclusions = value.capabilities.filter(capability => capability.classification === 'web-only')
  return [
    GENERATED_NOTICE,
    '',
    '# Web–TUI capability parity',
    '',
    `Target: DeepSeek Harness Web \`${value.target}\`. Capability parity, not layout parity.`,
    '',
    'Web profile roster and shared runtime contracts are authoritative. Every non-Web-only action requires keyboard and mouse reachability plus automated and real-user proof.',
    '',
    'Keyboard paths, mouse paths, source evidence, automated proof, dogfood proof, and gap notes live in `docs/parity.json`.',
    '',
    '## Implemented',
    '',
    renderRows(implemented),
    '',
    '## Capability matrix',
    '',
    renderRows(value.capabilities),
    '',
    '## Terminal alternative',
    '',
    renderRows(alternatives),
    '',
    '## Web-only exclusion',
    '',
    renderRows(exclusions),
    '',
    '## Source of truth',
    '',
    ...value.sourceOfTruth.map(source => `- \`${source}\``),
    '',
  ].join('\n')
}

test('provides a machine-readable Web–TUI parity manifest', () => {
  assert.equal(existsSync(MANIFEST_URL), true, 'docs/parity.json must exist')
})

test('classifies every capability with evidence and dual-input paths', () => {
  const value = manifest()
  if (value === undefined) return

  assert.equal(value.target, TARGET_VERSION)
  assert.ok(value.sourceOfTruth.length > 0)
  assert.ok(value.capabilities.length > 0)

  const ids = new Set<string>()
  for (const capability of value.capabilities) {
    assert.match(capability.id, ID_PATTERN)
    assert.equal(ids.has(capability.id), false, `duplicate capability ${capability.id}`)
    ids.add(capability.id)
    assertNonEmpty(capability.title, `${capability.id}.title`)
    assert.equal(CLASSIFICATIONS.has(capability.classification), true, `${capability.id}.classification`)
    assert.equal(STATUSES.has(capability.status), true, `${capability.id}.status`)
    assert.ok(capability.webRows.length + capability.webPackages.length > 0, `${capability.id}.web source`)
    assert.ok(capability.evidence.length > 0, `${capability.id}.evidence`)
    assertNonEmpty(capability.owner, `${capability.id}.owner`)
    assertNonEmpty(capability.keyboard, `${capability.id}.keyboard`)
    assertNonEmpty(capability.mouse, `${capability.id}.mouse`)
    assert.ok(capability.automatedProof.length > 0, `${capability.id}.automatedProof`)
    assertNonEmpty(capability.dogfoodProof, `${capability.id}.dogfoodProof`)
    assertNonEmpty(capability.notes, `${capability.id}.notes`)

    if (capability.classification === 'web-only') {
      assert.equal(capability.status, 'excluded', `${capability.id}.status`)
      assert.match(capability.keyboard, WEB_ONLY_UNAVAILABLE_PATTERN)
      assert.match(capability.mouse, WEB_ONLY_UNAVAILABLE_PATTERN)
    } else {
      assert.doesNotMatch(capability.keyboard, WEB_ONLY_UNAVAILABLE_PATTERN)
      assert.doesNotMatch(capability.mouse, WEB_ONLY_UNAVAILABLE_PATTERN)
      assert.notEqual(capability.status, 'excluded')
    }

    if (capability.status === 'complete') {
      for (const proof of capability.automatedProof) assert.doesNotMatch(proof, INCOMPLETE_PROOF_PATTERN)
      assert.doesNotMatch(capability.dogfoodProof, INCOMPLETE_PROOF_PATTERN)
    }
  }
})

test('marks every terminal capability complete before claiming parity', () => {
  const value = manifest()
  if (value === undefined) return

  for (const capability of value.capabilities) {
    if (capability.classification === 'web-only') continue
    assert.equal(capability.status, 'complete', capability.id)
  }
})

test('covers every row in the Web profile patch', () => {
  const value = manifest()
  if (value === undefined) return

  const coveredRows = new Set(value.capabilities.flatMap(capability => capability.webRows))
  assert.deepEqual([...coveredRows].filter(row => !EXPECTED_WEB_PATCH_ROWS.has(row)).toSorted(), [])
  assert.deepEqual([...EXPECTED_WEB_PATCH_ROWS].filter(row => !coveredRows.has(row)).toSorted(), [])
})

test('derives the human parity document from the manifest', () => {
  const value = manifest()
  if (value === undefined) return

  assert.equal(readFileSync(DOCUMENT_URL, 'utf8'), renderDocument(value))
})
