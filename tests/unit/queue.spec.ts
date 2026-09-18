import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { pendingPrompts, promptsOf } from '@/queue.ts'

/** One user message as the harness records it in the inbox projection. */
const message = (text: string, source: unknown = { kind: 'user' }): Record<string, unknown> => ({
  id: `message-${text}`,
  role: 'user',
  content: [{ type: 'text', text }],
  source,
})

/** One block of a message, so a content shape can be pinned without a message. */
const block = (type: string, text?: string): Record<string, unknown> => (text === undefined ? { type } : { type, text })

describe('the prompt queue', () => {
  it('lists the reader\'s prompts in the order the harness will deliver them', () => {
    // A step boundary claims next-step first and takes a queued turn after, so
    // that is the order the reader's own rows will reach the transcript in.
    const state = {
      'next-turn': [message('queued turn')],
      'next-step': [message('first steer'), message('second steer')],
    }
    expect(promptsOf(state)).toEqual(['first steer', 'second steer', 'queued turn'])
  })

  it('keeps only prompts the human wrote', () => {
    // Next-step also carries contexts a tool and a plugin inject, which are
    // machinery rather than something the reader is waiting to see delivered.
    const state = {
      'next-turn': [],
      'next-step': [
        message('the reader\'s own', { kind: 'user' }),
        message('tool context', { kind: 'tool', tool: 'read' }),
        message('plugin notice', { kind: 'plugin', plugin: 'dsh-agent' }),
        message('model echo', { kind: 'model', provider: 'p', model: 'm' }),
      ],
    }
    expect(promptsOf(state)).toEqual(['the reader\'s own'])
  })

  it('joins every text block of one prompt and drops a thought', () => {
    // A thought is the model's private reasoning; a prompt that carries one
    // among its blocks is still only read for what the human wrote.
    const prompt = { id: 'm', role: 'user', source: { kind: 'user' }, content: [block('text', 'one'), block('reasoning', 'why'), block('text', 'two')] }
    expect(promptsOf({ 'next-turn': [], 'next-step': [prompt] })).toEqual(['one\ntwo'])
  })

  it('names a prompt that carries no text block', () => {
    const prompt = { id: 'm', role: 'user', source: { kind: 'user' }, content: [block('image')] }
    expect(promptsOf({ 'next-turn': [], 'next-step': [prompt] })).toEqual(['(no text)'])
  })

  it('reads nothing from a state it cannot understand', () => {
    for (const state of [undefined, null, {}, [], { 'next-step': 'nope' }, { 'next-step': [1, 'two', null] }]) {
      expect(promptsOf(state), JSON.stringify(state)).toEqual([])
    }
  })

  it('reads the inbox projection of the session it is given', () => {
    const state = { 'next-turn': [message('waiting')], 'next-step': [] }
    const ctx = { get: (name: string) => (name === 'sessionProjections' ? { stateOf: () => state } : undefined) } as unknown as Context
    expect(pendingPrompts(ctx, { id: 'session' })).toEqual(['waiting'])
  })

  it('reads nothing when the composition has no projection registry', () => {
    const ctx = { get: () => undefined } as unknown as Context
    expect(pendingPrompts(ctx, { id: 'session' })).toEqual([])
  })

  it('reads nothing when the projection cannot be read', () => {
    const ctx = { get: () => ({ stateOf: () => { throw new Error('no such projection') } }) } as unknown as Context
    expect(pendingPrompts(ctx, { id: 'session' })).toEqual([])
  })
})
