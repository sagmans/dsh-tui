/**
 * Name a plugin that failed to start while the reader can still act on it.
 *
 * The launcher reports an inactive optional plugin on stderr, and the surface
 * holds stderr until it gives the screen back (see `terminal/host-writes.ts`).
 * A broken plugin would therefore read as a healthy `ready` for the whole
 * session, and its provider, tools, or commands would simply be missing. The
 * launcher keeps its full report with stacks, which still prints on exit; this
 * module adds the one line per plugin that the screen can spare.
 *
 * An error can quote the configuration value it refused. The screen shows what
 * stderr prints on exit anyway, but `/export` is a file made for sharing, so it
 * records only which plugin failed. Pattern redaction would miss other shapes.
 *
 * The launcher publishes no audit result, so this reads the same loader state
 * its audit reads (`auditStartupEntries` in `dsh-app-boot`), and reads it only
 * after `appReady`, when that audit has finished and the tree has settled.
 */
import type { Context } from '@deepseek-ai/cordis'
import { stripControlCharacters } from '../text.ts'

const LOADER_SERVICE = 'loader'

// Cordis declares `FiberState` as an ambient const enum, which has no runtime
// value to import under `verbatimModuleSyntax`; the launcher copies them too.
const FIBER_PENDING = 0
const FIBER_ACTIVE = 2
const FIBER_FAILED = 3
const FIBER_DISPOSED = 4

/** A notice is one transcript row, while a plugin error can quote a whole document. */
const REASON_LIMIT = 300
const REASON_ELLIPSIS = '…'
const LINE_BREAK = /\r?\n/u
const CHECK_FAILED = 'could not check plugin startup'

/** The part of a loader fiber this module reads; the loader package is not a dependency of this bundle. */
interface LoaderFiber {
  readonly state: number
  readonly inject: Readonly<Record<string, unknown>>
  readonly ctx: { get(service: string): unknown }
  await(): Promise<unknown>
}

/** One composed plugin row. `disabled` is a getter, because a row can compute it from an expression that throws. */
interface LoaderEntry {
  readonly options: { readonly id: string }
  readonly disabled: unknown
  readonly fiber?: LoaderFiber
}

interface PluginLoader {
  entries(): Iterable<LoaderEntry>
}

/** The screen may show a reason; only `exported` may reach a file. */
interface PluginNotice {
  readonly screen: string
  readonly exported: string
}

/** Error text comes from plugin code and configuration, so it reaches the screen only as one clean, bounded line. */
function oneLine(text: string): string {
  const [first = ''] = text.split(LINE_BREAK, 1)
  const clean = stripControlCharacters(first)
  return clean.length > REASON_LIMIT ? `${clean.slice(0, REASON_LIMIT)}${REASON_ELLIPSIS}` : clean
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A settled failed fiber rejects at once with its recorded reason; no wait can outlast the startup that recorded it. */
async function failureReason(fiber: LoaderFiber): Promise<string> {
  try {
    await fiber.await()
    return 'failed with no recorded error'
  } catch (error) {
    return errorText(error)
  }
}

function missingServices(fiber: LoaderFiber): string {
  const missing = Object.keys(fiber.inject).filter(
    (service) => fiber.ctx.get(service) === undefined,
  )
  return `waiting for: ${missing.join(', ') || 'unknown service'}`
}

/** Why one enabled row is not running, or `undefined` for a row that is. */
function fiberProblem(fiber: LoaderFiber | undefined): Promise<string> | string | undefined {
  if (fiber === undefined || fiber.state === FIBER_DISPOSED) return 'failed to import'
  if (fiber.state === FIBER_ACTIVE) return undefined
  if (fiber.state === FIBER_FAILED) return failureReason(fiber)
  if (fiber.state === FIBER_PENDING) return missingServices(fiber)
  return `fiber state ${String(fiber.state)}`
}

/** A throwing disabled expression is the row's own failure, so it must not stop the rows after it being read. */
async function entryProblem(entry: LoaderEntry): Promise<string | undefined> {
  try {
    if (entry.disabled) return undefined
  } catch (error) {
    return `disabled expression failed: ${errorText(error)}`
  }
  return fiberProblem(entry.fiber)
}

/** One notice for each composed plugin that is not running, in composition order. */
async function inactivePluginNotices(loader: PluginLoader): Promise<PluginNotice[]> {
  const notices: PluginNotice[] = []
  for (const entry of loader.entries()) {
    const problem = await entryProblem(entry)
    if (problem !== undefined) {
      const exported = `plugin ${oneLine(entry.options.id)} did not activate`
      notices.push({ screen: `${exported}: ${oneLine(problem)}`, exported })
    }
  }
  return notices
}

/**
 * Post the inactive plugins as notices once the launcher commits startup.
 *
 * The notice sink must outlive this call: the audit finishes after the surface
 * mounts, because the surface is itself a row of the tree that audit waits for.
 *
 * @returns a disposer, so that a surface that left the screen first posts nothing.
 */
export function reportInactivePlugins(
  ctx: Context,
  notice: (message: string, exportMessage: string) => void,
): () => void {
  const appReady = ctx.get('appReady')
  const loader = ctx.get(LOADER_SERVICE as never) as PluginLoader | undefined
  if (appReady === undefined || loader === undefined) return () => {}
  let live = true
  const post = ({ screen, exported }: PluginNotice): void => {
    if (live) notice(screen, exported)
  }
  const stop = appReady.onReady(() => {
    void inactivePluginNotices(loader).then(
      (notices) => {
        for (const pluginNotice of notices) post(pluginNotice)
      },
      // This check is a courtesy over a report the launcher still prints, so its own failure must not end the session.
      (error: unknown) => {
        post({
          screen: `${CHECK_FAILED}: ${oneLine(errorText(error))}`,
          exported: CHECK_FAILED,
        })
      },
    )
  })
  return () => {
    live = false
    stop()
  }
}
