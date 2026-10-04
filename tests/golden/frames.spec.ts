/**
 * Pin rendered output so layout changes require review against fixed fixtures.
 * WIDTHS documents why wrapping and truncation need both widths.
 */

import { describe, expect, it } from 'vitest'
import { WIDTHS, fixture, elapsedStatus, parkedStatus, mermaidFixture, markdownMessages, busyDock, queued, pickerCard, modelPickerCard, stashPickerCard, gateCard, runningFrame, dispatchedFrame } from './fixtures/frames.ts'


describe('golden frames', () => {
  for (const width of WIDTHS) {
    it(`renders normalized elapsed boundaries at ${width} columns`, () => {
      expect(elapsedStatus().map(status => status.render(width))).toMatchSnapshot()
    })
  }
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
    }
  // A picker card is built for one width rather than the frame around it — card()
  // takes no width — so the list is drawn once instead of looping over both.
  it('renders the session picker at 80 columns', () => {
      expect(pickerCard().card()).toMatchSnapshot()
    })
  it('renders the model picker at 80 columns', () => {
      expect(modelPickerCard().card()).toMatchSnapshot()
    })
  it('renders the stash picker at 80 columns', () => {
      expect(stashPickerCard().card()).toMatchSnapshot()
    })
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
  // Multiple drafts pin the numeric count, not just stash presence;
  // a comfortable width keeps the populated-footer snapshot readable.
  it('renders the status row with parked drafts at 80 columns', () => {
      expect(parkedStatus(3).render(80)).toMatchSnapshot()
    })
})

describe('a mermaid reply', () => {
  for (const width of WIDTHS) {
      it(`renders the diagram at ${width} columns`, () => {
        expect(mermaidFixture().render(width)).toMatchSnapshot()
      })
    }
})

describe('markdown messages', () => {
  for (const width of WIDTHS) {
      it(`renders a prompt and a thought as markdown at ${width} columns`, () => {
        expect(markdownMessages().render(width)).toMatchSnapshot()
      })
    }
})
