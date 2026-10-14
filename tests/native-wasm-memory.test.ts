import assert from 'node:assert/strict';
import {mock,test} from 'node:test';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {StructureParser} from '../src/analysis/tree-sitter/client.js';
import {createNativeWasmMemory,nativeWasmMemoryLimit,nativeWasmWorkerLimit,NATIVE_WASM_MEMORY_LIMITS as limits} from '../src/analysis/tree-sitter/wasm-memory.js';

test('native WASM linear memory has an engine-enforced maximum independent of V8 heap limits',()=>{
  const bounded=createNativeWasmMemory();
  assert.equal(bounded.memory.buffer.byteLength,limits.initialBytes);
  bounded.memory.grow((limits.maxBytes-limits.initialBytes)/limits.pageBytes);
  assert.equal(bounded.memory.buffer.byteLength,limits.maxBytes);
  assert.throws(()=>WebAssembly.Memory.prototype.grow.call(bounded.memory,1),RangeError);
  assert.equal(bounded.memory.buffer.byteLength,limits.maxBytes);
  assert.throws(()=>bounded.memory.grow(1),RangeError);
  assert.throws(bounded.assertAvailable,/WASM memory exhausted/);
});

test('native WASM failed over-allocation can retry within the same fixed engine maximum',()=>{
  const bounded=createNativeWasmMemory(limits.initialBytes+limits.pageBytes);
  assert.throws(()=>bounded.memory.grow(2),RangeError);assert.throws(bounded.assertAvailable,/exhausted/);
  bounded.memory.grow(1);bounded.assertAvailable();assert.equal(bounded.memory.buffer.byteLength,limits.initialBytes+limits.pageBytes);
});

test('owned native memory arguments reject unknown, duplicate, unaligned and raised limits before allocation or fork',()=>{
  assert.equal(nativeWasmWorkerLimit([]),limits.maxBytes);
  assert.equal(nativeWasmWorkerLimit([`--max-wasm-bytes=${limits.initialBytes}`]),limits.initialBytes);
  for(const value of [0,limits.initialBytes-1,limits.maxBytes+limits.pageBytes,limits.initialBytes+1,Infinity,NaN,1.5]){
    assert.throws(()=>nativeWasmMemoryLimit(value));assert.throws(()=>createNativeWasmMemory(value));
    assert.throws(()=>new StructureParser(10_000,undefined,undefined,true,undefined,value));
  }
  for(const args of [['--unknown=1'],['--max-wasm-bytes=1','--max-wasm-bytes=2'],['--max-wasm-bytes=1e9'],['--max-wasm-bytes=-1']])assert.throws(()=>nativeWasmWorkerLimit(args));
  assert.throws(()=>new StructureParser(10_000,'/foreign-worker',undefined,true,undefined,limits.initialBytes),/owned Tree-sitter worker/);
});

test('real bounded native worker reports allocation exhaustion, retires before recovery and preserves admitted facts',async()=>{
  const original=cp.fork,children:cp.ChildProcess[]=[];
  const observation=mock.method(cp,'fork',((...args:unknown[])=>{
    for(const child of children)assert.ok(child.exitCode!==null||child.signalCode!==null,'Previous WASM address space must exit before recovery');
    const child=Reflect.apply(original,cp,args);children.push(child);return child;
  }) as typeof cp.fork);syncBuiltinESMExports();
  const bounded=new StructureParser(10_000,undefined,undefined,true,undefined,limits.initialBytes),ordinary=new StructureParser();
  try{
    const source='// Original é😀\r\nint retained(void) { return 1; }\r\n';
    const expected=await ordinary.parse('c',source,{nativeOnly:true});await ordinary.closeAndWait();children.length=0;
    assert.deepEqual(await bounded.parse('c',source,{nativeOnly:true}),expected);
    const pressure='int owned_pressure = 1;\n'.repeat(200_000);
    await assert.rejects(bounded.parse('c',pressure,{nativeOnly:true}),/Native Tree-sitter WASM memory exhausted at 33554432 bytes/);
    assert.deepEqual(await bounded.parse('c',source,{nativeOnly:true}),expected);assert.equal(children.length,2);
    await bounded.closeAndWait();
    for(const child of children){assert.ok(child.exitCode!==null||child.signalCode!==null);assert.equal(child.listenerCount('message'),0);}
  }finally{await ordinary.closeAndWait();await bounded.closeAndWait();observation.mock.restore();syncBuiltinESMExports();}
});
