import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createToolPresenter } from '@/agent/present.ts'
import { rowText } from '@/cards.ts'
import { inject } from '@/index.ts'

/** A tools registry stub: the presenter only ever asks it for a definition. */
function contextWith(definition: unknown): Context {
  return { tools: { get: () => definition } } as unknown as Context
}

const input = { argumentsJson: '{"path":"a.ts"}', content: [], isError: false, meta: undefined }

describe('createToolPresenter', () => {
  it('asks the tool how its call reads', () => {
    const presenter = createToolPresenter(contextWith({
      presentCall: (args: { path: string }) => ({ card: 'generic', title: `Read ${args.path}` }),
    }))
    expect(presenter.call('read', '{"path":"a.ts"}')).toMatchObject({ kind: 'generic', title: 'Read a.ts' })
  })

  it('passes the call arguments and the result facts through', () => {
    const seen: unknown[] = []
    const presenter = createToolPresenter(contextWith({
      presentResult: (args: unknown, result: unknown) => {
        seen.push(args, result)
        return { card: 'generic', title: 'ok' }
      },
    }))
    presenter.result('read', { ...input, meta: { from: 'replay' } })
    expect(seen[0]).toEqual({ path: 'a.ts' })
    expect(seen[1]).toEqual({ content: [], isError: false, meta: { from: 'replay' } })
  })

  it('hands the presenter the tool content, not the durable result envelope', () => {
    const seen: unknown[] = []
    const presenter = createToolPresenter(contextWith({
      presentResult: (_args: unknown, result: { content: unknown }) => {
        seen.push(result.content)
        return { card: 'generic', title: 'ok' }
      },
    }))
    presenter.result('read', {
      ...input,
      content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'hi' }], isError: false }],
    })
    expect(seen).toEqual([[{ type: 'text', text: 'hi' }]])
  })

  it('leaves a call to the transcript fallback when the tool declares no view', () => {
    // Returning a generic card here would silently drop the raw arguments;
    // undefined lets the transcript show what the call was made with.
    const presenter = createToolPresenter(contextWith({}))
    expect(presenter.call('mystery', '{"a":1}')).toBeUndefined()
  })

  it('falls back when a tool throws instead of breaking the transcript', () => {
    const presenter = createToolPresenter(contextWith({
      presentCall: () => { throw new Error('bad presenter') },
      presentResult: () => { throw new Error('bad presenter') },
    }))
    expect(presenter.call('boom', '{}')).toBeUndefined()
    expect(presenter.result('boom', input)).toBeUndefined()
  })

  it('degrades a result when the registry itself fails or the arguments are not JSON', () => {
    const presenter = createToolPresenter({ tools: { get: () => { throw new Error('no registry') } } } as unknown as Context)
    expect(presenter.call('read', 'not json')).toBeUndefined()
    expect(presenter.result('read', { ...input, argumentsJson: 'not json' })).toMatchObject({ kind: 'generic', title: 'read' })
  })

  it('renders the model-facing text when no view is declared for a result', () => {
    const presenter = createToolPresenter(contextWith(undefined))
    const card = presenter.result('bash', { ...input, content: [{ type: 'text', text: 'line one\nline two' }] })
    expect(card?.detail.map(rowText)).toEqual(['line one', 'line two'])
  })

  it('resolves the tool in the session scope, not the plugin root', () => {
    const seen: unknown[] = []
    const agent = { id: 'tui-session-x' } as unknown as Agent
    const ctx = {
      tools: { get: (name: string, scope: Agent | undefined) => { seen.push(name, scope); return undefined } },
    } as unknown as Context
    createToolPresenter(ctx, () => agent).call('bash', '{}')
    expect(seen).toEqual(['bash', agent])
  })

  it('resolves a result in the session scope too', () => {
    const seen: unknown[] = []
    const agent = { id: 'tui-session-y' } as unknown as Agent
    const ctx = {
      tools: { get: (name: string, scope: Agent | undefined) => { seen.push(name, scope); return undefined } },
    } as unknown as Context
    createToolPresenter(ctx, () => agent).result('read', input)
    expect(seen).toEqual(['read', agent])
  })

  it('declares the tools service it reads its cards through', () => {
    // Reading `ctx.tools` without injecting it throws, which silently degraded
    // every card to a bare generic row; the row has to declare what it reads.
    expect(inject).toContain('tools')
  })
})
