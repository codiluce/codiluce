import assert from 'node:assert/strict';
import {mock,test} from 'node:test';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {EmbeddedSources,EMBEDDED_SOURCE_MEMO_MAX_BYTES,EMBEDDED_SOURCE_MEMO_MAX_ENTRIES} from '../src/analysis/embedded/index.js';
import {extractEmbedded,embeddedText} from '../src/analysis/embedded/source.js';
import {resolveConfig} from '../src/core/config.js';
import {GraphBuilder} from '../src/core/graph.js';
import type {AnalysisContext} from '../src/core/analyzer.js';
import {filesystemAnalyzer} from '../src/analyzers/filesystem.js';
import {indexRepository} from '../src/pipeline/index.js';
import {typescriptFrameworkPacks} from '../src/analysis/frameworks/index.js';
import type {TypeScriptFrameworkPack} from '../src/analysis/frameworks/typescript-pack.js';
const oracle=JSON.parse(await readFile(new URL('./fixtures/embedded-compiler-inputs.json',import.meta.url),'utf8'))as {fixtures:Record<string,string>;expected:Record<string,{virtualFile:string;text:string}[]>};
async function contextFor(files:Record<string,string>):Promise<AnalysisContext>{
 const root=await mkdtemp(path.join(tmpdir(),'codiluce-embedded-residency-'));for(const [file,text]of Object.entries(files)){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),text);}const config=await resolveConfig(root,{repository:{name:'Owned embedded source residency'}}),graph=new GraphBuilder(config.repository.name),context:AnalysisContext={root,config,graph,repositoryId:graph.id('repository'),applicationIds:new Map(),files:new Map(),http:[]};await filesystemAnalyzer.analyze(context);return context;
}
function populate(context:AnalysisContext,service:EmbeddedSources,fixtures=oracle.fixtures){for(const [name,text]of Object.entries(fixtures)){const file=context.files.get(name)!;if(['vue','svelte','astro'].includes(file.language??''))service.add(file,text,extractEmbedded(text,file.language as 'vue'|'svelte'|'astro'));}}
test('lazy compiler inputs exactly match the frozen prior Vue/Svelte/Astro module, setup, facade, Unicode and failed/collision outputs under repeated eviction',async()=>{
 const context=await contextFor(oracle.fixtures);try{
  const service=new EmbeddedSources(context,{maxBytes:5000,maxEntries:1});populate(context,service);assert.equal(service.memoStats().entries,0,'Adding all components must not retain expanded texts');
  for(let pass=0;pass<3;pass++)for(const [name,expected]of Object.entries(oracle.expected)){const file=context.files.get(name)!,outputs=service.inputs(file).map(f=>f.absolutePath),facade=service.facade(file.absolutePath);if(facade)outputs.push(facade);assert.deepEqual(outputs.map(p=>path.basename(p)),expected.map(e=>e.virtualFile));for(let i=0;i<outputs.length;i++){const text=service.readFile(outputs[i]!);assert.equal(text,expected[i]!.text);assert.equal(service.input(outputs[i]!)!.text,text);assert.equal(Object.getOwnPropertyDescriptor(service.input(outputs[i]!)!,'text')!.value,undefined,'Input descriptors must not pin a full text string');}}
  const stats=service.memoStats();assert.ok(stats.evictions>0);assert.ok(stats.peakBytes<=5000);assert.equal(stats.peakEntries,1);assert.ok(stats.hits>0);service.clearTextMemo();assert.equal(service.memoStats().bytes,0);assert.equal(service.memoStats().entries,0);assert.equal(service.facts.size,6);
 }finally{await rm(context.root,{recursive:true,force:true});}
});
test('virtual source admission accounts exact UTF-16 text and key bytes, oversized inputs bypass retention and disabled profiles preserve all original text',async()=>{
 const original='<!-- é😀 -->\r\n<script>function original(){return "😀";}</script>',context=await contextFor({'Page.astro':original});try{
  const file=context.files.get('Page.astro')!,facts=extractEmbedded(original,'astro'),virtual=embeddedText(original,facts.regions[0]!),key=`${file.absolutePath}.__codiluce_client_0.ts`,bytes=2*(key.length+virtual.length);
  for(const profile of [{maxBytes:bytes,maxEntries:1},{maxBytes:bytes-1,maxEntries:1},{maxBytes:0,maxEntries:1},{maxBytes:bytes,maxEntries:0}]){const service=new EmbeddedSources(context,profile);service.add(file,original,structuredClone(facts));assert.equal(service.readFile(key),virtual);assert.equal(service.readFile(key),virtual);if(profile.maxBytes===bytes&&profile.maxEntries){assert.equal(service.memoStats().bytes,bytes);assert.equal(service.memoStats().hits,1);}else{assert.equal(service.memoStats().entries,0);assert.equal(service.memoStats().bypasses,2);}}
  assert.equal(EMBEDDED_SOURCE_MEMO_MAX_BYTES,32*1024*1024);assert.equal(EMBEDDED_SOURCE_MEMO_MAX_ENTRIES,4096);
  for(const profile of [{maxBytes:-1},{maxEntries:Infinity},{maxBytes:1.5},{maxEntries:NaN}])assert.throws(()=>new EmbeddedSources(context,profile),/nonnegative safe integers/);
 }finally{await rm(context.root,{recursive:true,force:true});}
});
test('one allowed original with 32 Astro scripts can exceed the memo budget without expanding persistent descriptors or dropping any source region',async()=>{
 const original='<!-- é😀\r\n'+'.'.repeat(600000)+' -->\r\n'+Array.from({length:32},(_,i)=>`<script>function original${i}(){return ${i};}</script>\r\n`).join(''),context=await contextFor({'Page.astro':original});try{
  const file=context.files.get('Page.astro')!,facts=extractEmbedded(original,'astro'),service=new EmbeddedSources(context);service.add(file,original,facts);assert.equal(service.memoStats().entries,0);assert.equal(service.inputs(file).length,32);let total=0;
  for(let pass=0;pass<2;pass++)for(const input of service.inputs(file)){const text=service.readFile(input.absolutePath)!;assert.equal(text,embeddedText(original,input.embedded!));assert.equal(text.slice(input.embedded!.start,input.embedded!.end),original.slice(input.embedded!.start,input.embedded!.end));total+=2*(input.absolutePath.length+text.length);assert.equal(Object.getOwnPropertyDescriptor(service.input(input.absolutePath)!,'text')!.value,undefined);}
  const stats=service.memoStats();assert.ok(total>2*stats.maxBytes);assert.ok(stats.evictions>0);assert.ok(stats.peakBytes<=stats.maxBytes);assert.ok(stats.peakEntries<=stats.maxEntries);service.clearTextMemo();assert.equal(service.memoStats().bytes,0);
 }finally{await rm(context.root,{recursive:true,force:true});}
});
test('evicted originals must revalidate scan hashes and a failed reload invalidates every remaining region and facade memo for that original',async()=>{
 const original='<script lang="ts">export function shared(){return 1;}</script><script setup lang="ts">function caller(){return shared();}</script>',context=await contextFor({'Pair.vue':original});try{
  const file=context.files.get('Pair.vue')!,service=new EmbeddedSources(context,{maxEntries:2});service.add(file,original,extractEmbedded(original,'vue'));const [module,setup]=service.inputs(file),facade=service.facade(file.absolutePath)!;assert.ok(module&&setup);const expected=service.readFile(module.absolutePath);assert.ok(expected);assert.ok(service.readFile(facade));assert.ok(service.readFile(setup.absolutePath));assert.equal(service.memoStats().entries,2);
  await writeFile(file.absolutePath,original.replace('return 1','return 9'));assert.equal(service.readFile(module.absolutePath),undefined);assert.equal(service.memoStats().entries,0);assert.equal(service.readFile(facade),undefined);assert.equal(service.readFile(setup.absolutePath),undefined);assert.throws(()=>service.input(setup.absolutePath)!.text,/unavailable/);assert.match(context.sources!.failures.get(file.path)!,/changed after the scan/);
  await writeFile(file.absolutePath,original);assert.equal(service.readFile(module.absolutePath),expected,'Reload the exact original after restoration');await rm(file.absolutePath);service.clearTextMemo();assert.equal(service.readFile(module.absolutePath),undefined);assert.equal(service.memoStats().entries,0);
 }finally{await rm(context.root,{recursive:true,force:true});}
});
test('re-registering an original retires previous recipes, regions and memo while a new original remains source-validated',async()=>{
 const original='<script>function old(){}</script>',changed='<template>plain</template>',context=await contextFor({'Pair.vue':original});try{
  const file=context.files.get('Pair.vue')!,service=new EmbeddedSources(context);service.add(file,original,extractEmbedded(original,'vue'));const old=service.inputs(file)[0]!.absolutePath;assert.ok(service.readFile(old));await writeFile(file.absolutePath,changed);context.graph.entities.get(file.id)!.metadata.contentHash=createHash('sha256').update(changed).digest('hex');service.add(file,changed,extractEmbedded(changed,'vue'));assert.equal(service.memoStats().entries,0);assert.equal(service.input(old),undefined);assert.equal(service.readFile(old),undefined);assert.equal(service.inputs(file).length,0);assert.ok(service.readFile(service.facade(file.absolutePath)!));
 }finally{await rm(context.root,{recursive:true,force:true});}
});
test('real TypeScript component completion and framework failure clear the virtual text memo after all current consumers',async()=>{
 const context=await contextFor({'package.json':'{"dependencies":{"vue":"3.5.0"}}','Pair.vue':'<script lang="ts">export function shared(){return 1;}</script><script setup lang="ts">function caller(){return shared();}</script>'});let failed=false;const snapshots:Array<{before:number;after:number}>=[],originalClear=EmbeddedSources.prototype.clearTextMemo,clear=mock.method(EmbeddedSources.prototype,'clearTextMemo',function(this:EmbeddedSources){const before=this.memoStats().entries;originalClear.call(this);snapshots.push({before,after:this.memoStats().entries});});let observed:EmbeddedSources|undefined;const pack:TypeScriptFrameworkPack={id:'owned-embedded-memory-observer',version:'1',applies:()=>true,declare(scope){observed=scope.context.embedded!;assert.ok(observed.memoStats().entries>0);if(failed)throw Error('Injected own embedded framework failure');},finish(){assert.ok(observed!.memoStats().entries>0);}};const packs=typescriptFrameworkPacks as TypeScriptFrameworkPack[];packs.push(pack);
 try{await indexRepository(context.root);assert.ok(snapshots.some(s=>s.before>0&&s.after===0));assert.equal(observed!.memoStats().entries,0);failed=true;await assert.rejects(indexRepository(context.root),/Injected own embedded framework failure/);assert.equal(observed!.memoStats().entries,0);assert.ok(snapshots.filter(s=>s.before>0&&s.after===0).length>=2);}finally{clear.mock.restore();packs.splice(packs.indexOf(pack),1);await rm(context.root,{recursive:true,force:true});}
});
