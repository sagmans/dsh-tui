import { sanitizeText } from '../sessions/projection.js'

const IMAGE_LABEL = 'image'
const BYTE_UNIT = 'B'
const KIBIBYTE = 1_024
const MEBIBYTE = KIBIBYTE * KIBIBYTE
const KIBIBYTE_UNIT = 'KiB'
const MEBIBYTE_UNIT = 'MiB'
const DIMENSION_SEPARATOR = '×'
const DETAIL_SEPARATOR = ' · '

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function byteText(bytes: number): string {
  if (bytes >= MEBIBYTE) return `${Math.round(bytes / MEBIBYTE * 10) / 10} ${MEBIBYTE_UNIT}`
  if (bytes >= KIBIBYTE) return `${Math.round(bytes / KIBIBYTE * 10) / 10} ${KIBIBYTE_UNIT}`
  return `${bytes} ${BYTE_UNIT}`
}

export function imageFallback(attachment: unknown): string {
  if (!record(attachment)) return `[${IMAGE_LABEL}]`
  const details: string[] = []
  if (typeof attachment.name === 'string' && attachment.name.trim() !== '') {
    details.push(sanitizeText(attachment.name))
  }
  const width = positiveNumber(attachment.width)
  const height = positiveNumber(attachment.height)
  if (width !== undefined && height !== undefined) details.push(`${width}${DIMENSION_SEPARATOR}${height}`)
  const bytes = positiveNumber(attachment.bytes)
  if (bytes !== undefined) details.push(byteText(bytes))
  if (typeof attachment.mediaType === 'string' && attachment.mediaType.startsWith('image/')) {
    details.push(sanitizeText(attachment.mediaType))
  }
  return details.length === 0
    ? `[${IMAGE_LABEL}]`
    : `[${IMAGE_LABEL} ${details.join(DETAIL_SEPARATOR)}]`
}
