/**
 * A program's dispatches: the order they land in under their card, the rows a
 * click opens, and what retention caps.
 */

import { describe, expect, it } from 'vitest'
import { cardOfCall, cardOfResult } from '@/cards/presenter.ts'
import { contentLines, rowText, type ToolPresenter } from '@/cards.ts'
import { SUBCALL_MAX } from '@/cards/composition.ts'
import { TranscriptModel } from '@/transcript.ts'
import { text, card, recordingPresenter } from './fixtures/transcript.ts'


describe('TranscriptModel nested PTC calls', () => {
  const runCall = { type: 'tool/call', data: { name: 'run_code', arguments: '{"code":"x","description":"search"}', callId: 'root' } }
  const runResult = {
      type: 'tool/result',
      data: { message: { content: [{ type: 'tool-result', toolCallId: 'root', text: 'done' }], isError: false } },
    }
  const start = (subCallId: string, name: string, args: unknown, rootCallId = 'root') => ({
      type: 'tool/ptc-dispatch-start',
      data: { rootCallId, parentCallId: rootCallId, subCallId, name, arguments: args },
    })
  const settle = (subCallId: string, name: string, args: unknown, isError: boolean, content: readonly unknown[] = []) => ({
      type: 'tool/ptc-dispatch',
      data: { rootCallId: 'root', parentCallId: 'root', subCallId, name, arguments: args, isError, content },
    })
  /** The calls the one card in the fold kept, which is what a click opens. */
    const subCallsOf = (model: TranscriptModel) => {
      const entry = model.entries()[0]
      return entry?.kind === 'tool' ? entry.card.subCalls ?? [] : []
    }
  /** What a row says about the call it stands for, apart from the rows it opens to. */
    const rowShape = (model: TranscriptModel) =>
      subCallsOf(model).map(call => `${call.id} ${call.title} ${call.failed}`)
  it('draws a nested call on the card that dispatched it, and restates it with its outcome', () => {
      const presenter = recordingPresenter()
      const model = new TranscriptModel(presenter)
      model.apply(runCall)
      model.apply(start('root:ptc:1', 'read', { file_path: 'src/x.ts' }))
      expect(rowShape(model)).toEqual(['root:ptc:1 read pending false'])
      expect(presenter.calls).toEqual(['run_code:{"code":"x","description":"search"}', 'read:{"file_path":"src/x.ts"}'])
  
      model.apply(settle('root:ptc:1', 'read', { file_path: 'src/x.ts' }, true))
      expect(rowShape(model)).toEqual(['root:ptc:1 read pending true'])
  
      model.apply(runResult)
      expect(rowShape(model)).toEqual(['root:ptc:1 read pending true'])
    })
  it('accepts a replayed dispatch after the fold was reset', () => {
      const model = new TranscriptModel(recordingPresenter())
      model.apply(runCall)
      model.apply(start('root:ptc:1', 'read', { file_path: 'src/x.ts' }))
      model.reset()
      // A session switch replays the same ids through the same fold; the remembered
      // child index belongs to the fold that was dropped, not to this one.
      model.apply(runCall)
      model.apply(start('root:ptc:1', 'read', { file_path: 'src/x.ts' }))
      const replayed = model.entries()[0]
      expect(replayed?.kind === 'tool' && replayed.card.subCalls).toHaveLength(1)
    })
  it('forgets a call it did not keep when the run that dispatched it settles', () => {
      const model = new TranscriptModel(recordingPresenter())
      model.apply({ type: 'tool/call', data: { name: 'run_code', arguments: '{}', callId: 'a' } })
      for (let at = 0; at < SUBCALL_MAX; at++) model.apply(start(`a:${at}`, 'read', { file_path: 'f' }, 'a'))
      model.apply(start('a:overflow', 'read', { file_path: 'f' }, 'a'))
      model.apply({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'a', text: 'done' }], isError: false } } })
      // An overflow row has no row to clean up after, so its bookkeeping has to be
      // retired with the run; kept, it would refuse the same id to the next run.
      model.apply({ type: 'tool/call', data: { name: 'run_code', arguments: '{}', callId: 'b' } })
      model.apply(start('a:overflow', 'read', { file_path: 'f' }, 'b'))
      const second = model.entries()[1]
      expect(second?.kind === 'tool' && second.card.subCalls).toHaveLength(1)
    })
  it("keeps a dispatched shell call's output for the row a click opens", () => {
      // The program answers with its own return value, so a call's own stdout has
      // nowhere else to live; a shell view re-presents it from the logged content,
      // which is what a reader opens the row to see.
      const presenter: ToolPresenter = {
        call: name => (name === 'bash' ? cardOfCall({ card: 'terminal', title: 'echo hi' }, name) : undefined),
        result: (name, input) => (name === 'bash'
          ? cardOfResult(
              { card: 'terminal', output: contentLines(input.content).join('\n'), exitCode: 0 },
              { name, failed: input.isError, contentLines: contentLines(input.content) },
            )
          : undefined),
      }
      const model = new TranscriptModel(presenter)
      model.apply(runCall)
      model.apply(start('root:ptc:1', 'bash', { command: 'echo hi' }))
      model.apply(settle('root:ptc:1', 'bash', { command: 'echo hi' }, false, text('hi\nthere')))
      const opened = model.entries()[0]
      const output = opened?.kind === 'tool' ? opened.card.subCalls?.[0]?.output : undefined
      expect(output?.kind).toBe('terminal')
      expect(output?.rows.map(row => rowText(row))).toEqual(['hi', 'there'])
      expect(output?.totalLines).toBe(2)
  
      model.apply(start('root:ptc:2', 'read', { file_path: 'src/x.ts' }))
      model.apply(settle('root:ptc:2', 'read', { file_path: 'src/x.ts' }, false, text('file body')))
      // A tool whose own view needs metadata a dispatch does not carry still keeps
      // the content the program was shown, so its row opens to an outcome too.
      const fallback = subCallsOf(model)[1]?.output
      expect(fallback?.kind).toBe('generic')
      expect(fallback?.rows.map(rowText)).toEqual(['file body'])
    })
  it('keeps the change a dispatched edit declared, so the row opens to its diff', () => {
      // The call view is the only place an edit's diff exists: the dispatch carries
      // no diff metadata, and a reader clicking the row is asking for the change.
      const presenter: ToolPresenter = {
        call: (name, argumentsJson) => {
          const args = JSON.parse(argumentsJson) as { file_path?: string; old_string?: string; new_string?: string }
          return name === 'edit'
            ? cardOfCall({ card: 'diff', title: 'Edit', diffs: [{ path: args.file_path ?? '', oldText: args.old_string ?? '', newText: args.new_string ?? '' }] }, name)
            : undefined
        },
        result: () => undefined,
      }
      const model = new TranscriptModel(presenter)
      const args = { file_path: 'src/x.ts', old_string: 'b', new_string: 'B' }
      model.apply(runCall)
      model.apply(start('root:ptc:1', 'edit', args))
      // The diff is known the moment the call starts, so the row opens while in flight.
      expect(subCallsOf(model)[0]?.presented?.rows.map(rowText)).toEqual(['src/x.ts  -1 +1', '-b', '+B'])
      expect(subCallsOf(model)[0]?.output).toBeUndefined()
  
      model.apply(settle('root:ptc:1', 'edit', args, false, text('The file src/x.ts has been updated successfully.')))
      const call = subCallsOf(model)[0]
      expect(call?.presented?.kind).toBe('diff')
      expect(call?.presented?.rows.map(rowText)).toEqual(['src/x.ts  -1 +1', '-b', '+B'])
      expect(call?.output?.rows.map(rowText)).toEqual(['The file src/x.ts has been updated successfully.'])
    })
  it('takes back the change a failed call declared and keeps the reason it failed', () => {
      const presenter: ToolPresenter = {
        call: () => cardOfCall({ card: 'diff', title: 'Edit', diffs: [{ path: 'src/x.ts', oldText: 'b', newText: 'B' }] }, 'edit'),
        result: () => undefined,
      }
      const model = new TranscriptModel(presenter)
      const reason = 'Error: cannot modify "src/x.ts": file has not been read — read the file, then retry'
      model.apply(runCall)
      model.apply(start('root:ptc:1', 'edit', { file_path: 'src/x.ts' }))
      model.apply(settle('root:ptc:1', 'edit', { file_path: 'src/x.ts' }, true, text(reason)))
      const call = subCallsOf(model)[0]
      expect(call?.failed).toBe(true)
      // Rows that still drew as applied would claim a change that never happened.
      expect(call?.presented).toBeUndefined()
      expect(call?.output?.rows.map(rowText)).toEqual([reason])
    })
  it('opens a row for a tool the surface has no presenter for', () => {
      const model = new TranscriptModel()
      model.apply(runCall)
      model.apply(start('root:ptc:1', 'mystery', { a: 1 }))
      model.apply(settle('root:ptc:1', 'mystery', { a: 1 }, false, text('mystery said no')))
      const call = subCallsOf(model)[0]
      expect(call?.title).toBe('mystery')
      expect(call?.presented).toBeUndefined()
      expect(call?.output?.rows.map(rowText)).toEqual(['mystery said no'])
    })
  it('keeps the calls in dispatch order and counts every one', () => {
      const model = new TranscriptModel(recordingPresenter())
      model.apply(runCall)
      model.apply(start('root:ptc:1', 'read', { file_path: 'a.ts' }))
      model.apply(settle('root:ptc:1', 'read', { file_path: 'a.ts' }, false))
      model.apply(start('root:ptc:2', 'bash', { command: 'ls' }))
      const card = model.entries()[0]
      const subCalls = card?.kind === 'tool' ? card.card.subCalls : undefined
      expect(subCalls?.map(call => call.title)).toEqual(['read pending', 'bash pending'])
      expect(card?.kind === 'tool' && card.card.subCallsTotal).toBe(2)
    })
  it('caps retained calls and still reports how many ran', () => {
      const model = new TranscriptModel(recordingPresenter())
      model.apply(runCall)
      for (let index = 1; index <= SUBCALL_MAX + 1; index += 1) {
        model.apply(start(`root:ptc:${index}`, 'read', { file_path: `${index}.ts` }))
      }
      const card = model.entries()[0]
      expect(card?.kind === 'tool' && card.card.subCalls).toHaveLength(SUBCALL_MAX)
      expect(card?.kind === 'tool' && card.card.subCallsTotal).toBe(SUBCALL_MAX + 1)
    })
  it('ignores a dispatch whose root call is not in this fold', () => {
      const model = new TranscriptModel(recordingPresenter())
      model.apply(start('other:ptc:1', 'read', { file_path: 'x.ts' }, 'other'))
      expect(model.entries()).toEqual([])
    })
  it('keeps the nested calls when the result presenter declines', () => {
      const presenter: ToolPresenter = {
        call: name => ({ kind: 'generic', tool: name, title: name, detail: [], failed: false, totalLines: 0 }),
        result: () => undefined,
      }
      const model = new TranscriptModel(presenter)
      model.apply(runCall)
      model.apply(start('root:ptc:1', 'read', { file_path: 'x.ts' }))
      model.apply(runResult)
      const card = model.entries()[0]
      expect(card?.kind === 'tool' && card.card.subCalls).toHaveLength(1)
    })
  it('marks a dispatched call in flight only until its dispatch log lands', () => {
      const model = new TranscriptModel(recordingPresenter())
      model.apply(runCall)
      model.apply(start('root:ptc:1', 'read', { file_path: 'src/x.ts' }))
      // The start is logged before the call runs, so the row drawn from it is the
      // only sign a reader has that the program is waiting on this call.
      expect(subCallsOf(model).map(call => call.running)).toEqual([true])
  
      model.apply(settle('root:ptc:1', 'read', { file_path: 'src/x.ts' }, false))
      expect(subCallsOf(model).map(call => call.running)).toEqual([false])
    })
  it('ends a dispatched call that answered with nothing to open', () => {
      // A call whose content the program discarded still settles: a row left
      // saying it is running would outlive the program that dispatched it.
      const presenter: ToolPresenter = { call: () => undefined, result: () => undefined }
      const model = new TranscriptModel(presenter)
      model.apply(runCall)
      model.apply(start('root:ptc:1', 'read', { file_path: 'src/x.ts' }))
      model.apply(settle('root:ptc:1', 'read', { file_path: 'src/x.ts' }, false))
      expect(subCallsOf(model).map(call => call.running)).toEqual([false])
      expect(subCallsOf(model)[0]?.output).toBeUndefined()
    })
})
