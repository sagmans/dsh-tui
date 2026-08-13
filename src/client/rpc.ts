import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { RpcError, RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { InvokeRemoteRequest, TypertGateway } from '@deepseek-ai/dsh-api-gateway/types'
import { TypertLookupFailure } from '@deepseek-ai/dsh-typert-protocol'

const API_CHANNEL = '/api'
const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/u
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/u
const CANCELLED_CODE = 'cancelled'
const INTERNAL_CODE = 'internal'

interface RemotePayload {
  readonly args: Readonly<Record<string, unknown>>
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === null || prototype === Object.prototype
}

function isRemotePayload(value: unknown): value is RemotePayload {
  return isPlainRecord(value)
    && Reflect.ownKeys(value).length === 1
    && isPlainRecord(value.args)
}

function assertTarget(channel: string, endpoint: string): [namespace: string, method: string] {
  const segments = endpoint.split('/')
  const namespace = segments.at(0)
  const method = segments.at(1)
  if (channel !== API_CHANNEL
    || !CHANNEL_PATTERN.test(channel)
    || segments.length !== 2
    || namespace === undefined
    || method === undefined
    || segments.some(segment => segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    throw new Error(`connection: invalid RPC target ${JSON.stringify(`${channel}/${endpoint}`)}`)
  }
  return [namespace, method]
}

function error(code: typeof CANCELLED_CODE | typeof INTERNAL_CODE, message: string): RpcResult<never> {
  return { ok: false, error: { code, message, details: {} } }
}

function isAborted(signal: AbortSignal | undefined): signal is AbortSignal {
  return signal?.aborted === true
}

function abortMessage(signal: AbortSignal): string {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : 'This operation was aborted'
}

export function createInProcessRpc(gateway: TypertGateway): ClientConnectionRpc {
  return {
    call(channel, endpoint, payload, signal) {
      let namespace: string
      let method: string
      try {
        ;[namespace, method] = assertTarget(channel, endpoint)
      } catch (failure) {
        return Promise.reject(failure instanceof Error ? failure : new Error(String(failure)))
      }
      return invoke(gateway, namespace, method, endpoint, payload, signal)
    },
  }
}

async function invoke(
  gateway: TypertGateway,
  namespace: string,
  method: string,
  endpoint: string,
  payload: unknown,
  signal: AbortSignal | undefined,
): Promise<RpcResult<unknown>> {
  if (!isRemotePayload(payload)) {
    return error(INTERNAL_CODE, `connection: invalid Remote payload for ${endpoint}`)
  }
  if (isAborted(signal)) return error(CANCELLED_CODE, abortMessage(signal))

  try {
    const request: InvokeRemoteRequest = { namespace, method, args: payload.args }
    const value = await gateway.invoke(signal === undefined ? request : { ...request, signal })
    return { ok: true, value }
  } catch (failure) {
    if (isAborted(signal)) return error(CANCELLED_CODE, abortMessage(signal))
    if (failure instanceof TypertLookupFailure && isRpcError(failure.failure)) {
      return { ok: false, error: failure.failure }
    }
    return error(INTERNAL_CODE, failure instanceof Error ? failure.message : String(failure))
  }
}

function isRpcError(value: unknown): value is RpcError {
  return isPlainRecord(value)
    && typeof value.code === 'string'
    && typeof value.message === 'string'
    && isPlainRecord(value.details)
}
