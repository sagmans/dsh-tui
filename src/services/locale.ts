import { EN_LOCALE, type LocaleKey, type LocaleVariables } from '../locales/en.js'
import { ZH_LOCALE } from '../locales/zh.js'

export const LOCALE_IDS = Object.freeze(['zh', 'en'] as const)
export const LOCALE_SETTINGS_NAMESPACE = 'locale'
export const LOCALE_PREFERENCE_FIELD = 'preference'
export const DEFAULT_LOCALE = 'zh'

const ENGLISH_LOCALE_PREFIX = 'en'
const CHINESE_LOCALE_PREFIX = 'zh'
const VARIABLE_PATTERN = /\{([A-Za-z][A-Za-z0-9]*)\}/gu
const MISSING_VARIABLE_ERROR = 'missing locale variable'

export type LocaleId = typeof LOCALE_IDS[number]

export interface TuiLocaleEnvironment {
  readonly LANG?: string | undefined
  readonly LC_ALL?: string | undefined
  readonly LC_MESSAGES?: string | undefined
}

export interface TuiLocaleSnapshot {
  readonly id: LocaleId
  readonly revision: number
}

export interface TuiLocale {
  getSnapshot(): TuiLocaleSnapshot
  setLocale(id: LocaleId): void
  subscribe(listener: () => void): () => void
  t(key: LocaleKey, variables?: LocaleVariables): string
}

export interface TuiLocaleOptions {
  readonly environment?: TuiLocaleEnvironment | undefined
  readonly locale?: LocaleId | undefined
}

const DICTIONARIES: Readonly<Record<LocaleId, Readonly<Record<LocaleKey, string>>>> = Object.freeze({
  en: EN_LOCALE,
  zh: ZH_LOCALE,
})

export function isLocaleId(value: unknown): value is LocaleId {
  return LOCALE_IDS.some(id => id === value)
}

export function resolveEnvironmentLocale(environment: TuiLocaleEnvironment): LocaleId {
  const value = environment.LC_ALL ?? environment.LC_MESSAGES ?? environment.LANG ?? ''
  const normalized = value.trim().toLowerCase()
  if (normalized.startsWith(ENGLISH_LOCALE_PREFIX)) return 'en'
  if (normalized.startsWith(CHINESE_LOCALE_PREFIX)) return 'zh'
  return DEFAULT_LOCALE
}

function interpolate(template: string, variables: LocaleVariables): string {
  return template.replace(VARIABLE_PATTERN, (_match, name: string) => {
    const value = variables[name]
    if (value === undefined) throw new Error(`${MISSING_VARIABLE_ERROR}: ${name}`)
    return String(value)
  })
}

export function createTuiLocale(options: TuiLocaleOptions = {}): TuiLocale {
  let id = options.locale ?? resolveEnvironmentLocale(options.environment ?? process.env)
  let revision = 0
  const listeners = new Set<() => void>()

  return Object.freeze({
    getSnapshot(): TuiLocaleSnapshot {
      return Object.freeze({ id, revision })
    },
    setLocale(next: LocaleId): void {
      if (next === id) return
      id = next
      revision += 1
      for (const listener of listeners) listener()
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    t(key: LocaleKey, variables: LocaleVariables = {}): string {
      return interpolate(DICTIONARIES[id][key], variables)
    },
  })
}
