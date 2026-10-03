import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LaunchUsageError, identityOf, resolveLaunchIntent, resumeHint } from '@/identity.ts'

const SHELL_FIXTURE = fileURLToPath(new URL('../fixtures/resume-hint.sh', import.meta.url))
const HINT_PREFIX = 'To resume this session: '
const SHELL_TOKENS = ['session with spaces', 'session\twith\ttabs', 'session\nwith\nlines', "session'quoted", 'session; printf unexpected', 'session$(printf unexpected)']
const CONTROL_ID = 'session\x1b]0;title\x07\rhidden\b\x9dtitle\x9c'
const CONTROL_PROFILE = 'tui\x1b[31m'
const LITERAL_HINT = String.raw`To resume this session: dsh --profile 'tui\x1B[31m' --resume='session\x1B]0;title\x07\x0Dhidden\x08\x9Dtitle\x9C'`

const base = { mode: undefined, session: undefined, resumeFlag: undefined, newSession: undefined } as const

describe('resolveLaunchIntent', () => {
  it('treats a bare --resume as a request for the picker', () => {
    expect(resolveLaunchIntent({ ...base, resumeFlag: true })).toEqual({ resumeId: '', resumePicker: true })
  })

  it('accepts an id from the flag or the positional form', () => {
    expect(resolveLaunchIntent({ ...base, resumeFlag: 'abc' }).resumeId).toBe('abc')
    expect(resolveLaunchIntent({ ...base, mode: 'resume', session: 'abc' }).resumeId).toBe('abc')
  })

  it('refuses two different ids', () => {
    expect(() => resolveLaunchIntent({ ...base, mode: 'resume', session: 'a', resumeFlag: 'b' })).toThrow(LaunchUsageError)
  })

  it('refuses a positional id without a resume mode', () => {
    expect(() => resolveLaunchIntent({ ...base, session: 'a' })).toThrow(LaunchUsageError)
  })

  it('starts a fresh session for --new alone, with no picker', () => {
    expect(resolveLaunchIntent({ ...base, newSession: true })).toEqual({ resumeId: '', resumePicker: false })
  })

  it('refuses --new combined with a resume request', () => {
    expect(() => resolveLaunchIntent({ ...base, newSession: true, resumeFlag: true })).toThrow(LaunchUsageError)
    expect(() => resolveLaunchIntent({ ...base, newSession: true, mode: 'resume' })).toThrow(LaunchUsageError)
  })

  it('refuses an unknown positional mode', () => {
    expect(() => resolveLaunchIntent({ ...base, mode: 'continue' })).toThrow(LaunchUsageError)
  })
})

describe('identityOf', () => {
  it('resumes the named session and marks it as a resume', () => {
    expect(identityOf({ resumeId: 'abc', resumePicker: false }, 'uuid')).toEqual({ id: 'abc', resume: true })
  })

  it('creates a fresh identity that embeds the generated uuid', () => {
    expect(identityOf({ resumeId: '', resumePicker: false }, 'uuid')).toEqual({ id: 'tui-session-uuid', resume: false })
  })
})

describe('resumeHint', () => {
  it.each(SHELL_TOKENS)('keeps %j as one literal shell argument', id => {
    const command = resumeHint(id, id).slice(HINT_PREFIX.length)
    const output = execFileSync('sh', [SHELL_FIXTURE, command], { encoding: 'utf8' })
    expect(output).toBe(`--profile\n${id}\n--resume=${id}\n`)
  })

  it('spells controls in session and profile tokens instead of issuing terminal commands', () => {
    expect(resumeHint(CONTROL_ID, CONTROL_PROFILE)).toBe(LITERAL_HINT)
  })

  it('names the exact command that returns to this session', () => {
    expect(resumeHint('abc', 'tui')).toBe('To resume this session: dsh --profile tui --resume=abc')
  })
})
