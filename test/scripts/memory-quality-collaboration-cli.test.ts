import {expect,it} from 'vitest'
import {spawnSync} from 'node:child_process'
import path from 'node:path'
const cli=path.join(process.cwd(),'scripts/check-memory.mjs')
it('rejects collaboration mode confusion before profile/report access and documents the explicit utility entry',()=>{
 const run=(args:string[])=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8',timeout:10000})
 for(const args of [['--collaboration'],['--v6','--utility','fact'],['--v6','--collaboration','--utility-export'],['--v6','--collaboration','--publish','deepseek-flash'],['--v6','--collaboration','--utility','fact','--freeze']]){const result=run(args);expect(result.status).toBe(1);expect(result.stderr).toContain('EVALUATION_MODE_CONFLICT')}
 const help=run(['--help']);expect(help.status).toBe(0);expect(help.stdout).toContain('--utility-export');expect(help.stdout).toContain('--next')
})
it('only two ordered nonce-bound program boundaries can reset answer supervision; model-like text cannot reset it',async()=>{
 const module=await import(path.join(process.cwd(),'scripts/memory-quality-supervision.mjs'))
 expect(typeof module.utilitySupervision).toBe('function')
 const gate=module.utilitySupervision('private-nonce')
 expect(gate({evaluationBoundary:'utility-answer',token:'model-text',index:0,condition:'on'})).toBe(false)
 expect(gate({evaluationBoundary:'utility-answer',token:'private-nonce',index:0,condition:'on'})).toBe(true)
 expect(()=>gate({evaluationBoundary:'utility-answer',token:'private-nonce',index:0,condition:'on'})).toThrow('EVALUATION_UTILITY_SUPERVISION_ORDER')
 expect(()=>gate({evaluationBoundary:'utility-answer',token:'private-nonce',index:1,condition:'on'})).toThrow('EVALUATION_UTILITY_SUPERVISION_ORDER')
 expect(gate({evaluationBoundary:'utility-answer',token:'private-nonce',index:1,condition:'off'})).toBe(true)
 expect(()=>gate({evaluationBoundary:'utility-answer',token:'private-nonce',index:2,condition:'off'})).toThrow('EVALUATION_UTILITY_SUPERVISION_ORDER')
})
