import type { ToolPresentation, ToolPresentationInput, ToolPresentationState } from './contracts.js'
import { imageFallback } from '../attachments/presentation.js'
import { sanitizeConversationText } from '../conversation/projection.js'
import { producedPaths } from '../deliverables/projection.js'

const MAX_SUMMARY_TEXT = 12_000
const READ_LINE_NUMBER_WIDTH = 5
const EMPTY_DETAILS = '(no details)'
const UNKNOWN_TITLE = 'tool'
const LINE_SEPARATOR = '\n'

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null
}

function stringField(value: unknown, key: string): string | undefined {
  if (!record(value)) return undefined
  const field = value[key]
  return typeof field === 'string' ? sanitizeConversationText(field) : undefined
}

function numberField(value: unknown, key: string): number | undefined {
  if (!record(value)) return undefined
  const field = value[key]
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined
}

function booleanField(value: unknown, key: string): boolean | undefined {
  if (!record(value)) return undefined
  const field = value[key]
  return typeof field === 'boolean' ? field : undefined
}

function boundedSummary(value: string): string {
  const safe = sanitizeConversationText(value)
  return safe.length <= MAX_SUMMARY_TEXT
    ? safe
    : `${safe.slice(0, MAX_SUMMARY_TEXT)}…`
}

function json(value: unknown): string {
  try {
    return sanitizeConversationText(JSON.stringify(value, null, 2) ?? String(value))
  } catch {
    return sanitizeConversationText(String(value))
  }
}

function content(value: unknown): string {
  if (!Array.isArray(value)) return json(value)
  return value.map((block) => {
    if (!record(block)) return json(block)
    switch (block.type) {
      case 'text': return stringField(block, 'text') ?? ''
      case 'reasoning': return `thinking: ${stringField(block, 'text') ?? ''}`
      case 'image': return imageFallback(block.attachment)
      case 'tool-call': return `tool ${stringField(block, 'name') ?? UNKNOWN_TITLE}: ${stringField(block, 'arguments') ?? ''}`
      case 'tool-result': return content(block.content)
      default: return json(block)
    }
  }).filter(part => part !== '').join(LINE_SEPARATOR)
}

function diffDetails(value: unknown): string | undefined {
  if (!record(value) || !Array.isArray(value.diffs) || value.diffs.length === 0) return undefined
  const sections: string[] = []
  for (const candidate of value.diffs) {
    if (!record(candidate)) return undefined
    const path = stringField(candidate, 'path')
    const oldText = candidate.oldText
    const newText = stringField(candidate, 'newText')
    if (path === undefined || (oldText !== null && typeof oldText !== 'string') || newText === undefined) return undefined
    const removed = oldText === null ? [] : sanitizeConversationText(oldText).split(LINE_SEPARATOR).map(line => `- ${line}`)
    const added = newText.split(LINE_SEPARATOR).map(line => `+ ${line}`)
    sections.push([path, ...removed, ...added].join(LINE_SEPARATOR))
  }
  return sections.join(`${LINE_SEPARATOR}${LINE_SEPARATOR}`)
}

function genericCall(value: unknown): { readonly details: string[]; readonly title?: string | undefined } | undefined {
  if (!record(value) || value.card !== 'generic') return undefined
  const details: string[] = []
  if ('rawInput' in value) details.push(json(value.rawInput))
  if ('content' in value) details.push(content(value.content))
  if (Array.isArray(value.locations)) {
    const locations = value.locations.flatMap((location) => {
      if (!record(location) || typeof location.path !== 'string') return []
      const line = numberField(location, 'line')
      return [`${sanitizeConversationText(location.path)}${line === undefined ? '' : `:${line}`}`]
    })
    if (locations.length > 0) details.push(`files${LINE_SEPARATOR}${locations.join(LINE_SEPARATOR)}`)
  }
  return { details, title: stringField(value, 'title') }
}

function callProjection(value: unknown): { readonly details: string[]; readonly title?: string | undefined } {
  const generic = genericCall(value)
  if (generic !== undefined) return generic
  if (!record(value)) return { details: [] }
  if (value.card === 'terminal') {
    const title = stringField(value, 'title')
    return {
      title,
      details: [
        stringField(value, 'description'),
        stringField(value, 'cwd') === undefined ? undefined : `cwd ${stringField(value, 'cwd')}`,
        title === undefined ? undefined : `$ ${title}`,
      ].filter((line): line is string => line !== undefined),
    }
  }
  if (value.card === 'diff') {
    const details = diffDetails(value)
    return details === undefined ? { details: [] } : { title: stringField(value, 'title'), details: [details] }
  }
  return { details: [] }
}

function searchDetails(value: Readonly<Record<string, unknown>>): string | undefined {
  const truncated = booleanField(value, 'truncated') === true ? ' · truncated' : ''
  const total = numberField(value, 'total')
  const header = total === undefined ? `search${truncated}` : `search · ${total}${truncated}`
  if (value.shape === 'paths' && Array.isArray(value.paths)) {
    const paths = value.paths
    if (!paths.every(path => typeof path === 'string')) return undefined
    return [header, ...paths.map(path => sanitizeConversationText(path))].join(LINE_SEPARATOR)
  }
  if (value.shape === 'matches' && Array.isArray(value.files)) {
    const lines: string[] = [header]
    for (const file of value.files) {
      if (!record(file) || typeof file.path !== 'string' || !Array.isArray(file.matches)) return undefined
      lines.push(sanitizeConversationText(file.path))
      for (const match of file.matches) {
        if (!record(match) || typeof match.line !== 'string' || typeof match.lineNumber !== 'number') return undefined
        lines.push(`  ${match.lineNumber}: ${sanitizeConversationText(match.line)}`)
      }
    }
    return lines.join(LINE_SEPARATOR)
  }
  return undefined
}

interface SafeReadLine {
  readonly number: number
  readonly text: string
}

function safeReadLine(value: unknown): value is SafeReadLine {
  return record(value) && typeof value.number === 'number' && typeof value.text === 'string'
}

function readDetails(value: Readonly<Record<string, unknown>>): string | undefined {
  if (!Array.isArray(value.lines) || typeof value.path !== 'string') return undefined
  const lines: unknown[] = value.lines
  if (!lines.every(line => safeReadLine(line))) return undefined
  const safeLines = lines.filter(line => safeReadLine(line))
  const total = numberField(value, 'totalLines')
  return [
    `${sanitizeConversationText(value.path)}${total === undefined ? '' : ` · ${total} lines`}`,
    ...safeLines.map(line => `${String(line.number).padStart(READ_LINE_NUMBER_WIDTH)}  ${sanitizeConversationText(line.text)}`),
  ].join(LINE_SEPARATOR)
}

function webDetails(value: Readonly<Record<string, unknown>>): string | undefined {
  if (value.kind === 'fetch') {
    const url = stringField(value, 'url')
    const status = numberField(value, 'statusCode')
    if (url === undefined || status === undefined) return undefined
    return `${url}${LINE_SEPARATOR}HTTP ${status}${booleanField(value, 'truncated') === true ? ' · truncated' : ''}`
  }
  if (value.kind !== 'search' || !Array.isArray(value.sources)) return undefined
  const lines = [stringField(value, 'answer')].filter((line): line is string => line !== undefined)
  for (const source of value.sources) {
    if (!record(source) || typeof source.url !== 'string') return undefined
    const title = stringField(source, 'title')
    lines.push(`${title === undefined ? '' : `${title} · `}${sanitizeConversationText(source.url)}`)
    const snippet = stringField(source, 'snippet')
    if (snippet !== undefined) lines.push(`  ${snippet}`)
  }
  if (booleanField(value, 'truncated') === true) lines.push('[truncated]')
  return lines.join(LINE_SEPARATOR)
}

function resultProjection(value: unknown): { readonly details: string[]; readonly title?: string | undefined } {
  if (!record(value)) return { details: [] }
  const title = stringField(value, 'title')
  if (value.card === 'generic') {
    return { title, details: 'content' in value ? [content(value.content)] : [] }
  }
  if (value.card === 'terminal') {
    const lines = [stringField(value, 'output')]
    const exitCode = numberField(value, 'exitCode')
    const signal = stringField(value, 'signal')
    if (exitCode !== undefined) lines.push(`exit ${exitCode}`)
    if (signal !== undefined) lines.push(`signal ${signal}`)
    return { title, details: lines.filter((line): line is string => line !== undefined) }
  }
  if (value.card === 'diff') {
    const details = diffDetails(value)
    return { title, details: details === undefined ? [] : [details] }
  }
  if (value.card === 'search') {
    const details = searchDetails(value)
    return { title, details: details === undefined ? [] : [details] }
  }
  if (value.card === 'read') {
    const details = readDetails(value)
    return { title, details: details === undefined ? [] : [details] }
  }
  if (value.card === 'web') {
    const details = webDetails(value)
    return { title, details: details === undefined ? [] : [details] }
  }
  return { details: [] }
}

function stateOf(input: ToolPresentationInput): ToolPresentationState {
  if (input.errorCode === 'interrupted') return 'stopped'
  if (input.isError) return 'error'
  return input.result === undefined ? 'running' : 'ok'
}

function summaryOf(title: string, input: ToolPresentationInput, state: ToolPresentationState): string {
  const resultFirstLine = input.result?.split(LINE_SEPARATOR)[0]?.trim()
  if (state === 'error' && resultFirstLine !== undefined && resultFirstLine !== '') return resultFirstLine
  if (title !== input.name) return input.name
  const argsFirstLine = input.args.split(LINE_SEPARATOR)[0]?.trim()
  return argsFirstLine === undefined || argsFirstLine === '' ? input.callId : argsFirstLine
}

export function projectToolPresentation(input: ToolPresentationInput): ToolPresentation {
  const call = callProjection(input.callView)
  const result = resultProjection(input.resultView)
  const title = result.title ?? call.title ?? sanitizeConversationText(input.name || UNKNOWN_TITLE)
  const rawFallback = input.result ?? input.args
  const state = stateOf(input)
  const paths = producedPaths(input.callView, state !== 'ok')
  const details = [...call.details, ...result.details]
  if (paths.length > 0) details.push(`produced files${LINE_SEPARATOR}${paths.join(LINE_SEPARATOR)}`)
  if (details.length === 0 && rawFallback !== '') details.push(rawFallback)
  const safeDetails = sanitizeConversationText(details.filter(detail => detail !== '').join(LINE_SEPARATOR) || EMPTY_DETAILS)
  return Object.freeze({
    callId: sanitizeConversationText(input.callId),
    children: Object.freeze([...(input.children ?? [])]),
    details: safeDetails,
    name: sanitizeConversationText(input.name || UNKNOWN_TITLE),
    paths,
    state,
    summary: boundedSummary(summaryOf(title, input, state)),
    title: boundedSummary(title),
  })
}
