#!/usr/bin/env node
// Explicit paid evaluation only. Ordinary tests/build/CI never invoke this entry.
import {build} from 'vite'
import {copyFileSync,mkdirSync,readFileSync} from 'node:fs'
import {spawn} from 'node:child_process'
import {createRequire,builtinModules} from 'node:module'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),require=createRequire(import.meta.url)
const args=process.argv.slice(2).filter(a=>a!=='--'),value=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1]}
if(args.includes('--help')){console.log('pnpm memory:check [--live --profile PATH --models ID,ID --report PATH] [--pilot] [--only MiniMax-M3|deepseek-flash]\nV5: --v5 [--freeze|--diagnose|--live|--review|--stop MODEL] --round 1|2 --cases ID --screen --annotation FILE\nV4: --experiment-v4 [--freeze|--diagnose|--live|--review|--stop MODEL] --cases ID (one pair) --screen --annotation FILE --profile PATH --models ID,ID --report PATH');process.exit(0)}
const options={v5:args.includes('--v5'),round:Number(value('--round')??1)-1,v4:args.includes('--experiment-v4'),freeze:args.includes('--freeze'),diagnose:args.includes('--diagnose'),review:args.includes('--review'),stop:value('--stop'),annotation:value('--annotation'),screen:args.includes('--screen'),cases:(value('--cases')??'').split(',').filter(Boolean),root,budget:path.join(root,'.cache','memory-quality','2026-10-04'),live:args.includes('--live'),pilot:args.includes('--pilot'),only:value('--only'),profile:value('--profile'),models:(value('--models')??'').split(',').filter(Boolean),report:value('--report')??path.join(root,'out','memory-quality-report')}
if(options.v5&&options.v4){console.error('EVALUATION_MODE_CONFLICT');process.exit(1)}
if(options.only&&!['MiniMax-M3','deepseek-flash'].includes(options.only)){console.error('EVALUATION_MODELS_NOT_AUTHORIZED');process.exit(1)}
if((options.live||options.freeze||options.diagnose)&&(!options.profile||!options.models.length)){console.error('Explicit profile and model record IDs required.');process.exit(1)}
mkdirSync(options.report,{recursive:true,mode:0o700})
const out=path.join(root,'out','memory-evaluation'),pkg=JSON.parse(readFileSync(path.join(root,'package.json'),'utf8'))
await build({configFile:false,logLevel:'error',build:{outDir:out,emptyOutDir:true,target:'node22',minify:false,lib:{entry:path.join(root,'scripts','memory-quality-electron.ts'),formats:['es'],fileName:()=> 'evaluation.mjs'},rollupOptions:{external:['electron',...Object.keys(pkg.dependencies),...builtinModules,...builtinModules.map(n=>'node:'+n)]}}})
copyFileSync(path.join(root,'build/Release/rgent_fs.node'),path.join(out,'rgent_fs.node'))
const child=spawn(require('electron'),[path.join(out,'evaluation.mjs')],{cwd:root,stdio:['inherit','pipe','inherit'],env:{...process.env,ELECTRON_RUN_AS_NODE:undefined,RGENT_MEMORY_EVAL_OPTIONS:JSON.stringify(options)}})
let startupText=''
const startupTimer=setTimeout(()=>{console.error('EVALUATION_STARTUP_TIMEOUT');child.kill('SIGTERM')},30000)
child.stdout.on('data',chunk=>{process.stdout.write(chunk);startupText=(startupText+chunk).slice(-1024);if(startupText.includes('EVALUATION_READY'))clearTimeout(startupTimer)})
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal))
child.on('error',()=>{clearTimeout(startupTimer);process.exitCode=1});child.on('exit',(code)=>{clearTimeout(startupTimer);process.exitCode=code??1})
