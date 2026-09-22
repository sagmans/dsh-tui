import { describe, expect, it } from 'vitest'
import { injectionSummary } from '@/injection.ts'

describe('injectionSummary', () => {
  it('names the instruction files of a baseline', () => {
    const data = {
      source: {
        kind: 'agent-instructions',
        form: 'instructions',
        baseline: true,
        changes: [
          { action: 'set', scope: 'user-global\u0000AGENTS.md', path: '~/.dsh/AGENTS.md' },
          { action: 'set', scope: '.\u0000AGENTS.md', path: 'AGENTS.md' },
        ],
      },
    }
    const text = '<system-reminder>\nInstructions from: ~/.dsh/AGENTS.md\nrule one\n\nInstructions from: AGENTS.md\nrule two\n</system-reminder>'
    expect(injectionSummary(data, text)).toBe('injected instructions · ~/.dsh/AGENTS.md, AGENTS.md · 6 lines')
  })

  it('names the file an instruction delta touched', () => {
    const data = {
      source: {
        kind: 'agent-instructions',
        form: 'instructions',
        changes: [{ action: 'replace', scope: 'packages/app\u0000AGENTS.md', path: 'packages/app/AGENTS.md' }],
      },
    }
    expect(injectionSummary(data, '<system-reminder>\nupdated\n</system-reminder>')).toBe(
      'injected instructions updated · packages/app/AGENTS.md · 3 lines',
    )
  })

  it('reports a removal without a line count', () => {
    const data = {
      source: {
        kind: 'agent-instructions',
        form: 'instructions',
        changes: [{ action: 'remove', scope: 'packages/app\u0000AGENTS.md', path: 'packages/app/AGENTS.md' }],
      },
    }
    expect(injectionSummary(data, '<system-reminder>\nInstructions removed: packages/app/AGENTS.md\n</system-reminder>')).toBe(
      'injected instructions removed · packages/app/AGENTS.md',
    )
  })

  it('caps a long path list instead of widening the row', () => {
    const data = {
      source: {
        kind: 'agent-instructions',
        form: 'instructions',
        baseline: true,
        changes: ['a', 'b', 'c', 'd'].map(name => ({ action: 'set', scope: name, path: name + '/AGENTS.md' })),
      },
    }
    expect(injectionSummary(data, 'x')).toBe('injected instructions · a/AGENTS.md, b/AGENTS.md, c/AGENTS.md +1 more · 1 lines')
  })

  it('keeps instruction paths when a legacy source carries no form', () => {
    const data = { source: { kind: 'agent-instructions', changes: [{ action: 'set', path: 'AGENTS.md' }] } }
    expect(injectionSummary(data, 'x')).toBe('injected instructions updated · AGENTS.md · 1 lines')
  })

  it('keeps the legacy label for a form-less plugin source', () => {
    const data = { source: { kind: 'plugin', plugin: 'dsh-agent-instructions' } }
    expect(injectionSummary(data, '<system-reminder>\nfollow the plan\nkeep it short')).toBe(
      'injected dsh-agent-instructions · 3 lines — <system-reminder>',
    )
  })

  it('falls back to plugin or kind when nothing identifies the producer', () => {
    expect(injectionSummary({}, 'a\nb')).toBe('injected plugin · 2 lines — a')
    expect(injectionSummary({ source: { kind: 'future-kind' } }, 'a\nb')).toBe('injected future-kind · 2 lines — a')
  })

  it('counts the entries a skill catalog published', () => {
    const entries = Array.from({ length: 67 }, (_, index) => ({ name: 'skill-' + index, description: 'x' }))
    const body = ['<system-reminder>', ...Array.from({ length: 98 }, (_, index) => '- skill-' + index), '</system-reminder>'].join('\n')
    expect(injectionSummary({ source: { kind: 'skill-catalog', form: 'catalog', entries } }, body)).toBe(
      'injected skills · 67 skills · 100 lines',
    )
  })

  it('marks a replacement catalog as updated', () => {
    const entries = [{ name: 'a', description: 'x' }, { name: 'b', description: 'y' }]
    expect(injectionSummary({ source: { kind: 'skill-catalog', form: 'catalog', update: true, entries } }, 'a\nb\nc')).toBe(
      'injected skills updated · 2 skills · 3 lines',
    )
  })

  it('names the skill an invocation injected', () => {
    const data = { source: { kind: 'skill-invocation', form: 'instructions', name: 'tdd' } }
    expect(injectionSummary(data, '<skill_content>\nred green\n</skill_content>')).toBe('injected skill tdd · 3 lines')
  })

  it('names the sections a runtime snapshot assembled', () => {
    const data = {
      source: {
        kind: 'plugin',
        plugin: '@deepseek-ai/dsh-system-prompt',
        form: 'snapshot',
        sections: [
          { name: 'sandbox:policy', text: 'Current DSH file policy: danger-full-access.' },
          { name: 'approval:policy', text: 'Approval prompts are disabled in this session.' },
        ],
      },
    }
    const body = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nCurrent DSH file policy: danger-full-access.\n\nApproval prompts are disabled in this session.'
    expect(injectionSummary(data, body)).toBe(
      'injected @deepseek-ai/dsh-system-prompt · sandbox:policy, approval:policy · 3 lines',
    )
  })

  it('shows the producer summary a notice already carries', () => {
    const toolJobs = { source: { kind: 'plugin', plugin: 'tool-jobs', form: 'notice', summary: 'job bash-1 completed' } }
    expect(injectionSummary(toolJobs, 'much longer body\nsecond line')).toBe('injected job bash-1 completed')
    const settled = { source: { kind: 'subagent-settled', form: 'notice', summary: 'child finished' } }
    expect(injectionSummary(settled, 'body')).toBe('injected child finished')
  })

  it('labels a relayed agent message', () => {
    const data = { source: { kind: 'agent-message', form: 'relay', senderSessionId: 'tui-session-abc' } }
    expect(injectionSummary(data, 'please check\nline two')).toBe('injected agent message · 2 lines')
  })

  it('counts the sessions a recall lifted', () => {
    const data = {
      source: { kind: 'session-reference', form: 'recall', version: 1, references: [{ sessionId: 'a' }, { sessionId: 'b' }] },
    }
    expect(injectionSummary(data, 'x\ny\nz')).toBe('injected session recall · 2 sessions · 3 lines')
  })

  it('names the continuation round a goal message opened', () => {
    const withRound = { source: { kind: 'goal', goalId: 'g1', revision: 3, round: 3 } }
    expect(injectionSummary(withRound, 'continue the goal\nnext step')).toBe('injected goal continuation · round 3 · 2 lines')
    const bare = { source: { kind: 'goal', goalId: 'g1', revision: 1 } }
    expect(injectionSummary(bare, 'body')).toBe('injected goal · 1 lines')
  })
})
