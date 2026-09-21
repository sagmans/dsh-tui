import {
  CombinedAutocompleteProvider,
  type AutocompleteItem,
  type AutocompleteSuggestions,
  type SlashCommand,
} from '@earendil-works/pi-tui'
import {
  atToken,
  atValue,
  createFileIndex,
  offerableCandidate,
  rankFiles,
  SUGGESTION_LIMIT,
  type Candidate,
  type FileIndex,
} from './file-search.ts'
import { LOCAL_COMMANDS, LOCAL_COMMAND_DESCRIPTIONS } from './submission.ts'
import { displayText } from '../text.ts'

/** One command another package registered, as the registry reports it. */
export interface RegisteredCommand {
  readonly name: string
  readonly description: string
}

/**
 * Every command the editor can complete.
 *
 * The surface's own commands come first because they always exist, and the
 * registry's follow: a reader typing a slash wants to see what this session can
 * actually run, not what a build happened to ship.
 */
export function commandMenu(registered: readonly RegisteredCommand[]): SlashCommand[] {
  const local = LOCAL_COMMANDS.map(name => ({
    // The menu shows and completes the bare name; the slash is already typed.
    name: name.slice(1),
    description: LOCAL_COMMAND_DESCRIPTIONS[name] ?? '',
  }))
  return [...local, ...registered.map(command => ({ name: command.name, description: command.description }))]
}

/**
 * Build the editor's completion provider.
 *
 * Commands and file references share one provider so a slash, an at-sign, and a
 * path prefix all behave the same way while typing. The at-sign is answered
 * here from the workspace index; everything else is left to the base provider,
 * which owns slash commands and path completion.
 */
export function createCompletionProvider(
  registered: readonly RegisteredCommand[],
  cwd: string,
  index: FileIndex = createFileIndex(cwd),
): CombinedAutocompleteProvider {
  return new WorkspaceFileProvider(commandMenu(registered), cwd, index)
}

/**
 * The editor's provider, with workspace files behind the at-sign.
 *
 * The base class gathers file rows only when an `fd` binary was handed to it,
 * which this surface does not depend on; overriding the suggestion call for the
 * at-token keeps one code path on every machine while the class keeps owning
 * commands, argument completion, and Tab path completion.
 */
class WorkspaceFileProvider extends CombinedAutocompleteProvider {
  constructor(commands: readonly SlashCommand[], cwd: string, private readonly index: FileIndex) {
    super([...commands], cwd)
  }

  override async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const text = (lines[cursorLine] ?? '').slice(0, cursorCol)
    const token = atToken(text)
    if (token !== undefined && !isOutsideWorkspace(token.query)) {
      const candidates = await this.index.candidates(options.signal)
      if (options.signal.aborted) return null
      // An index is free to be some other source of rows, so what a pick may
      // insert is checked here as well: a row the menu cannot draw honestly,
      // or cannot follow up on, must not reach the prompt.
      const offerable = candidates.filter(candidate => offerableCandidate(candidate))
      const items = rankFiles(token.query, offerable, SUGGESTION_LIMIT).map(candidate => fileItem(candidate, token.quoted))
      return items.length === 0 ? null : { items, prefix: token.prefix }
    }
    return await super.getSuggestions(lines, cursorLine, cursorCol, options)
  }
}

/**
 * Whether the fragment points outside the workspace the index knows.
 *
 * An absolute or home path is readdir's question, not the index's, and the base
 * provider already answers it; stealing it here would offer nothing at all.
 */
function isOutsideWorkspace(query: string): boolean {
  return query.startsWith('/') || query.startsWith('~')
}

/** One suggestion as the menu draws it, and the exact text a pick inserts. */
function fileItem(candidate: Candidate, quoted: boolean): AutocompleteItem {
  const path = candidate.isDirectory ? candidate.path + '/' : candidate.path
  const name = candidate.path.slice(candidate.path.lastIndexOf('/') + 1)
  // The base class decides where the text goes and adds a space after a file,
  // so the value has to carry the at-sign and any quoting the path needs.
  return {
    value: atValue(path, quoted, candidate.isDirectory),
    label: rowText(candidate.isDirectory ? name + '/' : name),
    description: rowText(candidate.path),
  }
}

/**
 * A row's text as a single line the terminal draws rather than obeys.
 *
 * The shared display escape keeps line feeds because a rendered block needs
 * them, but a menu row that carried one would draw outside its own box.
 */
function rowText(raw: string): string {
  return displayText(raw.replaceAll('\n', '\\n'))
}
