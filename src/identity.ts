import { SessionId } from '@deepseek-ai/dsh-session'
import type { LauncherAgentIdentity } from '@deepseek-ai/dsh-agent-loop'

/** A command line that cannot be resolved into one launch identity. */
export class LaunchUsageError extends Error {}

/** Resolved intent of the arguments dsh handed to this app. */
export interface LaunchIntent {
  /** Exact session id to resume, or empty for a fresh session. */
  readonly resumeId: string
  /** Whether to open the history picker instead of starting a turn immediately. */
  readonly resumePicker: boolean
  /** Whether the user explicitly asked for a new session. */
  readonly fresh: boolean
}

/**
 * Resolve the app's own arguments into one identity decision.
 *
 * The three ways to name a session (positional `resume <id>`, `--resume [id]`,
 * and `--new`) overlap, so an ambiguous combination is refused here rather
 * than silently picking one: a wrong guess would resume the wrong conversation.
 */
export function resolveLaunchIntent(input: {
  readonly mode: string | undefined
  readonly session: string | undefined
  readonly resumeFlag: string | boolean | undefined
  readonly newSession: boolean | undefined
}): LaunchIntent {
  const mode = input.mode?.trim() ?? ''
  if (mode !== '' && mode !== 'resume') {
    throw new LaunchUsageError(`unknown argument "${mode}" (expected "resume")`)
  }
  const flagValue = typeof input.resumeFlag === 'string' ? input.resumeFlag.trim() : ''
  const positional = input.session?.trim() ?? ''
  if (flagValue !== '' && positional !== '' && flagValue !== positional) {
    throw new LaunchUsageError('session id given twice with different values (--resume and positional)')
  }
  if (positional !== '' && mode === '' && input.resumeFlag === undefined) {
    throw new LaunchUsageError('a session id requires resume mode or --resume')
  }
  const resumeId = flagValue !== '' ? flagValue : positional
  const resumeRequested = mode === 'resume' || input.resumeFlag !== undefined || positional !== ''
  if (input.newSession === true && resumeRequested) {
    throw new LaunchUsageError('--new cannot be combined with a resume session id or mode')
  }
  return {
    resumeId,
    // An empty --resume (bare flag) asks for the picker rather than a fresh session.
    resumePicker: resumeId === '' && (mode === 'resume' || input.resumeFlag !== undefined),
    fresh: input.newSession === true,
  }
}

/** Identity the agent-loop row would adopt when a profile configures one. */
export function identityOf(intent: LaunchIntent, uuid: string): LauncherAgentIdentity {
  return intent.resumeId === ''
    ? { id: SessionId(`tui-session-${uuid}`), resume: false }
    : { id: SessionId(intent.resumeId), resume: true }
}

/** Profile the surface is installed into; only used for the resume hint. */
export const PROFILE_NAME = 'tui'

/** Line printed after the terminal is handed back, so the session is recoverable. */
export function resumeHint(sessionId: string, profile: string): string {
  return `To resume this session: dsh --profile ${profile} --resume=${sessionId}`
}
