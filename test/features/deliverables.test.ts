import assert from 'node:assert/strict'
import { test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type {
  ConversationMatch,
  ConversationNodeContext,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ToolEventView } from '@deepseek-ai/dsh-api-remotes/client'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { deliverablesDefinition } from '../../src/client/conversation/deliverables.js'
import {
  apply,
  inject,
  resolveProducedMention,
} from '../../src/features/deliverables/index.js'
import { producedPaths } from '../../src/features/deliverables/projection.js'

/* oxlint-disable typescript/no-unsafe-type-assertion -- Fixtures cross branded and open Harness event boundaries. */
type Event = Parameters<ConversationNodeDefinition['match']>[0]
type DeliverablesState = ReturnType<typeof deliverablesDefinition.start>

function match(sourceEvent: Event, role: ConversationMatch['role'], view?: ToolEventView): ConversationMatch {
  return { event: sourceEvent, role, view, location: { kind: 'unresolved' } }
}

function context(
  matches: readonly ConversationMatch[],
  state?: DeliverablesState,
): ConversationNodeContext<DeliverablesState> {
  return {
    key: '1:tui-deliverables1',
    kind: deliverablesDefinition.kind,
    id: '1',
    matches,
    start: matches[0],
    state,
    current: new Map(),
  }
}

function runtimeEvent(type: string, seq: number, data: Readonly<Record<string, unknown>>): Event {
  return { type, seq, time: seq, data } as unknown as Event
}

function lineText(node: ReturnType<NonNullable<typeof deliverablesDefinition.buildViewNode>>): string {
  assert.notEqual(node, null)
  const data: unknown = node?.data
  if (typeof data !== 'object' || data === null) throw new Error('missing deliverables node data')
  const line: unknown = Reflect.get(data, 'line')
  if (typeof line !== 'object' || line === null) throw new Error('missing deliverables line')
  const text: unknown = Reflect.get(line, 'text')
  if (typeof text !== 'string') throw new Error('missing deliverables text')
  return text
}

test('projects all successful mutation paths in first-seen order', () => {
  const locations = Array.from({ length: 100 }, (_, index) => ({ path: `out/file-${index}.txt` }))
  locations.push({ path: 'out/file-0.txt' })
  const paths = producedPaths({
    card: 'generic',
    kind: 'edit',
    title: 'Generate outputs',
    rawInput: {},
    content: [],
    locations,
  }, false)

  assert.equal(paths.length, 100)
  assert.equal(paths[0], 'out/file-0.txt')
  assert.equal(paths.at(-1), 'out/file-99.txt')
  assert.deepEqual(producedPaths({ card: 'generic', kind: 'read', title: 'Read', content: [] }, false), [])
  assert.deepEqual(producedPaths({ card: 'diff', title: 'Failed', diffs: [], locations }, true), [])
  assert.deepEqual(producedPaths({
    card: 'diff',
    title: 'Unsafe',
    diffs: [],
    locations: [
      { path: 'https://example.invalid/output.txt' },
      { path: 'file:///tmp/output.txt' },
      { path: '//server/share/output.txt' },
      { path: 'safe/output.txt' },
      { path: 'C:\\safe\\output.txt' },
    ],
  }, false), ['safe/output.txt', 'C:\\safe\\output.txt'])
})

test('resolves exact and unique basename mentions while leaving ambiguity inert', () => {
  const paths = ['src/index.ts', 'test/index.ts', 'docs/guide.md']

  assert.equal(resolveProducedMention(paths, 'src/index.ts'), 'src/index.ts')
  assert.equal(resolveProducedMention(paths, 'guide.md'), 'docs/guide.md')
  assert.equal(resolveProducedMention(paths, 'index.ts'), undefined)
  assert.equal(resolveProducedMention(paths, 'https://example.invalid'), undefined)
  assert.equal(resolveProducedMention(['https://example.invalid/guide.md'], 'guide.md'), undefined)
})

test('publishes a completed turn-tail from successful tool locations', () => {
  const start = match(runtimeEvent('turn/start', 1, { turn: 1 }), 'start')
  const write = match(runtimeEvent('tool/call', 2, {
    turn: 1,
    step: 1,
    callId: 'write-one',
    name: 'write',
    arguments: '{}',
  }), 'update', {
    for: 'call',
    view: {
      card: 'diff',
      title: 'Write files',
      diffs: [],
      locations: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }],
    },
  })
  const result = match(runtimeEvent('tool/result', 3, {
    turn: 1,
    step: 1,
    message: {
      source: { callId: 'write-one' },
      content: [{ type: 'tool-result', isError: false, content: [{ type: 'text', text: 'ok' }] }],
    },
  }), 'update')
  const assistant = match(runtimeEvent('assistant/message', 4, {
    turn: 1,
    step: 2,
    message: { content: [{ type: 'text', text: 'Done.' }] },
  }), 'update')
  const end = match(runtimeEvent('turn/end', 5, { turn: 1, reason: { kind: 'completed' } }), 'update')
  const matches = [start, write, result, assistant, end]
  let state = deliverablesDefinition.start(context([start]), start, { previous: () => undefined })
  for (const update of matches.slice(1)) {
    state = deliverablesDefinition.update({ ...context(matches, state), state }, update)
  }

  const projected = deliverablesDefinition.buildViewNode?.(context(matches, state)) ?? null
  assert.equal(lineText(projected), 'produced files\n`src/a.ts`\n`src/b.ts`')
})

test('registers terminal file-reference guidance only while mounted', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt, { persona: '' })
    const mounted = ctx.plugin({ apply, inject })
    await mounted.await()

    const section = (await ctx.systemPrompt.assemble()).sections
      .find(entry => entry.name === 'ui:deliverable-file-references')
    assert.match(section?.text ?? '', /exact file-tool path/u)
    assert.match(section?.text ?? '', /terminal/u)

    await mounted.dispose()
    assert.equal((await ctx.systemPrompt.assemble()).sections
      .some(entry => entry.name === 'ui:deliverable-file-references'), false)
  } finally {
    await ctx.fiber.dispose()
  }
})

/* oxlint-enable typescript/no-unsafe-type-assertion */
