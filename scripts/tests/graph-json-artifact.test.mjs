import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {GRAPH_ARTIFACT_LIMITS,writeGraphArtifact} from '../graph-json-artifact.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t){const root=await mkdtemp(path.join(tmpdir(),'codiluce-graph-json-test-'));t.after(()=>rm(root,{recursive:true,force:true}));return path.join(root,'graph.json');}
test('exact native JSON bytes, hash and complete graph records survive small output chunks',async t=>{
  const file=await fixture(t),value={schemaVersion:1,run:{revision:'original'},entities:[{id:'one',metadata:{quote:'"\\\n\t\r\b\f\u0000',unicode:'é😀\u2028',number:1e30}}],relations:[],diagnostics:[{reason:'complete'}]},expected=Buffer.from(JSON.stringify(value)+'\n');
  const result=await writeGraphArtifact(file,value,{chunkBytes:7});assert.deepEqual(await readFile(file),expected);assert.equal(result.sha256,sha(expected));assert.equal(result.bytes,expected.length);assert.ok(result.peakChunkBytes<=7);assert.equal(result.serialization,'lossless-plain-json-chunks');
});
test('surrogate pairs at every escape-slice boundary and lone surrogates match native JSON',async t=>{
  const file=await fixture(t),value={['k'.repeat(4095)+'😀']:['x'.repeat(4095)+'😀'+'y'.repeat(4095)+'😀','\ud800','\udfff','a\ud800\ud800\udfff\udfff', '😀'.repeat(5000)]};await writeGraphArtifact(file,value,{chunkBytes:31});assert.deepEqual(await readFile(file),Buffer.from(JSON.stringify(value)+'\n'));
});
test('omitted object values, array holes, shared objects and nonfinite numbers preserve JSON semantics',async t=>{
  const file=await fixture(t),shared={same:true},array=[undefined,()=>{},Symbol('x'),NaN,Infinity,-Infinity,-0,shared,shared];array[12]=null;
  const value={missing:undefined,call:()=>{},symbol:Symbol('x'),array,shared};await writeGraphArtifact(file,value);assert.deepEqual(await readFile(file),Buffer.from(JSON.stringify(value)+'\n'));
});
test('an exact byte limit includes the final newline; overflow stays a retained partial artifact',async t=>{
  const file=await fixture(t),value={complete:'é😀'},expected=Buffer.from(JSON.stringify(value)+'\n');await writeGraphArtifact(file,value,{maxBytes:expected.length,chunkBytes:5});
  const failed=file+'.limited';let failure;await assert.rejects(writeGraphArtifact(failed,value,{maxBytes:expected.length-1,chunkBytes:5}),error=>{failure=error;return /byte limit/.test(error.message);});await assert.rejects(readFile(failed),{code:'ENOENT'});const partial=await readFile(failure.partialArtifact.file);assert.equal(partial.length,failure.partialArtifact.bytes);assert.equal(sha(partial),failure.partialArtifact.sha256);assert.ok(partial.length<=expected.length-1);assert.ok(expected.subarray(0,partial.length).equals(partial));
});
test('cycles fail without rejecting shared acyclic graph objects',async t=>{
  const file=await fixture(t),value={};value.loop=value;let failure;await assert.rejects(writeGraphArtifact(file,value),error=>{failure=error;return /cycle/.test(error.message);});await assert.rejects(readFile(file),{code:'ENOENT'});assert.equal(sha(await readFile(file+'.pending')),failure.partialArtifact.sha256);
});
test('deep JSON uses iterative traversal and keeps its explicit depth boundary',async t=>{
  const file=await fixture(t);let value='original';for(let index=0;index<1200;index++)value={child:value};await writeGraphArtifact(file,value,{maxDepth:1200});assert.deepEqual(await readFile(file),Buffer.from(JSON.stringify(value)+'\n'));await assert.rejects(writeGraphArtifact(file+'.limited',value,{maxDepth:1199}),/depth limit/);
});
test('invalid roots, BigInt and nonplain objects are failed inputs, without executing custom toJSON',async t=>{
  for(const value of [undefined,1n,new Date(),new Map()]){const file=await fixture(t);await assert.rejects(writeGraphArtifact(file,value));await assert.rejects(readFile(file),{code:'ENOENT'});}
  let called=false;class Executable{toJSON(){called=true;return 'never';}}const file=await fixture(t);await assert.rejects(writeGraphArtifact(file,new Executable()),/plain JSON/);assert.equal(called,false);
  const plain=await fixture(t);await assert.rejects(writeGraphArtifact(plain,{toJSON(){called=true;return 'never';}}),/custom toJSON/);assert.equal(called,false);
});
test('limits cannot silently select unknown, unbounded or excessively large buffers',async t=>{
  for(const options of [{maxBytes:0},{chunkBytes:0},{maxDepth:Infinity},{maxBytes:1.5},{chunkBytes:1024*1024+1},{unknown:1}])await assert.rejects(writeGraphArtifact(await fixture(t),{},options));assert.equal(GRAPH_ARTIFACT_LIMITS.maxBytes,1024*1024*1024);
});
test('existing complete and pending observations are never overwritten',async t=>{
  const file=await fixture(t);await writeFile(file,'prior original');await assert.rejects(writeGraphArtifact(file,{next:true}),{code:'EEXIST'});assert.equal(await readFile(file,'utf8'),'prior original');assert.equal(await readFile(file+'.pending','utf8'),'{"next":true}\n');await assert.rejects(writeGraphArtifact(file,{again:true}),{code:'EEXIST'});assert.equal(await readFile(file+'.pending','utf8'),'{"next":true}\n');
});
test('an expanded shared payload is streamed in full without truncating repeated records',async t=>{
  const file=await fixture(t),shared={original:'😀\\\n'.repeat(4096)},value={entities:Array(64).fill(shared),relations:[],diagnostics:[]},expected=Buffer.from(JSON.stringify(value)+'\n');const result=await writeGraphArtifact(file,value,{chunkBytes:8192});assert.equal(result.bytes,expected.length);assert.equal(result.sha256,sha(expected));assert.ok(result.peakChunkBytes<=8192);assert.deepEqual(await readFile(file),expected);assert.equal(JSON.parse((await readFile(file)).toString()).entities.length,64);
});
