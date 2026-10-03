import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs'
import os from 'node:os';import path from 'node:path'
import {it,expect} from 'vitest'
import {ReasoningStore} from '../../src/main/reasoning-store.ts'
it('bounds device-only reasoning without splitting UTF-8 and expires it independently',()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'rgent-reasoning-')),key='a'.repeat(64),store=new ReasoningStore(dir)
 try{store.write(key,'task','中文🙂'.repeat(10000));const text=store.read(key,'task')!;expect(Buffer.byteLength(text)).toBeLessThanOrEqual(32768);expect(text).not.toContain('�');const file=path.join(dir,key,'task.json'),v=JSON.parse(readFileSync(file,'utf8'));writeFileSync(file,JSON.stringify({...v,createdAt:Date.now()-8*86400000}));expect(store.read(key,'task')).toBeNull()}finally{rmSync(dir,{recursive:true,force:true})}
})
