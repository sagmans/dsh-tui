import type { TuiActionSpec } from '../../contracts/actions.js'

const FIRST_INDEX = 0
const BACKWARD_STEP = -1
const FORWARD_STEP = 1

export interface ActionCursor<ActionId extends string> {
  current(actions: readonly TuiActionSpec<ActionId>[]): ActionId | undefined
  move(actions: readonly TuiActionSpec<ActionId>[], delta: number): ActionId | undefined
  reset(): void
  select(actions: readonly TuiActionSpec<ActionId>[], id: ActionId): boolean
}

class ActionCursorService<ActionId extends string> implements ActionCursor<ActionId> {
  private selectedId: ActionId | undefined

  current(actions: readonly TuiActionSpec<ActionId>[]): ActionId | undefined {
    const enabled = actions.filter(action => action.enabled)
    if (enabled.length === 0) {
      this.selectedId = undefined
      return undefined
    }
    if (this.selectedId !== undefined && enabled.some(action => action.id === this.selectedId)) return this.selectedId
    this.selectedId = enabled[FIRST_INDEX]?.id
    return this.selectedId
  }

  move(actions: readonly TuiActionSpec<ActionId>[], delta: number): ActionId | undefined {
    if (!Number.isFinite(delta) || delta === 0) return this.current(actions)
    const enabled = actions.filter(action => action.enabled)
    if (enabled.length === 0) {
      this.selectedId = undefined
      return undefined
    }
    const current = this.current(enabled)
    const currentIndex = enabled.findIndex(action => action.id === current)
    const step = delta < 0 ? BACKWARD_STEP : FORWARD_STEP
    const nextIndex = (Math.max(FIRST_INDEX, currentIndex) + step + enabled.length) % enabled.length
    this.selectedId = enabled[nextIndex]?.id
    return this.selectedId
  }

  reset(): void {
    this.selectedId = undefined
  }

  select(actions: readonly TuiActionSpec<ActionId>[], id: ActionId): boolean {
    if (!actions.some(action => action.id === id && action.enabled)) return false
    this.selectedId = id
    return true
  }
}

export function createActionCursor<ActionId extends string>(): ActionCursor<ActionId> {
  return new ActionCursorService<ActionId>()
}
