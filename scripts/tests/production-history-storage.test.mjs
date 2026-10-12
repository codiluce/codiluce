import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {HistoryStore} from '../../src/history/store.ts';
import {GraphBuilder} from '../../src/core/graph.ts';
import {productionGraphDigest} from '../production-graph-digest.mjs';
import {productionSnapshotDigest} from '../production-history-storage.mjs';

const proof={source:'filesystem',analyzer:'owned-fixture',analyzerVersion:'1',confidence:1};
function graph(commit,detail){
 const builder=new GraphBuilder('owned-history'),root=builder.id('repository'),file=builder.id('file','original.txt');builder.addEntity({id:root,type:'repository',name:'Original',metadata:{},evidence:[proof]});builder.contain({id:file,type:'file',name:'original.txt',path:'original.txt',parentId:root,metadata:{bytes:12,contentHash:'original hash',retained:{conditions:['original'],details:detail}},evidence:[{...proof,file:'original.txt'}]});builder.relate(root,file,'references',[{...proof,file:'original.txt',line:1},{...proof,file:'original.txt',line:1}],{retained:{original:'relationship metadata'}});builder.diagnose({analyzer:'owned-fixture',severity:'warning',code:'original-gap',reason:'Retain every diagnostic field',file:'original.txt',line:1,entityId:file});return builder.finish({id:randomUUID(),repositoryId:root,repositoryName:'Original',commitSha:commit,dirty:false,analyzedAt:new Date().toISOString(),schemaVersion:1,configDigest:'original',analyzerVersions:{'rust-symbols':'2','owned-fixture':'1'}});
}
test('actual SQLite source snapshots retain every full record across deduplication and read-only reopen',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'codiluce-history-storage-')),file=path.join(directory,'history.db');let store;
 try{
  store=new HistoryStore(file);const expected=[];
  for(const [commit,detail] of [['a'.repeat(40),'one'],['b'.repeat(40),'two']]){store.saveCommits([{sha:commit,tree:'c'.repeat(40),parents:[],authorName:'Owned',authorEmail:'fixture@example.invalid',authoredAt:'2026-01-01T00:00:00Z',committedAt:'2026-01-01T00:00:00Z',subject:'Original',body:''}]);const value=graph(commit,detail),snapshot=store.saveSnapshot(value,'owned-proof');expected.push({id:snapshot.id,digest:productionGraphDigest(value,{normalize:false})});assert.deepEqual(productionSnapshotDigest(store,snapshot.id),expected.at(-1).digest);}
  assert.equal(store.status().versions.entities,3,'Unchanged original entity payloads remain deduplicated');store.close();store=new HistoryStore(file,true);for(const row of expected)assert.deepEqual(productionSnapshotDigest(store,row.id),row.digest);
 }finally{store?.close();await rm(directory,{recursive:true});}
});
test('missing, altered or identity-corrupt stored payloads cannot qualify full graph parity',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'codiluce-history-storage-negative-'));let store;
 try{
  store=new HistoryStore(path.join(directory,'history.db'));const commit='a'.repeat(40);store.saveCommits([{sha:commit,tree:'c'.repeat(40),parents:[],authorName:'Owned',authorEmail:'fixture@example.invalid',authoredAt:'2026-01-01T00:00:00Z',committedAt:'2026-01-01T00:00:00Z',subject:'Original',body:''}]);const value=graph(commit,'one'),snapshot=store.saveSnapshot(value,'owned-proof'),expected=productionGraphDigest(value,{normalize:false});
  for(const mutate of [run=>run.id='changed payload UUID',run=>run.analyzedAt='changed timestamp',run=>run.analyzerVersions['rust-symbols']='1']){const run=structuredClone(value.run);mutate(run);store.db.prepare('UPDATE snapshots SET run=? WHERE id=?').run(JSON.stringify(run),snapshot.id);assert.notEqual(productionSnapshotDigest(store,snapshot.id).sha256,expected.sha256);}
  store.db.prepare('UPDATE snapshots SET run=? WHERE id=?').run(JSON.stringify(value.run),snapshot.id);
  const row=store.db.prepare("SELECT vid,data FROM entity_versions WHERE type='file'").get(),changed=JSON.parse(row.data);changed.metadata.retained.details='lost original detail';store.db.prepare('UPDATE entity_versions SET data=? WHERE vid=?').run(JSON.stringify(changed),row.vid);assert.notEqual(productionSnapshotDigest(store,snapshot.id).sha256,expected.sha256);
  changed.id='invented';store.db.prepare('UPDATE entity_versions SET data=? WHERE vid=?').run(JSON.stringify(changed),row.vid);assert.throws(()=>productionSnapshotDigest(store,snapshot.id),/identity differs/);assert.throws(()=>productionSnapshotDigest(store,'missing'),/snapshot is missing/);
 }finally{store?.close();await rm(directory,{recursive:true});}
});
