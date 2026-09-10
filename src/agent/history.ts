import type { Context } from '@deepseek-ai/cordis'

/** One stored session as the picker shows it. */
export interface StoredSession {
  readonly id: string
  readonly cwd: string | undefined
  readonly createdAt: number
  readonly eventCount: number | undefined
}

/** One stored event, reduced to what the transcript fold reads. */
export interface StoredEvent {
  readonly type: string
  readonly data?: unknown
}

/** The part of the persistence seam this surface uses, described structurally. */
export interface SessionHistory {
  /** Newest sessions first, at most `limit` of them. */
  list(limit: number): Promise<readonly StoredSession[]>
  /** Read a session's log from its start; `limit` bounds a title read. */
  read(id: string, limit?: number): Promise<readonly StoredEvent[]>
}

/** Sessions the picker offers before a menu stops being a menu. */
export const PICKER_LIMIT = 30

/** Events read to title one session: enough to reach its first prompt. */
export const TITLE_EVENT_LIMIT = 40

/** Longest session title the picker shows, before the row can no longer hold it. */
export const TITLE_CHAR_LIMIT = 72

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

/**
 * First human prompt of a session, for a row a person can recognize.
 *
 * Only a direct prompt titles a session: injected context and plugin notices
 * also arrive as user-role messages and would name every session after whatever
 * the harness happened to inject first.
 */
export function sessionTitle(events: readonly StoredEvent[], limit = TITLE_CHAR_LIMIT): string | undefined {
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const data = asRecord(event.data)
    if (asRecord(data?.source)?.kind !== 'user') continue
    const content = Array.isArray(data?.content) ? data.content : []
    const parts: string[] = []
    for (const block of content) {
      const text = asRecord(block)?.text
      if (typeof text === 'string') parts.push(text)
    }
    const title = parts.join(' ').replace(/\s+/gu, ' ').trim()
    if (title === '') continue
    return title.length > limit ? `${title.slice(0, limit - 1)}…` : title
  }
  return undefined
}

/**
 * Wrap the persistence service in the little of it a terminal needs.
 *
 * The seam itself is optional here: a composition without durable storage can
 * still run the surface, it just cannot list or replay stored sessions. A read
 * handle is always closed, because an unclosed one keeps backend resources
 * alive for the rest of the process.
 */
export function createSessionHistory(ctx: Context): SessionHistory | undefined {
  const service = ctx.get('sessionPersistence') as
    | {
        list(): Promise<unknown>
        open(id: string, access: 'read'): Promise<unknown>
      }
    | undefined
  if (typeof service?.list !== 'function' || typeof service.open !== 'function') return undefined
  const read = async (id: string, limit?: number): Promise<readonly StoredEvent[]> => {
    const handle = (await service.open(id, 'read')) as {
      read(offset?: number, length?: number): Promise<{ events?: readonly unknown[] }>
      close(): Promise<void>
    }
    try {
      const result = await handle.read(0, limit)
      const events: StoredEvent[] = []
      for (const entry of result.events ?? []) {
        const record = asRecord(entry)
        if (typeof record?.type !== 'string') continue
        events.push({ type: record.type, data: record.data })
      }
      return events
    } finally {
      await handle.close()
    }
  }
  return {
    read,
    list: async limit => {
      const snapshots = await service.list()
      const sessions: StoredSession[] = []
      for (const entry of Array.isArray(snapshots) ? snapshots : []) {
        const header = asRecord(asRecord(entry)?.header)
        const id = header?.id
        if (typeof id !== 'string') continue
        const eventCount = asRecord(entry)?.eventCount
        sessions.push({
          id,
          cwd: typeof header?.cwd === 'string' ? header.cwd : undefined,
          createdAt: typeof header?.createdAt === 'number' ? header.createdAt : 0,
          eventCount: typeof eventCount === 'number' ? eventCount : undefined,
        })
      }
      return sessions.sort((left, right) => right.createdAt - left.createdAt).slice(0, limit)
    },
  }
}
