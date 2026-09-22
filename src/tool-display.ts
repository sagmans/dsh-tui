import { CARD_DETAIL_MAX, CARD_SHELL_PREVIEW } from './cards.ts'

/**
 * How one tool's cards draw.
 *
 * The reader owns this, because how much of a call a session shows is a
 * preference about their own screen rather than something a tool can declare:
 * the same command card is noise in one session and the answer in another.
 */
export interface ToolDisplaySpec {
  /** Whether the tool's cards start folded to one header row. */
  readonly collapsed: boolean
  /** Characters of the argument a folded header keeps before it is cut. */
  readonly maxArgument: number
  /** What a folded card shows of the rows behind it. */
  readonly output: ToolOutputDisplay
  /** Rows a folded card keeps when {@link ToolOutputDisplay} is `tail`. */
  readonly tail: number
}

/** A tool's row as it is read: only the fields the reader wrote, still writable while they are collected. */
export type WrittenToolDisplay = { -readonly [K in keyof ToolDisplaySpec]?: ToolDisplaySpec[K] }

/** The values the `output` key accepts, declared once for the schema and the refusal message. */
export const TOOL_OUTPUT_DISPLAYS = ['hidden', 'tail'] as const
export type ToolOutputDisplay = (typeof TOOL_OUTPUT_DISPLAYS)[number]

/** Bounds the schema and the refusal message share, so neither can drift from the other. */
export const TOOL_DISPLAY_LIMITS = {
  maxArgument: { min: 1, max: 1000 },
  tail: { min: 0, max: CARD_DETAIL_MAX },
} as const

/** What every tool draws when the reader has written nothing: one clipped line, no output. */
export const DEFAULT_TOOL_DISPLAY: ToolDisplaySpec = {
  collapsed: true,
  maxArgument: 100,
  output: 'hidden',
  tail: CARD_SHELL_PREVIEW,
}

/** The one name the block reserves: the row every tool without its own inherits. */
export const DEFAULT_TOOL_ENTRY = 'default'

/** The `tools:` block once resolved: the default row, and every tool that named its own. */
export interface ToolDisplayTable {
  readonly default: ToolDisplaySpec
  readonly tools: Readonly<Record<string, ToolDisplaySpec>>
}

/** The display one tool draws with, falling back to the block's own default. */
export function toolDisplayFor(table: ToolDisplayTable, tool: string): ToolDisplaySpec {
  return table.tools[tool] ?? table.default
}

/**
 * Fill the fields a partial spec left out.
 *
 * A per-tool entry merges over the block's own `default` rather than over the
 * shipped one, so a reader who writes `default: { maxArgument: 40 }` keeps that
 * budget for every tool that does not name its own.
 */
export function resolveToolDisplay(
  partial: Partial<ToolDisplaySpec> | undefined,
  fallback: ToolDisplaySpec = DEFAULT_TOOL_DISPLAY,
): ToolDisplaySpec {
  return {
    collapsed: partial?.collapsed ?? fallback.collapsed,
    maxArgument: partial?.maxArgument ?? fallback.maxArgument,
    output: partial?.output ?? fallback.output,
    tail: partial?.tail ?? fallback.tail,
  }
}

/**
 * Build the table a view reads.
 *
 * Per-tool entries merge here rather than at read time: the view asks once per
 * card per frame, and re-merging there would repeat the same answer for every
 * row on screen.
 */
export function toolDisplayTable(specs: Readonly<Record<string, Partial<ToolDisplaySpec>>> = {}): ToolDisplayTable {
  const base = resolveToolDisplay(specs[DEFAULT_TOOL_ENTRY])
  const tools: Record<string, ToolDisplaySpec> = {}
  for (const [tool, partial] of Object.entries(specs)) {
    if (tool === DEFAULT_TOOL_ENTRY) continue
    tools[tool] = resolveToolDisplay(partial, base)
  }
  return { default: base, tools }
}
