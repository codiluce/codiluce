// Owned preparation fault: original scripts never execute.
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,readdir,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
const sourceRoot=new URL(process.argv[2]);
const {filesystemAnalyzer}=await import(new URL('analyzers/filesystem.js',sourceRoot));
const {projectAnalyzer}=await import(new URL('analysis/project-model.js',sourceRoot));
const {isolatedEmbeddedAnalyzer,typeScriptWorkerRequest,runTypeScriptWorker,TypeScriptWorkerError}=await import(new URL('analyzers/typescript-isolated.js',sourceRoot));
const {resolveConfig}=await import(new URL('core/config.js',sourceRoot));
const {GraphBuilder}=await import(new URL('core/graph.js',sourceRoot));
const {AnalysisCache}=await import(new URL('pipeline/cache.js',sourceRoot));
const {canonicalJson}=await import(new URL('history/fingerprint.js',sourceRoot));
const root=await mkdtemp(path.join(tmpdir(),'codiluce-preparation-atomic-')),text='<script lang="ts">export const original={'+Array.from({length:200000},()=> 'p:1').join(',')+'};throw new Error("Target never executes");</script><script setup lang="ts">function caller(){return original}</script>';
await writeFile(path.join(root,'Original.vue'),text);const config=await resolveConfig(root,{repository:{name:'Owned preparation heap failure'}}),graph=new GraphBuilder(config.repository.name),context={root,config,graph,repositoryId:graph.id('repository'),files:new Map(),applicationIds:new Map(),http:[]};let passed=false;
try{
 for(const analyzer of [filesystemAnalyzer,projectAnalyzer])await analyzer.analyze(context);
 context.cache=new AnalysisCache(path.join(root,'.codiluce/cache'));const before=canonicalJson({entities:[...graph.entities.values()],relations:[...graph.relations.values()],diagnostics:[...graph.diagnostics.values()],http:context.http});
 assert.ok(Buffer.byteLength(text)<config.maxFileBytes);assert.ok(context.files.get('Original.vue').analyzable);await isolatedEmbeddedAnalyzer.analyze(context);assert.equal(context.embedded,undefined);assert.equal(context.embeddedPreparationPending,true);assert.ok(![...graph.entities.values()].some(entity=>entity.type==='component'));
 let failure;try{await runTypeScriptWorker(typeScriptWorkerRequest(context),{oldSpaceMiB:96});}catch(error){failure=error;}
 assert.ok(failure instanceof TypeScriptWorkerError);assert.equal(failure.signal,'SIGABRT');assert.match(failure.stderr,/heap out of memory|Reached heap limit/);assert.equal(canonicalJson({entities:[...graph.entities.values()],relations:[...graph.relations.values()],diagnostics:[...graph.diagnostics.values()],http:context.http}),before);assert.equal(context.embedded,undefined);assert.equal(context.typescriptFiles,undefined);assert.equal(context.cache.events.length,0);assert.equal(await readFile(path.join(root,'Original.vue'),'utf8'),text);
 let entries=[];try{entries=await readdir(context.cache.directory);}catch(error){assert.equal(error.code,'ENOENT');}assert.ok(!entries.some(file=>file.startsWith('typescript-nextjs.')));
 const receipt={schema:1,passed:true,node:process.version,typescriptSourceLoader:process.execArgv.some(arg=>/tsx/.test(arg)),sourceRoot:sourceRoot.href,originalBytes:Buffer.byteLength(text),originalSha256:createHash('sha256').update(text).digest('hex'),maxFileBytes:config.maxFileBytes,oldSpaceMiB:96,signal:failure.signal,workerPid:failure.pid,parentGraphUnchanged:true,parentEmbeddedObjectsAbsent:true,failedSemanticComponentStored:false,cacheFiles:entries,rawStderr:failure.stderr,targetExecution:false,scope:'Authored lower-heap preparation failure; default budget and process-tree RSS qualification remain separate.'};if(process.argv[3])await writeFile(process.argv[3],JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify({...receipt,rawStderr:'Retained in exact JSON receipt'}));passed=true;
}finally{if(passed)await rm(root,{recursive:true,force:true});else console.error('Retained preparation pressure original:',root);}
