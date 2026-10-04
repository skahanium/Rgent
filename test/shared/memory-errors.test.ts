import {readFileSync,readdirSync} from 'node:fs'
import {expect,it} from 'vitest'
import {MEMORY_ERROR_CODES,memoryErrorText} from '../../src/shared/memory-errors.ts'
it('registers thrown memory codes and maps every public code to bounded Chinese text',()=>{
 const thrown=readdirSync('src/main').filter(f=>f.endsWith('.ts')).flatMap(f=>[...readFileSync('src/main/'+f,'utf8').matchAll(/(?:Error|throwError)\(['"](MEMORY_[A-Z_]+)/g)].map(m=>m[1]!))
 for(const code of thrown)expect(MEMORY_ERROR_CODES,code).toContain(code)
 for(const code of MEMORY_ERROR_CODES){expect(memoryErrorText(code)).toMatch(/[\u4e00-\u9fff]/);expect(memoryErrorText(code)).not.toContain(code)}
 expect(memoryErrorText('EIO /private/secret')).not.toContain('secret')
})

it('registers the material registry diagnosis with the refused control operations and a bounded next step',()=>{
 expect(MEMORY_ERROR_CODES).toContain('LEDGER_REGISTRY_INVALID');expect(memoryErrorText('LEDGER_REGISTRY_INVALID')).toContain('清空和推进学习进度已停止');expect(memoryErrorText('LEDGER_REGISTRY_INVALID')).toContain('请检查笔记库诊断或高级维护')
})
import {LEDGER_ERROR_CODES,ledgerErrorText} from '../../src/shared/ledger-errors.ts'
it('registers ledger recovery errors and keeps unknown diagnostics bounded',()=>{
 const thrown=readdirSync('src/main').filter(f=>f.endsWith('.ts')).flatMap(f=>[...readFileSync('src/main/'+f,'utf8').matchAll(/(?:Error|throwError)\(['"](LEDGER_[A-Z_]+)/g)].map(m=>m[1]!)).filter(code=>!['LEDGER_BOUNDARY_INVALID','LEDGER_PROVENANCE_LIMIT','LEDGER_BASIS_UNAVAILABLE'].includes(code)) // Existing Host and lifecycle contracts own these three codes.
 for(const code of thrown)expect(LEDGER_ERROR_CODES,code).toContain(code)
 for(const code of LEDGER_ERROR_CODES)expect(ledgerErrorText(code)).toMatch(/[\u4e00-\u9fff]/)
 expect(ledgerErrorText('private /secret/path')).not.toContain('/secret')
})
it('distinguishes an unregistered empty ledger from verified ownership',async()=>{
 const {ledgerEmptyText}=await import('../../src/shared/ledger-errors.ts')
 expect(ledgerEmptyText('unregistered')).toContain('尚未登记');expect(ledgerEmptyText('unregistered')).not.toContain('已核验')
 expect(ledgerEmptyText('verified')).toContain('已核验本篇归属')
})

it('explains output token, byte/proposal and queue limits separately from storage reserve exhaustion',()=>{
 for(const [code,reason] of [['MEMORY_OUTPUT_TOKEN_LIMIT','输出'],['MEMORY_OUTPUT_LIMIT','输出'],['MEMORY_QUEUE_FULL','队列']]){const text=memoryErrorText(code);expect(text).toContain(reason);expect(text).not.toMatch(/遗忘空间|修订计数|普通修改已暂停/);expect(text).toMatch(/重试|再试/)}expect(memoryErrorText('MEMORY_FILE_LIMIT')).toContain('遗忘空间')
})
