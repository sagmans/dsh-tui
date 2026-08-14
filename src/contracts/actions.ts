const ACTION_ENABLED = true
const COMMAND_SEPARATOR = '.'

export type TuiActionTone = 'danger' | 'default' | 'positive'

export interface TuiActionSpec<ActionId extends string> {
  readonly command: string
  readonly enabled: boolean
  readonly id: ActionId
  readonly label: string
  readonly tone: TuiActionTone
}

export function tuiActionCommand(scope: string, id: string): string {
  return `${scope}${COMMAND_SEPARATOR}${id}`
}

export function defineTuiAction<ActionId extends string>(
  scope: string,
  id: ActionId,
  label: string,
  tone: TuiActionTone,
): TuiActionSpec<ActionId> {
  return Object.freeze({
    command: tuiActionCommand(scope, id),
    enabled: ACTION_ENABLED,
    id,
    label,
    tone,
  })
}
