import { createInterface } from 'node:readline/promises'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply } from '@/startup.ts'
import { installBundledSkill, SkillAlreadyExistsError } from '@/install-skills.ts'

const DESTINATION = '/tmp/installed-skill'
const inputTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
const outputTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')

vi.mock('@/install-skills.ts', () => {
  class SkillAlreadyExistsError extends Error {
    constructor(readonly destination: string) {
      super(`skill already exists: ${destination}`)
    }
  }
  return { installBundledSkill: vi.fn(), SkillAlreadyExistsError }
})
vi.mock('node:readline/promises', () => ({ createInterface: vi.fn() }))

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

function setTTY(value: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value })
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value })
}

afterEach(() => {
  for (const [stream, descriptor] of [[process.stdin, inputTTY], [process.stdout, outputTTY]] as const) {
    if (descriptor === undefined) delete (stream as { isTTY?: boolean }).isTTY
    else Object.defineProperty(stream, 'isTTY', descriptor)
  }
  vi.restoreAllMocks()
})

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(installBundledSkill).mockReturnValue(DESTINATION)
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})

describe('install-skills command', () => {
  it('copies the bundled skill and exits without mounting the TUI', () => {
    const { ctx, exit, provide } = contextFor(['install-skills'])
    apply(ctx)
    expect(installBundledSkill).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(0)
    expect(provide).not.toHaveBeenCalled()
    expect(createInterface).not.toHaveBeenCalled()
  })

  it('requires --update for non-interactive replacement', () => {
    setTTY(false)
    vi.mocked(installBundledSkill).mockImplementationOnce(() => { throw new SkillAlreadyExistsError(DESTINATION) })
    const { ctx, exit, provide } = contextFor(['install-skills'])
    apply(ctx)
    expect(exit).toHaveBeenCalledWith(1)
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining('--update'))
    expect(installBundledSkill).toHaveBeenCalledTimes(1)
    expect(createInterface).not.toHaveBeenCalled()
    expect(provide).not.toHaveBeenCalled()
  })

  it('updates directly when --update is supplied', () => {
    const { ctx, exit, provide } = contextFor(['install-skills', '--update'])
    apply(ctx)
    expect(installBundledSkill).toHaveBeenCalledWith(undefined, true)
    expect(createInterface).not.toHaveBeenCalled()
    expect(exit).toHaveBeenCalledWith(0)
    expect(provide).not.toHaveBeenCalled()
  })

  it('updates an existing copy only after affirmative TTY input', async () => {
    setTTY(true)
    vi.mocked(installBundledSkill).mockImplementationOnce(() => { throw new SkillAlreadyExistsError(DESTINATION) })
    const question = vi.fn().mockResolvedValue('y')
    const close = vi.fn()
    vi.mocked(createInterface).mockReturnValue({ question, close } as unknown as ReturnType<typeof createInterface>)
    const { ctx, exit, provide } = contextFor(['install-skills'])
    apply(ctx)
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
    expect(question).toHaveBeenCalledWith(expect.stringContaining('[y/N]'))
    expect(installBundledSkill).toHaveBeenNthCalledWith(2, undefined, true)
    expect(close).toHaveBeenCalledOnce()
    expect(provide).not.toHaveBeenCalled()
  })

  it.each(['n', ''])('leaves the existing copy untouched for %j input', async (answer) => {
    setTTY(true)
    vi.mocked(installBundledSkill).mockImplementationOnce(() => { throw new SkillAlreadyExistsError(DESTINATION) })
    const close = vi.fn()
    vi.mocked(createInterface).mockReturnValue({ question: vi.fn().mockResolvedValue(answer), close } as unknown as ReturnType<typeof createInterface>)
    const { ctx, exit, provide } = contextFor(['install-skills'])
    apply(ctx)
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
    expect(installBundledSkill).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledOnce()
    expect(provide).not.toHaveBeenCalled()
  })

  it('reports a failed confirmed update without mounting the TUI', async () => {
    setTTY(true)
    vi.mocked(installBundledSkill)
      .mockImplementationOnce(() => { throw new SkillAlreadyExistsError(DESTINATION) })
      .mockImplementationOnce(() => { throw new Error('update failed') })
    const close = vi.fn()
    vi.mocked(createInterface).mockReturnValue({ question: vi.fn().mockResolvedValue('yes'), close } as unknown as ReturnType<typeof createInterface>)
    const { ctx, exit, provide } = contextFor(['install-skills'])
    apply(ctx)
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining('update failed'))
    expect(close).toHaveBeenCalledOnce()
    expect(provide).not.toHaveBeenCalled()
  })

  it('exits cleanly when reading the confirmation fails', async () => {
    setTTY(true)
    vi.mocked(installBundledSkill).mockImplementationOnce(() => { throw new SkillAlreadyExistsError(DESTINATION) })
    const close = vi.fn()
    vi.mocked(createInterface).mockReturnValue({ question: vi.fn().mockRejectedValue(new Error('input closed')), close } as unknown as ReturnType<typeof createInterface>)
    const { ctx, exit, provide } = contextFor(['install-skills'])
    apply(ctx)
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
    expect(installBundledSkill).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledOnce()
    expect(provide).not.toHaveBeenCalled()
  })
})
