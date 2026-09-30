/** A large ranking must let a newer input cancel it before stale filesystem proofs begin. */
import { setImmediate } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import { createCompletionProvider } from '@/input/completion.ts'
import { type FileIndex } from '@/input/file-index.ts'

const CANDIDATE_COUNT = 10_000
const QUERY = '@candidate'
const WORKSPACE = '/workspace'

describe('file completion input fairness', () => {
  it('observes cancellation while scoring a large workspace', async () => {
    const controller = new AbortController()
    const rows = Array.from({ length: CANDIDATE_COUNT }, (_, index) => ({ path: `candidate-${index}.ts`, isDirectory: false }))
    const reachable = vi.fn(async () => true)
    const index: FileIndex = { candidates: async () => rows, reachable }
    const provider = createCompletionProvider([], WORKSPACE, index)
    const cancel = setImmediate().then(() => controller.abort())
    const answer = await provider.getSuggestions([QUERY], 0, QUERY.length, { signal: controller.signal })
    await cancel

    expect(answer).toBeNull()
    expect(reachable).not.toHaveBeenCalled()
  })
})
