import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, test } from 'vitest'
import type { DownloadsApi } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { loadTerminalImage } from '../../src/features/attachments/index.js'
import { exportSessionArchive } from '../../src/features/export/index.js'

// Static fixture identity crosses only the Harness brand boundary.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const SESSION_ID = 'session-one' as SessionId
const IMAGE_BYTES = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1])
const SPOOFED_IMAGE_BYTES = Uint8Array.from([1, 2, 3, 4])
const EXPORT_BYTES = Uint8Array.from([80, 75, 3, 4])
const FILE_PERMISSION_MASK = 0o777
const PRIVATE_FILE_MODE = 0o600
const created: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-tui-parity-'))
  created.push(directory)
  return directory
}

afterEach(async () => {
  for (const path of created.splice(0).toReversed()) await rm(path, { force: true, recursive: true })
})

test('loads explicit local image paths without exposing the path to the prompt', async () => {
  const directory = await temporaryDirectory()
  const path = join(directory, 'screen.png')
  await writeFile(path, IMAGE_BYTES)

  const image = await loadTerminalImage(path, new AbortController().signal)

  assert.deepEqual(image.view, {
    bytes: IMAGE_BYTES.byteLength,
    mediaType: 'image/png',
    name: 'screen.png',
  })
  assert.deepEqual(image.content, {
    type: 'image',
    data: Buffer.from(IMAGE_BYTES).toString('base64'),
    mediaType: 'image/png',
    name: 'screen.png',
  })
  assert.equal(JSON.stringify(image).includes(directory), false)
})

test('rejects relative paths, unsupported media, and extension spoofing', async () => {
  const directory = await temporaryDirectory()
  const textPath = join(directory, 'notes.txt')
  const spoofedPath = join(directory, 'spoofed.png')
  await writeFile(textPath, 'not an image')
  await writeFile(spoofedPath, SPOOFED_IMAGE_BYTES)

  await assert.rejects(() => loadTerminalImage('screen.png', new AbortController().signal), /absolute/u)
  await assert.rejects(() => loadTerminalImage(textPath, new AbortController().signal), /PNG, JPEG, WebP, or GIF/u)
  await assert.rejects(() => loadTerminalImage(spoofedPath, new AbortController().signal), /contents/u)
})

test('streams session export to a new explicit archive with private permissions', async () => {
  const directory = await temporaryDirectory()
  const destination = join(directory, 'session.zip')
  const downloads: DownloadsApi = {
    sessionLog: () => Promise.resolve(new Response(EXPORT_BYTES, { status: 200 })),
  }

  await exportSessionArchive(downloads, SESSION_ID, destination, new AbortController().signal)

  assert.deepEqual(await readFile(destination), Buffer.from(EXPORT_BYTES))
  assert.equal((await stat(destination)).mode & FILE_PERMISSION_MASK, PRIVATE_FILE_MODE)
})

test('refuses relative or existing export destinations and removes failed partials', async () => {
  const directory = await temporaryDirectory()
  const existing = join(directory, 'existing.zip')
  const failed = join(directory, 'failed.zip')
  await writeFile(existing, 'keep')
  const success: DownloadsApi = {
    sessionLog: () => Promise.resolve(new Response(EXPORT_BYTES, { status: 200 })),
  }
  const failure: DownloadsApi = {
    sessionLog: () => Promise.resolve(new Response('unavailable', { status: 503 })),
  }

  await assert.rejects(() => exportSessionArchive(success, SESSION_ID, 'session.zip', new AbortController().signal), /absolute/u)
  await assert.rejects(() => exportSessionArchive(success, SESSION_ID, existing, new AbortController().signal), /already exists/u)
  await assert.rejects(() => exportSessionArchive(failure, SESSION_ID, failed, new AbortController().signal), /HTTP 503/u)
  await assert.rejects(() => readFile(failed), /ENOENT/u)
  assert.equal(await readFile(existing, 'utf8'), 'keep')
})
