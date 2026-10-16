// Portable qualification of Codiluce's source-only compiler address space.
import assert from 'node:assert/strict';
import {after,mock,test as registerTest} from 'node:test';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {serialize} from 'node:v8';
import {fileURLToPath} from 'node:url';
const sourceRoot=new URL(process.argv[2]);assert.equal(sourceRoot.protocol,'file:');assert.ok(sourceRoot.pathname.endsWith('/'));
const {isolatedTypescriptAnalyzer,runTypeScriptWorker,typeScriptWorkerRequest,TypeScriptWorkerError}=await import(new URL('analyzers/typescript-isolated.js',sourceRoot));
const {TYPESCRIPT_WORKER_LIMITS}=await import(new URL('analyzers/ts-worker-protocol.js',sourceRoot));
const {typescriptAnalyzer}=await import(new URL('analyzers/typescript.js',sourceRoot));
const {filesystemAnalyzer}=await import(new URL('analyzers/filesystem.js',sourceRoot));
const {projectAnalyzer}=await import(new URL('analysis/project-model.js',sourceRoot));
const {embeddedAnalyzer,EmbeddedSources}=await import(new URL('analysis/embedded/index.js',sourceRoot));
const {resolveConfig}=await import(new URL('core/config.js',sourceRoot));
const {GraphBuilder}=await import(new URL('core/graph.js',sourceRoot));
const {AnalysisCache,applyGraphPatch}=await import(new URL('pipeline/cache.js',sourceRoot));
const {indexRepository}=await import(new URL('pipeline/index.js',sourceRoot));
const {canonicalJson}=await import(new URL('history/fingerprint.js',sourceRoot));
const control=fileURLToPath(new URL('./typescript-worker-control.mjs',import.meta.url)),roots=[],completedCases=[],observations=[];
function test(name,work){registerTest(name,async()=>{await work();completedCases.push(name);});}
const same=graph=>canonicalJson({...graph,run:{...graph.run,id:'',analyzedAt:''}});
const shape=context=>canonicalJson({entities:[...context.graph.entities.values()],relations:[...context.graph.relations.values()],diagnostics:[...context.graph.diagnostics.values()],http:context.http});
async function fixture(files={'main.ts':'// é😀 original\r\nexport function original(value:string){return value.length;}\r\nthrow new Error("Target never executes");'},name='Owned bounded compiler'){
 const root=await mkdtemp(path.join(tmpdir(),'codiluce-ts-worker-'));roots.push(root);
 for(const [file,text]of Object.entries(files)){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),text);}
 const config=await resolveConfig(root,{repository:{name}}),graph=new GraphBuilder(config.repository.name),context={root,config,graph,repositoryId:graph.id('repository'),applicationIds:new Map(),files:new Map(),http:[],sourceReads:new Set()};
 for(const analyzer of [filesystemAnalyzer,projectAnalyzer,embeddedAnalyzer])await analyzer.analyze(context);
 return context;
}
function forks(){const children=[],original=cp.fork,observer=mock.method(cp,'fork',(...args)=>{const child=original(...args);children.push({child,options:args[2],file:String(args[0])});return child;});syncBuiltinESMExports();return {children,restore(){observer.mock.restore();syncBuiltinESMExports();}};}
function retired(pid){try{process.kill(pid,0);}catch{return true;}if(process.platform==='linux'){try{const stat=readFileSync(`/proc/${pid}/stat`,'utf8'),state=stat.slice(stat.lastIndexOf(')')+2).split(' ')[0];return state==='Z'||state==='X';}catch{return true;}}return false;}
test('Default compiler worker applies fixed heap flags, ignores caller startup options, reaps its process and returns only original-input facts',async()=>{
 const context=await fixture(),request=typeScriptWorkerRequest(context),observation=forks(),prior=process.env.NODE_OPTIONS,priorPath=process.env.NODE_PATH;
 try{
  process.env.NODE_OPTIONS='--unknown-codiluce-owned-control-option';process.env.NODE_PATH='/owned-denied-dependency-search';
  const result=await runTypeScriptWorker(request);assert.equal(result.usage.heapLimitBytes,(2048+3*16)*1024*1024);assert.ok(result.usage.heapUsedBytes>0&&result.usage.heapUsedBytes<result.usage.heapLimitBytes);
  assert.equal(observation.children.length,1);const {child,options}=observation.children[0];assert.equal(child.exitCode,0);assert.equal(child.signalCode,null);assert.ok(retired(child.pid));assert.deepEqual(options.execArgv.slice(0,2),['--max-old-space-size=2048','--max-semi-space-size=16']);assert.equal(options.env.NODE_OPTIONS,undefined);assert.equal(options.env.NODE_PATH,undefined);assert.ok(!options.execArgv.some(arg=>arg==='--test'||arg==='--watch'));assert.deepEqual(result.typescriptFiles,['main.ts']);assert.ok(result.sourceReads.includes('main.ts'));assert.ok(result.patch.entities.some(entity=>entity.name==='original'));assert.equal(context.typescript,undefined);observations.push({kind:'default-worker',...result.usage,actualExit:child.exitCode,flags:options.execArgv,originalInputs:result.typescriptFiles});
 }finally{if(prior===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=prior;if(priorPath===undefined)delete process.env.NODE_PATH;else process.env.NODE_PATH=priorPath;observation.restore();}
});
test('Embedded recipe transfer preserves original UTF-16 regions, module/setup shadowing, facades and exact virtual bytes without materialized text ownership',async()=>{
 const context=await fixture({'Pair.vue':'<script lang="ts">export function shared(){return "é😀"}</script>\r\n<script setup lang="ts">function caller(){return shared()}</script>\r\n<div>{{caller()}}</div>'}),before=context.embedded,wire=structuredClone(before.snapshot()),after=EmbeddedSources.fromSnapshot(context,wire),file=context.files.get('Pair.vue');
 assert.deepEqual(after.snapshot(),wire);assert.equal(after.memoStats().entries,0);assert.ok(wire.recipes.every(recipe=>!('text'in recipe)));assert.deepEqual(after.facts,before.facts);assert.deepEqual(after.inputs(file),before.inputs(file));
 for(const input of before.inputs(file))assert.equal(after.readFile(input.absolutePath),before.readFile(input.absolutePath));assert.equal(after.facade(file.absolutePath),before.facade(file.absolutePath));assert.equal(after.readFile(after.facade(file.absolutePath)),before.readFile(before.facade(file.absolutePath)));
});
test('Complete default cold/warm/revision graphs preserve cross-project original handlers, calls, HTTP effect aliases and independent compilation scopes',async()=>{
 const files={'package.json':JSON.stringify({workspaces:['server','shared','other','ui']}),'server/package.json':JSON.stringify({name:'server',dependencies:{express:'5.1.0',shared:'workspace:*'}}),'server/main.ts':'import express from "express";import {original} from "shared";const app=express();app.get("/one",original);app.listen(3000);','shared/package.json':'{"name":"shared","main":"source.ts"}','shared/source.ts':'// é😀\r\nexport function original(req,res){return leaf()}\r\nfunction leaf(){return 1}\r\nthrow new Error("Target never executes");','other/package.json':'{"name":"other","dependencies":{"express":"5.1.0"}}','other/main.ts':'import express from "express";const app=express();function independent(){return absentGlobal()}app.get("/two",independent);','ui/package.json':'{"name":"ui","dependencies":{"vue":"3.5.0","svelte":"5.57.2","astro":"7.0.0"}}','ui/View.vue':'<script setup lang="ts">async function original(){return fetch("/one")}</script><button @click="original">Read é😀</button>','ui/View.svelte':'<script>async function original(){return fetch("/one")}</script><button onclick={original}>Read é😀</button>','ui/Page.astro':'---\nasync function original(){return fetch("/one")}\n---\n<div>é😀</div>','ui/globals.ts':'function absentGlobal(){return 1;}'};
 const context=await fixture(files,'Owned compiler whole parity'),config=context.config,revision='e'.repeat(40),reference=mock.method(isolatedTypescriptAnalyzer,'analyze',async context=>{if(context.embeddedPreparationPending)await embeddedAnalyzer.analyze(context);await typescriptAnalyzer.analyze(context);});let coldReference,revisionReference;
 try{coldReference=await indexRepository(context.root,{config});revisionReference=await indexRepository(context.root,{config,revision});}finally{reference.mock.restore();}
 const events=[],cache=new AnalysisCache(path.join(context.root,'.codiluce/cache'),undefined,event=>events.push(event)),cold=await indexRepository(context.root,{config,cache}),warm=await indexRepository(context.root,{config,cache}),atRevision=await indexRepository(context.root,{config,revision});assert.equal(same(cold),same(coldReference));assert.equal(same(warm),same(coldReference));assert.equal(same(atRevision),same(revisionReference));assert.deepEqual(events,cache.events);assert.ok(events.some(event=>event.analyzer==='typescript-nextjs'&&event.hit));
 const endpoint=cold.entities.find(entity=>entity.type==='api_endpoint'&&entity.name==='GET /one'),handler=cold.entities.find(entity=>entity.name==='original'&&entity.path==='shared/source.ts'),leaf=cold.entities.find(entity=>entity.name==='leaf'&&entity.path==='shared/source.ts'),global=cold.entities.find(entity=>entity.name==='absentGlobal'&&entity.path==='ui/globals.ts'),independent=cold.entities.find(entity=>entity.name==='independent');assert.ok(endpoint&&handler&&leaf&&global&&independent);assert.equal(handler.sourceRange.startLine,2);assert.ok(cold.relations.some(relation=>relation.type==='handles'&&relation.from===endpoint.id&&relation.to===handler.id));assert.ok(cold.relations.some(relation=>relation.type==='calls'&&relation.from===handler.id&&relation.to===leaf.id));assert.ok(!cold.relations.some(relation=>relation.type==='calls'&&relation.from===independent.id&&relation.to===global.id));assert.ok(cold.entities.some(entity=>Array.isArray(entity.metadata.effects)&&entity.metadata.effects.some(effect=>effect.category==='network')));
 for(const [file,text]of Object.entries(files))assert.equal(await readFile(path.join(context.root,file),'utf8'),text);observations.push({kind:'whole-parity',comparisons:3,entities:cold.entities.length,relations:cold.relations.length,diagnostics:cold.diagnostics.length,sourceFiles:Object.keys(files).length,normalization:['run.id','run.analyzedAt']});
});
test('A changed indexed original produces explicit source failure and cannot become a reusable healthy TypeScript cache entry',async()=>{
 const context=await fixture({'package.json':'{"dependencies":{"express":"5.1.0"}}','main.ts':'import express from "express";const app=express();function original(){}app.get("/one",original);'});context.cache=new AnalysisCache(path.join(context.root,'.codiluce/cache'));await writeFile(path.join(context.root,'main.ts'),'export function fabricated(){}');await isolatedTypescriptAnalyzer.analyze(context);assert.ok([...context.graph.diagnostics.values()].some(item=>item.code==='indexed-source-unavailable'&&item.file==='main.ts'));assert.ok(![...context.graph.entities.values()].some(entity=>entity.name==='fabricated'||entity.name==='original'));assert.ok(!context.cache.events.some(event=>event.analyzer==='typescript-nextjs'));let entries=[];try{entries=await readdir(context.cache.directory);}catch(error){assert.equal(error.code,'ENOENT');}assert.ok(!entries.some(file=>file.startsWith('typescript-nextjs.')));
});
test('An unsupported framework registry rejects the worker without parent graph, HTTP or cache mutation and has no unbounded fallback',async()=>{
 const context=await fixture(),before=shape(context),request=typeScriptWorkerRequest(context);request.packs.push(['owned-unregistered-pack','1']);await assert.rejects(runTypeScriptWorker(request),/Unsupported TypeScript worker or framework registry/);assert.equal(shape(context),before);assert.equal(context.typescript,undefined);
});
test('Invalid and oversized request budgets reject before launching any worker',async()=>{
 const context=await fixture(),request=typeScriptWorkerRequest(context),before=shape(context),observation=forks();try{for(const value of [0,-1,NaN,1.5,Infinity])await assert.rejects(runTypeScriptWorker(request,{oldSpaceMiB:value}),/positive safe integers/);await assert.rejects(runTypeScriptWorker(request,{maxMessageBytes:16}),/input exceeds 16 bytes/);assert.equal(observation.children.length,0);assert.equal(shape(context),before);}finally{observation.restore();}
});
test('Wrong protocols, duplicate messages, late failed exits and oversized responses all reject after actual worker retirement',async()=>{
 for(const mode of ['wrong-protocol','duplicate-response','result-then-nonzero','unexpected-exit','oversized-response']){
  const context=await fixture({'main.ts':'export function original(){}'},mode),request=typeScriptWorkerRequest(context),before=shape(context),options={worker:control,maxMessageBytes:serialize(request).length+1},observation=forks();let failure;
  try{await runTypeScriptWorker(request,options);}catch(error){failure=error;}finally{observation.restore();}
  assert.ok(failure instanceof TypeScriptWorkerError);assert.equal(observation.children.length,1);assert.ok(observation.children[0].child.exitCode!==null||observation.children[0].child.signalCode!==null);assert.ok(retired(failure.pid));assert.equal(shape(context),before);if(mode==='result-then-nonzero')assert.equal(failure.code,23);if(mode==='unexpected-exit')assert.equal(failure.code,17);if(mode==='oversized-response')assert.match(failure.message,/output exceeds/);observations.push({kind:'transport-rejection',mode,pid:failure.pid,actualExit:failure.code,signal:failure.signal});
 }
});
test('A successful response remains unpublished until the worker actually exits',async()=>{
 const context=await fixture({'main.ts':'export function original(){}'},'delayed-exit'),observation=forks();let settled=false,messageWhileRunning=false;
 try{const promise=runTypeScriptWorker(typeScriptWorkerRequest(context),{worker:control}).then(result=>{settled=true;return result;});const child=observation.children[0].child;child.on('message',()=>{assert.equal(child.exitCode,null);assert.equal(settled,false);messageWhileRunning=true;});await promise;assert.ok(messageWhileRunning);assert.equal(child.exitCode,0);assert.ok(retired(child.pid));}finally{observation.restore();}
});
test('Actual compiler heap exhaustion rejects a whole component while the parent graph, HTTP and failed component cache stay untouched',async()=>{
 const text='export const original={'+Array.from({length:200000},()=>`p:1`).join(',')+'};\nthrow new Error("Target never executes");',context=await fixture({'tsconfig.json':'{"compilerOptions":{"noLib":true}}','original.ts':text}),before=shape(context);assert.ok(Buffer.byteLength(text)<context.config.maxFileBytes);assert.ok(context.files.get('original.ts').analyzable);context.cache=new AnalysisCache(path.join(context.root,'.codiluce/cache'));const request=typeScriptWorkerRequest(context);let failure;
 try{await runTypeScriptWorker(request,{oldSpaceMiB:96});}catch(error){failure=error;}
 assert.ok(failure instanceof TypeScriptWorkerError);assert.equal(failure.signal,'SIGABRT');assert.match(failure.stderr,/heap out of memory|Reached heap limit/);assert.ok(retired(failure.pid));assert.equal(shape(context),before);assert.equal(context.cache.events.length,0);assert.equal(await readFile(path.join(context.root,'original.ts'),'utf8'),text);let entries=[];try{entries=await readdir(context.cache.directory);}catch(error){assert.equal(error.code,'ENOENT');}assert.ok(!entries.some(file=>file.startsWith('typescript-nextjs.')));observations.push({kind:'authored-lower-heap-compiler-control',oldSpaceMiB:96,pid:failure.pid,actualExit:failure.code,signal:failure.signal,originalBytes:Buffer.byteLength(text),originalSha256:createHash('sha256').update(text).digest('hex'),parentGraphUnchanged:true,failedComponentStored:false});
});
test('Fatal owner exit retires its reported parser child before the failure reaches the caller',async()=>{
 const context=await fixture({'main.ts':'export function original(){}'},'owned-child-fatal-exit');let failure;try{await runTypeScriptWorker(typeScriptWorkerRequest(context),{worker:control});}catch(error){failure=error;}assert.ok(failure instanceof TypeScriptWorkerError);assert.equal(failure.code,19);const pid=Number(/owned-child-pid:(\d+)/.exec(failure.stderr)?.[1]);assert.ok(pid>0);assert.ok(retired(pid));assert.ok(retired(failure.pid));observations.push({kind:'fatal-owner-child-retirement',parent:failure.pid,child:pid,actualExit:failure.code,addressSpacesRetired:true,platform:process.platform});
});
test('Owning process exit and default shutdown signals terminate outstanding compiler work',async()=>{
 for(const mode of ['exit','SIGTERM']){
  const owner=cp.fork(new URL('./typescript-worker-owner.mjs',import.meta.url),[sourceRoot.href],{execArgv:process.execArgv,stdio:['ignore','ignore','pipe','ipc']});let workerPid;
  const closed=new Promise(resolve=>owner.once('close',(code,signal)=>resolve({code,signal})));
  await new Promise((resolve,reject)=>{owner.once('error',reject);owner.once('message',message=>{workerPid=message.workerPid;resolve();});});
  if(mode==='exit')owner.send('exit');else owner.kill(mode);
  const terminal=await closed;assert.ok(workerPid>0);if(mode==='exit')assert.equal(terminal.code,31);else assert.equal(terminal.signal,'SIGTERM');
  const deadline=performance.now()+2000;while(!retired(workerPid)&&performance.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(retired(workerPid));observations.push({kind:'owner-shutdown',mode,ownerPid:owner.pid,workerPid,...terminal,addressSpacesRetired:true});
 }
});
test('Malformed graph patches with dangling output or duplicate identities cannot partially mutate the parent graph',async()=>{
 const context=await fixture(),before=shape(context),base={entities:[],patches:[],relations:[],merged:[],diagnostics:[],http:[]};for(const patch of [{...base,diagnostics:[{id:'owned',entityId:'missing'}]},{...base,http:[{callerId:context.repositoryId,fileId:'missing',expression:'owned'}]},{...base,entities:[{id:'duplicate',type:'file',metadata:{},evidence:[]},{id:'duplicate',type:'file',metadata:{},evidence:[]}]}]){assert.equal(applyGraphPatch(context,patch),false);assert.equal(shape(context),before);}
});
after(async()=>{
 const result={schema:1,passed:completedCases.length===12,caseCount:12,completedCases,sourceRoot:sourceRoot.href,typescriptSourceLoader:process.execArgv.some(arg=>/tsx/.test(arg)),platform:process.platform,node:process.version,limits:TYPESCRIPT_WORKER_LIMITS,observations,targetExecution:false,scope:'Default indexer TypeScript old-space and bounded IPC isolation, graph/cache/revision parity, parser retirement, owner shutdown and rejection atomicity. Lower-heap authored control is separate from default-budget and total RSS qualification.'};
 if(process.argv[3])await writeFile(process.argv[3],JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
 if(result.passed)for(const root of roots)await rm(root,{recursive:true,force:true});else console.error('Retained worker qualification fixture roots:',roots);
});
