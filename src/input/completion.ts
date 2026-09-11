import { CombinedAutocompleteProvider, type SlashCommand } from '@earendil-works/pi-tui'
import { LOCAL_COMMANDS, LOCAL_COMMAND_DESCRIPTIONS } from './submission.ts'

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
 * path prefix all behave the same way while typing.
 */
export function createCompletionProvider(registered: readonly RegisteredCommand[], cwd: string): CombinedAutocompleteProvider {
  return new CombinedAutocompleteProvider(commandMenu(registered), cwd)
}
