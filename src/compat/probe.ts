/**
 * Capability probe.
 *
 * The surface composes over whatever the profile already mounted, so a missing
 * row shows up as a runtime failure somewhere deep in a turn. Naming the
 * capability and the package that provides it turns that into a message the
 * reader can act on.
 */

/** One capability the surface reads, and what to do when it is absent. */
export interface Capability {
  /** Service name as it appears on the Cordis context. */
  readonly service: string
  /** What the surface does with it. */
  readonly use: string
  /** The row a composition must mount to provide it. */
  readonly fix: string
}

/** Without these the surface cannot run at all. */
export const REQUIRED_CAPABILITIES: readonly Capability[] = [
  {
    service: 'agents',
    use: 'creating and resuming the agent this terminal drives',
    fix: 'mount @deepseek-ai/dsh-agent with an agent-loop implementation',
  },
  {
    service: 'agentPresets',
    use: 'choosing the composition an agent runs, which owns its tools and prompt',
    fix: 'mount @deepseek-ai/dsh-agent-presets, which this bundle inserts',
  },
  {
    service: 'appExit',
    use: 'leaving with the exit code the launcher owns',
    fix: 'start this surface with dsh --profile tui',
  },
]

/** Without these the surface runs, with something switched off. */
export const OPTIONAL_CAPABILITIES: readonly Capability[] = [
  {
    service: 'tools',
    use: 'presenting each tool call through its own render intent',
    fix: 'mount @deepseek-ai/dsh-tools',
  },
  {
    service: 'commands',
    use: 'slash commands and their completion menu',
    fix: 'mount @deepseek-ai/dsh-commands',
  },
  {
    service: 'sessionPersistence',
    use: 'listing and replaying stored sessions',
    fix: 'mount @deepseek-ai/dsh-session-persistence-jsonl',
  },
  {
    service: 'userQuestions',
    use: 'answering the questions the model asks',
    fix: 'mount @deepseek-ai/dsh-user-questions',
  },
  {
    service: 'approval',
    use: 'pausing a gated tool for a decision',
    fix: 'mount @deepseek-ai/dsh-user-approval',
  },
]

/** What a composition provides, and what it does not. */
export interface ProbeReport {
  readonly missingRequired: readonly Capability[]
  readonly missingOptional: readonly Capability[]
}

/** Ask which capabilities a composition provides. */
export function probeComposition(has: (service: string) => boolean): ProbeReport {
  return {
    missingRequired: REQUIRED_CAPABILITIES.filter(capability => !has(capability.service)),
    missingOptional: OPTIONAL_CAPABILITIES.filter(capability => !has(capability.service)),
  }
}

/** The failure that stops activation, naming every missing requirement at once. */
export function describeMissingRequired(report: ProbeReport): string {
  const lines = report.missingRequired.map(capability =>
    `  ${capability.service}: needed for ${capability.use} — ${capability.fix}`)
  return `dsh-tui: this profile is missing what the terminal surface needs\\n${lines.join('\\n')}`
}

/** One line for the reader when the surface runs with something switched off. */
export function describeMissingOptional(report: ProbeReport): string | undefined {
  if (report.missingOptional.length === 0) return undefined
  const names = report.missingOptional.map(capability => capability.service)
  return `running without ${names.join(', ')}; run /status after adding the rows this profile lacks`
}
