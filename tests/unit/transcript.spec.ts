import { describe, expect, it } from 'vitest'
import { TranscriptModel } from '@/transcript.ts'

const text = (value: string) => [{ type: 'text', text: value }]

describe('TranscriptModel', () => {
  it('renders a human prompt as a user row', () => {
    const model = new TranscriptModel()
    model.apply({ type: 'user/message', data: { content: text('hello'), source: { kind: 'user' } } })
    expect(model.entries()).toEqual([{ kind: 'user', text: 'hello' }])
  })

  it('renders injected context as a notice rather than as the human speaking', () => {
    const model = new TranscriptModel()
    model.apply({ type: 'user/message', data: { content: text('context'), source: { kind: 'plugin', plugin: 'x' } } })
    expect(model.entries()).toEqual([{ kind: 'notice', text: 'context' }])
  })

  it('accumulates streamed text and drops it once the durable message settles', () => {
    const model = new TranscriptModel()
    model.applyStreamChunk({ type: 'text-delta', text: 'he' })
    model.applyStreamChunk({ type: 'text-delta', text: 'llo' })
    expect(model.entries()).toEqual([{ kind: 'assistant', text: 'hello' }])
    model.apply({ type: 'assistant/message', data: { message: { content: text('hello') } } })
    expect(model.entries()).toEqual([{ kind: 'assistant', text: 'hello' }])
  })

  it('ignores a streamed block end that is not text', () => {
    const model = new TranscriptModel()
    model.applyStreamChunk({ type: 'text-delta', text: 'kept' })
    model.applyStreamChunk({ type: 'block-end', block: { type: 'reasoning', text: 'x' } })
    expect(model.entries()).toEqual([{ kind: 'assistant', text: 'kept' }])
  })

  it('summarizes tool calls and results, marking failures', () => {
    const model = new TranscriptModel()
    model.apply({ type: 'tool/call', data: { name: 'bash', arguments: '{"command":"ls"}' } })
    model.apply({ type: 'tool/result', data: { message: { content: text('file.txt\nmore'), isError: false } } })
    model.apply({ type: 'tool/result', data: { message: { content: text('boom'), isError: true } } })
    expect(model.entries()).toEqual([
      { kind: 'tool', text: 'bash {"command":"ls"}' },
      { kind: 'tool', text: 'file.txt' },
      { kind: 'tool', text: 'failed: boom' },
    ])
  })

  it('ignores unrelated events and resets to an empty transcript', () => {
    const model = new TranscriptModel()
    model.apply({ type: 'turn/start', data: { turn: 1 } })
    expect(model.isEmpty()).toBe(true)
    model.notice('local line')
    expect(model.isEmpty()).toBe(false)
    model.reset()
    expect(model.isEmpty()).toBe(true)
  })
})
