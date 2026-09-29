import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { createAppearance, type Appearance } from '@/surface/appearance.ts'

const NAMESPACE = 'dsh-tui'
const THEME = 'violet-orbit'
const OTHER_THEME = 'pine-slope'
const ENABLED = { theme: THEME, history: { enabled: true, ghost: true } }

/**
 * The profile-entry settings generation a dsh 0.1.7 profile mounts: one Config row
 * per entry, read through `describe()` and written through `update()` against the
 * revision the reader last saw. `user` is the section the reader owns; `value` is
 * what the composition resolved from it.
 */
function formsGeneration(seed: { readonly value: unknown; readonly user?: unknown }) {
  let row = { value: seed.value, user: seed.user, revision: 1 }
  const listeners = new Map<string, (...args: unknown[]) => void>()
  const announce = (): void => { listeners.get('settings/document-updated')?.(NAMESPACE, row.revision) }
  const merge = (current: unknown, patch: object): unknown => ({ ...(current as Record<string, unknown> | undefined ?? {}), ...patch })
  return {
    listeners,
    row: () => row,
    service: {
      writable: true,
      describe: () => [{ ns: NAMESPACE, ...row }],
      update: async (_ns: string, patch: object, expected?: number): Promise<void> => {
        // The host refuses a write built on a stale read; a spec that skipped the
        // revision check would hide the conflict the surface has to survive.
        if (expected !== undefined && expected !== row.revision) throw new Error('SETTINGS_CONFLICT')
        row = { value: merge(row.value, patch), user: merge(row.user, patch), revision: row.revision + 1 }
        announce()
      },
    },
    /** A write another surface makes: the row moves and the document event fires. */
    publish: (next: { readonly value: unknown; readonly user?: unknown }): void => {
      row = { value: next.value, user: next.user, revision: row.revision + 1 }
      announce()
    },
  }
}

function fixture(seed: { readonly value: unknown; readonly user?: unknown }) {
  const generation = formsGeneration(seed)
  const ctx = {
    fiber: { entry: { options: { id: NAMESPACE } } },
    inject: (_names: string[], callback: (ctx: unknown) => void) => { callback({ settings: generation.service }) },
    on: (event: string, callback: (...args: unknown[]) => void) => {
      generation.listeners.set(event, callback)
      return () => { generation.listeners.delete(event) }
    },
    effect: (register: () => () => void) => register(),
  } as unknown as Context
  const notices: string[] = []
  const appearance: Appearance = createAppearance(ctx, {
    color: () => true, rowTheme: undefined, rowSettings: () => ({}), rowSettingsLive: true,
    notice: message => notices.push(message), render: vi.fn(), invalidateMarkdown: vi.fn(), invalidateView: vi.fn(),
    keybindings: () => ({ installBindings: vi.fn(), disarmChord: vi.fn() }),
    openPicker: async () => undefined,
  })
  appearance.openNotices(message => notices.push(message))
  appearance.registerSection()
  ctx.effect(() => appearance.settingsListener())
  return { appearance, notices, generation }
}

describe('appearance against the profile-entry settings generation', () => {
  it('keeps a raw opt-out in force while a sibling field is written', async () => {
    const given = fixture({ value: ENABLED, user: { history: { enabled: false, ghost: false } } })

    // The reader owns the opt-out even though the resolved row allows recording.
    expect(given.appearance.historyEnabled()).toBe(false)
    expect(given.appearance.historyGhost()).toBe(false)

    given.appearance.runThemeCommand(OTHER_THEME)

    await vi.waitFor(() => { expect(given.notices.join('\n')).toContain('written to the settings document') })
    expect(given.generation.row().value).toMatchObject({ theme: OTHER_THEME })
    // A theme choice is not consent to record, so the opt-out survives the write.
    expect(given.appearance.historyEnabled()).toBe(false)
  })

  it.each([123, false, [], null, { theme: 123, history: { enabled: false, ghost: false } }].map(value => ({ value })))(
    'keeps malformed preferences off: $value', async ({ value }) => {
      const given = fixture({ value, user: value })

      expect(given.appearance.historyEnabled()).toBe(false)
      expect(given.appearance.historyGhost()).toBe(false)
    },
  )

  it('refuses a disappearing raw section until the reader opts back in', async () => {
    const given = fixture({ value: ENABLED, user: ENABLED })
    await vi.waitFor(() => { expect(given.appearance.historyEnabled()).toBe(true) })
    expect(given.appearance.historyGhost()).toBe(true)

    given.generation.publish({ value: 'not a mapping' })

    // Removing the section is not consent either: only an explicit opt-in resumes.
    expect(given.appearance.historyEnabled()).toBe(false)
    expect(given.appearance.historyGhost()).toBe(false)

    given.generation.publish({ value: ENABLED, user: ENABLED })
    await vi.waitFor(() => { expect(given.appearance.historyEnabled()).toBe(true) })
    expect(given.appearance.historyGhost()).toBe(true)
  })
})
