import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import type { TuiClientFacade } from '../../client/context.js'
import type {
  ConversationPreferenceResult,
  ConversationSendMode,
  ConversationSubmissionPreferences,
} from './contracts.js'

export const CONVERSATION_SETTINGS_NAMESPACE = 'ui-conversation'
const BUSY_ENTER_FIELD = 'busyEnter'
const BUSY_ENTER_QUEUE = 'queue'
const BUSY_ENTER_STEER = 'steer'
const SETTINGS_EVENT = 'settings/document-updated'
const SETTINGS_UNAVAILABLE_CODE = 'settings-unavailable'
const SETTINGS_UNAVAILABLE_MESSAGE = 'conversation settings unavailable'
const SETTINGS_INVALID_CODE = 'settings-invalid'
const SETTINGS_INVALID_MESSAGE = 'conversation settings are invalid'
const SETTINGS_TRANSPORT_CODE = 'settings-transport'
const SETTINGS_TRANSPORT_MESSAGE = 'conversation settings transport failed'
const SETTINGS_SET_OPERATION = 'set'

const CONVERSATION_SETTINGS_SCHEMA = z.object({
  [BUSY_ENTER_FIELD]: z.union([BUSY_ENTER_QUEUE, BUSY_ENTER_STEER]).default(BUSY_ENTER_QUEUE),
})

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSendMode(value: unknown): value is ConversationSendMode {
  return value === BUSY_ENTER_QUEUE || value === BUSY_ENTER_STEER
}

function transportFailure(error: unknown): ConversationPreferenceResult<never> {
  return {
    ok: false,
    error: {
      code: SETTINGS_TRANSPORT_CODE,
      message: error instanceof Error ? error.message : SETTINGS_TRANSPORT_MESSAGE,
    },
  }
}

function preferenceFromNamespace(
  view: SettingsNamespaceView,
): ConversationPreferenceResult<{ readonly behavior: ConversationSendMode; readonly revision: number }> {
  if (!isRecord(view.value) || !isSendMode(view.value[BUSY_ENTER_FIELD])) {
    return { ok: false, error: { code: SETTINGS_INVALID_CODE, message: SETTINGS_INVALID_MESSAGE } }
  }
  return {
    ok: true,
    value: { behavior: view.value[BUSY_ENTER_FIELD], revision: view.revision },
  }
}

export function createConversationSubmissionPreferences(
  client: TuiClientFacade,
): ConversationSubmissionPreferences {
  return {
    read: async () => {
      try {
        const response = await client.api.settings.describe({})
        if (!response.result.ok) return response.result
        const namespace = response.result.value.namespaces.find(
          candidate => candidate.ns === CONVERSATION_SETTINGS_NAMESPACE,
        )
        return namespace === undefined
          ? { ok: false, error: { code: SETTINGS_UNAVAILABLE_CODE, message: SETTINGS_UNAVAILABLE_MESSAGE } }
          : preferenceFromNamespace(namespace)
      } catch (error) {
        return transportFailure(error)
      }
    },
    subscribe: listener => client.remote.$on(SETTINGS_EVENT, (namespace) => {
      if (String(namespace) === CONVERSATION_SETTINGS_NAMESPACE) listener()
    }),
    write: async (behavior, revision) => {
      try {
        const response = await client.api.settings.mutate({
          ns: CONVERSATION_SETTINGS_NAMESPACE,
          ops: [{ op: SETTINGS_SET_OPERATION, path: [BUSY_ENTER_FIELD], value: behavior }],
          expectedRevision: revision,
        })
        return response.result.ok ? preferenceFromNamespace(response.result.value) : response.result
      } catch (error) {
        return transportFailure(error)
      }
    },
  }
}

export function registerConversationSettings(ctx: Context): void {
  ctx.inject(['settings'], settingsCtx => {
    settingsCtx.settings.register(
      settingsNamespace(CONVERSATION_SETTINGS_NAMESPACE),
      CONVERSATION_SETTINGS_SCHEMA,
    )
  })
}
