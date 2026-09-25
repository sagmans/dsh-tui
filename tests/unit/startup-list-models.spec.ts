import { CONFIGURED_AGENT_IDENTITIES_KEY } from '@deepseek-ai/dsh-agent-loop'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, LIST_MODELS_SERVICE, TUI_STARTUP_SERVICE } from '@/startup.ts'

function contextFor(args: string[]) {
  const exit = vi.fn()
  const provide = vi.fn()
  const ctx = {
    get(key: string) {
      if (key === 'cmdlineArgs') return { get: () => args }
      if (key === 'appExit') return exit
      return undefined
    },
    provide,
  } as unknown as Context
  return { ctx, exit, provide }
}

beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('list-models command', () => {
  it('publishes the listing flag beside the startup identity the surface row injects', () => {
    const { ctx, exit, provide } = contextFor(['list-models'])
    apply(ctx)
    expect(provide).toHaveBeenCalledWith(LIST_MODELS_SERVICE, true)
    expect(provide).toHaveBeenCalledWith(TUI_STARTUP_SERVICE, expect.objectContaining({
      sessionId: expect.stringMatching(/^tui-session-/),
      resume: false,
      resumePicker: false,
      model: undefined,
      provider: undefined,
      preset: undefined,
      color: true,
      bell: true,
    }))
    // The identity the agent plane adopts belongs to an interactive run: a
    // listing must not wake an agent row it will never drive.
    expect(provide).not.toHaveBeenCalledWith(CONFIGURED_AGENT_IDENTITIES_KEY, expect.anything())
    expect(provide).toHaveBeenCalledTimes(2)
    expect(exit).not.toHaveBeenCalled()
    expect(process.stdout.write).not.toHaveBeenCalled()
    expect(process.stderr.write).not.toHaveBeenCalled()
  })

  it('leaves the interactive launch publishing the agent identity', () => {
    const { ctx, provide } = contextFor([])
    apply(ctx)
    expect(provide).toHaveBeenCalledWith(CONFIGURED_AGENT_IDENTITIES_KEY, {
      main: expect.objectContaining({ resume: false }),
    })
    expect(provide).toHaveBeenCalledWith(TUI_STARTUP_SERVICE, expect.objectContaining({ resume: false }))
    expect(provide).toHaveBeenCalledWith('tuiGoodbyeMessage', expect.stringContaining('--resume='))
  })
})
