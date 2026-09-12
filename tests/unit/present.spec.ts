import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createToolPresenter } from '@/agent/present.ts'
import { rowText } from '@/cards.ts'

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

  it('falls back to a generic card when the tool declares no view', () => {
    const presenter = createToolPresenter(contextWith({}))
    expect(presenter.call('mystery', '{"a":1}')).toMatchObject({ kind: 'generic', title: 'mystery' })
  })

  it('falls back when a tool throws instead of breaking the transcript', () => {
    const presenter = createToolPresenter(contextWith({
      presentCall: () => { throw new Error('bad presenter') },
      presentResult: () => { throw new Error('bad presenter') },
    }))
    expect(presenter.call('boom', '{}')).toBeUndefined()
    expect(presenter.result('boom', input)).toBeUndefined()
  })

  it('degrades to a generic card when the registry itself fails or the arguments are not JSON', () => {
    // The row still has to say what ran: only a *presenter* that throws leaves
    // the card to the transcript's own fallback.
    const presenter = createToolPresenter({ tools: { get: () => { throw new Error('no registry') } } } as unknown as Context)
    expect(presenter.call('read', 'not json')).toMatchObject({ kind: 'generic', title: 'read', detail: [] })
    expect(presenter.result('read', { ...input, argumentsJson: 'not json' })).toMatchObject({ kind: 'generic', title: 'read' })
  })

  it('renders the model-facing text when no view is declared for a result', () => {
    const presenter = createToolPresenter(contextWith(undefined))
    const card = presenter.result('bash', { ...input, content: [{ type: 'text', text: 'line one\nline two' }] })
    expect(card?.detail.map(rowText)).toEqual(['line one', 'line two'])
  })
})
