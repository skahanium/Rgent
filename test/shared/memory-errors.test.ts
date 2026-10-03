import {readFileSync,readdirSync} from 'node:fs'
import {expect,it} from 'vitest'
import {MEMORY_ERROR_CODES,memoryErrorText} from '../../src/shared/memory-errors.ts'
it('registers thrown memory codes and maps every public code to bounded Chinese text',()=>{
 const thrown=readdirSync('src/main').filter(f=>f.endsWith('.ts')).flatMap(f=>[...readFileSync('src/main/'+f,'utf8').matchAll(/(?:Error|throwError)\(['"](MEMORY_[A-Z_]+)/g)].map(m=>m[1]!))
 for(const code of thrown)expect(MEMORY_ERROR_CODES,code).toContain(code)
 for(const code of MEMORY_ERROR_CODES){expect(memoryErrorText(code)).toMatch(/[\u4e00-\u9fff]/);expect(memoryErrorText(code)).not.toContain(code)}
 expect(memoryErrorText('EIO /private/secret')).not.toContain('secret')
})
