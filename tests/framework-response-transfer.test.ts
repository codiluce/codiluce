import assert from 'node:assert/strict';
import {mock,test} from 'node:test';
import cp from 'node:child_process';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {TemplateFrameworkParser} from '../src/analysis/embedded/framework-parser.js';
import type {AnalysisContext} from '../src/core/analyzer.js';
import {embeddedAnalyzer} from '../src/analysis/embedded/index.js';
import {indexRepository} from '../src/pipeline/index.js';
import {resolveConfig} from '../src/core/config.js';
import {AnalysisCache} from '../src/pipeline/cache.js';
import {canonicalJson} from '../src/history/fingerprint.js';
import {isolatedTypescriptAnalyzer} from '../src/analyzers/typescript-isolated.js';
import {typescriptAnalyzer} from '../src/analyzers/typescript.js';
const worker=fileURLToPath(new URL('./fixtures/framework-no-v8.mjs',import.meta.url));
test('actual Svelte AST transfer succeeds while full-value V8 serialization is forbidden',async()=>{
 const parser=new TemplateFrameworkParser(undefined,10_000,worker);try{const source='<script>function original(){return "é😀"}</script>\r\n<button onclick={original}>original</button>';const value=await parser.svelte(source,'Original.svelte');assert.ok(JSON.stringify(value).includes('original'));assert.equal(value.instance!.content.body[0]!.type,'FunctionDeclaration');}finally{await parser.closeAndWait();}
});
test('actual Astro AST transfer succeeds while full-value V8 serialization is forbidden',async()=>{
 const parser=new TemplateFrameworkParser(undefined,10_000,worker);try{const value=await parser.astro('---\r\nconst original="é😀";\r\n---\r\n<div>{original}</div>');assert.ok(JSON.stringify(value).includes('original'));}finally{await parser.closeAndWait();}
});
test('portable Svelte/Astro transfer contract preserves complete previous-wire ASTs and diagnostics with nine real retired workers',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'codiluce-framework-frame-'));let passed=false;
 try{const receipt=path.join(root,'receipt.json');cp.execFileSync(process.execPath,['--experimental-sqlite','--import','tsx',fileURLToPath(new URL('./fixtures/framework-frame-qualification.mjs',import.meta.url)),new URL('../src/',import.meta.url).href,receipt,new URL('./fixtures/',import.meta.url).href],{stdio:'pipe'});passed=true;}
 finally{if(passed)await rm(root,{recursive:true});else console.error('Retained framework transfer probe:',root);}
});
test('legacy framework graph cache cannot bypass bounded parser policy and the new complete result replays warm',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'codiluce-framework-frame-cache-'));let passed=false;
 const execution=mock.method(isolatedTypescriptAnalyzer,'analyze',async(context:AnalysisContext)=>{if(context.embeddedPreparationPending)await embeddedAnalyzer.analyze(context);await typescriptAnalyzer.analyze(context);});
 try{
  for(const [name,text] of Object.entries({'package.json':'{"name":"original","dependencies":{"svelte":"5.57.2"}}','tsconfig.json':'{"include":["**/*.svelte"]}','Original.svelte':'<script>function original(){return "é😀";}</script>\r\n<button onclick={original}>original</button>'})){await mkdir(path.dirname(path.join(root,name)),{recursive:true});await writeFile(path.join(root,name),text);}
  const config=await resolveConfig(root,{repository:{name:'Original framework transfer cache'}}),cache=new AnalysisCache(path.join(root,'.codiluce/cache')),unit=cache.unit.bind(cache);
  const legacy=mock.method(cache,'unit',(async(context,analyzer,key,parts,work,policy)=>{
   if(analyzer!=='typescript-nextjs')return unit(context,analyzer,key,parts,work,policy);
   const {frameworkFramePolicy,...prior}=parts as Record<string,unknown>;
   assert.equal(frameworkFramePolicy,'bounded-facts-v1');return unit(context,analyzer,key,prior,async()=>{},policy);
  })as typeof cache.unit);
  try{const old=await indexRepository(root,{config,cache});assert.ok(!old.entities.some(row=>row.type==='function'&&row.name==='original'));}finally{legacy.mock.restore();}
  const current=await indexRepository(root,{config,cache});assert.ok(current.entities.some(row=>row.type==='function'&&row.name==='original'));
  assert.ok(cache.events.some(row=>row.analyzer==='typescript-nextjs'&&!row.hit));
  const warm=await indexRepository(root,{config,cache});assert.ok(cache.events.some(row=>row.analyzer==='typescript-nextjs'&&row.hit));
  const whole=(value:typeof current)=>canonicalJson({...value,run:{...value.run,id:'owned-id',analyzedAt:'owned-time'}});
  assert.equal(whole(warm),whole(current));assert.equal(whole(await indexRepository(root,{config})),whole(current));passed=true;
 }finally{execution.mock.restore();if(passed)await rm(root,{recursive:true});else console.error('Retained framework cache fixture:',root);}
});
