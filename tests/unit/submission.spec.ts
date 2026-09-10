import { describe, expect, it } from 'vitest'
import { classifySubmission } from '@/input/submission.ts'

describe('classifySubmission', () => {
  it('treats blank input as nothing to do', () => {
    expect(classifySubmission('   \n ')).toEqual({ kind: 'empty' })
    expect(classifySubmission('/')).toEqual({ kind: 'empty' })
  })

  it('recognizes the surface-local commands', () => {
    expect(classifySubmission('/quit')).toEqual({ kind: 'quit' })
    expect(classifySubmission('/exit')).toEqual({ kind: 'quit' })
    expect(classifySubmission('/clear')).toEqual({ kind: 'clear' })
    expect(classifySubmission('/help')).toEqual({ kind: 'help' })
  })

  it('routes any other slash line as a command with its arguments', () => {
    expect(classifySubmission('/plan off')).toEqual({ kind: 'command', name: 'plan', line: '/plan off' })
    expect(classifySubmission('/PLAN')).toEqual({ kind: 'command', name: 'plan', line: '/PLAN' })
    expect(classifySubmission('/unknown thing')).toEqual({ kind: 'command', name: 'unknown', line: '/unknown thing' })
  })

  it('sends ordinary text to the agent with surrounding whitespace removed', () => {
    expect(classifySubmission('  ping  ')).toEqual({ kind: 'prompt', text: 'ping' })
  })

  it('treats a path-like line as a prompt, not a command', () => {
    expect(classifySubmission('src/index.ts is broken')).toEqual({ kind: 'prompt', text: 'src/index.ts is broken' })
  })
})
