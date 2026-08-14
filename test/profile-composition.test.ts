import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'vitest'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'

const PROFILE_PATCH_URL = new URL('../cordis.patch.yml', import.meta.url)
const TEST_LABEL = 'dsh-tui profile test'
const DEFAULT_AGENT_PRESET_CONFIG = { default: 'standard' }
const AGENT_PLANE_ROWS = new Map<string, string>([
  ['tool-bash', '@deepseek-ai/dsh-tool-bash'],
  ['tool-pwsh', '@deepseek-ai/dsh-tool-pwsh'],
  ['tool-jobs', '@deepseek-ai/dsh-tool-jobs'],
  ['tool-fs', '@deepseek-ai/dsh-tool-fs'],
  ['tool-fs-search', '@deepseek-ai/dsh-tool-fs-search'],
  ['tool-str-replace-editor', '@deepseek-ai/dsh-tool-str-replace-editor'],
  ['skill-filesystem', '@deepseek-ai/dsh-skill-filesystem'],
  ['tool-skill', '@deepseek-ai/dsh-tool-skill'],
  ['tool-goal', '@deepseek-ai/dsh-tool-goal'],
  ['plan-mode', '@deepseek-ai/dsh-plan-mode'],
  ['compaction-basic', '@deepseek-ai/dsh-compaction-basic'],
  ['command-compact', '@deepseek-ai/dsh-command-compact'],
  ['tool-result-pruner', '@deepseek-ai/dsh-compaction-tool-result-pruner'],
  ['tool-subagent-control', '@deepseek-ai/dsh-tool-subagent-control'],
  ['tool-subagent-list-agents', '@deepseek-ai/dsh-tool-subagent-control/list-agents'],
  ['tool-subagent', '@deepseek-ai/dsh-tool-subagent'],
  ['tool-subagent-fork', '@deepseek-ai/dsh-tool-subagent'],
  ['workflow-worker-thread', '@deepseek-ai/dsh-workflow-worker-thread'],
  ['tool-workflow', '@deepseek-ai/dsh-tool-workflow'],
  ['tool-ralph', '@deepseek-ai/dsh-tool-ralph'],
  ['agent-instructions', '@deepseek-ai/dsh-agent-instructions'],
  ['tool-todo', '@deepseek-ai/dsh-tool-todo'],
  ['tool-web', '@deepseek-ai/dsh-tool-web'],
])
const BASE_FIXTURE: PatchOptions[] = [{
  insert: [
    { id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt' },
    { id: 'hmr', name: '@deepseek-ai/cordis-plugin-hmr' },
    { id: 'session-query-sqlite', name: '@deepseek-ai/dsh-session-query' },
    { id: 'tools', name: '@deepseek-ai/dsh-tools' },
    ...[...AGENT_PLANE_ROWS].map(([id, name]) => ({ id, name })),
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
  ['workspace', '@deepseek-ai/dsh-workspace'],
  ['session-projection-cache', '@deepseek-ai/dsh-session-projection-cache'],
  ['session-stats', '@deepseek-ai/dsh-session-stats'],
  ['directory-picker', '@deepseek-ai/dsh-host-directory-picker-browse'],
  ['plugin-inventory', '@deepseek-ai/dsh-host-plugin-inventory'],
  ['api-gateway', '@deepseek-ai/dsh-host-apiproxy'],
  ['cordis-host-runner', '@deepseek-ai/dsh-cordis-host-runner'],
  ['agent-presets', '@deepseek-ai/dsh-agent-presets'],
  ['tui-startup', '@sagmans/dsh-tui/startup'],
  ['tui-client', '@sagmans/dsh-tui/service/client'],
  ['tui-kernel', '@sagmans/dsh-tui'],
  ['tui-shell', '@sagmans/dsh-tui/feature/shell'],
  ['tui-sessions', '@sagmans/dsh-tui/feature/sessions'],
  ['tui-conversation', '@sagmans/dsh-tui/feature/conversation'],
  ['tui-tools', '@sagmans/dsh-tui/feature/tools'],
  ['tui-interactions', '@sagmans/dsh-tui/feature/interactions'],
  ['tui-operations', '@sagmans/dsh-tui/feature/operations'],
  ['tui-settings', '@sagmans/dsh-tui/feature/settings'],
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
  'session-log-download',
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

test('delegates the model-facing agent plane to presets', () => {
  const entries = profileEntries()

  for (const id of AGENT_PLANE_ROWS.keys()) {
    assert.equal(entries.find(entry => entry.id === id)?.disabled, true, id)
  }
  assert.deepEqual(entries.find(entry => entry.id === 'agent-presets')?.config, DEFAULT_AGENT_PRESET_CONFIG)
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
  assert.equal(dependencies['@deepseek-ai/dsh-host-directory-picker-auto'], undefined)
  assert.equal(dependencies['@deepseek-ai/dsh-session-log-export'], undefined)
})
