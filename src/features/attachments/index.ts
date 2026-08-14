import { Buffer } from 'node:buffer'
import { open } from 'node:fs/promises'
import { basename, extname, isAbsolute } from 'node:path'
import type { PromptContentPart } from '@deepseek-ai/dsh-api-remotes/client'
import type { ConversationAttachmentView, ConversationLoadedImage } from '../conversation/contracts.js'

export const DEFAULT_TERMINAL_IMAGE_MAX_BYTES = 5 * 1_024 * 1_024

type ImageMediaType = Extract<PromptContentPart, { type: 'image' }>['mediaType']

const EMPTY_IMAGE_ERROR = 'Image file is empty.'
const FILE_REQUIRED_ERROR = 'Image path must name a regular file.'
const PATH_REQUIRED_ERROR = 'Image path must be absolute.'
const SIZE_ERROR = 'Image exceeds the terminal attachment size limit.'
const TYPE_ERROR = 'Attachment must be a PNG, JPEG, WebP, or GIF image.'
const CONTENT_ERROR = 'Image contents do not match the file extension.'
const GIF_EXTENSION = '.gif'
const JPEG_EXTENSION = '.jpeg'
const JPG_EXTENSION = '.jpg'
const PNG_EXTENSION = '.png'
const WEBP_EXTENSION = '.webp'
const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])
const JPEG_SIGNATURE = Uint8Array.from([255, 216, 255])
const GIF87_SIGNATURE = Uint8Array.from([71, 73, 70, 56, 55, 97])
const GIF89_SIGNATURE = Uint8Array.from([71, 73, 70, 56, 57, 97])
const WEBP_RIFF_SIGNATURE = Uint8Array.from([82, 73, 70, 70])
const WEBP_FORMAT_SIGNATURE = Uint8Array.from([87, 69, 66, 80])
const WEBP_FORMAT_OFFSET = 8

function mediaType(path: string): ImageMediaType {
  const extension = extname(path).toLowerCase()
  switch (extension) {
    case GIF_EXTENSION: return 'image/gif'
    case JPEG_EXTENSION:
    case JPG_EXTENSION: return 'image/jpeg'
    case PNG_EXTENSION: return 'image/png'
    case WEBP_EXTENSION: return 'image/webp'
    default: throw new Error(TYPE_ERROR)
  }
}

function startsWith(data: Uint8Array, signature: Uint8Array, offset = 0): boolean {
  if (data.byteLength < offset + signature.byteLength) return false
  return signature.every((byte, index) => data[offset + index] === byte)
}

function matchesMediaType(data: Uint8Array, selectedMediaType: ImageMediaType): boolean {
  switch (selectedMediaType) {
    case 'image/gif': return startsWith(data, GIF87_SIGNATURE) || startsWith(data, GIF89_SIGNATURE)
    case 'image/jpeg': return startsWith(data, JPEG_SIGNATURE)
    case 'image/png': return startsWith(data, PNG_SIGNATURE)
    case 'image/webp': return startsWith(data, WEBP_RIFF_SIGNATURE)
      && startsWith(data, WEBP_FORMAT_SIGNATURE, WEBP_FORMAT_OFFSET)
    default: {
      const exhaustive: never = selectedMediaType
      return Boolean(exhaustive)
    }
  }
}

export async function loadTerminalImage(
  path: string,
  signal: AbortSignal,
  maxBytes = DEFAULT_TERMINAL_IMAGE_MAX_BYTES,
): Promise<ConversationLoadedImage> {
  if (!isAbsolute(path)) throw new Error(PATH_REQUIRED_ERROR)
  const selectedMediaType = mediaType(path)
  const handle = await open(path, 'r')
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) throw new Error(FILE_REQUIRED_ERROR)
    if (stats.size === 0) throw new Error(EMPTY_IMAGE_ERROR)
    if (stats.size > maxBytes) throw new Error(SIZE_ERROR)
    const data = await handle.readFile({ signal })
    if (data.byteLength === 0) throw new Error(EMPTY_IMAGE_ERROR)
    if (data.byteLength > maxBytes) throw new Error(SIZE_ERROR)
    if (!matchesMediaType(data, selectedMediaType)) throw new Error(CONTENT_ERROR)
    const name = basename(path)
    const view: ConversationAttachmentView = Object.freeze({
      bytes: data.byteLength,
      mediaType: selectedMediaType,
      name,
    })
    return Object.freeze({
      content: Object.freeze({
        type: 'image',
        data: Buffer.from(data).toString('base64'),
        mediaType: selectedMediaType,
        name,
      }),
      view,
    })
  } finally {
    await handle.close()
  }
}
