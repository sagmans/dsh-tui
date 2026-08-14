import assert from 'node:assert/strict'
import { test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { TuiClientFacade } from '../../src/client/context.js'
import {
  CONVERSATION_SETTINGS_NAMESPACE,
  createConversationSubmissionPreferences,
  registerConversationSettings,
} from '../../src/features/conversation/submission.js'

const INITIAL_REVISION = 7
const NEXT_REVISION = 8

function namespace(behavior: 'queue' | 'steer', revision: number) {
  return {
    applies: 'live' as const,
    ns: CONVERSATION_SETTINGS_NAMESPACE,
    revision,
    schema: {},
    secrets: [],
    value: { busyEnter: behavior },
  }
}

test('reads, writes, and invalidates the host-backed busy-submit preference', async () => {
  const calls: unknown[] = []
  let invalidate: ((namespace: string) => void) | undefined
  const client = {
    api: {
      settings: {
        describe: () => Promise.resolve({
          result: {
            ok: true,
            value: { hasDocument: true, namespaces: [namespace('steer', INITIAL_REVISION)], writable: true },
          },
        }),
        mutate: (request: unknown) => {
          calls.push(request)
          return Promise.resolve({ result: { ok: true, value: namespace('queue', NEXT_REVISION) } })
        },
      },
    },
    remote: {
      $on: (event: string, listener: (namespace: string) => void) => {
        assert.equal(event, 'settings/document-updated')
        invalidate = listener
        return () => { invalidate = undefined }
      },
    },
  }
  // The adapter consumes only settings API and forwarded-event faces.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const preferences = createConversationSubmissionPreferences(client as unknown as TuiClientFacade)

  assert.deepEqual(await preferences.read(), {
    ok: true,
    value: { behavior: 'steer', revision: INITIAL_REVISION },
  })
  assert.deepEqual(await preferences.write('queue', INITIAL_REVISION), {
    ok: true,
    value: { behavior: 'queue', revision: NEXT_REVISION },
  })
  assert.deepEqual(calls, [{
    ns: CONVERSATION_SETTINGS_NAMESPACE,
    ops: [{ op: 'set', path: ['busyEnter'], value: 'queue' }],
    expectedRevision: INITIAL_REVISION,
  }])

  let notifications = 0
  const dispose = preferences.subscribe(() => { notifications += 1 })
  invalidate?.('other-settings')
  assert.equal(notifications, 0)
  invalidate?.(CONVERSATION_SETTINGS_NAMESPACE)
  assert.equal(notifications, 1)
  dispose()
  assert.equal(invalidate, undefined)
})

test('maps settings transport failures into preference errors', async () => {
  const failure = new Error('settings transport unavailable')
  const client = {
    api: {
      settings: {
        describe: () => Promise.reject(failure),
        mutate: () => Promise.reject(failure),
      },
    },
    remote: { $on: () => () => {} },
  }
  // Fixture implements only the settings transport consumed by this adapter.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const preferences = createConversationSubmissionPreferences(client as unknown as TuiClientFacade)

  assert.deepEqual(await preferences.read(), {
    ok: false,
    error: { code: 'settings-transport', message: failure.message },
  })
  assert.deepEqual(await preferences.write('queue', INITIAL_REVISION), {
    ok: false,
    error: { code: 'settings-transport', message: failure.message },
  })
})

test('registers only the allowlisted conversation preference schema', async () => {
  const registrations: Array<{ readonly namespace: string; readonly schema: unknown }> = []
  const ctx = new Context()
  // Fixture implements only registration because provider persistence is outside this boundary.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  ctx.provide('settings', {
    register: (registeredNamespace: string, schema: unknown) => {
      registrations.push({ namespace: registeredNamespace, schema })
      return () => {}
    },
  } as never)

  registerConversationSettings(ctx)
  await Promise.resolve()

  assert.equal(registrations.length, 1)
  assert.equal(registrations[0]?.namespace, CONVERSATION_SETTINGS_NAMESPACE)
  assert.notEqual(registrations[0]?.schema, undefined)
  await ctx.fiber.dispose()
})
