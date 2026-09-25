import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { CONFIGURED_AGENT_IDENTITIES_KEY, type LauncherAgentIdentity } from '@deepseek-ai/dsh-agent-loop'
import type { TuiStartup } from './contracts.ts'
import { LaunchUsageError, PROFILE_NAME, identityOf, resolveLaunchIntent, resumeHint } from './identity.ts'
import { installBundledSkill, SkillAlreadyExistsError } from './install-skills.ts'

export const name = 'tui-startup'

/** The launcher owns the arguments; this row only reads its own snapshot. */
export const inject = ['cmdlineArgs']

export { PROFILE_NAME } from './identity.ts'

/** Config id the agent-loop row uses when a profile configures one. */
export const MAIN_AGENT_ID = 'main'

/** Context key of the parsed launch service consumed by the tui row. */
export const TUI_STARTUP_SERVICE = 'tuiStartup'

/**
 * Context key of the boolean service that turns one invocation into a listing run.
 *
 * A boolean rather than the lines themselves: the command line runs before llm
 * mounts, so the action can only order the listing, and the surface row that
 * reads the directory decides when to answer it.
 */
export const LIST_MODELS_SERVICE = 'tuiListModels'

/** Launch flags the command line may carry; the listing command carries none. */
interface LaunchOptions {
  readonly resume?: string | boolean
  readonly new?: boolean
  readonly model?: string
  readonly provider?: string
  readonly preset?: string
  readonly color?: boolean
  readonly bell?: boolean
}

/**
 * Resolve the launch identity and the startup service both actions publish.
 *
 * Shared because the surface row injects `tuiStartup` and reads its own config
 * from it: an invocation that published no startup, the listing included, would
 * leave the row unmounted and print nothing.
 */
function launchOf(
  program: Command,
  mode: string | undefined,
  session: string | undefined,
  options: LaunchOptions,
): { readonly identity: LauncherAgentIdentity; readonly startup: TuiStartup } | undefined {
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
      return undefined
    }
    throw error
  }
  const identity = identityOf(intent, randomUUID())
  return {
    identity,
    startup: {
      sessionId: identity.id,
      resume: identity.resume,
      resumePicker: intent.resumePicker,
      model: options.model?.trim() || undefined,
      provider: options.provider?.trim() || undefined,
      preset: options.preset?.trim() || undefined,
      color: options.color !== false,
      bell: options.bell !== false,
    },
  }
}

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
    .description('install or update the bundled dogfood skill in ~/.agents/skills/')
    .option('--update', 'replace an existing skill without asking')
    .action((options: { update?: boolean }) => {
      const exit = ctx.get('appExit')
      if (exit === undefined) throw new Error('dsh --profile tui: the launcher must provide appExit')
      const fail = (error: unknown): void => {
        process.stderr.write(`dsh --profile tui install-skills: ${error instanceof Error ? error.message : String(error)}\n`)
        exit(1)
      }
      const install = (update: boolean): void => {
        const destination = update ? installBundledSkill(undefined, true) : installBundledSkill()
        process.stdout.write(`Installed ${destination}\n`)
        exit(0)
      }

      if (options.update === true) {
        try { install(true) } catch (error) { fail(error) }
        return
      }
      try {
        install(false)
      } catch (error) {
        if (!(error instanceof SkillAlreadyExistsError)) {
          fail(error)
          return
        }
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          fail(new Error(`${error.message}; rerun with --update in non-interactive mode`))
          return
        }

        // parseCmdline uses synchronous Commander.parse, so handle the prompt promise here.
        const confirmUpdate = async (): Promise<void> => {
          const readline = createInterface({ input: process.stdin, output: process.stdout })
          let answer: string
          try {
            answer = await readline.question(`Update existing skill at ${error.destination}? [y/N] `)
          } finally {
            readline.close()
          }
          if (!/^(y|yes)$/i.test(answer.trim())) {
            process.stdout.write(`Unchanged ${error.destination}\n`)
            exit(0)
            return
          }
          install(true)
        }
        void confirmUpdate().catch(fail)
      }
    })

  program.command('list-models')
    .description('print every provider/model the model picker can reach, then exit')
    .action(() => {
      // The flag is published before the startup service, because the surface
      // row's action runs as soon as its injected tuiStartup exists and must
      // already know this run lists instead of claiming the terminal.
      ctx.provide(LIST_MODELS_SERVICE, true)
      const launch = launchOf(program, undefined, undefined, {})
      if (launch === undefined) return
      ctx.provide(TUI_STARTUP_SERVICE, launch.startup)
    })

  program.action((
    mode: string | undefined,
    session: string | undefined,
    options: LaunchOptions,
  ) => {
    const launch = launchOf(program, mode, session, options)
    if (launch === undefined) return
    ctx.provide(CONFIGURED_AGENT_IDENTITIES_KEY, { [MAIN_AGENT_ID]: launch.identity })
    ctx.provide(TUI_STARTUP_SERVICE, launch.startup)
    ctx.provide('tuiGoodbyeMessage', resumeHint(launch.identity.id, PROFILE_NAME))
  })

  parseCmdline(ctx, program)
}
