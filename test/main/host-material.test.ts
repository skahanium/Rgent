import { expect, it } from 'vitest'
import { TaskMaterialTracker } from '../../src/main/host-material.ts'
import { appendLedgerChapter } from '../../src/main/host-source.ts'
import { ledgerChapters } from '../../src/main/host-context.ts'
const snapshot = { relPath: 'a.md', sessionId: 's', objectVersion: 'o', revision: 'r' }
it('commits only dispatched context, classifies controlled blocks and omits reasoning', () => {
 const tracker = new TaskMaterialTracker()
 const source = appendLedgerChapter('人写\n\n<!-- rgent:ai:v1 task-id="old" -->\n\nAI段\n', {taskId:'old',startedAt:'now',status:'completed',prompt:'旧口令',answer:'旧答复',reasoning:'PRIVATE_REASONING'})
 const chapter = ledgerChapters(source.slice(source.indexOf('<!-- rgent:ledger:v1 -->')))[0]!
 tracker.context(source, [{kind:'body',sourceId:'body-1'}], snapshot)
 expect(tracker.snapshot().fragments).toEqual([])
 tracker.context(source, [{kind:'body',sourceId:'body-2'}, {kind:'ledger',sourceId:chapter.sourceId}], snapshot)
 tracker.commit()
 const fragments = tracker.snapshot().fragments
 expect(fragments.map(f=>f.classification)).toEqual(['ai','command','ai'])
 expect(JSON.stringify(fragments)).not.toContain('人写'); expect(JSON.stringify(fragments)).not.toContain('PRIVATE_REASONING')
 expect(fragments.every(f=>f.taskId === 'old')).toBe(true)
})
it('keeps returned tool slices only and bounds material retention', () => {
 const tracker = new TaskMaterialTracker(800, 2)
 tracker.body('正文\n\n秘密未返回', {start:0,end:2}, snapshot)
 tracker.commit()
 expect(tracker.snapshot().fragments[0]?.text).toBe('正文')
 tracker.body('长'.repeat(1000), {start:0,end:1000}, snapshot)
 tracker.commit()
 expect(tracker.snapshot().truncated).toBe(true)
 expect(JSON.stringify(tracker.snapshot())).not.toContain('秘密未返回')
})

it('refuses duplicate answer headings rather than guessing an answer offset', () => {
 const tracker=new TaskMaterialTracker()
 const source=appendLedgerChapter('正文',{taskId:'old',startedAt:'now',status:'completed',prompt:'口令',answer:'### 回答'})
 const chapter=ledgerChapters(source.slice(source.indexOf('<!-- rgent:ledger:v1 -->')))[0]!
 tracker.context(source,[{kind:'ledger',sourceId:chapter.sourceId}],snapshot);tracker.commit()
 expect(tracker.snapshot().fragments).toEqual([])
 expect(tracker.snapshot().truncated).toBe(true)
})

it.each(['普通引言。\n\n### 工具摘要\n\n秘密尾句。', '普通引言。\n\n```md\n### 工具摘要\n```\n\n秘密尾句。'])('does not sample guessed command or answer fields from ambiguous chapters: %s', answer => {
 const tracker=new TaskMaterialTracker()
 const source=appendLedgerChapter('正文',{taskId:'ambiguous',startedAt:'now',status:'completed',prompt:'口令',answer,reasoning:'不得采样的推理'})
 const chapter=ledgerChapters(source.slice(source.indexOf('<!-- rgent:ledger:v1 -->')))[0]!
 tracker.context(source,[{kind:'ledger',sourceId:chapter.sourceId}],snapshot);tracker.commit()
 expect(tracker.snapshot().fragments).toEqual([])
 expect(tracker.snapshot().truncated).toBe(true)
})

it('bounds the complete material JSON at the single-fragment edge and across commits', () => {
 const make=(target:number)=>{const probe=new TaskMaterialTracker(1024*1024);const large='x'.repeat(262000);probe.body(large,{start:0,end:large.length},snapshot);probe.commit();const overhead=Buffer.byteLength(JSON.stringify(probe.snapshot().fragments[0]))-large.length;return 'x'.repeat(target-overhead)}
 const raw=make(262142),tracker=new TaskMaterialTracker();tracker.body(raw,{start:0,end:raw.length},snapshot);tracker.commit()
 expect(Buffer.byteLength(JSON.stringify(tracker.snapshot()))).toBeLessThanOrEqual(256*1024);expect(tracker.snapshot().truncated).toBe(true)
 const multi=new TaskMaterialTracker(800);multi.body('x'.repeat(200),{start:0,end:200},snapshot);multi.commit();multi.body('y'.repeat(200),{start:0,end:200},{...snapshot,relPath:'b.md'});multi.commit();expect(Buffer.byteLength(JSON.stringify(multi.snapshot()))).toBeLessThanOrEqual(800);expect(multi.snapshot().truncated).toBe(true)
})
