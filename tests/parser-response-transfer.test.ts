import assert from 'node:assert/strict';
import {test,mock} from 'node:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {structureAnalyzer} from '../src/analysis/tree-sitter/analyzer.js';
import {filesystemAnalyzer} from '../src/analyzers/filesystem.js';
import {IndexedSources} from '../src/analysis/indexed-sources.js';
import {resolveConfig} from '../src/core/config.js';
import {GraphBuilder} from '../src/core/graph.js';
import {AnalysisCache} from '../src/pipeline/cache.js';
import type {AnalysisContext} from '../src/core/analyzer.js';
import type {StructureFacts} from '../src/analysis/facts.js';
import {fileURLToPath} from 'node:url';
import {serialize,deserialize} from 'node:v8';
import {encodeParserFrame,decodeParserFrame,PARSER_FRAME_BYTES,ParserFrameLimitError,parserJob} from '../src/analysis/tree-sitter/frames.js';
import type {TypeScriptCodecStats} from '../src/analyzers/ts-worker-codec.js';
import {TemplateScriptParser} from '../src/analysis/tree-sitter/template-scripts.js';
import {StructureParser} from '../src/analysis/tree-sitter/client.js';
const worker=fileURLToPath(new URL('./fixtures/parser-response-control.mjs',import.meta.url));
test('parser rejects oversized completion announcements before accepting a response delivery allowance',async()=>{
 const parser=new StructureParser<{pid:number}>(1500,worker,[],false);
 try{const before=await parser.parse('owned','healthy');await assert.rejects(parser.parse('owned','oversized'),/Parser response exceeds 67108864 bytes/);assert.notEqual((await parser.parse('owned','healthy')).pid,before.pid);}finally{await parser.closeAndWait();}
});
test('parser refuses an unknown response encoding without returning facts or reusing the address space',async()=>{
 const parser=new StructureParser<{pid:number}>(10_000,worker,[],false);
 try{const before=await parser.parse('owned','healthy');await assert.rejects(parser.parse('owned','unknown-encoding'),/Invalid parser response encoding/);assert.notEqual((await parser.parse('owned','healthy')).pid,before.pid);}finally{await parser.closeAndWait();}
});
test('parser refuses a response whose encoding changes after its completed frame',async()=>{
 const parser=new StructureParser<{pid:number}>(10_000,worker,[],false);
 try{const before=await parser.parse('owned','healthy');await assert.rejects(parser.parse('owned','changed-encoding'),/Invalid parser response/);assert.notEqual((await parser.parse('owned','healthy')).pid,before.pid);}finally{await parser.closeAndWait();}
});


test('parser frames retain complete original UTF-16, undefined values, binary data and cyclic object aliases',()=>{
 const proof={source:'é😀\r\n\ud800',optional:undefined},facts:{[key:string]:unknown}={proof,alias:proof,values:[undefined,-0,NaN,Infinity],buffer:Buffer.from([0,255,4]),map:new Map([['original',proof]]),set:new Set([proof])};facts.self=facts;
 const bytes=encodeParserFrame({facts}),decoded=decodeParserFrame(bytes) as {facts:typeof facts};assert.deepEqual(serialize(decoded),serialize(deserialize(serialize({facts}))));assert.equal(decoded.facts.alias,decoded.facts.proof);assert.equal(decoded.facts.self,decoded.facts);assert.equal((decoded.facts.map as Map<string,unknown>).get('original'),decoded.facts.proof);
});
test('parser encoding refuses larger string and binary payloads before unbounded copies or final concatenation',()=>{
 for(const value of ['é😀'.repeat(8192),Buffer.alloc(32768)]){const stats={} as TypeScriptCodecStats;assert.throws(()=>encodeParserFrame({facts:value},4096,stats),ParserFrameLimitError);assert.ok(stats.allocatedBlockBytes<=4096);assert.equal(stats.concatenatedBytes,0);assert.ok(stats.peakStringTemporaryBytes<=8192);}
});
test('parser decoding checks compact sparse array lengths before allocating decoded slots',()=>{
 const value={facts:Array(1_000_000)},bytes=encodeParserFrame(value);assert.ok(bytes.length<100);const stats={} as TypeScriptCodecStats;assert.throws(()=>decodeParserFrame(bytes,PARSER_FRAME_BYTES,stats,{arraySlots:16}),/Parser facts arraySlots exceeds 16 limit/);assert.equal(stats.arraySlots,0);
});
test('parser structure limits preserve reference reuse and reject new object, key and depth ownership',()=>{
 const shared={original:true},value={facts:[shared,shared]},bytes=encodeParserFrame(value);assert.deepEqual(decodeParserFrame(bytes,PARSER_FRAME_BYTES,undefined,{objects:3}),value);
 for(const limits of [{objects:2},{properties:1},{depth:1},{keysPerObject:1}]){const input=limits.keysPerObject?{facts:{a:1,b:2}}:value;assert.throws(()=>encodeParserFrame(input,PARSER_FRAME_BYTES,undefined,limits),ParserFrameLimitError);assert.throws(()=>decodeParserFrame(encodeParserFrame(input),PARSER_FRAME_BYTES,undefined,limits),ParserFrameLimitError);}
});
test('parser frame limits cannot be raised and malformed bounded jobs cannot become legacy jobs',()=>{
 for(const limit of [0,-1,1.5,Infinity,PARSER_FRAME_BYTES+1]){assert.throws(()=>encodeParserFrame({},limit));assert.throws(()=>decodeParserFrame(Buffer.from([0]),limit));}
 for(const job of [{id:1,encoding:'unknown',payload:Buffer.alloc(0)},{id:1,encoding:'bounded-v1',payload:'not bytes'},{id:1,encoding:'bounded-v1',payload:encodeParserFrame([])}])assert.throws(()=>parserJob(job));
 const raw={id:1,language:'owned'};assert.equal(parserJob(raw),raw);assert.deepEqual(parserJob({id:2,encoding:'bounded-v1',payload:encodeParserFrame({language:'python',content:'def original(): pass\n'})}),{id:2,language:'python',content:'def original(): pass\n'});
});
test('actual bundled native parsing uses bounded requests and returns complete original facts',async()=>{
 const parser=new StructureParser();try{const source='// original é😀\r\nint original(void) { return 1; }\r\n';const first=await parser.parse('c',source,{nativeOnly:true});assert.ok(first.declarations.some(row=>row.name==='original'));assert.deepEqual(await parser.parse('c',source,{nativeOnly:true}),first);}finally{await parser.closeAndWait();}
});
test('actual literal-script parsing receives native aliases through bounded requests and retains original script declarations',async()=>{
 const parser=new StructureParser(),scripts=new TemplateScriptParser();try{const source='<script>function original(){return "é😀"}</script>\n';const facts=await parser.parse('erb',source,{nativeOnly:true,erbHost:'html'});await parser.closeAndWait();const completed=await scripts.finish(source,facts);assert.ok(completed.declarations.some(row=>row.name==='original'));assert.equal(completed.declarations.find(row=>row.name==='original')!.range.startLine,1);assert.equal(facts.declarations.some(row=>row.name==='original'),false,'Child script completion cannot mutate the original parent facts');}finally{await parser.closeAndWait();await scripts.closeAndWait();}
});

test('bounded parser framing invalidates legacy native facts and preserves subsequent genuine warm reuse',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'codiluce-frame-cache-'));let passed=false;
 try{
  await writeFile(path.join(root,'original.py'),'def retained(): return 1\n');
  const config=await resolveConfig(root,{repository:{name:'Owned frame cache'}}),cache=new AnalysisCache(path.join(root,'.codiluce/cache'));
  const context=async()=>{
   const graph=new GraphBuilder(config.repository.name),value:AnalysisContext={root,config,graph,repositoryId:graph.id('repository'),files:new Map(),applicationIds:new Map(),http:[],cache};
   await filesystemAnalyzer.analyze(value);value.sources=new IndexedSources(value);return value;
  };
  const value=cache.value.bind(cache);
  const legacy=mock.method(cache,'value',(<T>(kind:string,unit:string,parts:unknown,produce:()=>Promise<T>)=>{
   if(kind!=='syntax-facts')return value(kind,unit,parts,produce);
   const {nativeFramePolicy,...old}=parts as Record<string,unknown>;
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
 }finally{if(passed)await rm(root,{recursive:true,force:true});else console.error('Retained parser frame cache fixture:',root);}
});
