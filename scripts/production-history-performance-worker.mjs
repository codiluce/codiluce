// Actual indexHistory with native jobs/messages/save/ACKs. Full graph and raw
// column verification begin only after the external sampler acknowledges end.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {productionSnapshotDigest} from './production-history-storage.mjs';
import {snapshotStorageLedger} from './production-history-storage-ledger.mjs';
import {processPeakRssKiB} from './process-memory.mjs';

const request=JSON.parse(await readFile(process.argv[2],'utf8'));
const fromEngine=file=>import(pathToFileURL(path.join(request.engine,file)).href);
const [{indexHistory,historyIdentity},{HistoryStore}]=await Promise.all([fromEngine('src/history/indexer.ts'),fromEngine('src/history/store.ts')]);
assert.equal(historyIdentity(request.record.config),request.record.historyIdentity);
const acknowledge=type=>new Promise((resolve,reject)=>{
 const cleanup=()=>{process.off('message',receive);process.off('disconnect',disconnected);};
 const disconnected=()=>{cleanup();reject(Error('Observer disconnected before measurement acknowledgement'));};
 const receive=message=>{if(message?.type===type){cleanup();resolve();}};
 process.on('message',receive);process.once('disconnect',disconnected);process.send({type:type==='go'?'begin':'end'},error=>{if(error){cleanup();reject(error);}});
});
await acknowledge('go');
const started=performance.now(),events=[],indexed=await indexHistory({root:request.root,stateDirectory:request.state,ref:request.record.head,commits:request.record.revisions.map(r=>r.commit),jobs:2,onProgress:event=>events.push(event)}),milliseconds=performance.now()-started,parentVmHwmKiB=processPeakRssKiB();
await acknowledge('digest-go');
const count=request.record.revisions.length;assert.deepEqual(indexed,{ref:request.record.head,head:request.record.head,indexed:count,failed:0,skipped:0,snapshots:count});
const plans=events.filter(e=>e.type==='plan');assert.equal(plans.length,1);assert.equal(plans[0].pending,count);assert.equal(plans[0].targets,count);assert.equal(plans[0].jobs,2);assert.equal(events.filter(e=>e.type==='failed').length,0);
const database=path.join(request.state,'history.db'),baselineDatabase=path.join(request.baselineDirectory,request.record.database);
let history=new HistoryStore(database);history.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();history.close();history=new HistoryStore(database,true);
const original=new HistoryStore(baselineDatabase,true),result={schema:1,passed:false,milliseconds,parentVmHwmKiB,indexed,plan:plans[0],revisions:[],database};
const withoutVolatile=run=>{const {id,analyzedAt,...rest}=run;return rest;};
try{
 const snapshots=history.snapshots();assert.equal(snapshots.length,count);assert.equal(new Set(snapshots.map(r=>r.commitSha)).size,count);assert.equal(new Set(snapshots.map(r=>r.id)).size,count);
 for(const snapshot of snapshots){
  const prior=request.record.revisions.find(r=>r.commit===snapshot.commitSha);assert.ok(prior);const previous=original.snapshot(prior.snapshot.id);assert.ok(previous);assert.deepEqual(withoutVolatile(snapshot.run),withoutVolatile(previous.run));
  const logical=productionSnapshotDigest(history,snapshot.id),view={db:history.db,snapshot:id=>{assert.equal(id,snapshot.id);return {...snapshot,run:{...snapshot.run,id:previous.run.id,analyzedAt:previous.run.analyzedAt}};}},canonical=productionSnapshotDigest(view,snapshot.id);
  assert.deepEqual(canonical,prior.logical,'Complete saved graph differs from qualified original');assert.deepEqual(logical.normalization,[]);
  result.revisions.push({commit:snapshot.commitSha,snapshot:{id:snapshot.id,seq:snapshot.seq},status:'verified',logical,canonical:{sha256:canonical.sha256,bytes:canonical.bytes},volatileFields:['run.id','run.analyzedAt']});
 }
 const savedEvents=events.filter(e=>e.type==='indexed');assert.equal(savedEvents.length,count);for(const event of savedEvents){const r=result.revisions.find(r=>r.commit===event.commit.sha);assert.ok(r);assert.equal(event.snapshot.id,r.snapshot.id);assert.equal(event.snapshot.seq,r.snapshot.seq);}
 result.snapshotColumnLedger=snapshotStorageLedger(history.db);result.passed=true;
}finally{history.close();original.close();await writeFile(request.result,JSON.stringify(result,null,2)+'\n',{flag:'wx'});}
await new Promise((resolve,reject)=>process.send({type:'result',result},error=>error?reject(error):resolve()));process.disconnect();
