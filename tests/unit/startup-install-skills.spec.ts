import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '@/startup.ts'
import { installBundledSkill } from '@/install-skills.ts'

vi.mock('@/install-skills.ts', () => ({
  installBundledSkill: vi.fn(() => '/tmp/installed-skill'),
}))

describe('install-skills command', () => {
  it('copies the bundled skill and exits without mounting the TUI', () => {
    const exit = vi.fn()
    const provide = vi.fn()
    const ctx = {
      get(key: string) {
        if (key === 'cmdlineArgs') return { get: () => ['install-skills'] }
        if (key === 'appExit') return exit
        return undefined
      },
      provide,
    } as unknown as Context
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      apply(ctx)
      expect(installBundledSkill).toHaveBeenCalledOnce()
      expect(exit).toHaveBeenCalledWith(0)
      expect(provide).not.toHaveBeenCalled()
    } finally {
      output.mockRestore()
    }
  })

  it('reports a collision and exits without mounting the TUI', () => {
    vi.mocked(installBundledSkill).mockImplementationOnce(() => { throw new Error('skill already exists') })
    const exit = vi.fn()
    const provide = vi.fn()
    const ctx = {
      get(key: string) {
        if (key === 'cmdlineArgs') return { get: () => ['install-skills'] }
        if (key === 'appExit') return exit
        return undefined
      },
      provide,
    } as unknown as Context
    const error = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      apply(ctx)
      expect(exit).toHaveBeenCalledWith(1)
      expect(provide).not.toHaveBeenCalled()
    } finally {
      error.mockRestore()
    }
  })
})
