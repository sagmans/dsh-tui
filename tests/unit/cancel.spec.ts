import { describe, expect, it } from 'vitest'
import { cancelStep, quitStep } from '@/input/cancel.ts'

describe('cancelStep', () => {
  it('takes the bar first, because the text is the reader own work', () => {
    expect(cancelStep({ barHasText: true, queuedPrompts: 2, turnRunning: true, viewingChild: true })).toBe('clear-editor')
  })

  it('takes queued prompts back before it only stops the turn', () => {
    // An interrupt drops what the agent has not started, so the press that stops
    // the work is also the press that has to return those words.
    expect(cancelStep({ barHasText: false, queuedPrompts: 1, turnRunning: true, viewingChild: false })).toBe('reclaim-queued')
  })

  it('takes queued prompts back even when no turn is left to stop', () => {
    expect(cancelStep({ barHasText: false, queuedPrompts: 3, turnRunning: false, viewingChild: true })).toBe('reclaim-queued')
  })

  it('stops the turn once there is nothing queued', () => {
    expect(cancelStep({ barHasText: false, queuedPrompts: 0, turnRunning: true, viewingChild: true })).toBe('interrupt-turn')
  })

  it('leaves a child transcript when nothing is running', () => {
    expect(cancelStep({ barHasText: false, queuedPrompts: 0, turnRunning: false, viewingChild: true })).toBe('leave-child-view')
  })

  it('asks for nothing when there is nothing left to take back', () => {
    expect(cancelStep({ barHasText: false, queuedPrompts: 0, turnRunning: false, viewingChild: false })).toBe('hand-back')
  })
})

describe('quitStep', () => {
  it('keeps the key for the editor while the bar holds text', () => {
    expect(quitStep({ barHasText: true, overlayOpen: false, turnRunning: true })).toBe('hand-back')
  })

  it('keeps the key for an overlay field, which is a text field of its own', () => {
    expect(quitStep({ barHasText: false, overlayOpen: true, turnRunning: false })).toBe('hand-back')
  })

  it('leaves, asking a running turn to stop first', () => {
    expect(quitStep({ barHasText: false, overlayOpen: false, turnRunning: true })).toBe('cancel-then-quit')
  })

  it('leaves at once when nothing is running', () => {
    expect(quitStep({ barHasText: false, overlayOpen: false, turnRunning: false })).toBe('quit')
  })
})
