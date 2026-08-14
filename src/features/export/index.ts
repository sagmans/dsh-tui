import { Buffer } from 'node:buffer'
import { open, unlink } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { DownloadsApi } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'

const PRIVATE_FILE_MODE = 0o600
const EXCLUSIVE_WRITE_FLAG = 'wx'
const ABSOLUTE_PATH_ERROR = 'Export destination must be absolute.'
const BODY_ERROR = 'Session export returned no archive body.'
const EXISTS_ERROR = 'Export destination already exists.'

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

async function ignoreCleanupFailure(action: () => Promise<unknown>): Promise<void> {
  try {
    await action()
  } catch {
    // Cleanup must not replace the primary export failure.
  }
}

async function writeChunk(
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
): Promise<void> {
  const data = Buffer.from(chunk)
  let offset = 0
  while (offset < data.byteLength) {
    const result = await handle.write(data, offset, data.byteLength - offset)
    offset += result.bytesWritten
  }
}

export async function exportSessionArchive(
  downloads: DownloadsApi,
  sessionId: SessionId,
  destination: string,
  signal: AbortSignal,
): Promise<void> {
  if (!isAbsolute(destination)) throw new Error(ABSOLUTE_PATH_ERROR)
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(destination, EXCLUSIVE_WRITE_FLAG, PRIVATE_FILE_MODE)
  } catch (error) {
    if (errorCode(error) === 'EEXIST') throw new Error(EXISTS_ERROR, { cause: error })
    throw error
  }

  let complete = false
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const response = await downloads.sessionLog({ sessionId, includeDescendants: true }, signal)
    const body = response.body
    if (!response.ok) {
      if (body !== null) await ignoreCleanupFailure(() => body.cancel())
      throw new Error(`Session export failed: HTTP ${response.status}`)
    }
    if (body === null) throw new Error(BODY_ERROR)
    reader = body.getReader()
    while (true) {
      signal.throwIfAborted()
      const next = await reader.read()
      if (next.done) break
      await writeChunk(handle, next.value)
    }
    await handle.sync()
    complete = true
  } finally {
    if (!complete && reader !== undefined) {
      const incompleteReader = reader
      await ignoreCleanupFailure(() => incompleteReader.cancel())
    }
    await handle.close()
    if (!complete) await ignoreCleanupFailure(() => unlink(destination))
  }
}
