import type { ConfigurationResult } from './contracts.js'

export function configurationSuccess(): ConfigurationResult<void> {
  return { ok: true, value: undefined }
}

export function configurationFailure(
  error: { readonly code: string; readonly message: string },
): ConfigurationResult<never> {
  return { ok: false, error: { code: error.code, message: error.message } }
}

export function configurationBusinessFailure(
  value: { readonly message?: string; readonly reason?: string },
): ConfigurationResult<never> {
  return {
    ok: false,
    error: {
      code: value.reason ?? 'operation-failed',
      message: value.message ?? 'Operation failed.',
    },
  }
}
