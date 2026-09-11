import { describe, expect, it } from 'vitest'
import { clipboardSequence } from '@/terminal/clipboard.ts'

const ESC = '\u001b'
const BEL = '\u0007'

describe('clipboardSequence', () => {
  it('asks the terminal to put the text on the system clipboard', () => {
    expect(clipboardSequence('hello')).toBe(`${ESC}]52;c;aGVsbG8=${BEL}`)
  })

  it('encodes text that would otherwise end the sequence', () => {
    const hostile = clipboardSequence(`a${BEL}${ESC}]52;c;cHduZWQ=${BEL}`)
    expect(hostile.indexOf(BEL)).toBe(hostile.length - 1)
    expect(hostile.split(ESC)).toHaveLength(2)
  })

  it('carries multi-byte text intact', () => {
    const sequence = clipboardSequence('✓ done — 完了')
    const payload = sequence.slice(sequence.indexOf('c;') + 2, -1)
    expect(Buffer.from(payload, 'base64').toString('utf8')).toBe('✓ done — 完了')
  })
})
