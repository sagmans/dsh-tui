import { ProcessTerminal } from '@earendil-works/pi-tui'

/** The pinned decoder recognizes SS3 F1–F4, but not their valid unmodified CSI event forms. */
const FUNCTION_PRESS_EVENT = /^\u001b\[1;1:[12]([PQRS])$/u
const SS3_PREFIX = '\u001bO'

/** Normalize before viewport, modal, and editor readers so the same physical press keeps one meaning. */
export class EventSafeTerminal extends ProcessTerminal {
  override start(onInput: (data: string) => void, onResize: () => void): void {
    super.start(data => {
      const match = FUNCTION_PRESS_EVENT.exec(data)
      // Releases and modified keys retain their metadata rather than becoming unmodified presses.
      onInput(match === null ? data : SS3_PREFIX + match[1])
    }, onResize)
  }
}
