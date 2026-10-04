/** Footer wrapping must not turn an empty scope into false proof that a draft vanished. */
const EDITOR_ROW = /^\s*│/u
const FOOTER = /^\s*[●▶] (?:ready|working)\b/u
const MAX_EDITOR_FOOTER_GAP = 3

/** Only the current prompt block beside the footer counts, not a picker or transcript card above it. */
export function editorText(text) {
  const lines = text.split('\n')
  const footer = lines.findLastIndex(line => FOOTER.test(line))
  const last = lines.findLastIndex((line, index) => index < footer && EDITOR_ROW.test(line))
  if (last < 0 || footer - last > MAX_EDITOR_FOOTER_GAP) return undefined
  let first = last
  while (first > 0 && EDITOR_ROW.test(lines[first - 1])) first--
  return lines.slice(first, last + 1).join('\n')
}
