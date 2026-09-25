import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { describe, expect, it, vi } from 'vitest'
import { createAppearance, type Appearance } from '@/surface/appearance.ts'

const NAMESPACE = 'dsh-tui'
const THEME = 'violet-orbit'
const ENABLED = { theme: THEME, history: { enabled: true, ghost: true } }

/** Real provider validation and publication run without a disk, terminal, or network. */
class MemorySettings extends SettingsProvider {
  readonly writable = true

  protected async load(): Promise<Record<string, unknown>> {
    return {}
  }

  protected async persist(_ns: SettingsNamespace, _section: Record<string, unknown>): Promise<void> {}

  publishDocument(value: unknown): void {
    this.publish({ [NAMESPACE]: value })
  }
}

/** Cordis's asynchronous injection and backend validation must remain part of the regression. */
async function fixture(initial: unknown) {
  const ctx = new Context()
  try {
    await ctx.plugin(MemorySettings)
    const settings = ctx.get('settings') as MemorySettings
    settings.publishDocument(initial)
    let appearance: Appearance | undefined
    const notices: string[] = []
    await ctx.plugin({
      inject: ['settings'],
      apply: owner => {
        appearance = createAppearance(owner, {
          color: () => true, rowTheme: undefined, rowSettings: () => ({}), rowSettingsLive: false,
          notice: message => notices.push(message), render: vi.fn(), invalidateMarkdown: vi.fn(), invalidateView: vi.fn(),
          keybindings: () => ({ installBindings: vi.fn(), disarmChord: vi.fn() }),
          openPicker: async () => undefined,
        })
        appearance.openNotices(message => notices.push(message))
        appearance.registerSection()
        owner.effect(() => appearance!.settingsListener())
      },
    })
    await vi.waitFor(() => { expect(appearance).toBeDefined() })
    return { ctx, settings, appearance: appearance!, notices }
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}

describe('appearance with the released settings provider', () => {
  it('honors current raw opt-outs when invalid siblings prevent commits and notifications', async () => {
    const { ctx, settings, appearance, notices } = await fixture(ENABLED)
    try {
      await vi.waitFor(() => { expect(appearance.historyEnabled()).toBe(true) })
      expect(appearance.historyGhost()).toBe(true)
      const painted = appearance.theme.style('status.cwd', 'cwd')
      const changed = vi.fn()
      ctx.on('settings/updated', changed)
      ctx.on('settings/document-updated', changed)
      settings.publishDocument({ theme: 123, history: { enabled: false, ghost: false } })
      expect(changed).not.toHaveBeenCalled()
      expect(settings.describe()[0]?.user).toMatchObject({ history: { enabled: false, ghost: false } })
      expect(appearance.historyEnabled()).toBe(false)
      expect(appearance.historyGhost()).toBe(false)
      expect(appearance.theme.style('status.cwd', 'cwd')).toBe(painted)
      appearance.runThemeCommand('tokens')
      expect(notices.join('\n')).toContain(THEME)
      // Removing the raw opt-out in another rejected candidate does not authorize recording again.
      settings.publishDocument({ theme: 123, history: { enabled: true, ghost: true } })
      expect(appearance.historyEnabled()).toBe(false)
      expect(appearance.historyGhost()).toBe(false)
      settings.publishDocument(ENABLED)
      await vi.waitFor(() => { expect(appearance.historyEnabled()).toBe(true) })
      expect(appearance.historyGhost()).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each([123, false, [], null, { theme: 123, history: { enabled: false, ghost: false } }].map(value => ({ value })))(
    'keeps malformed startup preferences off: $value', async ({ value }) => {
      const { ctx, appearance, notices } = await fixture(value)
      try {
        await vi.waitFor(() => { expect(notices.join('\n')).toContain('prompt history stays off until the section parses') })
        expect(appearance.historyEnabled()).toBe(false)
        expect(appearance.historyGhost()).toBe(false)
      } finally {
        await ctx.fiber.dispose()
      }
    },
  )

  it('refuses an uncommitted disappearing raw section even before the first history read', async () => {
    const { ctx, settings, appearance } = await fixture(ENABLED)
    try {
      await vi.waitFor(() => { expect(settings.describe()).toHaveLength(1) })
      const revision = settings.describe()[0]!.revision
      settings.publishDocument('not a mapping')
      expect(settings.describe()[0]!.revision).toBe(revision)
      expect(settings.describe()[0]!.user).toBeUndefined()
      expect(appearance.historyEnabled()).toBe(false)
      expect(appearance.historyGhost()).toBe(false)
      settings.publishDocument(ENABLED)
      await vi.waitFor(() => { expect(appearance.historyEnabled()).toBe(true) })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('characterizes the public descriptor ambiguity between absent and malformed root sections', async () => {
    const { ctx, settings, appearance } = await fixture(undefined)
    try {
      await vi.waitFor(() => { expect(appearance.historyEnabled()).toBe(true) })
      const before = settings.describe()
      settings.publishDocument('not a mapping')
      // No public raw layer, revision, or accepted value exposes this rejected root.
      expect(settings.describe()).toEqual(before)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
