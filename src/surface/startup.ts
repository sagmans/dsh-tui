/** Startup validation stays ahead of screen ownership so launch failures remain visible in the shell. */
import type { Context } from '@deepseek-ai/cordis'
import { TUI_PROFILING_SERVICE, profileAsync, PROFILE_PHASE, PROFILE_MILESTONE } from '../profiling.ts'
import { windowTitle } from '../terminal/title.ts'
import type { CommandsPorts } from './commands.ts'

const READY_TITLE = 'ready'
type StartupPorts = Pick<CommandsPorts, 'missingOptional' | 'skillDrift' | 'transcript' | 'modes' | 'launch' | 'terminal' | 'appearance'>

/** Separating launch from submission routing keeps startup phase ownership in one small module. */
export function createSurfaceStart(ctx: Context, ports: StartupPorts, boot: () => Promise<void>): () => Promise<void> {
  return async () => {
    const profiling = ctx.get(TUI_PROFILING_SERVICE)
    const missing = ports.missingOptional()
    if (missing !== undefined) ports.transcript.notice(missing)
    // Skill drift teaches the wrong wiring, so report it before the alternate screen hides host diagnostics.
    const drift = ports.skillDrift()
    if (drift !== undefined) ports.transcript.notice(drift)
    await profileAsync(profiling, PROFILE_PHASE.launch, () => ports.modes.validateLaunch(ports.launch))
    ports.terminal.tui.start()
    ports.terminal.writeTerminal(windowTitle(process.cwd(), READY_TITLE))
    // Pane ownership starts with the screen, even when a history picker must wait for a human.
    ports.terminal.herdr.publish()
    ports.appearance.openNotices(message => ports.transcript.notice(message))
    await boot()
    if (!ports.terminal.exited()) profiling?.mark(PROFILE_MILESTONE.inputReady)
  }
}
