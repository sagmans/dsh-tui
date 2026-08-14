import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import {
  createInputTriggerController,
  detectInputTrigger,
  type InputTriggerPort,
} from '../../src/features/input-trigger/model.js'

// Static fixture identities cross only Harness brand boundaries.
/* oxlint-disable typescript/no-unsafe-type-assertion */
const SESSION_ID = 'parent' as SessionId
const CHILD_ID = 'child' as SessionId
/* oxlint-enable typescript/no-unsafe-type-assertion */
const MALICIOUS_CHILD_LABEL = 'reviewer\u001B[31m'

interface MutableSource<T> extends ObservableSnapshot<T> {
  publish(next: T): void
}

function source<T>(initial: T): MutableSource<T> {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => current,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    publish(next) {
      current = next
      for (const listener of listeners) listener()
    },
  }
}

function fixture(input: {
  readonly commands?: InputTriggerPort['commands']
  readonly serialize?: InputTriggerPort['serializeReference']
} = {}) {
  const sessions = source({
    current: SESSION_ID,
    byId: {
      [SESSION_ID]: {
        displayTitle: 'Parent',
        parentId: undefined,
        running: false,
      },
      [CHILD_ID]: {
        displayTitle: 'reviewer agent',
        parentId: SESSION_ID,
        running: true,
      },
    },
  })
  const port: InputTriggerPort = {
    commands: input.commands ?? (() => Promise.resolve({
      ok: true,
      value: [
        { name: 'compact', description: 'Compact context' },
        { name: 'config-show', description: 'Show config' },
        { name: 'plan', description: 'Set plan mode', inputHint: 'mode' },
      ],
    })),
    skills: () => Promise.resolve({
      ok: true,
      value: [
        { name: 'commit', description: 'Create commit', modelInvocable: true },
        { name: 'create-pr', description: 'Create pull request', modelInvocable: false },
      ],
    }),
    serializeReference: input.serialize ?? ((_source, reference) => Promise.resolve(`@${reference}`)),
  }
  return {
    controller: createInputTriggerController({ port, sessions }),
    sessions,
  }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

test('detects only boundary-safe slash and at-sign tokens at the caret', () => {
  assert.deepEqual(detectInputTrigger('/com', 4), {
    end: 4,
    position: 'leading',
    query: 'com',
    start: 0,
    trigger: '/',
  })
  assert.equal(detectInputTrigger('user@example.com', 16), undefined)
  assert.equal(detectInputTrigger('https://example.com/', 20), undefined)
  assert.deepEqual(detectInputTrigger('ask @rev', 8), {
    end: 8,
    position: 'inline',
    query: 'rev',
    start: 4,
    trigger: '@',
  })
})

test('groups fuzzy commands, prefix skills, and running child references', async () => {
  const { controller } = fixture()

  controller.track(SESSION_ID, '/cm', 3)
  await settle()
  let view = controller.getSnapshot()
  assert.equal(view.open, true)
  assert.deepEqual(view.groups.map(group => [group.source, group.items.map(item => item.name)]), [
    ['command', ['compact']],
    ['skill', []],
  ])

  controller.track(SESSION_ID, '/c', 2)
  await settle()
  view = controller.getSnapshot()
  assert.deepEqual(view.groups.map(group => [group.source, group.items.map(item => item.name)]), [
    ['command', ['compact', 'config-show']],
    ['skill', ['commit', 'create-pr']],
  ])

  controller.track(SESSION_ID, 'ask @review', 11)
  await settle()
  view = controller.getSnapshot()
  assert.deepEqual(view.groups.map(group => [group.source, group.items.map(item => item.name)]), [
    ['subagent', ['reviewer agent']],
  ])
})

test('rejects stale catalog results after invalidation', async () => {
  const requests: Array<(result: Awaited<ReturnType<InputTriggerPort['commands']>>) => void> = []
  const { controller } = fixture({
    commands: () => new Promise(resolve => { requests.push(resolve) }),
  })
  controller.track(SESSION_ID, '/c', 2)
  controller.invalidate(SESSION_ID)

  requests[1]?.({ ok: true, value: [{ name: 'config-show', description: 'Fresh' }] })
  await settle()
  assert.deepEqual(controller.getSnapshot().groups[0]?.items.map(item => item.name), ['config-show'])

  requests[0]?.({ ok: true, value: [{ name: 'compact', description: 'Stale' }] })
  await settle()
  assert.deepEqual(controller.getSnapshot().groups[0]?.items.map(item => item.name), ['config-show'])
})

test('launcher and typed menu picks share insertion and direct-command outcomes', async () => {
  const { controller } = fixture()

  controller.launch(SESSION_ID, 'draft ', 6)
  await settle()
  const launched = controller.getSnapshot()
  assert.equal(launched.open, true)
  assert.equal(launched.launcher, true)
  assert.deepEqual(launched.groups.map(group => group.source), ['command', 'skill', 'subagent'])
  assert.equal(launched.groups[0]?.items.some(item => item.name === 'plan'), false)

  const command = controller.pick('command', 0)
  assert.deepEqual(command, { end: 6, start: 6, submit: true, text: '/compact' })
  assert.equal(controller.getSnapshot().open, false)

  controller.track(SESSION_ID, '/pl', 3)
  await settle()
  const leading = controller.pick('command', 0)
  assert.deepEqual(leading, { end: 3, start: 0, submit: false, text: '/plan ' })

  controller.launch(SESSION_ID, '', 0)
  await settle()
  assert.equal(controller.getSnapshot().groups[0]?.items.some(item => item.name === 'plan'), true)
})

test('menu navigation wraps and dismissal clears the active hit', async () => {
  const { controller } = fixture()
  controller.track(SESSION_ID, '/c', 2)
  await settle()

  assert.deepEqual(controller.getSnapshot().highlight, { source: 'command', index: 0 })
  controller.move(-1)
  assert.deepEqual(controller.getSnapshot().highlight, { source: 'skill', index: 1 })
  controller.dismiss()
  assert.equal(controller.getSnapshot().open, false)
  assert.equal(controller.pickHighlighted(), undefined)
})

test('keeps terminal controls out of inserted references while preserving owner identity', async () => {
  const serialized: string[] = []
  const { controller, sessions } = fixture({
    serialize: (_source, reference) => {
      serialized.push(reference)
      return Promise.resolve(`<subagent:${reference}>`)
    },
  })
  sessions.publish({
    current: SESSION_ID,
    byId: {
      [CHILD_ID]: {
        displayTitle: MALICIOUS_CHILD_LABEL,
        parentId: SESSION_ID,
        running: true,
      },
    },
  })
  controller.launch(SESSION_ID, '', 0)
  await settle()

  assert.deepEqual(controller.pick('subagent', 0), {
    end: 0,
    start: 0,
    submit: false,
    text: '@reviewer ',
  })
  assert.equal(
    await controller.serialize(SESSION_ID, 'ask @reviewer', new AbortController().signal),
    `ask <subagent:${MALICIOUS_CHILD_LABEL}>`,
  )
  assert.deepEqual(serialized, [MALICIOUS_CHILD_LABEL])
})

test('serializes only bounded subagent references', async () => {
  const { controller } = fixture({
    serialize: () => Promise.resolve('<subagent>'),
  })

  assert.equal(
    await controller.serialize(
      SESSION_ID,
      'email@reviewer agentically; ask @reviewer agent.',
      new AbortController().signal,
    ),
    'email@reviewer agentically; ask <subagent>.',
  )
})

test('blocks submit when a selected reference cannot serialize', async () => {
  const { controller } = fixture({
    serialize: () => Promise.reject(new Error('reference owner unavailable')),
  })

  await assert.rejects(
    controller.serialize(SESSION_ID, 'ask @reviewer agent', new AbortController().signal),
    /reference owner unavailable/u,
  )
})
