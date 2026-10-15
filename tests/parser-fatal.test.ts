import assert from 'node:assert/strict';
import {mock,test} from 'node:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {StructureParser} from '../src/analysis/tree-sitter/client.js';
import {NATIVE_WASM_MEMORY_LIMITS as limits} from '../src/analysis/tree-sitter/wasm-memory.js';
import {structureAnalyzer} from '../src/analysis/tree-sitter/analyzer.js';
import {filesystemAnalyzer} from '../src/analyzers/filesystem.js';
import {IndexedSources} from '../src/analysis/indexed-sources.js';
import {resolveConfig} from '../src/core/config.js';
import {GraphBuilder} from '../src/core/graph.js';
import {AnalysisCache} from '../src/pipeline/cache.js';
import type {AnalysisContext} from '../src/core/analyzer.js';
import type {StructureFacts} from '../src/analysis/facts.js';

const worker=fileURLToPath(new URL('./fixtures/parser-fatal.mjs',import.meta.url));
test('fatal parser errors retire even when ordinary reported source errors explicitly reuse their provider',async()=>{
 const parser=new StructureParser<{pid:number}>(10_000,worker,[],false);
 try{
  const first=await parser.parse('owned','healthy');
  await assert.rejects(parser.parse('owned','ordinary'),/Owned ordinary source error/);
  assert.equal((await parser.parse('owned','healthy')).pid,first.pid);
  await assert.rejects(parser.parse('owned','fatal'),/Owned fatal parser error/);
  assert.notEqual((await parser.parse('owned','healthy')).pid,first.pid);
 }finally{await parser.closeAndWait();}
});
test('malformed fatal markers and fatal success frames cannot publish facts or retain their provider',async()=>{
 const parser=new StructureParser<{pid:number}>(10_000,worker,[],false);
 try{
  for(const input of ['invalid','invalid-facts']){
   const first=await parser.parse('owned','healthy');
   await assert.rejects(parser.parse('owned',input),/Invalid parser response/);
   assert.notEqual((await parser.parse('owned','healthy')).pid,first.pid);
  }
 }finally{await parser.closeAndWait();}
});
test('real WASM exhaustion overrides ordinary-error reuse and recovers admitted original facts in a new process',async()=>{
 const parser=new StructureParser(10_000,undefined,undefined,false,undefined,limits.initialBytes);
 try{
  const source='// Original é😀\r\nint retained(void) { return 1; }\r\n';
  const original=await parser.parse('c',source,{nativeOnly:true});
  await assert.rejects(parser.parse('c','int owned_pressure = 1;\n'.repeat(200_000),{nativeOnly:true}),/Native Tree-sitter WASM memory exhausted at 33554432 bytes/);
  assert.deepEqual(await parser.parse('c',source,{nativeOnly:true}),original);
 }finally{await parser.closeAndWait();}
});
test('an auxiliary C++ WASM trap cannot return partial Objective-C facts or retain the trapped worker',async()=>{
 const auxiliary=fileURLToPath(new URL('./fixtures/parser-auxiliary-trap.mjs',import.meta.url));
 const parser=new StructureParser(10_000,auxiliary,[],false);
 try{
  const source='@interface Original\n@end\n@implementation Original\n@end\n';
  await assert.rejects(parser.parse('objective-c',source,{objectiveCpp:true,nativeOnly:true}),/Owned auxiliary C\+\+ runtime trap/);
  assert.ok((await parser.parse('python','def recovered(): pass\n',{nativeOnly:true})).declarations.some(item=>item.name==='recovered'));
 }finally{await parser.closeAndWait();}
});
test('native failure policy rejects legacy cached omissions and then preserves genuine warm fact reuse',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'codiluce-fatal-cache-'));let passed=false;
 try{
  await writeFile(path.join(root,'original.py'),'def retained(): return 1\n');
  const config=await resolveConfig(root,{repository:{name:'Owned fatal cache'}}),cache=new AnalysisCache(path.join(root,'.codiluce/cache'));
  const context=async()=>{
   const graph=new GraphBuilder(config.repository.name),value:AnalysisContext={root,config,graph,repositoryId:graph.id('repository'),files:new Map(),applicationIds:new Map(),http:[],cache};
   await filesystemAnalyzer.analyze(value);value.sources=new IndexedSources(value);return value;
  };
  const value=cache.value.bind(cache);
  const legacy=mock.method(cache,'value',(<T>(kind:string,unit:string,parts:unknown,produce:()=>Promise<T>)=>{
   if(kind!=='syntax-facts')return value(kind,unit,parts,produce);
   const {nativeFailurePolicy,...old}=parts as Record<string,unknown>;
   return value(kind,unit,old,async()=>({...await produce() as StructureFacts,declarations:[]}) as T);
  }) as typeof cache.value);
  const prior=await context();try{await structureAnalyzer.analyze(prior);}finally{legacy.mock.restore();}
  assert.ok(![...prior.graph.entities.values()].some(row=>row.name==='retained'));
  let parses=0;const parse=StructureParser.prototype.parse;
  const observation=mock.method(StructureParser.prototype,'parse',async function(this:StructureParser,...args:Parameters<StructureParser['parse']>){parses++;return parse.apply(this,args);});
  try{
   const current=await context();await structureAnalyzer.analyze(current);assert.equal(parses,1);assert.ok([...current.graph.entities.values()].some(row=>row.name==='retained'));
   const warm=await context();await structureAnalyzer.analyze(warm);assert.equal(parses,1);assert.deepEqual([...warm.graph.entities.values()],[...current.graph.entities.values()]);
  }finally{observation.mock.restore();}
  passed=true;
 }finally{if(passed)await rm(root,{recursive:true,force:true});else console.error('Retained native failure cache fixture:',root);}
});
