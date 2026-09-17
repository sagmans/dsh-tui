/**
 * Token estimates shared by every row that reports a size.
 *
 * The exact count needs the provider's own tokenizer, which a terminal does not
 * have; four characters per token is the estimate a reader can compare against,
 * and one definition keeps a reasoning row, a status row, and a tool card from
 * disagreeing about the same text.
 */

/** Characters a provider bills as roughly one token. */
export const CHARS_PER_TOKEN = 4

const THOUSAND = 1000
const HUNDRED_THOUSAND = 100 * THOUSAND
const MILLION = 1_000_000

/** A thought's or a payload's size in tokens, rounded up so a non-empty text never reads as zero. */
export function countTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/** Compact a token count, because the exact number changes nothing a reader decides. */
export function formatTokens(count: number): string {
  if (count >= MILLION) return `${(count / MILLION).toFixed(1)}M`
  // A decimal on a five-digit count is noise: 128.0k reads worse than 128k.
  if (count >= HUNDRED_THOUSAND) return `${Math.round(count / THOUSAND)}k`
  if (count >= THOUSAND) return `${(count / THOUSAND).toFixed(1)}k`
  return String(count)
}
