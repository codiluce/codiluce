// Exercise only Codiluce-owned parsers. Original component statements never execute.
import assert from 'node:assert/strict';
import {serialize,deserialize} from 'node:v8';
import {writeFile} from 'node:fs/promises';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import {fileURLToPath} from 'node:url';
import {mock} from 'node:test';
import cp from 'node:child_process';
const source=new URL(process.argv[2]),fixtures=new URL(process.argv[4]);
const worker=fileURLToPath(new URL('analysis/embedded/native-framework-worker.mjs',source));
const [{TemplateFrameworkParser},frames]=await Promise.all([import(new URL('analysis/embedded/framework-parser.js',source)),import(new URL('analysis/tree-sitter/frames.js',source))]);
const require=createRequire(worker),{parse:svelte}=require('svelte/compiler'),{parse:astro}=require('@astrojs/compiler-rs');
const {PARSER_FRAME_BYTES,PARSER_FRAME_ENCODING,decodeParserFrame}=frames,children=[],observations=[],fork=cp.fork,originalWorker=process.env.CODILUCE_OWNED_FRAMEWORK_WORKER;
// Both directions preserve the complete value and its reference relationships.
const previousWire=value=>deserialize(serialize(value));
function same(a,b,left=new Map(),right=new Map()){
 if(a===null||typeof a!=='object'){assert.ok(Object.is(a,b));return;}
 assert.ok(b!==null&&typeof b==='object');
 if(left.has(a)){assert.equal(left.get(a),b);return;}
 assert.ok(!right.has(b));left.set(a,b);right.set(b,a);
 assert.equal(Object.getPrototypeOf(a),Object.getPrototypeOf(b));
 if(a instanceof RegExp){assert.equal(a.source,b.source);assert.equal(a.flags,b.flags);assert.equal(a.lastIndex,b.lastIndex);}
 assert.deepEqual(Reflect.ownKeys(b),Reflect.ownKeys(a));
 for(const key of Reflect.ownKeys(a)){
  const x=Object.getOwnPropertyDescriptor(a,key),y=Object.getOwnPropertyDescriptor(b,key);
  assert.equal(x.enumerable,y.enumerable);assert.equal(x.configurable,y.configurable);assert.equal(x.writable,y.writable);same(x.value,y.value,left,right);
 }
}
const observer=mock.method(cp,'fork',(...args)=>{
 assert.ok(children.every(child=>child.exitCode!==null||child.signalCode!==null),'Predecessor must retire before replacement');
 const child=Reflect.apply(fork,cp,args);children.push(child);
 if(String(args[0])===worker){
  const send=child.send;child.send=function(message,...rest){if(message.id!==900){assert.equal(message.encoding,PARSER_FRAME_ENCODING);assert.ok(Buffer.isBuffer(message.payload));}return Reflect.apply(send,this,[message,...rest]);};
 }
 child.on('message',message=>assert.equal(message.encoding,PARSER_FRAME_ENCODING));return child;
});syncBuiltinESMExports();
try{
 process.env.CODILUCE_OWNED_FRAMEWORK_WORKER=worker;
 const originals={svelte:'<script lang="ts">let value="é😀\\ud800";const pattern=/é😀/giu;const big=12n;function original(){throw Error("Target must never execute");}</script>\r\n{#if value}<button onclick={original}>{value}</button>{/if}',astro:'---\r\nconst value="é😀";const pattern=/é😀/giu;const big=12n;throw Error("Target must never execute");\r\n---\r\n<div>{value}</div><script>function original(){return 1;}</script>'};
 for(const language of ['svelte','astro']){
  const parser=new TemplateFrameworkParser(undefined,10_000,fileURLToPath(new URL('framework-no-v8.mjs',fixtures)));
  try{same(previousWire(language==='svelte'?svelte(originals.svelte,{modern:true,filename:'Original.svelte'}):astro(originals.astro)),language==='svelte'?await parser.svelte(originals.svelte,'Original.svelte'):await parser.astro(originals.astro));observations.push({case:language+'-complete-original-ast-without-full-value-v8',completePriorWireDescriptorsAndBidirectionalAliases:true});}finally{await parser.closeAndWait();}
 }
 const parser=new TemplateFrameworkParser();
 try{
  const invalid='<script>\r\nconst value="é😀";\r\nconst broken=;</script>';let expected;
  try{svelte(invalid,{modern:true,filename:'Broken.svelte'});}catch(error){expected=error;}assert.ok(expected);
  await assert.rejects(parser.svelte(invalid,'Broken.svelte'),actual=>{assert.equal(actual.message,expected.message);assert.equal(actual.name,expected.name);assert.equal(String(actual),String(expected));same(expected.position,actual.position);same(expected.start,actual.start);return true;});
  same(previousWire(svelte(originals.svelte,{modern:true,filename:'Original.svelte'})),await parser.svelte(originals.svelte,'Original.svelte'));
  observations.push({case:'original-syntax-error-coordinates-and-reaped-recovery'});
  await assert.rejects(parser.astro('x'.repeat(PARSER_FRAME_BYTES+1)),/Parser facts payload exceeds 67108864 bytes/);
  same(previousWire(astro(originals.astro)),await parser.astro(originals.astro));observations.push({case:'actual-bounded-request-admission-and-reaped-recovery',originalSourceUnits:PARSER_FRAME_BYTES+1});
 }finally{await parser.closeAndWait();}
 const generation=new TemplateFrameworkParser({maxJobs:2,maxSourceBytes:1024*1024});
 try{const before=children.length;await generation.svelte('<div>first</div>','First.svelte');await generation.astro('<div>second</div>');assert.ok(children.at(-1).exitCode!==null||children.at(-1).signalCode!==null);await generation.svelte('<div>third</div>','Third.svelte');assert.equal(children.length-before,2);assert.equal(generation.stats().peakJobs,2);observations.push({case:'bounded-default-requests-and-job-generation-retirement',maxJobs:2});}finally{await generation.closeAndWait();}
 const raw=cp.fork(worker,[],{execArgv:['--max-old-space-size=256'],serialization:'advanced',stdio:['ignore','ignore','ignore','ipc']});
 try{
  const messages=[];
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Missing framework failure frame')),10_000);raw.once('error',reject);raw.on('message',message=>{try{messages.push(message);if(message.type==='result'){clearTimeout(timer);resolve();}}catch(error){clearTimeout(timer);reject(error);}});raw.send({id:900,encoding:'unknown-owned-probe',payload:Buffer.from([0])});});
  assert.equal(messages.length,2);assert.equal(messages[0].type,'completed');assert.equal(messages[0].bytes,messages[1].payload.length);same({error:'Invalid parser request encoding',fatal:true},decodeParserFrame(messages[1].payload));observations.push({case:'actual-malformed-request-produces-bounded-fatal-frame'});
 }finally{await new Promise(resolve=>{raw.once('exit',resolve);raw.kill();});}
 assert.equal(observations.length,6);assert.equal(children.length,9);assert.ok(children.every(child=>child.exitCode!==null||child.signalCode!==null));
 const receipt={schema:1,passed:true,node:process.version,sourceLoader:process.execArgv.some(arg=>/tsx/.test(arg)),caseCount:6,frameBytes:PARSER_FRAME_BYTES,observations,actualWorkers:children.map(child=>({pid:child.pid,code:child.exitCode,signal:child.signalCode})),actualAddressSpacesRetired:true,targetExecution:false,totalRssQualified:false,scope:'Complete original Svelte/Astro ASTs under the previous V8 wire semantics, descriptors and bidirectional aliases, original syntax diagnostics, bounded requests/replies and actual retirement. Optional parser allocation and physical RSS remain separate.'};
 await writeFile(process.argv[3],JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({passed:true,node:receipt.node,caseCount:6,actualWorkers:children.length}));
}finally{observer.mock.restore();syncBuiltinESMExports();if(originalWorker===undefined)delete process.env.CODILUCE_OWNED_FRAMEWORK_WORKER;else process.env.CODILUCE_OWNED_FRAMEWORK_WORKER=originalWorker;for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill();}
