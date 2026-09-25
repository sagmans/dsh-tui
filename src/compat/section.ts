/** Keep released section ownership and Config-backed profile edits behind one checked seam. */
import type { Context } from '@deepseek-ai/cordis'

const READ_UNSUPPORTED = 'the settings service cannot read the section; prompt history stays off'
const WRITE_UNSUPPORTED = 'the settings service cannot write the section; the patch was not applied'
const CONFIG_NOT_LIVE = 'the settings service cannot write live Config with this schema runtime; the patch was not applied'

/** Appearance must not report success until its durable owner accepts the patch. */
export interface SectionScope {
  readonly kind: 'installSection' | 'register' | 'config' | 'unsupported'
  get(): unknown
  update(patch: object): Promise<void>
  /** Raw opt-outs can precede a valid commit and therefore never reach get() or notifications. */
  readUser(): { readonly value: unknown; readonly revision: number } | undefined
}

/** The installing API changes its authoritative reader when the provider detaches. */
interface SectionHooks<T> {
  setSource(current: () => T): void
  onChange(): void
}

/** Source hosts expose plain snapshots keyed by profile entry options.id, not qualified Loader paths. */
interface ConfigDescriptor {
  ns: string
  value: unknown
  user?: unknown
  revision: number
}

/** Probe behavior, not CLI identity: both host generations can share a version label. */
interface SettingsSeam {
  installSection?(owner: Context, ns: string, schema: unknown, entry: unknown, hooks: SectionHooks<unknown>): void
  register?(ns: string, schema: unknown, options: { base: unknown }): Pick<SectionScope, 'get' | 'update'>
  describe?(): ConfigDescriptor[]
  update?(ns: string, patch: object, revision?: number): Promise<void>
  writable?: boolean
}

/** The row reader is needed before the Loader marks the calling fiber active. */
export interface SectionRequest<T> {
  readonly owner: Context
  readonly ns: string
  readonly schema: unknown
  readonly entry: T
  readonly onChange: () => void
  readonly config?: { readonly ns: string | undefined; readonly get: () => unknown; readonly live: boolean }
}

/** Never manufacture a successful write when no supported owner can persist it. */
export function openSection<T>(service: unknown, request: SectionRequest<T>): SectionScope {
  const settings = (service ?? {}) as SettingsSeam
  const refuseWrite = (): Promise<never> => Promise.reject(new Error(WRITE_UNSUPPORTED))
  const readUser = (ns: string | undefined): ReturnType<SectionScope['readUser']> => {
    if (typeof settings.describe !== 'function') return undefined
    const descriptor = settings.describe().find(row => row.ns === ns)
    if (descriptor === undefined || !Number.isSafeInteger(descriptor.revision) || descriptor.revision < 0) {
      throw new Error(READ_UNSUPPORTED)
    }
    return { value: descriptor.user, revision: descriptor.revision }
  }
  if (typeof settings.installSection === 'function') {
    let source: () => unknown = () => request.entry
    // An attach notification precedes the caller receiving its scope.
    let attached = false
    settings.installSection(request.owner, request.ns, request.schema, request.entry, {
      setSource: current => { source = current },
      onChange: () => { if (attached) request.onChange() },
    })
    attached = true
    return {
      kind: 'installSection',
      readUser: () => readUser(request.ns),
      get: () => source(),
      update: async patch => {
        if (settings.writable === false || typeof settings.update !== 'function') return refuseWrite()
        await settings.update(request.ns, patch)
      },
    }
  }
  if (typeof settings.register === 'function') {
    const scope = settings.register(request.ns, request.schema, { base: request.entry })
    return {
      kind: 'register',
      readUser: () => readUser(request.ns),
      get: () => scope.get(),
      update: async patch => {
        if (settings.writable === false || typeof scope.update !== 'function') return refuseWrite()
        await scope.update(patch)
      },
    }
  }
  if (typeof settings.describe === 'function' && request.config !== undefined) {
    const config = request.config
    const descriptor = (): ConfigDescriptor | undefined => config.ns === undefined
      ? undefined
      : settings.describe!().find(row => row.ns === config.ns)
    return {
      kind: 'config',
      readUser: () => readUser(config.ns),
      // Config is readable during startup even before describe() includes this fiber.
      get: () => {
        const current = descriptor()
        return current === undefined ? config.get() : current.value
      },
      update: async patch => {
        if (!config.live) throw new Error(CONFIG_NOT_LIVE)
        const current = descriptor()
        if (current === undefined || settings.writable === false || typeof settings.update !== 'function'
          || !Number.isSafeInteger(current.revision) || current.revision < 0) return refuseWrite()
        await settings.update(current.ns, patch, current.revision)
      },
    }
  }
  return {
    kind: 'unsupported',
    readUser: () => { throw new Error(READ_UNSUPPORTED) },
    get: () => { throw new Error(READ_UNSUPPORTED) },
    update: refuseWrite,
  }
}
