import type { SessionId } from '@deepseek-ai/dsh-session'

/**
 * Launch identity and presentation options the app-owned command line row
 * resolves before any row that depends on them activates. Absent on `--help`
 * and on a usage error, which is how dependent rows stay unmounted.
 */
export interface TuiStartup {
  /** Exact session this run owns: a fresh id or the one being resumed. */
  readonly sessionId: SessionId
  /** Rehydrate persisted history instead of creating the session fresh. */
  readonly resume: boolean
  /** Open the history picker before the first turn. */
  readonly resumePicker: boolean
  /** Model override supplied on the command line. */
  readonly model: string | undefined
  /** Provider-route override supplied on the command line. */
  readonly provider: string | undefined
  /** Agent preset the new session runs; absent takes the roster's default. */
  readonly preset: string | undefined
  /** Whether ANSI styling is enabled. */
  readonly color: boolean
  /** Whether a long turn may ring the terminal bell when it finishes. */
  readonly bell: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tuiStartup?: TuiStartup
    /** Printed after the terminal is handed back, so the session stays recoverable. */
    tuiGoodbyeMessage?: string
  }
}
