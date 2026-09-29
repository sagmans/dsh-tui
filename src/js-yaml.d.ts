/**
 * The calls this surface makes into js-yaml.
 *
 * The library ships no types, and `@types/js-yaml` would put a second package in
 * the lockfile for a handful of functions. Both readers only ever parse — the
 * bytes an export writes are copied, never serialized — so declaring more than
 * this would be a claim about an API nobody calls.
 */
declare module 'js-yaml' {
  /** A tag the default schema does not know, declared by whoever reads the file. */
  export class Type {
    /** The tag name is always the resolved form, as in `tag:yaml.org,2002:js`. */
    constructor(tag: string, options: { readonly kind: 'scalar'; readonly construct: (value: string) => unknown })
  }

  /** A document's tag set, which is what makes a file's own tags readable. */
  export interface Schema {
    extend(definition: readonly Type[]): Schema
  }

  /** The tag set a plain YAML document is read with, before any of its own. */
  export const DEFAULT_SCHEMA: Schema

  /**
   * Parse one YAML document.
   *
   * Throws a `YAMLException` whose message carries the offending line, which is
   * the part of it a reader editing a theme or a mode can act on.
   */
  export function load(input: string, options?: { readonly schema?: Schema }): unknown
}
