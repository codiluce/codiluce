// Real pipeline under a parent compiler prohibition. No target source executes.
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
const sourceRoot=new URL(process.argv[2]),mode=process.argv[4]??'candidate';
const {indexRepository}=await import(new URL('pipeline/index.js',sourceRoot));
const {resolveConfig}=await import(new URL('core/config.js',sourceRoot));
const {AnalysisCache}=await import(new URL('pipeline/cache.js',sourceRoot));
const {canonicalJson}=await import(new URL('history/fingerprint.js',sourceRoot));
const normalize=graph=>canonicalJson({...graph,run:{...graph.run,id:'',analyzedAt:''}}),roots=[],results=[];
const profiles=[
 {name:'components',files:{'package.json':'{"dependencies":{"vue":"3.5.0","svelte":"5.57.2","astro":"7.0.0"}}','Pair.vue':'<script lang="ts">export function shared(){return "é😀"}</script><script setup lang="ts">function original(){return shared()}</script><button @click="original">Read</button>','Pair.svelte':'<script context="module" lang="ts">export function shared(){return "é😀"}</script><script lang="ts">function original(){return shared()}</script><button onclick={original}>Read</button>','Page.astro':'---\nconst original="é😀";\n---\n<div>{original}</div>'}},
 {name:'config-only',files:{'tsconfig.json':'{"compilerOptions":{"rootDir":"src","target":"ES2020"}}'}},
 {name:'invalid-config-only',files:{'tsconfig.json':'{'}},
 {name:'typescript',files:{'main.ts':'// é😀\r\nexport function original(value:string){return value.length}\r\nthrow new Error("Target never executes");'}}
];
let passed=false;
try{
 for(const profile of profiles){
  const root=await mkdtemp(path.join(tmpdir(),'codiluce-preparation-parent-'));roots.push(root);
  for(const [file,text]of Object.entries(profile.files)){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),text);}
  const config=await resolveConfig(root,{repository:{name:'Owned parent compiler prohibition'}}),cache=new AnalysisCache(path.join(root,'.codiluce/cache'));let first;
  try{first=await indexRepository(root,{config,cache});}catch(error){
   if(mode!=='baseline')throw error;assert.match(String(error),/Compiler construction used in parent/);results.push({profile:profile.name,expectedParentCompilerFailure:true,error:String(error)});continue;
  }
  if(mode==='baseline'&&profile.name!=='typescript')throw Error('Prior parent construction was unexpectedly isolated');
  const warm=await indexRepository(root,{config,cache}),revision=await indexRepository(root,{config,revision:'f'.repeat(40)}),revisionFresh=await indexRepository(root,{config,revision:'f'.repeat(40)});assert.equal(normalize(first),normalize(warm));assert.equal(normalize(revision),normalize(revisionFresh));
  if(profile.name==='components'){assert.ok(first.entities.some(entity=>entity.name==='shared'&&entity.path==='Pair.vue'));assert.ok(first.entities.some(entity=>entity.name==='original'&&entity.path==='Pair.svelte'));assert.ok(cache.events.some(event=>event.analyzer==='embedded-source'&&event.hit));assert.ok(cache.events.some(event=>event.analyzer==='typescript-nextjs'&&event.hit));}
  if(profile.name==='config-only'){const project=first.entities.find(entity=>entity.type==='repository').metadata.projects.find(item=>item.ecosystem==='node');assert.deepEqual(project.sourceRoots,['src']);}
  if(profile.name==='invalid-config-only')assert.ok(first.diagnostics.some(item=>item.code==='tsconfig-error'&&item.file==='tsconfig.json'));
  for(const [file,text]of Object.entries(profile.files))assert.equal(await readFile(path.join(root,file),'utf8'),text);
  results.push({profile:profile.name,passed:true,entities:first.entities.length,relations:first.relations.length,diagnostics:first.diagnostics.length,completeGraphComparisons:2,parentCompilerForbidden:true});
 }
 const receipt={schema:1,passed:true,mode,profiles:results,typescriptSourceLoader:process.execArgv.some(arg=>/tsx/.test(arg)),parentCompilerConstructionForbidden:true,parentOptionalParserForbidden:true,targetExecution:false,node:process.version,sourceRoot:sourceRoot.href};if(process.argv[3])await writeFile(process.argv[3],JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));passed=true;
}finally{if(passed)for(const root of roots)await rm(root,{recursive:true,force:true});else console.error('Retained parent preparation probe originals:',roots);}
