/**
 * What the escapes carry: the colour a terminal can draw, the tab and the
 * cursor a frame writes, and the same frames rendered in truecolor.
 */

import { describe, expect, it } from 'vitest'
import { createTheme } from '@/theme.ts'
import { WIDTHS, fixture, parkedStatus, busyDock, queued, terminalTextFrame } from './fixtures/frames.ts'


describe('terminal text', () => {
  for (const width of WIDTHS) {
      it(`draws a tab, a colour, and a carriage return at ${width} columns`, () => {
        expect(terminalTextFrame().render(width)).toMatchSnapshot()
      })
    }
  it('draws the colour when the terminal has one, and no escape when it does not', () => {
      expect(terminalTextFrame(createTheme('truecolor')).render(80).join('\n')).toMatchSnapshot()
      // The reader turned styling off, so the same rows must carry no escape at
      // all — not a dropped colour, not a reset the surface opened for itself.
      const plain = terminalTextFrame().render(80).join('\n')
      expect(plain).not.toContain('\u001b')
      // The row starts four columns in, so the tab after "name" reaches the stop
      // at sixteen: eight columns, not four.
      expect(plain).toContain(`name${' '.repeat(8)}role`)
      expect(plain).toContain('red plain')
      expect(plain).toContain('progress 100%')
    })
})

describe('styled golden frames', () => {
  const styled = createTheme('truecolor')
  it('renders the transcript with its escapes', () => {
      expect(fixture(styled).view.render(80)).toMatchSnapshot()
    })
  it('renders the status row with its escapes', () => {
      expect(fixture(styled).status.render(80)).toMatchSnapshot()
    })
  it('renders the parked-draft count with its escapes', () => {
      expect(parkedStatus(3, styled).render(80)).toMatchSnapshot()
    })
  it('renders the busy dock with its escapes', () => {
      expect(busyDock(styled).render(80)).toMatchSnapshot()
    })
  it('renders the queued prompts with their escapes', () => {
      expect(queued(styled).render(80)).toMatchSnapshot()
    })
})
