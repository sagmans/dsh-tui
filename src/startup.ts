import type { Context } from '@deepseek-ai/cordis'
import { Command } from 'commander'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

const TUI_STARTUP_SERVICE = 'tuiStartup'
const HELP_EXAMPLE = `
Examples:
  dsh --profile tui          open the terminal interface
`

export interface TuiStartupValues {
  readonly zen: boolean
}

export const name = 'tui-startup'
export const inject: readonly string[] = ['cmdlineArgs']

function tuiCommand(): Command {
  return new Command()
    .name('dsh --profile tui')
    .description('Open the DeepSeek Harness terminal interface.')
    .helpOption('-h, --help', 'show this help')
    .addHelpText('after', HELP_EXAMPLE)
}

export function apply(ctx: Context): void {
  const program = tuiCommand()
  program.action(() => {
    ctx.provide(TUI_STARTUP_SERVICE, Object.freeze({ zen: true } satisfies TuiStartupValues))
  })
  parseCmdline(ctx, program)
}
