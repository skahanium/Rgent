#!/usr/bin/env node
// Explicit paid evaluation only. Ordinary tests/build/CI never invoke this entry.
import {build,loadConfigFromFile} from 'vite'
import {copyFileSync,mkdirSync,readFileSync,existsSync} from 'node:fs'
import {spawn} from 'node:child_process'
import {createRequire,builtinModules} from 'node:module'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {randomUUID} from 'node:crypto'
import {utilitySupervision} from './memory-quality-supervision.mjs'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),require=createRequire(import.meta.url)
const args=process.argv.slice(2).filter(a=>a!=='--'),value=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1]}
if(args.includes('--help')){console.log('pnpm memory:check [--live --profile PATH --models ID,ID --report PATH] [--pilot] [--only MiniMax-M3|deepseek-flash]\nCollaboration: --v6 --collaboration [--next|--utility-summary|--freeze|--live|--review|--utility TASK [--live|--utility-export|--review --annotation FILE [--double]]]\nV6: --v6 [--freeze|--diagnose|--live|--review [--double]|--replay|--publish MODEL|--stop MODEL|--resume MODEL|--hashes --only M --round 1|2 --cases ID] --round 1|2 --cases ID --annotation FILE --profile PATH --models ID,ID (no --screen; 180s attempt supervision)\nV5: --v5 [--freeze|--diagnose|--live|--review|--stop MODEL] --round 1|2 --cases ID --screen --annotation FILE\nV4: --experiment-v4 [--freeze|--diagnose|--live|--review|--stop MODEL] --cases ID (one pair) --screen --annotation FILE --profile PATH --models ID,ID --report PATH');process.exit(0)}
// Resolve before changing the child's cwd: Electron requires an absolute userData
// path, and report/profile/annotation/budget must refer to the caller's directory.
const pathValue=(name,fallback)=>{
 if(!args.includes(name))return fallback
 const raw=value(name)
 if(!raw||raw.startsWith('--')||!raw.trim()){console.error('EVALUATION_PATH_REQUIRED');process.exit(1)}
 return path.resolve(process.cwd(),raw)
}
const options={collaboration:args.includes('--collaboration'),utility:value('--utility'),utilityExport:args.includes('--utility-export'),utilitySummary:args.includes('--utility-summary'),next:args.includes('--next'),supervisionToken:randomUUID(),replay:args.includes('--replay'),publish:value('--publish'),v6:args.includes('--v6'),v5:args.includes('--v5'),round:Number(value('--round')??1)-1,v4:args.includes('--experiment-v4'),freeze:args.includes('--freeze'),diagnose:args.includes('--diagnose'),review:args.includes('--review'),stop:value('--stop'),resume:value('--resume'),hashes:args.includes('--hashes'),double:args.includes('--double'),annotation:pathValue('--annotation'),screen:args.includes('--screen'),cases:(value('--cases')??'').split(',').filter(Boolean),root,budget:pathValue('--budget',path.join(root,'.cache','memory-quality','2026-10-04')),live:args.includes('--live'),pilot:args.includes('--pilot'),only:value('--only'),profile:pathValue('--profile'),models:(value('--models')??'').split(',').filter(Boolean),report:pathValue('--report',path.join(root,'out','memory-quality-report'))}
if(value('--budget')&&(options.live||options.freeze||options.diagnose||options.publish)){console.error('EVALUATION_BUDGET_OVERRIDE_NOT_AUTHORIZED');process.exit(1)}
if((options.collaboration||options.utility||options.utilityExport||options.utilitySummary||options.next)&&!options.v6||options.utility&&!options.collaboration||options.utilityExport&&!options.utility||options.utility&&(options.freeze||options.publish||options.replay||options.cases.length)||options.collaboration&&options.publish||options.utilitySummary&&(options.live||options.freeze||options.annotation||options.utility)){console.error('EVALUATION_MODE_CONFLICT');process.exit(1)}
if(options.v5&&options.v4||options.v6&&(options.v4||options.v5)){console.error('EVALUATION_MODE_CONFLICT');process.exit(1)}
if(options.replay&&(options.live||options.publish||options.freeze||options.annotation)){console.error('EVALUATION_REPLAY_READ_ONLY');process.exit(1)}
// v6 无付费筛查：试卷按 30 次尝试冻结，任何 --screen 组合都在启动子进程前拒绝。
if(options.v6&&options.screen){console.error('EVALUATION_SCREEN_NOT_AUTHORIZED');process.exit(1)}
// v6 每次只跑一个案例、只接受 1|2 两轮；转换到内部 0|1 与 v5 口径一致。
if(options.v6&&options.cases.length>1){console.error('EVALUATION_ONE_ATTEMPT_REQUIRED');process.exit(1)}
if(options.v6&&value('--round')!==undefined&&!['1','2'].includes(value('--round'))){console.error('EVALUATION_ROUND_INVALID');process.exit(1)}
if(options.only&&!['MiniMax-M3','deepseek-flash'].includes(options.only)){console.error('EVALUATION_MODELS_NOT_AUTHORIZED');process.exit(1)}
if((options.live||options.freeze||options.diagnose)&&(!options.profile||!options.models.length)){console.error('Explicit profile and model record IDs required.');process.exit(1)}
if(options.v6&&!options.freeze&&(options.live||options.review||options.replay||options.publish||options.stop||options.resume||options.hashes||options.utility||options.utilitySummary||options.next)&&!existsSync(path.join(options.report,'v6-manifest.json'))){console.error('EVALUATION_FREEZE_REQUIRED');process.exit(1)}
mkdirSync(options.report,{recursive:true,mode:0o700})
const out=path.join(root,'out','memory-evaluation'),pkg=JSON.parse(readFileSync(path.join(root,'package.json'),'utf8'))
const productionConfig=await loadConfigFromFile({command:'build',mode:'production'},path.join(root,'electron.vite.config.ts'))
await build({define:productionConfig.config.main.define,configFile:false,logLevel:'error',build:{outDir:out,emptyOutDir:true,target:'node22',minify:false,lib:{entry:path.join(root,'scripts','memory-quality-electron.ts'),formats:['es'],fileName:()=> 'evaluation.mjs'},rollupOptions:{external:['electron',...Object.keys(pkg.dependencies),...builtinModules,...builtinModules.map(n=>'node:'+n)]}}})
copyFileSync(path.join(root,'build/Release/rgent_fs.node'),path.join(out,'rgent_fs.node'))
const child=spawn(require('electron'),[path.join(out,'evaluation.mjs')],{cwd:root,stdio:['inherit','pipe','inherit'],env:{...process.env,ELECTRON_RUN_AS_NODE:undefined,RGENT_MEMORY_EVAL_OPTIONS:JSON.stringify(options)}})
let startupText=''
const startupTimer=setTimeout(()=>{console.error('EVALUATION_STARTUP_TIMEOUT');child.kill('SIGTERM')},30000)
// v6 单次尝试的独立硬超时：180000 与 scripts/memory-quality-support.ts 的 V6_RULES.supervisionMs 同值，
// 与整理自身 120 秒期限分列。10 秒宽限后才 SIGKILL；子进程退出时两个计时器一并清理。
const supervisionMs=180000,supervisionGraceMs=10000
let supervisionTimer,killTimer
const boundary=utilitySupervision(options.supervisionToken)
const supervise=()=>{if(supervisionTimer)clearTimeout(supervisionTimer);supervisionTimer=setTimeout(()=>{console.error('EVALUATION_ATTEMPT_TIMEOUT');child.kill('SIGTERM');killTimer=setTimeout(()=>child.kill('SIGKILL'),supervisionGraceMs)},supervisionMs)}
let boundaryText=''
const clearTimers=()=>{clearTimeout(startupTimer);if(supervisionTimer)clearTimeout(supervisionTimer);if(killTimer)clearTimeout(killTimer)}
child.stdout.on('data',chunk=>{process.stdout.write(chunk);startupText=(startupText+chunk).slice(-1024)
 if(startupText.includes('EVALUATION_READY')){clearTimeout(startupTimer);if(options.v6&&!supervisionTimer)supervise()}
 if(options.utility&&options.live){boundaryText+=chunk;const lines=boundaryText.split('\n');boundaryText=lines.pop()??'';if(boundaryText.length>65536)boundaryText=''
  for(const line of lines){let value;try{value=JSON.parse(line)}catch{continue}try{if(boundary(value))supervise()}catch(error){console.error(error.message);child.kill('SIGTERM')}}
 }
})
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal))
child.on('error',()=>{clearTimers();process.exitCode=1});child.on('exit',(code)=>{clearTimers();process.exitCode=code??1})
