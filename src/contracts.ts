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

/**
 * The row's own configuration: every launch option, plus what only the profile
 * can name.
 *
 * Split from the startup service because no command-line flag can carry these
 * values. A harness that keeps settings per row has no `dsh-tui:` document
 * section left to write a theme into, so the row's own config is the one place a
 * profile patch pins it — and that makes the row the config surface for it, not
 * the launcher.
 */
export interface TuiRowConfig extends TuiStartup {
  /**
   * Theme the row pins, below the settings section and above the package default.
   *
   * The section is the reader's own document and still outranks this; the
   * package's default answers when neither names a theme.
   */
  readonly theme: string | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tuiStartup?: TuiStartup
    /** Printed after the terminal is handed back, so the session stays recoverable. */
    tuiGoodbyeMessage?: string
  }
}
