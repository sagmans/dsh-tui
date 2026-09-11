import type { Context } from '@deepseek-ai/cordis'

/** One stored session as the picker shows it. */
export interface StoredSession {
  readonly id: string
  readonly cwd: string | undefined
  readonly createdAt: number
  readonly eventCount: number | undefined
}

/** The persisted header fields this surface reads besides the list columns. */
export interface StoredHeader {
  readonly id: string
  /** Preset the session STARTED with; a later selection is a log event. */
  readonly agentPreset: string | undefined
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
  /** Read a slice of a session's log; `limit` bounds a title read. */
  read(id: string, options?: { readonly offset?: number; readonly limit?: number }): Promise<readonly StoredEvent[]>
  /** One session's stored header, or undefined when nothing is stored under that id. */
  header(id: string): Promise<StoredHeader | undefined>
}

/** Sessions the picker offers before a menu stops being a menu. */
export const PICKER_LIMIT = 30

/** Events read to title one session: enough to reach its title or first prompt. */
export const TITLE_EVENT_LIMIT = 40

/** Longest session title the picker shows, before the row can no longer hold it. */
export const TITLE_CHAR_LIMIT = 72

/** Events read to resolve a session's preset: a selection sits in its blank prefix. */
export const PRESET_EVENT_LIMIT = 40

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

/** One stored header, or undefined when the snapshot carries no usable identity. */
function headerOf(snapshot: unknown): StoredHeader | undefined {
  const entry = asRecord(snapshot)
  const header = asRecord(entry?.header)
  const id = header?.id
  if (typeof id !== 'string') return undefined
  const eventCount = entry?.eventCount
  return {
    id,
    agentPreset: typeof header?.agentPreset === 'string' ? header.agentPreset : undefined,
    eventCount: typeof eventCount === 'number' ? eventCount : undefined,
  }
}

function clip(title: string, limit: number): string {
  const collapsed = title.replace(/\s+/gu, ' ').trim()
  if (collapsed === '') return ''
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed
}

/**
 * Name a session, preferring the title the harness derived or the reader set.
 *
 * The durable `session/title` wins because it is what every other surface
 * shows; a session that has none yet falls back to its first human prompt.
 * Injected context and plugin notices also arrive as user-role messages, so
 * only a direct prompt may name a session.
 */
export function sessionTitle(events: readonly StoredEvent[], limit = TITLE_CHAR_LIMIT): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'session/title') continue
    const declared = asRecord(event.data)?.title
    if (typeof declared !== 'string') continue
    const title = clip(declared, limit)
    if (title !== '') return title
  }
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
    const title = clip(parts.join(' '), limit)
    if (title === '') continue
    return title
  }
  return undefined
}

/**
 * Title one stored session.
 *
 * The tail is read first because a title is latest-wins and usually written
 * after the first turn; the head is the fallback for a session that has a
 * prompt but no title yet.
 */
export async function readSessionTitle(history: SessionHistory, session: StoredSession): Promise<string | undefined> {
  const end = session.eventCount ?? 0
  if (end > TITLE_EVENT_LIMIT) {
    const tail = await history.read(session.id, { offset: end - TITLE_EVENT_LIMIT, limit: TITLE_EVENT_LIMIT })
    const declared = sessionTitle(tail)
    if (declared !== undefined) return declared
  }
  return sessionTitle(await history.read(session.id, { limit: TITLE_EVENT_LIMIT }))
}

/**
 * The agent preset a stored session runs.
 *
 * The creation header names the preset the session STARTED with, and a
 * selection recorded while it was still blank replaced it. The projection's own
 * rule is that the last selection wins over the header, so the tail is read
 * first and the head second: the harness refuses a switch once a turn has run,
 * which puts any selection in the blank prefix. Reading both keeps this correct
 * if that rule ever loosens, and the event count bounds the work either way.
 */
export async function presetOfStoredSession(history: SessionHistory, id: string): Promise<string | undefined> {
  const header = await history.header(id)
  if (header === undefined) return undefined
  const end = header.eventCount ?? 0
  if (end > PRESET_EVENT_LIMIT) {
    const tail = await lastSelection(history, id, end - PRESET_EVENT_LIMIT, PRESET_EVENT_LIMIT)
    if (tail !== undefined) return tail
  }
  return await lastSelection(history, id, 0, PRESET_EVENT_LIMIT) ?? header.agentPreset
}

/** The last recorded selection inside one slice of a session's log. */
async function lastSelection(
  history: SessionHistory,
  id: string,
  offset: number,
  limit: number,
): Promise<string | undefined> {
  const events = await history.read(id, { offset, limit })
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'agent-preset/selected') continue
    const preset = asRecord(event.data)?.agentPreset
    if (typeof preset === 'string' && preset !== '') return preset
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
        stat?(id: string): Promise<unknown>
      }
    | undefined
  if (typeof service?.list !== 'function' || typeof service.open !== 'function') return undefined
  const read = async (
    id: string,
    options?: { readonly offset?: number; readonly limit?: number },
  ): Promise<readonly StoredEvent[]> => {
    const handle = (await service.open(id, 'read')) as {
      read(offset?: number, length?: number): Promise<{ events?: readonly unknown[] }>
      close(): Promise<void>
    }
    try {
      const result = await handle.read(options?.offset ?? 0, options?.limit)
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
    header: async id => {
      const stat = service.stat
      return typeof stat === 'function' ? headerOf(await stat.call(service, id)) : undefined
    },
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
