import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ForkInheritance, TuiAgent } from '../agent/host.ts'
import { parsePresetArgument, type PresetRoster, type PresetSummary } from '../agent/presets.ts'
import type { Keymap } from '../input/actions.ts'
import { PresetPicker } from '../ui/picker.ts'
import type { Picker } from './modal-input.ts'

/**
 * What the mode owner needs from the surface that composes it.
 *
 * The roster arrives as a handle because the open path mounts through it as
 * well, and the stored mode is a property of a log this surface only reads. The
 * screen, the keyboard, the notice, and the session the reader is watching
 * belong to the surface that owns them; the keys move with a settings edit, so
 * they are read per press.
 */
export interface PresetChoicePorts {
  readonly agentPresets: PresetRoster | undefined
  /** The mode named on the command line, which is the only one that may conflict. */
  readonly requestedPreset: string | undefined
  /** The mode a stored session's own log recorded, absent when it recorded none. */
  readonly storedPreset: (id: SessionId) => Promise<string | undefined>
  /** The mode a live session runs right now, which only its own projection knows. */
  readonly livePreset: (id: SessionId) => string | undefined
  /**
   * The agent this terminal drives, read at call time.
   *
   * Opening a session replaces it, so a command typed after that switch has to
   * reach the agent now on screen rather than the one it replaced.
   */
  readonly drivingAgent: () => TuiAgent | undefined
  readonly keymap: () => Keymap
  /** Take the keyboard for a list and answer with the pick id it settled on. */
  readonly openPicker: (picker: Picker) => Promise<string | undefined>
  readonly notice: (message: string) => void
  readonly render: () => void
  /**
   * Show the session this terminal drives again.
   *
   * Navigation belongs to the surface that owns the view, so the mode owner only
   * decides when a switch needs the reader looking at the session it landed on.
   */
  readonly returnToDrivenSession: () => Promise<void>
}

/** The launch a run was started for, as the mode it named has to be read. */
export interface PresetLaunch {
  /** The session this run opens. */
  readonly sessionId: SessionId
  readonly resume: boolean
  /**
   * Whether a bare `--resume` still has to ask which session to open.
   *
   * The mode a stored session recorded can only be compared with the run's own
   * flag once that pick lands, so the conflict waits for the chosen session.
   */
  readonly resumePicker: boolean
}

/** The reads and operations the composing surface routes to the mode owner. */
export interface PresetChoice {
  /** The mode one agent joins. */
  readonly presetFor: (id: SessionId, resume: boolean, fork: ForkInheritance | undefined) => Promise<string | undefined>
  /** Resolve the named mode and refuse a launch that cannot run it. */
  readonly validateLaunch: (launch: PresetLaunch) => Promise<void>
  /** Show or choose the mode this session runs. */
  readonly runPresetCommand: (argument: string) => void
  /** The mode a session starting now would take. */
  readonly currentSeat: () => string | undefined
}

/**
 * Which mode a session runs — its seat in the roster — and the two ways it
 * changes.
 *
 * The seat is one value for the whole run: a launch flag seeds it and a
 * successful switch updates it, so `/new` and `/fork` land in the mode the
 * reader last chose. A resumed session keeps the mode its own log recorded,
 * because swapping it would leave logged tool calls the new composition cannot
 * make — the same reason the harness refuses a switch once a turn has run.
 */
export function createPresetChoice(ports: PresetChoicePorts): PresetChoice {
  const requestedPreset = ports.requestedPreset

  /**
   * The mode a session the reader starts from here on joins.
   *
   * A launch flag seeds it and a successful switch updates it, so `/new` and
   * `/fork` land in the mode the reader last chose; nothing is written to
   * settings, because the mode of a session is not a property of the machine.
   * Unset means nobody chose, which is where the roster's default applies.
   */
  let seat = requestedPreset

  /**
   * The mode a session takes its seat in: the reader's latest choice, or the
   * roster's default read at this moment.
   *
   * The default cannot be captured when this row applies: it comes from the
   * settings document, which may be read after that, so a captured copy would
   * pin every later session to the mode the bundle happened to ship.
   */
  const seatMode = (): string | undefined => seat ?? ports.agentPresets?.defaultId

  /** The roster as the picker paints it, refreshed when the picker opens. */
  let presetRows: readonly PresetSummary[] = []

  /** Choose the mode a session that has not started yet will run. */
  const askForPreset = async (currentId: string | undefined): Promise<string | undefined> => {
    const roster = ports.agentPresets
    if (roster === undefined) return undefined
    presetRows = await roster.list()
    return await ports.openPicker(new PresetPicker(() => presetRows, () => currentId, ports.keymap))
  }

  /** The stored mode's roster row, or undefined when the roster no longer offers it. */
  const resolveStored = async (id: SessionId, stored: string): Promise<string | undefined> => {
    try {
      return (await ports.agentPresets?.resolve(stored))?.id
    } catch {
      return undefined
    }
  }

  /**
   * The mode one agent joins.
   *
   * A resumed session keeps the composition its own log recorded, because
   * swapping it would leave logged tool calls the new composition cannot make —
   * the same reason the harness refuses a switch once a turn has run. A session
   * that recorded none, which is every session written before modes existed,
   * takes the seat; a branch inherits the mode its parent is running.
   */
  const presetFor = async (id: SessionId, resume: boolean, fork: ForkInheritance | undefined): Promise<string | undefined> => {
    const roster = ports.agentPresets
    if (roster === undefined) return undefined
    if (fork !== undefined) return ports.livePreset(fork.from) ?? seatMode()
    if (!resume) return seatMode()
    const stored = await ports.storedPreset(id)
    if (stored === undefined) return seatMode()
    const resolvedStored = await resolveStored(id, stored)
    if (resolvedStored === undefined) {
      // The composition this session recorded is gone. Naming one explicitly is
      // the reader's only way forward, so that is the one case an override is
      // taken for a stored session.
      if (requestedPreset !== undefined) return (await roster.resolve(requestedPreset)).id
      throw new Error(
        `session ${id} runs mode "${stored}", which this roster no longer offers; name another with --preset`,
      )
    }
    if (requestedPreset !== undefined && requestedPreset !== resolvedStored) {
      throw new Error(
        `session ${id} runs mode "${resolvedStored}", so --preset ${requestedPreset} does not apply; /preset ${requestedPreset} switches it before its first turn`,
      )
    }
    return resolvedStored
  }

  /** Join this session to another mode and remember it for the next session. */
  const applyPreset = async (id: string): Promise<void> => {
    const roster = ports.agentPresets
    const agent = ports.drivingAgent()
    if (roster === undefined || agent === undefined) return
    try {
      const chosen = await roster.select(agent.agent, id)
      seat = chosen
      // The durable selection is folded as a marker on the session it belongs
      // to, so a reader watching a child has to come back to see it.
      await ports.returnToDrivenSession()
    } catch (error) {
      ports.notice(`could not switch the mode: ${error instanceof Error ? error.message : String(error)}`)
    }
    ports.render()
  }

  /**
   * Show or choose the mode this session runs.
   *
   * The mode decides which tools, prompt sections, and skills exist at all, so
   * it is fixed once a turn has run: the harness refuses the swap and this
   * surface explains why rather than pretending otherwise. Before the first
   * turn the switch is recorded in the log, which is what keeps the transcript
   * honest about the composition later turns ran under.
   */
  const runPresetCommand = (argument: string): void => {
    const roster = ports.agentPresets
    if (roster === undefined) {
      ports.notice('this profile has no agent roster, so there is no mode to choose')
      ports.render()
      return
    }
    const agent = ports.drivingAgent()
    if (agent === undefined) {
      ports.notice('the agent is still starting; try again in a moment')
      ports.render()
      return
    }
    const session = agent.agent.session
    const current = roster.current(session)
    const command = parsePresetArgument(argument)
    if (command.kind === 'pick') {
      if (roster.started(session)) {
        ports.notice(`this session runs ${current === undefined ? 'a mode' : `"${current}"`} and has already started, so its mode is fixed — /new starts a fresh session`)
        ports.render()
        return
      }
      void askForPreset(current).then(picked => picked === undefined ? undefined : applyPreset(picked))
      return
    }
    void applyPreset(command.id)
  }

  /**
   * Resolve the mode named on the command line and refuse a launch that cannot
   * run it.
   *
   * Raised while the launcher still owns the terminal, because the alternate
   * screen closes over whatever was painted on it: a mode this roster does not
   * offer has to be answered here rather than as a blank screen.
   */
  const validateLaunch = async (launch: PresetLaunch): Promise<void> => {
    const roster = ports.agentPresets
    if (requestedPreset !== undefined && roster !== undefined) {
      seat = (await roster.resolve(requestedPreset)).id
    }
    if (!launch.resumePicker) await presetFor(launch.sessionId, launch.resume, undefined)
  }

  return {
    presetFor,
    validateLaunch,
    runPresetCommand,
    currentSeat: seatMode,
  }
}
