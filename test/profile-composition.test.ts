import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'vitest'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'

const PROFILE_PATCH_URL = new URL('../cordis.patch.yml', import.meta.url)
const TEST_LABEL = 'dsh-tui profile test'
const BASE_FIXTURE: PatchOptions[] = [{
  insert: [
    { id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt' },
    { id: 'hmr', name: '@deepseek-ai/cordis-plugin-hmr' },
    { id: 'session-query-sqlite', name: '@deepseek-ai/dsh-session-query' },
    { id: 'tools', name: '@deepseek-ai/dsh-tools' },
  ],
}]
const EXPECTED_OVERRIDES = new Map<string, Readonly<Record<string, unknown>>>([
  ['system-prompt', {
    persona: 'You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.',
  }],
  ['session-query-sqlite', { path: ':memory:', openAt: 'never' }],
])
const EXPECTED_HOST_ROWS = new Map<string, string>([
  ['code-runtime', '@deepseek-ai/dsh-code-runtime-worker-thread'],
  ['storage', '@deepseek-ai/dsh-storage'],
  ['storage-json', '@deepseek-ai/dsh-storage-json'],
  ['storage-domain', '@deepseek-ai/dsh-storage-domain'],
  ['message-feedback', '@deepseek-ai/dsh-message-feedback'],
  ['session-log-download', '@deepseek-ai/dsh-session-log-export'],
  ['workspace', '@deepseek-ai/dsh-workspace'],
  ['session-projection-cache', '@deepseek-ai/dsh-session-projection-cache'],
  ['session-stats', '@deepseek-ai/dsh-session-stats'],
  ['directory-picker', '@deepseek-ai/dsh-host-directory-picker-auto'],
  ['plugin-inventory', '@deepseek-ai/dsh-host-plugin-inventory'],
  ['api-gateway', '@deepseek-ai/dsh-host-apiproxy'],
  ['cordis-host-runner', '@deepseek-ai/dsh-cordis-host-runner'],
  ['tui-startup', '@sagmans/dsh-tui/startup'],
  ['tui-client', '@sagmans/dsh-tui/service/client'],
  ['tui-kernel', '@sagmans/dsh-tui'],
  ['tui-shell', '@sagmans/dsh-tui/feature/shell'],
  ['tui-sessions', '@sagmans/dsh-tui/feature/sessions'],
  ['tui-conversation', '@sagmans/dsh-tui/feature/conversation'],
  ['tui-tools', '@sagmans/dsh-tui/feature/tools'],
  ['tui-interactions', '@sagmans/dsh-tui/feature/interactions'],
])
const FORBIDDEN_IDS = [
  'web-startup',
  'webserver',
  'web-runtime',
  'client-hmr',
  'modules',
  'connection',
  'cordis-client-runner',
  'ui-layout',
] as const

interface Entry {
  readonly id?: string
  readonly name?: string
  readonly disabled?: boolean | null
  readonly config?: unknown
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null
}

function profileEntries(): readonly Entry[] {
  return composeEntries([
    BASE_FIXTURE,
    loadOverlayPatches(TEST_LABEL, PROFILE_PATCH_URL.pathname),
  ])
}

test('keeps TUI surface policy aligned with the base profile', () => {
  const entries = profileEntries()

  for (const [id, config] of EXPECTED_OVERRIDES) {
    assert.deepEqual(entries.find(entry => entry.id === id)?.config, config)
  }
  assert.equal(entries.find(entry => entry.id === 'hmr')?.disabled, true)
})

test('mounts host parity and separately replaceable TUI rows', () => {
  const entries = profileEntries()

  for (const [id, name] of EXPECTED_HOST_ROWS) {
    assert.equal(entries.find(entry => entry.id === id)?.name, name)
  }
})

test('excludes browser transport and React UI rows', () => {
  const ids = new Set(profileEntries().map(entry => entry.id))

  for (const id of FORBIDDEN_IDS) assert.equal(ids.has(id), false)
  assert.equal([...ids].some(id => id?.startsWith('ui-') === true), false)
})

test('pins the published Harness compatibility line', () => {
  const metadata: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const dependencies = isRecord(metadata) && isRecord(metadata.dependencies) ? metadata.dependencies : {}

  assert.notDeepEqual(dependencies, {})
  for (const packageName of new Set([
    '@deepseek-ai/dsh-app-boot',
    ...[...EXPECTED_HOST_ROWS.values()].filter(name => name.startsWith('@deepseek-ai/')),
  ])) {
    assert.equal(dependencies[packageName], '0.1.0-rc.6', packageName)
  }
})
