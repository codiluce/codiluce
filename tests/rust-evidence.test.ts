import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Evidence } from '../src/core/graph.js';
import { RustEvidenceEncoder, RUST_EVIDENCE_LIMITS, rustOutcomeEvidence, snapshotRustEvidence } from '../src/analysis/rust-evidence.js';

const fact=(line=1):Evidence=>({source:'syntax',analyzer:'rust-symbols',analyzerVersion:'2',confidence:1,file:'src/😀.rs',line,explanation:'Original "source"\r\n\u0000 and \ud800'});
test('Rust evidence tables preserve every original field, duplicate occurrence and proof order',()=>{
  const first=fact(),second=fact(2),proof=[first,second,{...first},first];const encoder=new RustEvidenceEncoder(),refs=encoder.reference(proof),again=encoder.reference([second,first]),table=encoder.seal();
  assert.deepEqual(refs,[0,1,0,0]);assert.deepEqual(again,[1,0]);assert.equal(table.entries.length,2);assert.equal(table.proofs,2);assert.equal(table.evidenceBytes,Buffer.byteLength(JSON.stringify(table.entries)));assert.equal(table.referenceBytes,Buffer.byteLength(JSON.stringify(refs))+Buffer.byteLength(JSON.stringify(again)));
  const roundTrip=JSON.parse(JSON.stringify({rustSymbolEvidence:table,outcome:{proofRefs:refs}}));assert.equal(JSON.stringify(rustOutcomeEvidence(roundTrip,roundTrip.outcome)),JSON.stringify(proof));
});
test('Rust evidence snapshots and cached identities follow later original-field mutations',()=>{
  const original=fact(),encoder=new RustEvidenceEncoder(),before=encoder.reference([original]);original.line=2;const after=encoder.reference([original]);Object.assign(original,{extra:'original extension'});const extended=encoder.reference([original]);const table=encoder.seal();original.explanation='changed later';
  assert.deepEqual(before,[0]);assert.deepEqual(after,[1]);assert.deepEqual(extended,[2]);assert.equal(table.entries[0]!.line,1);assert.equal(table.entries[1]!.line,2);assert.equal((table.entries[2] as unknown as Record<string,unknown>).extra,'original extension');assert.notEqual(table.entries[2]!.explanation,original.explanation);
});
test('Rust evidence admission is atomic when a new row exceeds its table-entry budget',()=>{
  const encoder=new RustEvidenceEncoder({maxEntries:2});assert.deepEqual(encoder.reference([fact()]),[0]);assert.throws(()=>encoder.reference([fact(2),fact(3)]),/budget/);assert.deepEqual(encoder.reference([fact(2)]),[1]);const table=encoder.seal();assert.equal(table.entries.length,2);assert.equal(table.proofs,2);assert.equal(table.referenceBytes,6);
});
test('Rust evidence exact UTF-8 table payload limits admit the boundary and reject the next fact',()=>{
  const bytes=Buffer.byteLength(JSON.stringify([fact()])),encoder=new RustEvidenceEncoder({maxEvidenceBytes:bytes});assert.deepEqual(encoder.reference([fact()]),[0]);assert.throws(()=>encoder.reference([fact(2)]),/payload budget/);assert.equal(encoder.seal().evidenceBytes,bytes);
  const denied=new RustEvidenceEncoder({maxEvidenceBytes:bytes-1});assert.throws(()=>denied.reference([fact()]),/payload budget/);assert.equal(denied.seal().entries.length,0);
});
test('Rust evidence counts all repeated references against per-proof and cumulative byte limits',()=>{
  const encoder=new RustEvidenceEncoder({maxReferenceBytes:5,maxProofReferences:2});assert.deepEqual(encoder.reference([fact(),fact()]),[0,0]);assert.throws(()=>encoder.reference([]),/reference payload budget/);assert.throws(()=>encoder.reference([fact(),fact(),fact()]),/per-proof/);const table=encoder.seal();assert.equal(table.referenceBytes,5);assert.equal(table.proofs,1);
});
test('Rust evidence rejects unsafe/unknown limits and cannot expand beyond the declared profile',()=>{
  for(const limits of [{maxEntries:0},{maxEntries:1.5},{maxEntries:NaN},{maxEntries:Infinity},{maxEntries:Number.MAX_SAFE_INTEGER},{maxEvidenceBytes:1},{extra:1}])assert.throws(()=>new RustEvidenceEncoder(limits),/limit/);assert.equal(new RustEvidenceEncoder().seal().limits.maxEntries,RUST_EVIDENCE_LIMITS.maxEntries);
});
test('Rust evidence never executes custom object hooks or accessors',()=>{
  let ran=false;const encoder=new RustEvidenceEncoder(),getter={...fact()};Object.defineProperty(getter,'explanation',{enumerable:true,get(){ran=true;return 'generated';}});assert.throws(()=>encoder.reference([getter]),/accessors/);assert.equal(ran,false);
  assert.throws(()=>encoder.reference([{...fact(),toJSON(){ran=true;return fact();}} as Evidence]),/primitive/);assert.equal(ran,false);assert.throws(()=>encoder.reference([Object.assign(new Date(),fact())]),/plain/);assert.throws(()=>encoder.reference([{...fact(),confidence:NaN}]),/identity/);
});
test('Rust evidence rejects non-enumerable serialization hooks before they can execute',()=>{
  let ran=false;const original=fact();Object.defineProperty(original,'toJSON',{value(){ran=true;return fact(2);}});
  const encoder=new RustEvidenceEncoder();assert.throws(()=>encoder.reference([original]),/primitive/);assert.equal(ran,false);const table=encoder.seal();assert.equal(table.entries.length,0);assert.equal(table.proofs,0);
  assert.throws(()=>rustOutcomeEvidence({}, {proof:[original]}),/primitive/);assert.equal(ran,false);
});
test('Rust evidence reads old expanded proofs and rejects ambiguous/missing/corrupt compact data',()=>{
  assert.deepEqual(rustOutcomeEvidence({}, {proof:[fact(),fact()]}),[fact(),fact()]);const encoder=new RustEvidenceEncoder(),refs=encoder.reference([fact()]),metadata={rustSymbolEvidence:encoder.seal()};assert.deepEqual(rustOutcomeEvidence(metadata,{proofRefs:refs}),[fact()]);
  for(const proofRefs of [[-1],[0.5],[1],[NaN],['0'],null])assert.throws(()=>rustOutcomeEvidence(metadata,{proofRefs}),/Invalid/);assert.throws(()=>rustOutcomeEvidence(metadata,{proof:[],proofRefs:[]}),/Conflicting/);assert.throws(()=>rustOutcomeEvidence({}, {proofRefs:[]}),/unavailable/);assert.throws(()=>rustOutcomeEvidence({rustSymbolEvidence:{...metadata.rustSymbolEvidence,version:2}}, {proofRefs:refs}),/unavailable/);
});
test('Rust evidence empty and sealed tables retain exact accounting without later mutation',()=>{
  const encoder=new RustEvidenceEncoder({maxEvidenceBytes:2}),refs=encoder.reference([]),table=encoder.seal();assert.equal(table.evidenceBytes,2);assert.equal(table.referenceBytes,2);assert.deepEqual(rustOutcomeEvidence({rustSymbolEvidence:table},{proofRefs:refs}),[]);assert.throws(()=>encoder.reference([fact()]),/sealed/);assert.throws(()=>encoder.seal(),/sealed/);
});
test('Rust evidence storage scales with distinct facts while retaining thousands of original proof occurrences',()=>{
  const proof=Array.from({length:1000},(_,i)=>fact(i%3)),encoder=new RustEvidenceEncoder();const outcomes=Array.from({length:20},()=>({proofRefs:encoder.reference(proof)})),metadata={rustSymbolEvidence:encoder.seal()};assert.equal(metadata.rustSymbolEvidence.entries.length,3);assert.ok(Buffer.byteLength(JSON.stringify({metadata,outcomes}))<Buffer.byteLength(JSON.stringify(Array(20).fill({proof})))/20);
  for(const row of outcomes)assert.equal(JSON.stringify(rustOutcomeEvidence(metadata,row)),JSON.stringify(proof));
});
test('immutable Rust snapshots preserve original JSON without freezing public facts',()=>{
  const original=fact(),snapshot=snapshotRustEvidence(original),encoder=new RustEvidenceEncoder();
  assert.equal(Object.isFrozen(snapshot),true);assert.equal(Object.isFrozen(original),false);assert.equal(JSON.stringify(snapshot),JSON.stringify(original));
  original.line=99;assert.deepEqual(encoder.reference([snapshot,snapshot]),[0,0]);assert.deepEqual(encoder.reference([original]),[1]);assert.equal(encoder.seal().entries[0]!.line,1);
});
test('frozen fact admission still rejects accessors, hidden hooks and invalid identities',()=>{
  let ran=false;
  for(const create of [()=>{const value=fact();Object.defineProperty(value,'toJSON',{value(){ran=true;return fact(2);}});return value;},()=>{const value=fact();Object.defineProperty(value,'line',{get(){ran=true;return 2;}});return value;},()=>({...fact(),confidence:Infinity})]){
    const value=Object.freeze(create());assert.throws(()=>snapshotRustEvidence(value));assert.throws(()=>new RustEvidenceEncoder().reference([value]));assert.equal(ran,false);
  }
});
test('frozen cached facts cannot publish references from an atomically rejected row',()=>{
  const one=snapshotRustEvidence(fact()),two=snapshotRustEvidence(fact(2)),three=snapshotRustEvidence(fact(3)),encoder=new RustEvidenceEncoder({maxEntries:2});
  assert.deepEqual(encoder.reference([one]),[0]);assert.throws(()=>encoder.reference([two,three,two]),/budget/);assert.deepEqual(encoder.reference([three,three]),[1,1]);assert.throws(()=>encoder.reference([two]),/budget/);const table=encoder.seal();assert.equal(table.entries[1]!.line,3);assert.equal(table.proofs,2);assert.equal(table.referenceBytes,8);
});
test('fact mutation before freezing and late hidden hooks never reuse stale mutable admission',()=>{
  const value=fact(),encoder=new RustEvidenceEncoder();assert.deepEqual(encoder.reference([value]),[0]);value.line=2;Object.freeze(value);assert.deepEqual(encoder.reference([value,value]),[1,1]);assert.equal(encoder.seal().entries[1]!.line,2);
  const mutable=fact(),another=new RustEvidenceEncoder();another.reference([mutable]);let ran=false;Object.defineProperty(mutable,'toJSON',{value(){ran=true;return fact(99);}});assert.throws(()=>another.reference([mutable]),/primitive/);assert.equal(ran,false);
});
test('direct cached indices retain exact decimal reference byte accounting across digit boundaries',()=>{
  const facts=Array.from({length:105},(_,i)=>snapshotRustEvidence(fact(i))),encoder=new RustEvidenceEncoder();const first=encoder.reference(facts),second=encoder.reference([facts[0]!,facts[9]!,facts[10]!,facts[99]!,facts[100]!,facts[104]!]);const table=encoder.seal();assert.equal(table.referenceBytes,Buffer.byteLength(JSON.stringify(first))+Buffer.byteLength(JSON.stringify(second)));assert.equal(table.entries.length,105);
});
test('symbol-keyed getters cannot execute during immutable snapshot admission',()=>{
  let ran=false;const original=fact();Object.defineProperty(original,Symbol('extra'),{enumerable:true,get(){ran=true;return 'generated';}});
  assert.throws(()=>snapshotRustEvidence(original),/accessors/);assert.throws(()=>new RustEvidenceEncoder().reference([Object.freeze(original)]),/accessors/);assert.equal(ran,false);
});
