import z from '@deepseek-ai/schemastery'
import { ACTION_CATALOG, isPluginActionId } from './action-catalog.ts'

/**
 * One action's keys as the document writes them: one key, or a list of them.
 *
 * A free string rather than an enumerated union of key ids: the catalog owns
 * which keys exist, and its refusal is the message a reader can act on.
 */
const KeyListSchema = z.union([z.string(), z.array(z.string())])

/**
 * The `keys:` half of the section.
 *
 * A dictionary preserves optional plugin rows through profile settings projection;
 * a fixed object exposes only its schema-declared builtin names.
 * The resolver still validates action names and key policy before activation.
 */
export const KeymapSectionSchema: z = z.dict(KeyListSchema)

const ACTION_IDS: ReadonlySet<string> = new Set(ACTION_CATALOG.map(action => action.id))

/**
 * Whether a name is an action the surface has.
 *
 * Schemastery keeps what it does not declare, so a misspelled action would
 * otherwise parse cleanly and do nothing at all — the one outcome a reader
 * could not debug from the screen.
 */
export function isActionId(name: string): boolean {
  return ACTION_IDS.has(name) || isPluginActionId(name)
}
