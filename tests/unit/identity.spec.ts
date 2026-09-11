import { describe, expect, it } from 'vitest'
import { LaunchUsageError, identityOf, resolveLaunchIntent, resumeHint } from '@/identity.ts'

const base = { mode: undefined, session: undefined, resumeFlag: undefined, newSession: undefined } as const

describe('resolveLaunchIntent', () => {
  it('mints a fresh session when nothing names one', () => {
    expect(resolveLaunchIntent({ ...base })).toEqual({ resumeId: '', resumePicker: false, fresh: false })
  })

  it('treats a bare --resume as a request for the picker', () => {
    expect(resolveLaunchIntent({ ...base, resumeFlag: true })).toEqual({ resumeId: '', resumePicker: true, fresh: false })
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
    expect(identityOf({ resumeId: 'abc', resumePicker: false, fresh: false }, 'uuid')).toEqual({ id: 'abc', resume: true })
  })

  it('creates a fresh identity that embeds the generated uuid', () => {
    expect(identityOf({ resumeId: '', resumePicker: false, fresh: true }, 'uuid')).toEqual({ id: 'tui-session-uuid', resume: false })
  })
})

describe('resumeHint', () => {
  it('names the exact command that returns to this session', () => {
    expect(resumeHint('abc', 'tui')).toBe('To resume this session: dsh --profile tui --resume=abc')
  })
})
