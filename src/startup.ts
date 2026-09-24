import { randomUUID } from 'node:crypto'
import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { CONFIGURED_AGENT_IDENTITIES_KEY } from '@deepseek-ai/dsh-agent-loop'
import type { TuiStartup } from './contracts.ts'
import { LaunchUsageError, PROFILE_NAME, identityOf, resolveLaunchIntent, resumeHint } from './identity.ts'
import { installBundledSkill } from './install-skills.ts'

export const name = 'tui-startup'

/** The launcher owns the arguments; this row only reads its own snapshot. */
export const inject = ['cmdlineArgs']

export { PROFILE_NAME } from './identity.ts'

/** Config id the agent-loop row uses when a profile configures one. */
export const MAIN_AGENT_ID = 'main'

/** Context key of the parsed launch service consumed by the tui row. */
export const TUI_STARTUP_SERVICE = 'tuiStartup'

/**
 * Parse this app's own flags and publish the launch identity.
 *
 * On `--help` or a usage error nothing is provided, so the row that injects
 * this service never activates and the launcher exits with the parser's code.
 */
export function apply(ctx: Context): void {
  const program = new Command()
    .name('dsh --profile tui')
    .description('Interactive terminal session over DeepSeek Harness')
    .helpOption('-h, --help', 'show this help')
    .argument('[mode]', 'resume — open the history session picker')
    .argument('[session]', 'session id to resume (with the resume mode)')
    .option('--resume [session]', 'resume a persisted session (bare flag opens the picker)')
    .option('--new', 'start a fresh session without the history picker')
    .option('--model <model>', 'override the default model id')
    .option('--provider <provider>', 'override the default provider route')
    .option('--preset <preset>', 'agent preset (mode) the new session runs')
    .option('--no-color', 'disable ANSI styling')
    .option('--no-bell', 'do not ring the terminal bell when a long turn finishes')

  program.command('install-skills')
    .description('install the bundled dogfood skill into ~/.agents/skills/')
    .action(() => {
      const exit = ctx.get('appExit')
      if (exit === undefined) throw new Error('dsh --profile tui: the launcher must provide appExit')
      let destination: string
      try {
        destination = installBundledSkill()
      } catch (error) {
        program.error(`dsh --profile tui install-skills: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      process.stdout.write(`Installed ${destination}\n`)
      exit(0)
    })

  program.action((
    mode: string | undefined,
    session: string | undefined,
    options: {
      resume?: string | boolean
      new?: boolean
      model?: string
      provider?: string
      preset?: string
      color?: boolean
      bell?: boolean
    },
  ) => {
    let intent
    try {
      intent = resolveLaunchIntent({
        mode,
        session,
        resumeFlag: options.resume,
        newSession: options.new,
      })
    } catch (error) {
      if (error instanceof LaunchUsageError) {
        program.error(`dsh --profile tui: ${error.message}`)
        return
      }
      throw error
    }
    const identity = identityOf(intent, randomUUID())
    ctx.provide(CONFIGURED_AGENT_IDENTITIES_KEY, { [MAIN_AGENT_ID]: identity })
    ctx.provide(TUI_STARTUP_SERVICE, {
      sessionId: identity.id,
      resume: identity.resume,
      resumePicker: intent.resumePicker,
      model: options.model?.trim() || undefined,
      provider: options.provider?.trim() || undefined,
      preset: options.preset?.trim() || undefined,
      color: options.color !== false,
      bell: options.bell !== false,
    } satisfies TuiStartup)
    ctx.provide('tuiGoodbyeMessage', resumeHint(identity.id, PROFILE_NAME))
  })

  parseCmdline(ctx, program)
}
