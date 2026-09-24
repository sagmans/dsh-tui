/**
 * Section ownership seam.
 *
 * The settings capability moved between harness releases: the published rc line
 * exposes `register`, which hands the owner a scope to read and write through,
 * while the newer provider exposes `installSection`, which registers the same
 * namespace but reports the current value through a source thunk and routes the
 * write through the service itself. The surface consumes one narrow shape either
 * way, so the difference stays behind this seam instead of reaching the
 * appearance owner and the readers of its section.
 */
import type { Context } from '@deepseek-ai/cordis'

/** The narrow surface the appearance owner consumes: read the section, write a patch. */
export interface SectionScope {
  /** The section as it resolves now, the reader's own layer included. */
  get(): unknown
  /** Merge one patch into the section's user layer; rejects when the harness refuses it. */
  update(patch: object): Promise<void>
}

/**
 * How the installing shape reports the section.
 *
 * `setSource` swaps the authoritative thunk as the namespace attaches to and
 * detaches from the provider; `onChange` fires once per commit, which is how the
 * surface hears an edit when there is no scope of its own to watch.
 */
interface SectionHooks<T> {
  setSource(current: () => T): void
  onChange(): void
}

/** The settings service as a structural read, because the mounted shape depends on the harness release. */
interface SettingsSeam {
  installSection?(owner: Context, ns: string, schema: unknown, entry: unknown, hooks: SectionHooks<unknown>): void
  register?(ns: string, schema: unknown): SectionScope
  update?(ns: string, patch: object): Promise<void>
}

/** One request to own the reader's section. */
export interface SectionRequest<T> {
  /** Context the registration belongs to; unloading it removes the namespace again. */
  readonly owner: Context
  /** Namespace the reader writes the section under. */
  readonly ns: string
  /** Schemastery schema the provider validates the section against. */
  readonly schema: unknown
  /** Value the section falls back to whenever no provider holds it. */
  readonly entry: T
  /** Called once per committed change, after the section was re-read. */
  readonly onChange: () => void
}

/**
 * Own the reader's section on whichever service shape the harness mounts.
 *
 * The installing shape is tried first because it is the one a newer provider
 * keeps: the older service still carries both, and there the two are the same
 * registration, so preferring the narrower API loses nothing and stops a
 * harness that dropped `register` from failing here.
 *
 * Returns nothing when the service offers neither shape. The newest configuration
 * service projects each plugin's own Config into a form over the profile patch,
 * so there is no document section to register; the caller's row Config is then
 * the only durable store, and silence is the honest answer — an error would
 * report a missing section that this harness never had.
 */
export function openSection<T>(service: unknown, request: SectionRequest<T>): SectionScope | undefined {
  const settings = service as SettingsSeam
  if (typeof settings.installSection === 'function') {
    // The read is the provider's thunk: it answers with the resolved section
    // while the namespace is attached and with the composition entry after a
    // detach, so a scope of our own would only shadow that answer.
    let source: () => unknown = () => request.entry
    // The provider reports the attach through `onChange` before this call
    // returns, and the caller can only re-read the section once it holds the
    // scope below; forwarding that first report would read a surface that is
    // still being wired. The caller reads once right after opening instead.
    let attached = false
    settings.installSection(request.owner, request.ns, request.schema, request.entry, {
      setSource: current => { source = current as () => unknown },
      onChange: () => { if (attached) request.onChange() },
    })
    attached = true
    const update = settings.update?.bind(settings)
    return {
      get: () => source(),
      // The installing shape hands back no scope, so the write goes through the
      // service. Refusing loudly rather than swallowing the patch: a theme the
      // reader chose must not look written when nothing accepted it.
      update: patch => update === undefined
        ? Promise.reject(new Error('the settings service cannot write the section; the patch was not applied'))
        : update(request.ns, patch),
    }
  }
  if (typeof settings.register === 'function') {
    const scope = settings.register(request.ns, request.schema)
    return { get: () => scope.get(), update: patch => scope.update(patch) }
  }
  return undefined
}
