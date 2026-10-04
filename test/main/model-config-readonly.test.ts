import {mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {afterEach,expect,it} from 'vitest'
import * as config from '../../src/main/model-config.ts'
const dirs:string[]=[]
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true})})
const protection={isEncryptionAvailable:()=>true,encryptString:(s:string)=>Buffer.from(s),decryptString:(b:Buffer)=>b.toString()}
it('loads an explicitly selected credential without migrating old memory fields or opening memory configuration',()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'rgent-readonly-'));dirs.push(root)
 const store=config.createModelConfigStore(root,protection)
 store.saveProvider({provider:'custom',baseURL:'https://fiction.test/v1',modelId:'fiction',contextTokens:32768},'private-key')
 const id=store.getPublic().models.find(m=>m.provider==='custom')!.id
 const file=path.join(root,'model-config.json'),raw=JSON.parse(readFileSync(file,'utf8'));raw.memory={old:true}
 writeFileSync(file,JSON.stringify(raw));writeFileSync(path.join(root,'memory-config.json'),'{broken')
 const before=readdirSync(root).map(f=>[f,readFileSync(path.join(root,f),'utf8')])
 expect(typeof config.loadModelCredentialReadOnly).toBe('function')
 expect(config.loadModelCredentialReadOnly(root,protection,id)).toMatchObject({modelId:'fiction',apiKey:'private-key'})
 expect(readdirSync(root).map(f=>[f,readFileSync(path.join(root,f),'utf8')])).toEqual(before)
 expect(()=>config.loadModelCredentialReadOnly(root,protection,'missing')).toThrow('MODEL_NOT_FOUND')
 expect(()=>config.loadModelCredentialReadOnly(root,{...protection,isEncryptionAvailable:()=>false},id)).toThrow('ENCRYPTION_UNAVAILABLE')
})
