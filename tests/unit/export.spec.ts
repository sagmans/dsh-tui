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

  it('says how much of a long card the dump left out', () => {
    const model = new TranscriptModel()
    model.apply({ type: 'tool/call', data: { name: 'bash', arguments: '{}', callId: 'c1' } })
    model.apply({
      type: 'tool/result',
      data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', text: Array.from({ length: 400 }, (_, i) => `row ${i}`).join('\n') }], isError: false } },
    })
    expect(transcriptToText(model.entries())).toContain('more lines')
  })

  it('dumps the reasoning body, not only its count', () => {
    const model = new TranscriptModel()
    model.apply({ type: 'assistant/message', data: { message: { content: [
      { type: 'reasoning', text: 'weigh the options' },
      { type: 'text', text: 'the answer' },
    ] } } })
    const text = transcriptToText(model.entries())
    expect(text).toContain('weigh the options')
    expect(text).toContain('the answer')
  })

  it('cannot let a backtick run in tool output close the code block early', () => {
    const model = new TranscriptModel()
    model.apply({ type: 'tool/call', data: { name: 'bash', arguments: '{}', callId: 'c1' } })
    model.apply({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', text: 'before\n```\nafter' }], isError: false } } })
    const text = transcriptToText(model.entries())
    // The fence is longer than the run inside it, so the block survives.
    expect(text).toContain('````')
    expect(text).toContain('after')
  })

  it('cannot let a notice close its own comment', () => {
    const model = new TranscriptModel()
    model.notice('before --> after')
    const text = transcriptToText(model.entries())
    expect(text).toContain('--&gt;')
    expect(text).not.toContain('<!-- before --> after -->')
  })
})
