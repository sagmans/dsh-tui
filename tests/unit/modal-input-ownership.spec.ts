/** Canceled requests and asynchronous verdicts must not acquire another modal's keyboard. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { createTerminalLifecycle } from '@/surface/terminal-lifecycle.ts'
import { createModalInput } from '@/surface/modal-input.ts'
import { SESSION, ENTER, ESCAPE, fixture, requestApproval, requestQuestions, scriptedPicker, settle } from './fixtures/modal-input.ts'

const HERDR_MODE_ENV = 'HERDR_ENV'
const INERT_HERDR_CONTEXT = ''
const CANCELLED_APPROVAL_OUTCOME = 'cancelled'
const APPROVAL_REQUEST_EVENT = 'approval/request'
const DISPOSAL_TOOL_NAME = 'pending tool'
const DISPOSAL_REASON = 'reader decision'

describe('modal request ownership', () => {
  it('releases a live gate before real Cordis ownership restores the terminal', async () => {
    vi.stubEnv(HERDR_MODE_ENV, INERT_HERDR_CONTEXT)
    const given = fixture()
    const ctx = new Context()
    const controller = new AbortController()
    let modals: ReturnType<typeof createModalInput> | undefined
    let gateAtStop: ReturnType<ReturnType<typeof createModalInput>['gateCard']>
    const focusChanges: unknown[] = []
    let stopped = false
    const owner = await ctx.plugin((scoped: Context) => {
      const lifecycle = createTerminalLifecycle(scoped, {
        reportFrameError: () => {}, notice: () => {}, copyRows: () => [],
        activeSession: () => SESSION, sessionOpened: () => false, turnRunning: () => false,
        stopClock: () => {}, exit: () => {}, draftText: () => given.editor.text,
        draftBorrowed: () => false, holdDraft: text => given.editor.setText(text),
        writeDraft: text => given.editor.setText(text),
      })
      vi.spyOn(lifecycle.terminal, 'write').mockImplementation(() => {})
      const stop = lifecycle.tui.stop.bind(lifecycle.tui)
      vi.spyOn(lifecycle.tui, 'stop').mockImplementation(options => { stopped = true; gateAtStop = modals?.gateCard(); stop(options) })
      const setFocus = lifecycle.tui.setFocus.bind(lifecycle.tui)
      vi.spyOn(lifecycle.tui, 'setFocus').mockImplementation(component => { focusChanges.push(component); setFocus(component) })
      modals = createModalInput(scoped, { ...given.ports, tui: lifecycle.tui, terminal: lifecycle.terminal, herdr: lifecycle.herdr })
      modals.requestListeners()
    })
    try {
      const answer = Reflect.apply(ctx.waterfall, ctx, [APPROVAL_REQUEST_EVENT, {
        agent: { id: SESSION }, toolName: DISPOSAL_TOOL_NAME, reason: DISPOSAL_REASON, signal: controller.signal,
      }, () => undefined])
      expect(modals?.gateCard()?.title).toContain(DISPOSAL_TOOL_NAME)
      await owner.dispose()
      expect(await answer).toBe(CANCELLED_APPROVAL_OUTCOME)
      expect(stopped).toBe(true)
      expect(gateAtStop).toBeUndefined()
      expect(given.editor.disableSubmit).toBe(false)
      const focusCount = focusChanges.length
      controller.abort()
      expect(focusChanges.length).toBe(focusCount)
    } finally {
      await owner.dispose()
      vi.restoreAllMocks()
      vi.unstubAllEnvs()
    }
  })

  it.each([undefined, 'old refusal', new Error('expired check')])('ignores a canceled picker verdict %j after another picker opens', async reason => {
    const given = fixture()
    const modals = createModalInput(given.ctx, given.ports)
    const verdict = Promise.withResolvers<string | undefined>()
    const oldPicker = scriptedPicker()
    const oldAnswer = modals.openPicker(oldPicker, () => verdict.promise)
    oldPicker.action = { kind: 'pick', id: 'old' }
    modals.handleKey(ENTER)
    oldPicker.action = { kind: 'cancel' }
    modals.handleKey(ESCAPE)
    expect(await oldAnswer).toBeUndefined()

    const current = scriptedPicker()
    const answer = modals.openPicker(current)
    if (reason instanceof Error) verdict.reject(reason)
    else verdict.resolve(reason)
    await settle()
    expect(current.notes).toEqual([])
    current.action = { kind: 'pick', id: 'current' }
    modals.handleKey(ENTER)
    expect(await answer).toBe('current')
  })

  it('keeps a replacement picker vet locked when an old verdict completes', async () => {
    const given = fixture()
    const modals = createModalInput(given.ctx, given.ports)
    const oldVerdict = Promise.withResolvers<string | undefined>()
    const oldPicker = scriptedPicker()
    const oldAnswer = modals.openPicker(oldPicker, () => oldVerdict.promise)
    oldPicker.action = { kind: 'pick', id: 'old' }
    modals.handleKey(ENTER)
    oldPicker.action = { kind: 'cancel' }
    modals.handleKey(ESCAPE)
    expect(await oldAnswer).toBeUndefined()

    const verdict = Promise.withResolvers<string | undefined>()
    const picker = scriptedPicker()
    let attempts = 0
    const answer = modals.openPicker(picker, () => {
      attempts++
      return verdict.promise
    })
    picker.action = { kind: 'pick', id: 'current' }
    modals.handleKey(ENTER)
    expect(attempts).toBe(1)
    oldVerdict.resolve('obsolete refusal')
    await settle()
    picker.action = { kind: 'pick', id: 'current' }
    modals.handleKey(ENTER)
    expect(attempts).toBe(1)
    verdict.resolve(undefined)
    expect(await answer).toBe('current')
  })

  it('does not open an approval whose caller already aborted', async () => {
    const given = fixture()
    const modals = createModalInput(given.ctx, given.ports)
    const controller = new AbortController()
    controller.abort()
    const answer = requestApproval(modals, given, { signal: controller.signal })

    expect(modals.gateCard()).toBeUndefined()
    expect(given.editor.disableSubmit).toBe(false)
    expect(await answer).toBe('cancelled')
  })

  it('fails closed on overlapping approvals without orphaning the current request', async () => {
    const given = fixture()
    const modals = createModalInput(given.ctx, given.ports)
    const first = requestApproval(modals, given, { toolName: 'first tool' })
    const second = requestApproval(modals, given, { toolName: 'second tool' })

    expect(modals.gateCard()?.title).toContain('first tool')
    expect(await second).toBe('cancelled')
    modals.handleKey('y')
    expect(await first).toBe('allowed-once')
  })

  it('rejects overlapping questions without replacing the answer being typed', async () => {
    const given = fixture()
    const modals = createModalInput(given.ctx, given.ports)
    const request = { questions: [{ id: 'q1', question: 'where?' }] }
    const first = requestQuestions(modals, given, request)
    modals.handleKey('hello')
    const second = requestQuestions(modals, given, request)

    expect(given.editor.text).toBe('hello')
    expect(await second.answer).toEqual({ answers: [] })
    modals.handleKey(ENTER)
    expect(await first.answer).toEqual({ answers: [{ id: 'q1', selected: [], custom: 'hello' }] })
  })

  it('settles approval and releases the keyboard during disposal', async () => {
    const given = fixture()
    const modals = createModalInput(given.ctx, given.ports)
    const answer = requestApproval(modals, given)
    given.dispose()

    expect(modals.gateCard()).toBeUndefined()
    expect(given.editor.disableSubmit).toBe(false)
    expect(await answer).toBe('cancelled')
  })

  it('settles a picker during disposal and refuses late reopening', async () => {
    const given = fixture()
    const modals = createModalInput(given.ctx, given.ports)
    const answer = modals.openPicker(scriptedPicker())
    given.dispose()

    expect(modals.pickerCard()).toBeUndefined()
    expect(given.editor.disableSubmit).toBe(false)
    expect(await answer).toBeUndefined()
    expect(await modals.openPicker(scriptedPicker())).toBeUndefined()
    expect(modals.pickerCard()).toBeUndefined()
  })

  it('rejects a second picker without orphaning the current reader', async () => {
    const given = fixture()
    const modals = createModalInput(given.ctx, given.ports)
    const firstPicker = scriptedPicker()
    firstPicker.setNote('active refusal')
    const first = modals.openPicker(firstPicker)
    const second = modals.openPicker(scriptedPicker())
    expect(modals.pickerCard()?.note).toBe('active refusal')
    expect(await second).toBeUndefined()

    firstPicker.action = { kind: 'cancel' }
    modals.handleKey(ESCAPE)
    expect(await first).toBeUndefined()
  })
})
