/**
 * The one call this surface makes into js-yaml.
 *
 * The library ships no types, and `@types/js-yaml` would put a second package in
 * the lockfile for a single function. A theme reader only ever parses — the bytes
 * an export writes are copied, never serialized — so declaring more than this
 * would be a claim about an API nobody calls.
 */
declare module 'js-yaml' {
  /**
   * Parse one YAML document.
   *
   * Throws a `YAMLException` whose message carries the offending line, which is
   * the part of it a reader editing a theme can act on.
   */
  export function load(input: string): unknown
}
