import { Editor, ProcessTerminal, ScrollView, TuiAltScreen, VStack, matchesKey } from '@earendil-works/pi-tui'
import type { Context } from '@deepseek-ai/cordis'
import { startAgent, type TuiAgent } from './agent/host.ts'
import { resolveConfig } from './config.ts'
import { createRestoreRegistry } from './terminal/restore.ts'
import { createTheme } from './theme.ts'
import { TranscriptModel } from './transcript.ts'
import { TranscriptView } from './ui/view.ts'

export const name = 'tui'

/** `agents` is the only service the surface cannot run without. */
export const inject = ['agents']

const GOODBYE_KEY = 'tuiGoodbyeMessage'
const LOCAL_COMMANDS = ['/help', '/clear', '/quit', '/exit'] as const

/**
 * Refuse to run without a real terminal.
 *
 * A terminal surface that silently degrades to line mode hides deployment
 * mistakes and changes interaction semantics, so an unattended invocation
 * fails loud instead: a caller that wants one-shot output uses headless mode.
 */
export function assertInteractiveTerminal(input: {
  readonly stdinIsTTY?: boolean
  readonly stdoutIsTTY?: boolean
} = {}): void {
  const stdin = input.stdinIsTTY ?? process.stdin.isTTY === true
  const stdout = input.stdoutIsTTY ?? process.stdout.isTTY === true
  if (!stdin || !stdout) {
    throw new Error('dsh-tui: both stdin and stdout must be TTYs; run this profile from a terminal or SSH session')
  }
}

/**
 * Mount the terminal surface over the composed agent plane.
 *
 * The plugin owns input and presentation only: agent lifecycle, session
 * persistence, tool execution, and the model-facing question tool stay with
 * the composition rows around it.
 */
export function apply(ctx: Context, config: unknown): void {
  const resolved = resolveConfig(config)
  assertInteractiveTerminal()

  const appExit = ctx.get('appExit')
  if (appExit === undefined) {
    throw new Error('dsh-tui: the dsh launcher must provide appExit; start this surface with dsh --profile tui')
  }

  const theme = createTheme(resolved.color)
  const model = new TranscriptModel()
  const restore = createRestoreRegistry()
  const terminal = new ProcessTerminal()
  const tui = new TuiAltScreen(terminal)
  const view = new TranscriptView(model, theme)
  const editor = new Editor(tui, theme.editor)
  const disposers: Array<() => void> = []
  let agent: TuiAgent | undefined
  let turnOpen = false
  let exited = false

  restore.add(() => tui.stop())
  ctx.effect(() => () => {
    restore.restore()
    for (const dispose of disposers.reverse()) dispose()
  })

  tui.setLayoutRoot(new VStack([
    {
      component: new ScrollView(view, { follow: 'end', primary: true, overscroll: 'chain' }),
      basis: 0,
      grow: 1,
      minSize: 1,
    },
    { component: new VStack([{ component: editor, basis: 'auto', shrink: 1, minSize: 1 }]), basis: 'auto', shrink: 1, minSize: 1 },
  ]))
  tui.setFocus(editor)

  const requestExit = (code: number): void => {
    if (exited) return
    exited = true
    restore.restore()
    const goodbye = ctx.get(GOODBYE_KEY)
    if (typeof goodbye === 'string' && goodbye !== '') terminal.write(`\n${goodbye}\n`)
    appExit(code)
  }

  disposers.push(tui.addInputListener(data => {
    // In raw mode Ctrl+C never reaches the process as SIGINT, so the surface
    // decides: stop the work in flight, or leave when there is none.
    if (!matchesKey(data, 'ctrl+c')) return undefined
    if (turnOpen) {
      agent?.interrupt()
      model.notice('interrupt requested')
      tui.requestRender()
      return { consume: true }
    }
    requestExit(0)
    return { consume: true }
  }))

  editor.onSubmit = text => {
    const trimmed = text.trim()
    if (trimmed === '') return
    if (trimmed === '/quit' || trimmed === '/exit') {
      requestExit(0)
      return
    }
    if (trimmed === '/clear') {
      model.reset()
      tui.requestRender()
      return
    }
    if (trimmed === '/help') {
      model.notice(`local commands: ${LOCAL_COMMANDS.join(' ')}; any other /command goes to the agent`)
      tui.requestRender()
      return
    }
    if (agent === undefined) {
      model.notice('the agent is still starting; try again in a moment')
      tui.requestRender()
      return
    }
    // While a turn is running the human is steering it, not opening another.
    if (turnOpen) agent.steer(trimmed)
    else agent.submit(trimmed)
  }

  disposers.push(ctx.on('session/event', (session, event) => {
    if (session.id !== resolved.sessionId) return
    if (event.type === 'turn/start') turnOpen = true
    if (event.type === 'turn/end') turnOpen = false
    model.apply(event)
    tui.requestRender()
  }))

  disposers.push(ctx.on('agent/assistant-stream', payload => {
    if (payload.agent.id !== resolved.sessionId) return
    if (payload.frame.type !== 'chunk') return
    model.applyStreamChunk(payload.frame.chunk)
    tui.requestRender()
  }))

  tui.start()

  void startAgent(ctx, {
    sessionId: resolved.sessionId,
    resume: resolved.resume,
    model: resolved.model,
    provider: resolved.provider,
    cwd: process.cwd(),
  }).then(handle => {
    agent = handle
    disposers.push(() => {
      void handle.dispose()
    })
    model.notice(`session ${handle.sessionId}${resolved.resume ? ' (resumed)' : ''}`)
    tui.requestRender()
  }).catch((error: unknown) => {
    terminal.write(`\ndsh-tui: ${error instanceof Error ? error.message : String(error)}\n`)
    requestExit(1)
  })
}
