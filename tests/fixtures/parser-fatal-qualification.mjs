import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {mock} from 'node:test';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const source=new URL(process.argv[2]),fixtures=new URL(process.argv[4]);
const [{StructureParser},{NATIVE_WASM_MEMORY_LIMITS:limits}]=await Promise.all([import(new URL('analysis/tree-sitter/client.js',source)),import(new URL('analysis/tree-sitter/wasm-memory.js',source))]);
const worker=fileURLToPath(new URL('parser-fatal.mjs',fixtures)),auxiliary=fileURLToPath(new URL('parser-auxiliary-trap.mjs',fixtures));
const observations=[],children=[],fork=cp.fork;
const observer=mock.method(cp,'fork',(...args)=>{
 for(const child of children)assert.ok(child.exitCode!==null||child.signalCode!==null,'Previous parser must retire before its successor');
 const child=Reflect.apply(fork,cp,args);children.push(child);return child;
});syncBuiltinESMExports();
const previousTrap=process.env.CODILUCE_OWNED_TRAP_WORKER;
try{
 const ordinary=new StructureParser(10_000,worker,[],false);
 try{
  const first=await ordinary.parse('owned','healthy');await assert.rejects(ordinary.parse('owned','ordinary'),/Owned ordinary source error/);assert.equal((await ordinary.parse('owned','healthy')).pid,first.pid);
  await assert.rejects(ordinary.parse('owned','fatal'),/Owned fatal parser error/);assert.notEqual((await ordinary.parse('owned','healthy')).pid,first.pid);
  observations.push({case:'fatal-overrides-ordinary-reuse',ordinaryErrorReused:true,fatalReapedBeforeRecovery:true});
 }finally{await ordinary.closeAndWait();}
 const invalid=new StructureParser(10_000,worker,[],false);
 try{
  for(const input of ['invalid','invalid-facts']){const first=await invalid.parse('owned','healthy');await assert.rejects(invalid.parse('owned',input),/Invalid parser response/);assert.notEqual((await invalid.parse('owned','healthy')).pid,first.pid);}
  observations.push({case:'invalid-fatal-envelope',malformedMarkersRejected:true,fatalSuccessNotPublished:true});
 }finally{await invalid.closeAndWait();}
 const bounded=new StructureParser(10_000,undefined,undefined,false,undefined,limits.initialBytes);
 try{
  const original='// Original é😀\r\nint retained(void) { return 1; }\r\n',facts=await bounded.parse('c',original,{nativeOnly:true});
  await assert.rejects(bounded.parse('c','int owned_pressure = 1;\n'.repeat(200_000),{nativeOnly:true}),/Native Tree-sitter WASM memory exhausted at 33554432 bytes/);
  assert.deepEqual(await bounded.parse('c',original,{nativeOnly:true}),facts);observations.push({case:'real-wasm-exhaustion-with-reuse',selectedWasmBytes:limits.initialBytes,completeRecoveredFactsEqual:true});
 }finally{await bounded.closeAndWait();}
 process.env.CODILUCE_OWNED_TRAP_WORKER=new URL('analysis/tree-sitter/native-worker.mjs',source).href;
 const trapped=new StructureParser(10_000,auxiliary,[],false);
 try{
  await assert.rejects(trapped.parse('objective-c','@interface Original\n@end\n@implementation Original\n@end\n',{objectiveCpp:true,nativeOnly:true}),/Owned auxiliary C\+\+ runtime trap/);
  assert.ok((await trapped.parse('python','def recovered(): pass\n',{nativeOnly:true})).declarations.some(row=>row.name==='recovered'));observations.push({case:'auxiliary-cpp-runtime-trap',ownedInjectedRuntimeTrap:true,partialFactsNotPublished:true,recoverySuccessful:true});
 }finally{await trapped.closeAndWait();}
 assert.equal(children.length,9);assert.ok(children.every(child=>child.exitCode!==null||child.signalCode!==null));
 const receipt={schema:1,passed:true,node:process.version,sourceLoader:process.execArgv.some(arg=>/tsx/.test(arg)),caseCount:4,observations,actualWorkers:children.map(child=>({pid:child.pid,code:child.exitCode,signal:child.signalCode})),actualAddressSpacesRetired:true,targetExecution:false};
 await writeFile(process.argv[3],JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({passed:true,node:receipt.node,sourceLoader:receipt.sourceLoader,caseCount:4,actualWorkers:children.length}));
}finally{if(previousTrap===undefined)delete process.env.CODILUCE_OWNED_TRAP_WORKER;else process.env.CODILUCE_OWNED_TRAP_WORKER=previousTrap;observer.mock.restore();syncBuiltinESMExports();}
