// Complete logical JSON hashing for the reviewed producer-1/2 comparison.
// Storage/provenance alone is normalized. Facts, array order, repeated proof
// occurrences, conditions, diagnostics and source coordinates stay present.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const profile={maxEntries:65536,maxEvidenceBytes:8*1024*1024,maxReferenceBytes:16*1024*1024,maxProofReferences:65536};
const omitted=value=>value===undefined||typeof value==='function'||typeof value==='symbol';
function keys(value){
 const array=Array.isArray(value),prototype=Object.getPrototypeOf(value);
 if(prototype!==(array?Array.prototype:Object.prototype)&&prototype!==null)throw Error('Logical graphs require plain JSON data');
 for(const [name,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))){
  if(descriptor.get||descriptor.set)throw Error('Logical graph accessors cannot execute');
  if(name==='toJSON'&&typeof descriptor.value==='function')throw Error('Logical graph serialization hooks cannot execute');
 }
 return Object.keys(value).sort();
}
function version(value){if(!['1','2'].includes(value))throw Error('Unreviewed Rust symbol producer');return '1';}
function fact(value){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Original Evidence must be a plain fact');
 keys(value);
 if(typeof value.source!=='string'||typeof value.analyzer!=='string'||typeof value.analyzerVersion!=='string'||typeof value.confidence!=='number'||!Number.isFinite(value.confidence)||value.confidence<0||value.confidence>1)throw Error('Invalid original Evidence identity');
 for(const item of Object.values(value))if(item!==null&&item!==undefined&&!['string','number','boolean'].includes(typeof item))throw Error('Encoded original Evidence fields must be primitive');
}
function project(entity,stats,expand=true){
 keys(entity);const metadata=entity.metadata;if(!metadata||typeof metadata!=='object')return entity;keys(metadata);
 if(Object.hasOwn(metadata,'rustEvidenceRetention'))throw Error('Failed Rust retention cannot qualify logical production parity');
 const table=metadata.rustSymbolEvidence;
 const outcomes=['rustCallOutcomes','rustReferenceOutcomes'];
 if(table===undefined){for(const key of outcomes)for(const row of metadata[key]??[])if(Object.hasOwn(row,'proofRefs'))throw Error('Original Evidence table missing');return entity;}
 keys(table);assert.deepEqual(Object.keys(table).sort(),['entries','evidenceBytes','limits','proofs','referenceBytes','version']);
 assert.equal(entity.type,'file');assert.equal(entity.language,'rust');assert.equal(table.version,1);assert.ok(Array.isArray(table.entries));keys(table.limits);assert.deepEqual(Object.keys(table.limits).sort(),Object.keys(profile).sort());
 for(const [key,max] of Object.entries(profile))assert.ok(Number.isSafeInteger(table.limits[key])&&table.limits[key]>0&&table.limits[key]<=max,'Invalid Evidence profile');
 assert.ok(table.limits.maxEvidenceBytes>=2&&table.entries.length<=table.limits.maxEntries);
 for(const entry of table.entries)fact(entry);
 assert.equal(Buffer.byteLength(JSON.stringify(table.entries)),table.evidenceBytes);assert.ok(table.evidenceBytes<=table.limits.maxEvidenceBytes);
 const result={...metadata};delete result.rustSymbolEvidence;let proofs=0,bytes=0,references=0;const used=new Set();
 for(const key of outcomes){
  assert.ok(Array.isArray(metadata[key]),'Outcome inventory must remain complete');
  result[key]=metadata[key].map(row=>{
   keys(row);assert.ok(!Object.hasOwn(row,'proof')&&Array.isArray(row.proofRefs),'Conflicting original Evidence representations');
   assert.ok(row.proofRefs.length<=table.limits.maxProofReferences);const proof=[];
   for(const index of row.proofRefs){assert.ok(Number.isSafeInteger(index)&&index>=0&&index<table.entries.length,'Invalid original Evidence reference');used.add(index);proof.push(table.entries[index]);}
   proofs++;references+=proof.length;bytes+=Buffer.byteLength(JSON.stringify(row.proofRefs));
   const copy={...row,proof};delete copy.proofRefs;return copy;
  });
 }
 assert.equal(proofs,table.proofs);assert.equal(bytes,table.referenceBytes);assert.ok(bytes<=table.limits.maxReferenceBytes);assert.equal(used.size,table.entries.length,'Unreferenced table data cannot be discarded');
 stats.files++;stats.proofs+=proofs;stats.references+=references;stats.entries+=table.entries.length;
 return expand?{...entity,metadata:result}:entity;
}
function* quoted(text){
 yield '"';
 for(let start=0;start<text.length;){let end=Math.min(start+4096,text.length);if(end<text.length&&text.charCodeAt(end-1)>=0xd800&&text.charCodeAt(end-1)<=0xdbff&&text.charCodeAt(end)>=0xdc00&&text.charCodeAt(end)<=0xdfff)end--;yield JSON.stringify(text.slice(start,end)).slice(1,-1);start=end;}
 yield '"';
}
function replacement(object,key,value,normalize=true){
 if(!normalize)return value;
 if(key==='analyzerVersion'&&object.analyzer==='rust-symbols'&&typeof object.source==='string'&&typeof object.confidence==='number')return version(value);
 if(key==='version'&&object.adapter==='rust'&&typeof object.compilation==='string'&&typeof object.scope==='string'&&typeof object.owner==='string')return version(value);
 return value;
}
function* tokens(root,maxDepth,memo,normalize){
 const stack=[{value:root,depth:0}],active=new WeakSet();
 while(stack.length){
  const task=stack.pop();
  if(task.frame){
   const {value,list}=task;let key,item,found=false;
   while(task.index<(list?list.length:value.length)){key=list?list[task.index]:task.index;task.index++;item=replacement(value,key,value[key],normalize);if(list&&omitted(item))continue;found=true;break;}
   if(!found){active.delete(value);yield list?'}':']';continue;}
   if(task.emitted++)yield ',';if(list){yield* quoted(key);yield ':';}
   stack.push(task,{value:list?item:omitted(item)?null:item,depth:task.depth+1});continue;
  }
  const value=task.value;if(task.depth>maxDepth)throw Error('Logical graph depth budget exceeded');
  if(typeof value==='string'){yield* quoted(value);continue;}
  if(value===null||typeof value!=='object'){if(typeof value==='bigint')throw Error('BigInt is not JSON');const text=JSON.stringify(value);if(text===undefined)throw Error('Unsupported root JSON value');yield text;continue;}
  if(active.has(value))throw Error('Logical graph cycle');
  const known=memo.get(value);if(known!==undefined){if(task.depth+1>maxDepth)throw Error('Logical graph depth budget exceeded');yield known;continue;}
  const list=keys(value),array=Array.isArray(value);
  // A synchronous digest admits no application callbacks. Each duplicate
  // occurrence emits its complete canonical fact; memoization never drops it.
  if(!array&&typeof value.source==='string'&&typeof value.analyzer==='string'&&typeof value.analyzerVersion==='string'&&typeof value.confidence==='number'&&Object.values(value).every(item=>item===null||item===undefined||['string','number','boolean'].includes(typeof item))&&Object.values(value).reduce((n,item)=>n+(typeof item==='string'?item.length:0),0)<=16384){
   if(task.depth+1>maxDepth)throw Error('Logical graph depth budget exceeded');
   const text='{'+list.filter(key=>!omitted(value[key])).map(key=>JSON.stringify(key)+':'+JSON.stringify(replacement(value,key,value[key],normalize))).join(',')+'}';memo.set(value,text);yield text;continue;
  }
  active.add(value);yield array?'[':'{';stack.push({frame:true,value,list:array?undefined:list,index:0,emitted:0,depth:task.depth});
 }
}

export function productionGraphDigest(graph,options={}){
 keys(graph);assert.deepEqual(Object.keys(graph).sort(),['diagnostics','entities','relations','run','schemaVersion']);assert.equal(graph.schemaVersion,1);
 for(const group of ['entities','relations','diagnostics'])assert.ok(Array.isArray(graph[group]));
 return productionRecordDigest(graph.run,{entities:graph.entities,relations:graph.relations,diagnostics:graph.diagnostics},options);
}

/** Consume complete sorted records one at a time, including SQLite JSON
 * readback. This emits the identical public graph JSON, not a projection. */
export function productionRecordDigest(originalRun,records,{maxBytes=1024*1024*1024,maxDepth=4096,normalize=true}={}){
 assert.equal(typeof normalize,'boolean');
 assert.ok(Number.isSafeInteger(maxBytes)&&maxBytes>0&&Number.isSafeInteger(maxDepth)&&maxDepth>0);keys(records);assert.deepEqual(Object.keys(records).sort(),['diagnostics','entities','relations']);keys(originalRun);assert.equal(originalRun.schemaVersion,1);keys(originalRun.analyzerVersions);
 const run=normalize?{...originalRun,analyzerVersions:{...originalRun.analyzerVersions,'rust-symbols':version(originalRun.analyzerVersions['rust-symbols'])}}:originalRun;if(normalize){delete run.id;delete run.analyzedAt;}
 const hash=createHash('sha256'),memo=new WeakMap(),storage={files:0,proofs:0,references:0,entries:0},buffer=Buffer.allocUnsafe(65536);let bytes=0,used=0,peakChunkBytes=0;
 const emit=text=>{const chunk=Buffer.from(text);if(bytes+chunk.length>maxBytes)throw Error('Logical graph byte budget exceeded');bytes+=chunk.length;let offset=0;while(offset<chunk.length){const size=Math.min(buffer.length-used,chunk.length-offset);chunk.copy(buffer,used,offset,offset+size);used+=size;offset+=size;if(used===buffer.length){peakChunkBytes=Math.max(peakChunkBytes,used);hash.update(buffer);used=0;}}};
 emit('{"schemaVersion":1,"run":');for(const token of tokens(run,maxDepth,memo,normalize))emit(token);
 const counts={};
 for(const group of ['entities','relations','diagnostics']){
  assert.ok(records[group]&&typeof records[group][Symbol.iterator]==='function','Complete record stream unavailable');emit(',"'+group+'":[');const ids=new Set();let previous,index=0;
  for(const original of records[group]){
   keys(original);assert.equal(typeof original.id,'string');assert.ok(!ids.has(original.id)&&(!previous||previous<original.id),'Complete graph records must have unique sorted IDs');ids.add(original.id);previous=original.id;
   if(index++)emit(',');const value=group==='entities'?project(original,storage,normalize):original;
   for(const token of tokens(value,maxDepth,memo,normalize))emit(token);
  }
  counts[group]=index;emit(']');
 }
 emit('}');if(used){peakChunkBytes=Math.max(peakChunkBytes,used);hash.update(buffer.subarray(0,used));}
 return {format:'complete-logical-production-json-v1',sha256:hash.digest('hex'),bytes,counts,storage,peakChunkBytes,normalization:normalize?['run UUID/time','Rust symbol Evidence/outcome producer 2 to 1','exact ordered file-table proof expansion; storage container only']:[]};
}
