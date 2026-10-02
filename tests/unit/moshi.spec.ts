import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMoshiReporter } from '@/moshi.ts'

const TOKEN = 'test-moshi-token'
const SESSION = 'private-session-id'
const WEBHOOK = 'https://api.getmoshi.app/api/webhook'

/** A held request proves notification work cannot hold the agent's lifecycle. */
function heldRequest() {
  let settle!: (response: Response) => void
  const response = new Promise<Response>(resolve => { settle = resolve })
  return { response, settle: () => settle(new Response()) }
}

describe('optional Moshi notifications', () => {
  const send = vi.fn<typeof fetch>()

  beforeEach(() => {
    send.mockReset().mockResolvedValue(new Response())
    vi.stubGlobal('fetch', send)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('stays absent without explicit token consent', () => {
    expect(createMoshiReporter({})).toBeUndefined()
    expect(createMoshiReporter({ DSH_TUI_MOSHI_TOKEN: '   ' })).toBeUndefined()
    expect(send).not.toHaveBeenCalled()
  })

  it('sends only fixed text and token after observed work becomes idle', async () => {
    const reporter = createMoshiReporter({ DSH_TUI_MOSHI_TOKEN: TOKEN })!
    reporter.session(SESSION, 'idle')
    reporter.driver('idle')
    expect(send).not.toHaveBeenCalled()
    reporter.driver('running')
    reporter.driver('idle')
    reporter.driver('idle')
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    const [url, request] = send.mock.calls[0]!
    expect(url).toBe(WEBHOOK)
    expect(request).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' } })
    expect(JSON.parse(request!.body as string)).toEqual({
      token: TOKEN, title: 'DSH finished', message: 'The current session is ready for input.',
    })
    expect(request!.body).not.toContain(SESSION)
    reporter.dispose()
  })

  it('reports completion only when driver and background work both settle', async () => {
    const reporter = createMoshiReporter({ DSH_TUI_MOSHI_TOKEN: TOKEN })!
    reporter.session(SESSION, 'running')
    reporter.background(true)
    reporter.driver('idle')
    expect(send).not.toHaveBeenCalled()
    reporter.background(false)
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    reporter.dispose()
  })

  it('deduplicates a stacked attention wait without sending gate content', async () => {
    const reporter = createMoshiReporter({ DSH_TUI_MOSHI_TOKEN: TOKEN })!
    reporter.session(SESSION, 'running')
    reporter.block('private-approval-key')
    reporter.block('private-approval-key')
    reporter.block('private-question-key')
    reporter.driver('idle')
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(JSON.parse(send.mock.calls[0]![1]!.body as string)).toEqual({
      token: TOKEN, title: 'DSH needs attention', message: 'Return to the terminal to continue.',
    })
    reporter.unblock('private-approval-key')
    expect(send).toHaveBeenCalledTimes(1)
    reporter.unblock('private-question-key')
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    reporter.dispose()
  })

  it('keeps lifecycle calls synchronous while one request is held', async () => {
    const held = heldRequest()
    send.mockReturnValueOnce(held.response)
    const reporter = createMoshiReporter({ DSH_TUI_MOSHI_TOKEN: TOKEN })!
    reporter.session(SESSION, 'running')
    expect(reporter.block('gate')).toBeUndefined()
    reporter.unblock('gate')
    expect(reporter.driver('idle')).toBeUndefined()
    reporter.driver('running')
    reporter.driver('idle')
    expect(send).toHaveBeenCalledTimes(1)
    held.settle()
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    reporter.dispose()
  })

  it('drops queued completion when the driven agent resumes work', async () => {
    const held = heldRequest()
    send.mockReturnValueOnce(held.response)
    const reporter = createMoshiReporter({ DSH_TUI_MOSHI_TOKEN: TOKEN })!
    reporter.session(SESSION, 'running')
    reporter.block('gate')
    reporter.unblock('gate')
    reporter.driver('idle')
    reporter.driver('running')
    held.settle()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(send).toHaveBeenCalledTimes(1)
    reporter.driver('idle')
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    reporter.dispose()
  })

  it('drops queued attention after its gate has already settled', async () => {
    const held = heldRequest()
    send.mockReturnValueOnce(held.response)
    const reporter = createMoshiReporter({ DSH_TUI_MOSHI_TOKEN: TOKEN })!
    reporter.session(SESSION, 'running')
    reporter.driver('idle')
    reporter.block('gate')
    reporter.unblock('gate')
    held.settle()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(send).toHaveBeenCalledTimes(1)
    reporter.dispose()
  })

  it('aborts stale session work and discards queued notifications on a switch', async () => {
    const held = heldRequest()
    send.mockReturnValueOnce(held.response)
    const reporter = createMoshiReporter({ DSH_TUI_MOSHI_TOKEN: TOKEN })!
    reporter.session(SESSION, 'running')
    reporter.block('gate')
    reporter.unblock('gate')
    reporter.driver('idle')
    const signal = send.mock.calls[0]![1]!.signal!
    reporter.session('other-session', 'idle')
    expect(signal.aborted).toBe(true)
    held.settle()
    await Promise.resolve()
    await Promise.resolve()
    expect(send).toHaveBeenCalledTimes(1)
    reporter.driver('idle')
    expect(send).toHaveBeenCalledTimes(1)
    reporter.dispose()
  })

  it('silently absorbs network and HTTP failures without retries', async () => {
    send.mockRejectedValueOnce(new Error(TOKEN)).mockResolvedValueOnce(new Response('', { status: 401 }))
    const reporter = createMoshiReporter({ DSH_TUI_MOSHI_TOKEN: TOKEN })!
    reporter.session(SESSION, 'running')
    reporter.driver('idle')
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    reporter.driver('running')
    reporter.driver('idle')
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    reporter.dispose()
  })

  it('aborts a stalled request at the three-second boundary', async () => {
    vi.useFakeTimers()
    const held = heldRequest()
    send.mockReturnValueOnce(held.response)
    const reporter = createMoshiReporter({ DSH_TUI_MOSHI_TOKEN: TOKEN })!
    reporter.session(SESSION, 'running')
    reporter.driver('idle')
    const signal = send.mock.calls[0]![1]!.signal!
    vi.advanceTimersByTime(2_999)
    expect(signal.aborted).toBe(false)
    vi.advanceTimersByTime(1)
    expect(signal.aborted).toBe(true)
    reporter.dispose()
    held.settle()
  })

  it('aborts outstanding delivery on disposal', async () => {
    vi.useFakeTimers()
    const held = heldRequest()
    send.mockReturnValueOnce(held.response)
    const reporter = createMoshiReporter({ DSH_TUI_MOSHI_TOKEN: TOKEN })!
    reporter.session(SESSION, 'running')
    reporter.driver('idle')
    const signal = send.mock.calls[0]![1]!.signal!
    reporter.dispose()
    expect(signal.aborted).toBe(true)
    reporter.driver('running')
    reporter.driver('idle')
    reporter.block('gate')
    held.settle()
    await Promise.resolve()
    expect(send).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
})
