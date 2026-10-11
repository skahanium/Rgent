#!/usr/bin/env node
// Explicit paid protocol-stripped probe only. Ordinary tests/build/CI never invoke this entry.
// 用法：pnpm probe:check -- --profile <应用数据目录> --models <id,id> [--cases a,b] [--limit 16] [--print-prompts]
import {build,loadConfigFromFile} from 'vite'
import {copyFileSync,mkdirSync,readFileSync} from 'node:fs'
import {spawn} from 'node:child_process'
import {createRequire,builtinModules} from 'node:module'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),require=createRequire(import.meta.url)
const args=process.argv.slice(2).filter(a=>a!=='--'),value=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1]}
if(args.includes('--help')||args.includes('-h')){
 console.log('pnpm probe:check -- --profile PATH --models RECORD_ID,RECORD_ID [--report PATH] [--cases ID,ID] [--limit 16] [--print-prompts]')
 console.log('协议剥离对照探针（方案 C）：同一批虚构材料、同一句提问，不给 JSON 协议与字段清单。')
 console.log('--print-prompts 只打印题面与将发生的调用次数，不发生任何调用。')
 process.exit(0)
}
const pathValue=(name,fallback)=>{
 if(!args.includes(name))return fallback
 const raw=value(name)
 if(!raw||raw.startsWith('--')||!raw.trim()){console.error('PROBE_PATH_REQUIRED');process.exit(1)}
 return path.resolve(process.cwd(),raw)
}
const options={
 root,
 profile:pathValue('--profile'),
 report:pathValue('--report',path.join(root,'.cache','memory-quality','2026-10-11-probe')),
 models:(value('--models')??'').split(',').filter(Boolean),
 cases:(value('--cases')??'').split(',').filter(Boolean),
 limit:Number(value('--limit')??16),
 printPrompts:args.includes('--print-prompts')
}
if(!options.profile||!options.models.length){console.error('Explicit profile and model record IDs required.');process.exit(1)}
if(!Number.isSafeInteger(options.limit)||options.limit<1||options.limit>16){console.error('PROBE_CALL_LIMIT');process.exit(1)}
mkdirSync(options.report,{recursive:true,mode:0o700})
const out=path.join(root,'out','memory-probe'),pkg=JSON.parse(readFileSync(path.join(root,'package.json'),'utf8'))
const productionConfig=await loadConfigFromFile({command:'build',mode:'production'},path.join(root,'electron.vite.config.ts'))
await build({define:productionConfig.config.main.define,configFile:false,logLevel:'error',build:{outDir:out,emptyOutDir:true,target:'node22',minify:false,lib:{entry:path.join(root,'scripts','memory-protocol-probe.ts'),formats:['es'],fileName:()=> 'probe.mjs'},rollupOptions:{external:['electron',...Object.keys(pkg.dependencies),...builtinModules,...builtinModules.map(n=>'node:'+n)]}}})
copyFileSync(path.join(root,'build/Release/rgent_fs.node'),path.join(out,'rgent_fs.node'))
const child=spawn(require('electron'),[path.join(out,'probe.mjs')],{cwd:root,stdio:['inherit','pipe','inherit'],env:{...process.env,ELECTRON_RUN_AS_NODE:undefined,RGENT_PROBE_OPTIONS:JSON.stringify(options)}})
const startupTimer=setTimeout(()=>{console.error('PROBE_STARTUP_TIMEOUT');child.kill('SIGTERM')},60000)
// 单例硬超时：每例最多 120 秒模型请求，串行 12 例留 15 分钟总门。
const totalTimer=setTimeout(()=>{console.error('PROBE_TOTAL_TIMEOUT');child.kill('SIGTERM')},900000)
const clearTimers=()=>{clearTimeout(startupTimer);clearTimeout(totalTimer)}
child.stdout.on('data',chunk=>{process.stdout.write(chunk)})
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal))
child.on('error',()=>{clearTimers();process.exitCode=1})
child.on('exit',code=>{clearTimers();process.exitCode=code??1})
