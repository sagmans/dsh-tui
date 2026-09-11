import { describe, expect, it } from 'vitest'
import { defaultExportFile, transcriptToText } from '@/export.ts'
import { TranscriptModel } from '@/transcript.ts'

describe('defaultExportFile', () => {
  it('names the file after the session', () => {
    expect(defaultExportFile('tui-session-abc-123')).toBe('dsh-session-tui-session-abc-123.md')
  })

  it('cannot be steered out of the directory by a session id', () => {
    expect(defaultExportFile('../../etc/passwd')).toBe('dsh-session-.._.._etc_passwd.md')
  })
})

describe('transcriptToText', () => {
  const modelWithEverything = (): TranscriptModel => {
    const model = new TranscriptModel()
    model.apply({ type: 'user/message', data: { content: [{ type: 'text', text: 'add a dock' }], source: { kind: 'user' } } })
    model.apply({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Done.\n\n- one\n- two' }] } } })
    model.apply({ type: 'tool/call', data: { name: 'bash', arguments: '{"command":"ls"}', callId: 'c1' } })
    model.apply({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', text: 'a\nb' }], isError: false } } })
    model.marker('compacted 3 events')
    model.notice('local line')
    return model
  }

  it('keeps the shape a reader saw on screen', () => {
    const text = transcriptToText(modelWithEverything().entries())
    expect(text).toContain('> add a dock')
    expect(text).toContain('Done.')
    expect(text).toContain('- one')
    expect(text).toContain('### tool: bash')
    expect(text).toContain('a\nb')
    expect(text).toContain('--- compacted 3 events ---')
    expect(text).toContain('<!-- local line -->')
  })

  it('quotes every line of a multi-line prompt', () => {
    const model = new TranscriptModel()
    model.apply({ type: 'user/message', data: { content: [{ type: 'text', text: 'first\nsecond' }], source: { kind: 'user' } } })
    expect(transcriptToText(model.entries())).toContain('> first\n> second')
  })

  it('keeps control sequences out of a file that may be cat-ed', () => {
    const model = new TranscriptModel()
    model.apply({ type: 'tool/call', data: { name: 'bash', arguments: '{}', callId: 'c1' } })
    model.apply({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', text: '\u001b[31mred' }], isError: false } } })
    const text = transcriptToText(model.entries())
    expect(text).toContain('\\x1B[31mred')
    expect(text.includes('\u001b')).toBe(false)
  })

  it('keeps a thought in the dump, and keeps it out of the reply', () => {
    // A dump is a record, so it carries the thinking even though the screen
    // hides it; it stays commented because a reader scanning the file for the
    // answer must not find the model reasoning to itself in the middle of it.
    const model = new TranscriptModel()
    model.apply({
      type: 'assistant/message',
      data: { message: { content: [
        { type: 'reasoning', text: 'let me check\nbefore answering' },
        { type: 'text', text: 'the answer' },
      ] } },
    })
    const text = transcriptToText(model.entries())
    expect(text).toContain('<!-- thinking \u00b7 2 lines \u00b7 29 chars -->')
    expect(text).toContain('<!-- let me check -->')
    expect(text).toContain('<!-- before answering -->')
    expect(text).toContain('the answer')
    // The thought never appears as prose: every line of it is commented out.
    for (const line of text.split('\n')) {
      if (line.includes('let me check') || line.includes('before answering')) {
        expect(line.startsWith('<!--')).toBe(true)
      }
    }
  })

  it('escapes a thought that carries control sequences', () => {
    const model = new TranscriptModel()
    model.apply({
      type: 'assistant/message',
      data: { message: { content: [{ type: 'reasoning', text: '\u001b[31mthinking' }] } },
    })
    const text = transcriptToText(model.entries())
    expect(text).toContain('\\x1B[31mthinking')
    expect(text.includes('\u001b')).toBe(false)
  })

  it('says how much of a long card the dump left out', () => {
    const model = new TranscriptModel()
    model.apply({ type: 'tool/call', data: { name: 'bash', arguments: '{}', callId: 'c1' } })
    model.apply({
      type: 'tool/result',
      data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', text: Array.from({ length: 400 }, (_, i) => `row ${i}`).join('\n') }], isError: false } },
    })
    expect(transcriptToText(model.entries())).toContain('more lines')
  })
})
