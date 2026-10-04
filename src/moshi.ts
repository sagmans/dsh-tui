import type { DriverStatus } from './herdr/state.ts'

/** A dedicated token is explicit consent; generic Moshi pairing credentials are never read. */
const TOKEN_ENV = 'DSH_TUI_MOSHI_TOKEN'
const WEBHOOK = 'https://api.getmoshi.app/api/webhook'
// Bound each request so a stalled endpoint cannot retain the single delivery slot indefinitely.
const REQUEST_TIMEOUT_MS = 3_000
const NOTICES = {
  complete: { title: 'DSH finished', message: 'The current session is ready for input.' },
  attention: { title: 'DSH needs attention', message: 'Return to the terminal to continue.' },
} as const

type Notice = keyof typeof NOTICES

/** Surface facts exclude transcript, tool arguments, and approval authority. */
export interface MoshiReporter {
  session(id: string, status: DriverStatus): void
  driver(status: DriverStatus): void
  background(running: boolean): void
  block(key: string): void
  unblock(key: string): void
  dispose(): void
}

/** Best-effort notifications must never hold the terminal or become an agent dependency. */
export function createMoshiReporter(): MoshiReporter | undefined {
  const token = process.env[TOKEN_ENV]?.trim()
  if (!token) return undefined

  let session: string | undefined
  let driverRunning = false
  let backgroundRunning = false
  let workPending = false
  let disposed = false
  let sending = false
  let activeRequest: AbortController | undefined
  const blocked = new Set<string>()
  // Two fixed notice kinds bound memory while a slow endpoint is unavailable.
  const pending = new Set<Notice>()

  const flush = (): void => {
    if (disposed || session === undefined || sending) return
    const notice = pending.values().next().value
    if (notice === undefined) return
    pending.delete(notice)
    sending = true
    void deliver(notice)
  }

  const deliver = async (notice: Notice): Promise<void> => {
    const controller = new AbortController()
    activeRequest = controller
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    timeout.unref()
    try {
      const response = await fetch(WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // A redirect must not forward the notification credential elsewhere.
        redirect: 'error',
        signal: controller.signal,
        body: JSON.stringify({ token, ...NOTICES[notice] }),
      })
      await response.body?.cancel()
    } catch {
      // Errors may contain credentials; neither terminal output nor session logs may receive them.
    } finally {
      clearTimeout(timeout)
      if (activeRequest === controller) activeRequest = undefined
      sending = false
      flush()
    }
  }

  const enqueue = (notice: Notice): void => {
    if (disposed || session === undefined) return
    pending.add(notice)
    flush()
  }

  // Completion means observed work settled without blockers, not task success or a repeated idle event.
  const settle = (): void => {
    if (disposed || session === undefined) return
    if (driverRunning || backgroundRunning) {
      // A resumed run makes an unsent completion obsolete.
      pending.delete('complete')
      workPending = true
      return
    }
    if (blocked.size !== 0 || !workPending) return
    workPending = false
    enqueue('complete')
  }

  return {
    // New session facts invalidate queued notices and outstanding delivery for the previous session.
    session(id, status) {
      if (disposed) return
      pending.clear()
      activeRequest?.abort()
      session = id
      blocked.clear()
      backgroundRunning = false
      driverRunning = status === 'running'
      workPending = driverRunning
    },
    driver(status) {
      driverRunning = status === 'running'
      settle()
    },
    background(running) {
      backgroundRunning = running
      settle()
    },
    // Several gates may block one episode; only the first needs an attention notice.
    block(key) {
      if (disposed || session === undefined || blocked.has(key)) return
      const first = blocked.size === 0
      blocked.add(key)
      pending.delete('complete')
      if (first) enqueue('attention')
    },
    unblock(key) {
      if (!blocked.delete(key)) return
      if (blocked.size === 0) pending.delete('attention')
      settle()
    },
    dispose() {
      disposed = true
      session = undefined
      pending.clear()
      blocked.clear()
      activeRequest?.abort()
    },
  }
}
