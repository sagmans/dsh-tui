import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { TUI_THEME_PREFERENCES } from '../contracts/theme.js'
import {
  LOCALE_IDS,
  LOCALE_PREFERENCE_FIELD,
  LOCALE_SETTINGS_NAMESPACE,
} from './locale.js'
import {
  DEFAULT_THEME_PREFERENCE,
  THEME_PREFERENCE_FIELD,
  THEME_SETTINGS_NAMESPACE,
} from './theme.js'

const ThemeSettingsSchema = z.object({
  [THEME_PREFERENCE_FIELD]: z.union([...TUI_THEME_PREFERENCES]).default(DEFAULT_THEME_PREFERENCE),
})
const LocaleSettingsSchema = z.object({
  [LOCALE_PREFERENCE_FIELD]: z.union([...LOCALE_IDS]).required(false),
})

export function registerTuiPreferenceSettings(ctx: Context): void {
  ctx.inject(['settings'], settingsCtx => {
    settingsCtx.settings.register(
      settingsNamespace(THEME_SETTINGS_NAMESPACE),
      ThemeSettingsSchema,
    )
    settingsCtx.settings.register(
      settingsNamespace(LOCALE_SETTINGS_NAMESPACE),
      LocaleSettingsSchema,
    )
  })
}
