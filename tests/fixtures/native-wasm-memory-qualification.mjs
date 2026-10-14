import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {mock} from 'node:test';
import cp from 'node:child_process';
import {serialize,deserialize} from 'node:v8';
import {syncBuiltinESMExports} from 'node:module';

const source=new URL(process.argv[2]),originals=new URL(process.argv[4]);
const [{StructureParser},wasm]=await Promise.all([import(new URL('analysis/tree-sitter/client.js',source)),import(new URL('analysis/tree-sitter/wasm-memory.js',source))]);
const {NATIVE_WASM_MEMORY_LIMITS:limits,createNativeWasmMemory,nativeWasmWorkerLimit}=wasm;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),observations=[],profiles=[];
const memory=createNativeWasmMemory();assert.equal(memory.memory.buffer.byteLength,limits.initialBytes);
memory.memory.grow((limits.maxBytes-limits.initialBytes)/limits.pageBytes);assert.equal(memory.memory.buffer.byteLength,limits.maxBytes);
assert.throws(()=>WebAssembly.Memory.prototype.grow.call(memory.memory,1),RangeError);
assert.throws(()=>memory.memory.grow(1),RangeError);assert.throws(memory.assertAvailable,/WASM memory exhausted/);
observations.push({case:'engine-enforced-linear-memory',initialBytes:limits.initialBytes,maxBytes:limits.maxBytes,growthAboveMaximumRejected:true});
for(const args of [['--max-wasm-bytes=0'],[`--max-wasm-bytes=${limits.maxBytes+limits.pageBytes}`],[`--max-wasm-bytes=${limits.initialBytes+1}`],['--unknown=1'],['--max-wasm-bytes=1','--max-wasm-bytes=2']])assert.throws(()=>nativeWasmWorkerLimit(args));
observations.push({case:'owned-lower-only-limit',invalidProfilesRejected:5});
const cases=[
 ['python','python.py'],['go','go.go'],['ruby','ruby.rb'],['rust','rust.rs'],['java','Java.java'],['csharp','CSharp.cs'],['kotlin','Kotlin.kt'],['c','c.c'],['cpp','cpp.cpp'],
 ['objective-c','objc-cpp.mm',{objectiveCpp:true}],['swift','swift.swift'],['scala','scala.scala'],['groovy','groovy.groovy'],['fsharp','fsharp.fs'],['fsharp-signature','fsharp.fsi'],['vbnet','vbnet.vb'],
 ['erb','erb.html.erb',{erbHost:'html'}],['razor','Counter.razor',{razorKind:'component'}],['liquid','template.html.liquid',{liquidHost:'html',liquidEngine:'shopify',liquidBodyTags:true}],['html',null],
];
const ordinary=new StructureParser();
try{
 for(const [language,file,options]of cases){
  const bytes=file?await readFile(new URL(file,originals)):Buffer.from('<p>Original é😀</p>\r\n');
  const facts=await ordinary.parse(language,bytes.toString('utf8'),{...options,nativeOnly:true});
  assert.ok(Array.isArray(facts.declarations)&&Array.isArray(facts.issues));
  if(language==='liquid')assert.ok(facts.liquid?.host.regions.length,'Liquid original regions missing');
  else if(language!=='html')assert.ok(facts.declarations.length,language+' has no original declarations');
  if(file)assert.deepEqual(await readFile(new URL(file,originals)),bytes);
  const payload=serialize(facts);assert.deepEqual(deserialize(payload),facts);
  profiles.push({language,file,sourceSha256:hash(bytes),sourceBytes:bytes.length,facts,factsPayload:payload.toString('base64')});
 }
}finally{await ordinary.closeAndWait();}
observations.push({case:'complete-original-native-profiles',profiles:profiles.length,originalBytesUnchanged:true});
const fork=cp.fork,children=[];
const observer=mock.method(cp,'fork',(...args)=>{
 for(const child of children)assert.ok(child.exitCode!==null||child.signalCode!==null,'Retire the previous WASM address space before recovery');
 const child=Reflect.apply(fork,cp,args);children.push(child);return child;
});syncBuiltinESMExports();
const bounded=new StructureParser(10_000,undefined,undefined,true,undefined,limits.initialBytes);
try{
 const original='// Original é😀\r\nint retained(void) { return 1; }\r\n';
 const first=await bounded.parse('c',original,{nativeOnly:true});
 await assert.rejects(bounded.parse('c','int owned_pressure = 1;\n'.repeat(200_000),{nativeOnly:true}),/Native Tree-sitter WASM memory exhausted at 33554432 bytes/);
 assert.deepEqual(await bounded.parse('c',original,{nativeOnly:true}),first);assert.equal(children.length,2);
 await bounded.closeAndWait();assert.ok(children.every(child=>child.exitCode!==null||child.signalCode!==null));
 observations.push({case:'real-exhaustion-retirement-and-recovery',selectedBytes:limits.initialBytes,actualWorkers:children.map(child=>({pid:child.pid,code:child.exitCode,signal:child.signalCode})),previousAddressSpaceGoneBeforeSuccessor:true,completeRecoveredFactsEqual:true});
}finally{await bounded.closeAndWait();observer.mock.restore();syncBuiltinESMExports();}
const receipt={schema:1,passed:true,caseCount:observations.length,node:process.version,sourceLoader:process.execArgv.some(arg=>/tsx/.test(arg)),limits,observations,profiles,targetExecution:false,totalRssQualified:false,scope:'Fixed Tree-sitter linear-memory maximum, actual allocation exhaustion and reaped recovery, complete admitted original profiles. V8 heap, grammar module/input/fact buffers, optional component compilers, decoded graphs and total process RSS are separate.'};
await writeFile(process.argv[3],JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({passed:true,caseCount:receipt.caseCount,node:receipt.node,profiles:profiles.length,sourceLoader:receipt.sourceLoader}));
