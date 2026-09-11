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
    expect(classifySubmission('/resume')).toEqual({ kind: 'resume' })
    expect(classifySubmission('/status')).toEqual({ kind: 'status' })
    expect(classifySubmission('/model')).toEqual({ kind: 'model', argument: '' })
    expect(classifySubmission('/model  zai-coding-cn/glm-5.3 ')).toEqual({ kind: 'model', argument: 'zai-coding-cn/glm-5.3' })
    expect(classifySubmission('/preset')).toEqual({ kind: 'preset', argument: '' })
    expect(classifySubmission('/preset  ptc ')).toEqual({ kind: 'preset', argument: 'ptc' })
    expect(classifySubmission('/jobs')).toEqual({ kind: 'jobs', argument: '' })
    expect(classifySubmission('/jobs kill j1')).toEqual({ kind: 'jobs', argument: 'kill j1' })
    expect(classifySubmission('/rename  dock polish ')).toEqual({ kind: 'rename', title: 'dock polish' })
    expect(classifySubmission('/export /tmp/out.md')).toEqual({ kind: 'export', path: '/tmp/out.md' })
    expect(classifySubmission('/subagents kill abc')).toEqual({ kind: 'subagents', argument: 'kill abc' })
    expect(classifySubmission('/fork  parser branch ')).toEqual({ kind: 'fork', title: 'parser branch' })
    expect(classifySubmission('/todo')).toEqual({ kind: 'todo' })
    expect(classifySubmission('/copy')).toEqual({ kind: 'copy' })
    expect(classifySubmission('/new  fresh start')).toEqual({ kind: 'new', title: 'fresh start' })
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
