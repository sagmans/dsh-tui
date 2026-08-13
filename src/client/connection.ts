import type {
  ClientConnectionRpc,
  ConnectionConfig,
  ConnectionHandle,
  ConnectionSinks,
  HostDescription,
  IApiClient,
} from '@deepseek-ai/dsh-client-connection/client'
import { InProcessApiClient, toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import type { ApiProxy, HostFrame, MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'

const CONNECTION_ALREADY_STARTED_ERROR = 'tui connection stream already started'
const CONNECTION_STOPPED_ERROR = 'tui connection stopped before readiness'
const CONNECTION_LOG_PREFIX = '[dsh-tui] connection sink threw:'
const DEFAULT_BACKOFF_BASE_MS = 500
const DEFAULT_BACKOFF_FACTOR = 2
const DEFAULT_BACKOFF_MAX_MS = 10_000
const DEFAULT_STREAM_OPEN_TIMEOUT_MS = 3_000

interface ConnectionLoopConfig {
  readonly backoffBaseMs: number
  readonly backoffFactor: number
  readonly backoffMaxMs: number
  readonly streamOpenTimeoutMs: number
}

export interface TuiConnectionHandle extends ConnectionHandle {
  /** Resolves after both streams and host description establish the first generation. */
  readonly ready: Promise<void>
}

export interface InProcessConnectionOptions {
  readonly api?: IApiClient
  readonly config?: ConnectionConfig
  readonly rpc: ClientConnectionRpc
}

interface Deferred {
  readonly promise: Promise<void>
  readonly reject: (reason: Error) => void
  readonly resolve: () => void
}

function deferred(): Deferred {
  let reject!: (reason: Error) => void
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    reject = rejectPromise
    resolve = resolvePromise
  })
  return { promise, reject, resolve }
}

class InProcessConnection implements TuiConnectionHandle {
  readonly api: IApiClient
  readonly isLoopback = true
  readonly ready: Promise<void>
  readonly rpc: ClientConnectionRpc
  readonly hostDescription: ConnectionHandle['hostDescription']

  private readonly config: ConnectionLoopConfig
  private readonly readiness = deferred()
  private readonly descriptionListeners = new Set<() => void>()
  private readonly lifecycle = new AbortController()
  private description: HostDescription | undefined
  private generation?: AbortController
  private readinessSettled = false
  private started = false
  private stopped = false

  constructor(api: IApiClient, rpc: ClientConnectionRpc, config: ConnectionConfig = {}) {
    this.api = api
    this.rpc = rpc
    this.config = {
      backoffBaseMs: config.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS,
      backoffFactor: config.backoffFactor ?? DEFAULT_BACKOFF_FACTOR,
      backoffMaxMs: config.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS,
      streamOpenTimeoutMs: config.streamOpenTimeoutMs ?? DEFAULT_STREAM_OPEN_TIMEOUT_MS,
    }
    this.ready = this.readiness.promise
    this.hostDescription = {
      getSnapshot: () => this.description,
      subscribe: (listener) => {
        this.descriptionListeners.add(listener)
        return () => { this.descriptionListeners.delete(listener) }
      },
    }
  }

  start(sinks: ConnectionSinks): { stop(): void } {
    if (this.started) throw new Error(CONNECTION_ALREADY_STARTED_ERROR)
    this.started = true
    void this.run(sinks)
    return { stop: () => { this.stop() } }
  }

  private stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.lifecycle.abort()
    this.generation?.abort()
    this.clearDescription()
    if (!this.readinessSettled) {
      this.readinessSettled = true
      this.readiness.reject(new Error(CONNECTION_STOPPED_ERROR))
    }
  }

  private async run(sinks: ConnectionSinks): Promise<void> {
    let attempt = 0
    while (!this.stopped) {
      const controller = new AbortController()
      this.generation = controller
      const opened = deferred()
      let openedStreams = 0
      const onOpen = (): void => {
        openedStreams += 1
        if (openedStreams === 2) opened.resolve()
      }
      const ended = deferred()
      const endGeneration = (): void => {
        if (!controller.signal.aborted) controller.abort()
        ended.resolve()
      }
      void this.pump(this.api.events.mux({}, controller.signal, onOpen), sinks.onMuxEnvelope, endGeneration)
      void this.pump(this.api.events.host({}, controller.signal, onOpen), sinks.onHostEnvelope, endGeneration)

      try {
        const [response] = await Promise.all([
          this.api.host.describe({}, controller.signal),
          Promise.race([opened.promise, this.openTimeout(controller.signal)]),
        ])
        if (!response.result.ok) throw new Error(response.result.error.message)
        if (controller.signal.aborted) throw new Error(CONNECTION_STOPPED_ERROR)
        const description = response.result.value
        attempt = 0
        this.publishDescription(description)
        this.callSink(() => { sinks.onStateChange?.('connected') })
        this.callSink(() => { sinks.onConnected?.(description) })
        if (!this.readinessSettled) {
          this.readinessSettled = true
          this.readiness.resolve()
        }
      } catch {
        if (!controller.signal.aborted) controller.abort()
      }

      await ended.promise
      if (this.stopped) return
      this.clearDescription()
      this.callSink(() => { sinks.onStateChange?.('reconnecting') })
      attempt += 1
      await this.backoff(attempt, this.lifecycle.signal)
    }
  }

  private async pump<Frame extends { readonly type: string }>(
    stream: AsyncIterable<RpcRequest<Frame>>,
    sink: ((envelope: RpcRequest<Frame>) => void) | undefined,
    onEnd: () => void,
  ): Promise<void> {
    try {
      for await (const envelope of stream) {
        if (envelope.payload.type === 'stream/error') break
        if (sink !== undefined) this.callSink(() => { sink(envelope) })
      }
    } catch {
      // Stream loss converges through the shared generation restart.
    } finally {
      onEnd()
    }
  }

  private openTimeout(signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(done, this.config.streamOpenTimeoutMs)
      signal.addEventListener('abort', done, { once: true })
      function done(): void {
        clearTimeout(timer)
        signal.removeEventListener('abort', done)
        resolve()
      }
    })
  }

  private backoff(attempt: number, signal: AbortSignal): Promise<void> {
    const delay = Math.min(
      this.config.backoffMaxMs,
      this.config.backoffBaseMs * this.config.backoffFactor ** Math.max(0, attempt - 1),
    )
    if (signal.aborted) return Promise.resolve()
    return new Promise(resolve => {
      const timer = setTimeout(done, delay)
      signal.addEventListener('abort', done, { once: true })
      function done(): void {
        clearTimeout(timer)
        signal.removeEventListener('abort', done)
        resolve()
      }
    })
  }

  private clearDescription(): void {
    if (this.description === undefined) return
    this.description = undefined
    for (const listener of this.descriptionListeners) this.callSink(listener)
  }

  private publishDescription(description: HostDescription): void {
    if (Object.is(this.description, description)) return
    this.description = description
    for (const listener of this.descriptionListeners) this.callSink(listener)
  }

  private callSink(callback: () => void): void {
    try {
      callback()
    } catch (error) {
      console.error(CONNECTION_LOG_PREFIX, error)
    }
  }
}

export function createInProcessConnection(
  apiProxy: ApiProxy,
  options: InProcessConnectionOptions,
): TuiConnectionHandle {
  const api = options.api ?? new InProcessApiClient(toFetchHandler(apiProxy))
  return new InProcessConnection(api, options.rpc, options.config)
}

export type { HostFrame, MuxFrame }
