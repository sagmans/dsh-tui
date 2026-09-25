/**
 * The @-mention grammar: the token a reader typed, what an offer may rank, and
 * how a pick closes or keeps that token open.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { atToken, atValue, rankFiles } from '@/input/file-search.ts'
import { scratch, file, directory } from './fixtures/workspace.ts'

afterEach(() => {
  for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('atToken', () => {
  it('reads the fragment after an at-sign the reader just typed', () => {
      expect(atToken('@edi')).toEqual({ prefix: '@edi', query: 'edi', quoted: false })
    })
  it('reads the token that follows a space, not the whole line', () => {
      expect(atToken('look at @src/ui')).toEqual({ prefix: '@src/ui', query: 'src/ui', quoted: false })
    })
  it('ignores an at-sign inside a word', () => {
      expect(atToken('mail@example.com')).toBeUndefined()
    })
  it('reads a quoted token so a path with spaces can be typed', () => {
      expect(atToken('@"my fi')).toEqual({ prefix: '@"my fi', query: 'my fi', quoted: true })
    })
  it('stops at a quote the reader closed', () => {
      expect(atToken('@"my file" ')).toBeUndefined()
    })
  it('lets the reader keep the dot-slash habit', () => {
      expect(atToken('@./src')).toEqual({ prefix: '@./src', query: 'src', quoted: false })
    })
  it('offers the top level when only the at-sign is typed', () => {
      expect(atToken('@')).toEqual({ prefix: '@', query: '', quoted: false })
    })
})

describe('rankFiles', () => {
  it('lists top-level entries for an empty fragment, directories first', () => {
      const candidates = [file('src/deep.ts'), directory('src'), file('README.md'), file('src.ts')]
      expect(rankFiles('', candidates, 20).map(entry => entry.path)).toEqual(['src', 'README.md', 'src.ts'])
    })
  /**
     * The order below is the order the fzf binary prints for the same fragment
     * and paths, so the file list ranks the way the finder readers know.
     */
    it('ranks a workspace the way fzf ranks the same paths', () => {
      const candidates = [
        file('docs/editor-notes/old.md'),
        file('tests/unit/editor.spec.ts'),
        file('src/ui/editor.ts'),
      ]
      expect(rankFiles('edtr', candidates, 20).map(entry => entry.path)).toEqual([
        'src/ui/editor.ts',
        'docs/editor-notes/old.md',
        'tests/unit/editor.spec.ts',
      ])
    })
  it('lets a fragment scoped to a directory lead with that directory', () => {
      const candidates = [file('src/input/completion.ts'), file('src/ui/editor.ts')]
      expect(rankFiles('src/ui', candidates, 20).map(entry => entry.path)).toEqual(['src/ui/editor.ts', 'src/input/completion.ts'])
    })
  it('keeps a directory above a file it ties with, so it can be opened', () => {
      const candidates = [file('src/app.ts'), directory('src/app')]
      expect(rankFiles('app', candidates, 20).map(entry => entry.path)).toEqual(['src/app', 'src/app.ts'])
    })
  it('holds the list to the suggestions a menu can show', () => {
      const candidates = Array.from({ length: 25 }, (_, index) => file(`src/file-${index}.ts`))
      expect(rankFiles('file', candidates, 20)).toHaveLength(20)
    })
  it('matches a path whose spaces were quoted', () => {
      const candidates = [file('docs/my file.md'), file('docs/other.md')]
      expect(rankFiles('my file', candidates, 20).map(entry => entry.path)).toEqual(['docs/my file.md'])
    })
})

describe('atValue', () => {
  it('leaves a path that ends no token bare', () => {
      expect(atValue('src/ui/editor.ts', false, false)).toBe('@src/ui/editor.ts')
    })
  it('closes a file pick, because the reader is done with that token', () => {
      const value = atValue('docs/my file.md', false, false)
      expect(value).toBe('@"docs/my file.md"')
      expect(atToken(value + ' ')).toBeUndefined()
    })
  it('keeps a directory pick open while it needs quoting, so the reader can drill in', () => {
      const value = atValue('docs/my dir/', false, true)
      expect(value).toBe('@"docs/my dir/')
      expect(atToken(value)).toEqual({ prefix: value, query: 'docs/my dir/', quoted: true })
    })
  it('escapes a quote inside a path instead of ending the token there', () => {
      const value = atValue('docs/my" dir/', false, true)
      expect(atToken(value)).toEqual({ prefix: value, query: 'docs/my" dir/', quoted: true })
    })
  it('quotes every character that would end a token', () => {
      for (const path of ["a'b/", 'a=b/', 'a\tb/', 'a b/']) {
        expect(atToken(atValue(path, false, true))?.query).toBe(path)
      }
    })
  it('round-trips a backslash that sits beside a space', () => {
      expect(atToken(atValue('a\\ b/', false, true))?.query).toBe('a\\ b/')
    })
  it('keeps a token quoted once the reader opened the quote', () => {
      expect(atValue('src', true, false)).toBe('@"src"')
    })
})
