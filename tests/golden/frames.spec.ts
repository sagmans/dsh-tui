/**
 * Whole frames at the two widths that matter: the transcript, the dock, the
 * status row, a call, a program of calls, a diagram, and the markdown body.
 */

import { describe, expect, it } from 'vitest'
import { createTheme } from '@/theme.ts'
import { WIDTHS, fixture, parkedStatus, mermaidFixture, markdownMessages, busyDock, queued, pickerCard, modelPickerCard, stashPickerCard, gateCard, runningFrame, dispatchedFrame } from './fixtures/frames.ts'


describe('golden frames', () => {
  for (const width of WIDTHS) {
      it(`renders the transcript at ${width} columns`, () => {
        expect(fixture().view.render(width)).toMatchSnapshot()
      })
  
      it(`renders the dock at ${width} columns`, () => {
        expect(fixture().dock.render(width)).toMatchSnapshot()
      })
  
      it(`renders the status row at ${width} columns`, () => {
        expect(fixture().status.render(width)).toMatchSnapshot()
      })
  
      it(`renders the queued prompts at ${width} columns`, () => {
        expect(queued().render(width)).toMatchSnapshot()
      })
  
      it(`renders a question gate at ${width} columns`, () => {
        expect(gateCard().render(width)).toMatchSnapshot()
      })
  
      it(`renders a question gate collecting a typed answer at ${width} columns`, () => {
        expect(gateCard('the eu-central cluster').render(width)).toMatchSnapshot()
      })
    }
  for (const width of WIDTHS) {
      it(`renders a busy dock at ${width} columns`, () => {
        expect(busyDock().render(width)).toMatchSnapshot()
      })
  
      it(`renders the session picker at ${width} columns`, () => {
        expect(pickerCard().card()).toMatchSnapshot()
      })
  
      it(`renders the model picker at ${width} columns`, () => {
        expect(modelPickerCard().card()).toMatchSnapshot()
      })
  
      it(`renders the stash picker at ${width} columns`, () => {
        expect(stashPickerCard().card()).toMatchSnapshot()
      })
    }
  for (const width of WIDTHS) {
      it(`renders a call that has not answered yet at ${width} columns`, () => {
        expect(runningFrame().render(width)).toMatchSnapshot()
      })
    }
  for (const width of WIDTHS) {
      it(`renders a program's calls by state at ${width} columns`, () => {
        expect(dispatchedFrame().render(width)).toMatchSnapshot()
      })
    }
  it('renders the status row with parked drafts at 80 columns', () => {
      expect(parkedStatus(3).render(80)).toMatchSnapshot()
    })
  it('folds the same event log into identical rows, as a resume must', () => {
      // A resume replays the durable events into a fresh fold, so the same log has
      // to produce the same rows rather than a different order or an append.
      const live = fixture().view.render(80)
      const resumed = fixture().view.render(80)
      expect(resumed).toEqual(live)
    })
})

describe('a mermaid reply', () => {
  for (const width of WIDTHS) {
      it(`renders the diagram at ${width} columns`, () => {
        expect(mermaidFixture().render(width)).toMatchSnapshot()
      })
    }
  it('renders the diagram with its escapes', () => {
      expect(mermaidFixture(createTheme('truecolor')).render(80)).toMatchSnapshot()
    })
})

describe('markdown messages', () => {
  for (const width of WIDTHS) {
      it(`renders a prompt and a thought as markdown at ${width} columns`, () => {
        expect(markdownMessages().render(width)).toMatchSnapshot()
      })
    }
  it('renders the prompt and the thought with their escapes', () => {
      expect(markdownMessages(createTheme('truecolor')).render(80)).toMatchSnapshot()
    })
})
