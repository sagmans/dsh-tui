import { describe, expect, it, vi } from 'vitest'
import { GATE_WAIT_KEY } from '@/herdr/constants.ts'
import { createModalInput } from '@/surface/modal-input.ts'
import { POPUP_MAX_HEIGHT, popupRowBudget, popupWidth } from '@/ui/picker-card.ts'
import { SESSION, ESCAPE, ENTER, COLUMNS, ROWS, POPUP_MARGIN, fakePicker, scriptedPicker, fixture, approvalWaterfall, requestApproval, requestQuestions, settle } from './fixtures/modal-input.ts'

describe('createModalInput herdr waits', () => {
  it('notifies for agent gates but never for reader navigation', async () => {
    const given = fixture()
    const moshi = { block: vi.fn(), unblock: vi.fn() }
    Object.assign(given.ports, { moshi })
    const modals = createModalInput(given.ctx, given.ports)
    const picker = modals.openPicker(fakePicker('Model'))
    modals.handleKey(ESCAPE)
    await picker
    expect(moshi.block).not.toHaveBeenCalled()
    const answered = requestApproval(modals, given)
    expect(moshi.block).toHaveBeenCalledWith(GATE_WAIT_KEY)
    expect(moshi.block.mock.calls[0]).toHaveLength(1)
    modals.handleKey('y')
    await answered
    expect(moshi.unblock).toHaveBeenCalledWith(GATE_WAIT_KEY)
  })
  it('claims no wait for a menu the reader opened', async () => {
    const given = fixture()
    const modals = createModalInput(given.ctx, given.ports)

    const opened = modals.openPicker(fakePicker('Model'))
    modals.handleKey(ESCAPE)
    await opened

    // Herdr answers a transition into blocked with a needs-attention
    // notification and its sound, in the foreground pane as well as behind it, so
    // a menu the reader opened themselves must not claim one: the row would ring
    // for their own navigation and read as an agent stuck on a decision it never
    // asked for.
    expect(given.waits).toEqual([])
  })

  it('claims a gate as the wait it is, and gives it back when answered', () => {
    const given = fixture()
    const modals = createModalInput(given.ctx, given.ports)

    requestApproval(modals, given)
    expect(given.waits).toEqual([{ kind: 'block', key: GATE_WAIT_KEY, message: expect.stringContaining('bash') }])

    modals.handleKey('y')
    expect(given.waits.at(-1)).toEqual({ kind: 'unblock', key: GATE_WAIT_KEY, message: undefined })
  })

  it('rejects approval behind an active menu without claiming a phantom wait', async () => {
    const given = fixture()
    const modals = createModalInput(given.ctx, given.ports)
    const opened = modals.openPicker(fakePicker('Model'))
    const approval = requestApproval(modals, given)

    expect(await approval).toBe('cancelled')
    expect(modals.pickerCard()?.title).toBe('Model')
    expect(given.editor.disableSubmit).toBe(true)
    modals.handleKey(ESCAPE)
    expect(await opened).toBeUndefined()
    expect(given.waits).toEqual([])
    expect(modals.gateCard()).toBeUndefined()
    expect(modals.pickerCard()).toBeUndefined()
  })
})

describe('createModalInput gates', () => {
  it('keeps a gate open and repaints for a press it does not answer', () => {
    const given = fixture()
    const modals = createModalInput(given.ctx, given.ports)
    requestApproval(modals, given)

    const before = given.renders.length
    expect(modals.handleKey('x')).toBe(true)
    expect(given.renders.length).toBe(before + 1)
    expect(modals.gateCard()?.kind).toBe('approval')
  })

  it('turns an aborted approval into cancelled and gives the keyboard back', async () => {
    const given = fixture()
    const modals = createModalInput(given.ctx, given.ports)
    const controller = new AbortController()
    const answered = requestApproval(modals, given, { signal: controller.signal })

    controller.abort()
    await expect(answered as Promise<unknown>).resolves.toBe('cancelled')
    expect(modals.gateCard()).toBeUndefined()
    expect(given.editor.disableSubmit).toBe(false)
    expect(given.waits.map(call => `${call.kind}:${call.key}`)).toEqual([`block:${GATE_WAIT_KEY}`, `unblock:${GATE_WAIT_KEY}`])
  })

  it('borrows the bar for a question, answers in the seam shape, and gives it back', async () => {
    const given = fixture()
    const modals = createModalInput(given.ctx, given.ports)
    const controller = new AbortController()
    const call = requestQuestions(modals, given, {
      agent: { id: SESSION },
      questions: [{ id: 'q1', question: 'Which one?' }],
      signal: controller.signal,
    })

    // A question is answered in the reader's own editor, which is why the bar is
    // borrowed before the gate is built and given back only once it closes.
    expect(given.promptCalls).toEqual(['borrow'])
    expect(given.editor.focused).toBe(true)
    expect(given.focus.at(-1)).toBeNull()

    // A press the gate does not claim is the editor's; it repaints rather than
    // settling an answer nobody gave.
    const before = given.renders.length
    expect(modals.handleKey('x')).toBe(true)
    expect(given.renders.length).toBe(before + 1)
    expect(modals.gateCard()?.kind).toBe('question')

    given.editor.setText('ship it')
    expect(modals.handleKey(ENTER)).toBe(true)
    await expect(call.answer as Promise<unknown>).resolves.toEqual({
      answers: [{ id: 'q1', selected: [], custom: 'ship it' }],
    })
    expect(given.promptCalls).toEqual(['borrow', 'giveBack'])
    expect(given.focus.at(-1)).toBe(given.ports.editor)
    expect(modals.gateCard()).toBeUndefined()

    // The answered call is done with the signal: a later abort must not settle
    // the same question a second time.
    const settled = given.promptCalls.length
    controller.abort()
    await settle()
    expect(given.promptCalls.length).toBe(settled)
  })

  it('answers a listed row without inventing a custom answer', async () => {
    const given = fixture()
    const modals = createModalInput(given.ctx, given.ports)
    const call = requestQuestions(modals, given, {
      agent: { id: SESSION },
      questions: [{ id: 'q1', question: 'Deploy?', options: [{ label: 'ship' }] }],
    })

    // A picked label is the whole answer: the seam reads an answer with no typed
    // text as the option itself, so no custom field may be sent with it.
    expect(modals.handleKey('1')).toBe(true)
    expect(modals.handleKey(ENTER)).toBe(true)
    await expect(call.answer as Promise<unknown>).resolves.toEqual({
      answers: [{ id: 'q1', selected: ['ship'] }],
    })
  })

  it('ignores an abort that arrives after the reader answered the approval', () => {
    const given = fixture()
    const modals = createModalInput(given.ctx, given.ports)
    const controller = new AbortController()
    requestApproval(modals, given, { signal: controller.signal })

    modals.handleKey('y')
    const waitsAfterAnswer = given.waits.length
    controller.abort()

    // The gate is already answered and closed: a late abort must not read as a
    // second decision, which would give back a wait the row no longer holds.
    expect(given.waits.length).toBe(waitsAfterAnswer)
    expect(modals.gateCard()).toBeUndefined()
  })

  it('cancels a question whose caller aborts and answers it with nothing', async () => {
    const given = fixture()
    const modals = createModalInput(given.ctx, given.ports)
    const controller = new AbortController()
    const call = requestQuestions(modals, given, {
      agent: { id: SESSION },
      questions: [{ id: 'q1', question: 'Which one?' }],
      signal: controller.signal,
    })

    controller.abort()
    await expect(call.answer as Promise<unknown>).resolves.toEqual({ answers: [] })
    expect(modals.gateCard()).toBeUndefined()
    expect(given.promptCalls).toEqual(['borrow', 'giveBack'])
    expect(given.editor.disableSubmit).toBe(false)
  })

  it('releases a question the caller aborted before the gate existed', async () => {
    const given = fixture()
    const modals = createModalInput(given.ctx, given.ports)
    const call = requestQuestions(modals, given, {
      agent: { id: SESSION },
      questions: [{ id: 'q1', question: 'Which one?' }],
      signal: AbortSignal.abort(),
    })

    await expect(call.answer as Promise<unknown>).resolves.toEqual({ answers: [] })
    expect(modals.gateCard()).toBeUndefined()
    expect(given.promptCalls).toEqual(['borrow', 'giveBack'])
  })

  it('does not let a rejected question abort the active approval', async () => {
    const given = fixture()
    const modals = createModalInput(given.ctx, given.ports)
    const approval = requestApproval(modals, given)
    const controller = new AbortController()
    const call = requestQuestions(modals, given, {
      agent: { id: SESSION },
      questions: [{ id: 'q1', question: 'Which one?' }],
      signal: controller.signal,
    })

    controller.abort()
    await expect(call.answer as Promise<unknown>).resolves.toEqual({ answers: [] })
    expect(modals.gateCard()?.kind).toBe('approval')
    expect(given.promptCalls).toEqual([])
    modals.handleKey(ESCAPE)
    expect(await approval).toBe('cancelled')
  })

  const passthrough: [string, Record<string, unknown>][] = [
    ['another session', { agent: { id: 'tui-session-2' }, questions: [{ id: 'q1' }] }],
    ['no questions at all', { agent: { id: SESSION }, questions: [] }],
  ]

  it.each(passthrough)('hands a question request through untouched for %s', (_name, request) => {
    const given = fixture()
    const modals = createModalInput(given.ctx, given.ports)

    const call = requestQuestions(modals, given, request)
    expect(call.next()).toBe(1)
    expect(modals.gateCard()).toBeUndefined()
    expect(given.promptCalls).toEqual([])
  })

  it('hands an approval for another session through untouched', () => {
    const given = fixture()
    const modals = createModalInput(given.ctx, given.ports)
    const approval = approvalWaterfall(modals, given)

    let nexts = 0
    approval({ agent: { id: 'tui-session-2' }, toolName: 'bash' }, () => {
      nexts += 1
    })
    expect(nexts).toBe(1)
    expect(modals.gateCard()).toBeUndefined()
    expect(given.waits).toEqual([])
  })
})

describe('createModalInput pickers', () => {
  it('hands back a press when no modal holds the keyboard', () => {
    const given = fixture()
    const modals = createModalInput(given.ctx, given.ports)

    expect(modals.handleKey(ESCAPE)).toBe(false)
    expect(given.renders).toEqual([])
  })

  it('settles an inline menu on the id it picked and restores the editor', async () => {
    const given = fixture()
    const modals = createModalInput(given.ctx, given.ports)
    const picker = scriptedPicker()
    const opened = modals.openPicker(picker)

    expect(modals.pickerCard()).toEqual(picker.card())
    expect(given.editor.disableSubmit).toBe(true)
    expect(given.focus.at(-1)).toBeNull()

    const before = given.renders.length
    expect(modals.handleKey('j')).toBe(true)
    expect(given.renders.length).toBe(before + 1)

    picker.action = { kind: 'pick', id: 'kept' }
    expect(modals.handleKey(ENTER)).toBe(true)
    await expect(opened).resolves.toBe('kept')
    expect(modals.pickerCard()).toBeUndefined()
    expect(given.editor.disableSubmit).toBe(false)
    expect(given.focus.at(-1)).toBe(given.ports.editor)
  })

  it('hides a popup menu when it settles and draws no inline card for it', async () => {
    const given = fixture()
    const modals = createModalInput(given.ctx, given.ports)
    const picker = scriptedPicker()
    const opened = modals.openPicker(picker, undefined, 'popup')

    // A popup keeps its rows to itself, so the transcript card is only for the
    // inline placement; the box over the work is hidden the moment it settles.
    expect(modals.pickerCard()).toBeUndefined()
    expect(given.overlays).toHaveLength(1)
    expect(given.overlays[0]!.options).toEqual({
      width: popupWidth(COLUMNS),
      maxHeight: POPUP_MAX_HEIGHT,
      anchor: 'center',
      margin: POPUP_MARGIN,
      nonCapturing: true,
    })

    // The box draws the list itself, at the row budget the terminal's height affords.
    const component = given.overlays[0]!.component as { render(width: number): string[] }
    component.render(popupWidth(COLUMNS))
    expect(picker.windows).toEqual([popupRowBudget(ROWS)])

    picker.action = { kind: 'cancel' }
    expect(modals.handleKey(ESCAPE)).toBe(true)
    await expect(opened).resolves.toBeUndefined()
    expect(given.overlays[0]!.hidden).toBe(1)
  })

  it('keeps a refused row in the menu with the note it was refused for', async () => {
    const given = fixture()
    const modals = createModalInput(given.ctx, given.ports)
    const picker = scriptedPicker()
    const verdicts: ((reason: string | undefined) => void)[] = []
    const asked: string[] = []
    const opened = modals.openPicker(picker, id => {
      asked.push(id)
      return new Promise<string | undefined>(resolve => {
        verdicts.push(resolve)
      })
    })

    picker.action = { kind: 'pick', id: 'busy' }
    expect(modals.handleKey(ENTER)).toBe(true)
    expect(asked).toEqual(['busy'])

    // A second pick while the first verdict is being read must not race it.
    picker.action = { kind: 'pick', id: 'other' }
    expect(modals.handleKey(ENTER)).toBe(true)
    expect(asked).toEqual(['busy'])

    verdicts.shift()!('already running')
    await settle()
    expect(picker.notes).toEqual(['already running'])
    expect(modals.pickerCard()?.note).toBe('already running')

    picker.action = { kind: 'pick', id: 'busy' }
    expect(modals.handleKey(ENTER)).toBe(true)
    verdicts.shift()!(undefined)
    await expect(opened).resolves.toBe('busy')
  })

  it('settles a crashed check as a refusal and leaves no rejection unhandled', async () => {
    const given = fixture()
    const modals = createModalInput(given.ctx, given.ports)
    const picker = scriptedPicker()
    const rejections: unknown[] = []
    const onRejection = (error: unknown): void => {
      rejections.push(error)
    }
    process.on('unhandledRejection', onRejection)
    const opened = modals.openPicker(picker, () => Promise.reject(new Error('vet-port-crashed')))

    picker.action = { kind: 'pick', id: 'busy' }
    expect(modals.handleKey(ENTER)).toBe(true)
    await expect(opened).resolves.toBeUndefined()
    // A rejection the check leaked would only be reported as unhandled on a later tick.
    await settle()
    process.removeListener('unhandledRejection', onRejection)

    // A crashed check cannot vouch for the row and has no refusal text to keep
    // the menu open with, so the pick settles refused and the keyboard returns.
    expect(rejections).toEqual([])
    expect(modals.pickerCard()).toBeUndefined()
    expect(picker.notes).toEqual([])
    expect(given.editor.disableSubmit).toBe(false)
    expect(given.focus.at(-1)).toBe(given.ports.editor)
    expect(modals.handleKey('j')).toBe(false)
  })

  it('answers a cancelled menu at once and ignores the verdict that arrives later', async () => {
    const given = fixture()
    const modals = createModalInput(given.ctx, given.ports)
    const picker = scriptedPicker()
    let verdict: ((reason: string | undefined) => void) | undefined
    const opened = modals.openPicker(picker, () => new Promise<string | undefined>(resolve => {
      verdict = resolve
    }))

    picker.action = { kind: 'pick', id: 'busy' }
    modals.handleKey(ENTER)

    // Cancelling must not wait for a check the reader has walked away from.
    picker.action = { kind: 'cancel' }
    expect(modals.handleKey(ESCAPE)).toBe(true)
    await expect(opened).resolves.toBeUndefined()

    const afterCancel = given.renders.length
    verdict!('too late')
    await settle()
    expect(given.renders.length).toBe(afterCancel)
    expect(picker.notes).toEqual([])
  })
})
