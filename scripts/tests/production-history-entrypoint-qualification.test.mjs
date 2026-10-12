import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {verifyEntrypointQualification} from '../qualify-production-history-entrypoint.mjs';

const hash=text=>createHash('sha256').update(text).digest('hex');
function fixture(){
 const commits=['a'.repeat(40),'b'.repeat(40),'c'.repeat(40)],head=commits[1],corpus={repositories:[{id:'owned',head,revisions:commits.slice(0,2).map(commit=>({commit})),extraRevisions:[{commit:commits[2]}]}]},prior={id:'owned',status:'verified',head,readOnlyReopenVerified:true,worker:{pid:10,exitCode:0,signal:null},revisions:[]};
 const revisions=commits.map((commit,index)=>{
  const logical={format:'complete-logical-production-json-v1',sha256:hash('fresh'+commit),bytes:100,counts:{entities:1,relations:0,diagnostics:0},storage:{files:0,proofs:0,references:0,entries:0},peakChunkBytes:100,normalization:[]},old={...logical,sha256:hash('old'+commit)},graphInputs={commit,fileEntities:1,hashedOriginalSources:1,originalSymlinksExcludedFromFileEntities:true},original={recordDigest:hash(commit),regularFiles:1,literalSymlinks:1,unhydratedGitlinks:1,originalBytes:20};
  prior.revisions.push({commit,status:'verified',original,graphInputs,logical:old,readback:old,snapshot:{id:'old-'+index,seq:index+1}});
  return {commit,workerPid:index<2?20:21,status:'verified',acknowledged:true,logical,readback:logical,original:{commit,recordDigest:original.recordDigest,entries:3,bytes:20,literalSymlinks:1,symlinkTargetsFollowed:false},graphInputs,baselineComparison:{sha256:old.sha256,bytes:100,volatileFields:['run.id','run.analyzedAt']},snapshot:{id:'new-'+index,seq:index+1,stats:{entities:1}}};
 });
 const tables=Object.fromEntries(['snapshots','entity_versions','relation_versions','diagnostic_versions','snapshot_entities','snapshot_relations','snapshot_diagnostics'].map(name=>[name,{rows:name==='snapshots'?3:1,sha256:hash(name),columns:['owned'],bytes:20,largestTextBytes:10}])),views={passed:true,freshServicePasses:2,persistedBaseRegistryUnchanged:true,offFirstParentSnapshots:1,snapshots:revisions.map((r,index)=>({id:r.snapshot.id,commit:r.commit,entities:1,projectedNodes:2,holes:0,cachedFirstParent:index<2,rectangleSha256:hash(r.commit)}))};
 const child={id:'owned',pid:30,passed:true,completedAt:'terminal',readOnlyReopenVerified:true,revisions,snapshotColumnLedger:{tables},views,workers:[{pid:21,job:{commits:commits.slice(2)},results:commits.slice(2),acknowledgements:commits.slice(2),exitCode:0,signal:null},{pid:20,job:{commits:commits.slice(0,2)},results:commits.slice(0,2),acknowledgements:commits.slice(0,2),exitCode:0,signal:null}],stages:['fresh','resume'].map((name,index)=>({name,indexed:{ref:head,head,indexed:index===0?3:0,failed:0,skipped:index===0?0:3,snapshots:3},events:[{type:'plan',targets:3,head,pending:index===0?3:0,jobs:index===0?2:1},{type:'layout',snapshots:2,rebuilt:index===0},...(index===0?revisions.map(r=>({type:'indexed',commit:{sha:r.commit},snapshot:r.snapshot})):[])]}))};
 const baseline={passed:true,completedAt:'terminal',engineIdentity:{sha256:'old-engine'},corpusSha256:'owned',profilesSha256:'owned',repositories:[prior]},receipt={schema:1,startedAt:'started',passed:true,completedAt:'terminal',phase:'fresh-production-indexHistory-entrypoint-workers-and-resume',engineIdentity:{sha256:'new-engine'},baselineEngineSha256:'old-engine',observer:{},corpusSha256:'owned',profilesSha256:'owned',baselineReceiptSha256:'owned',repositories:[{id:'owned',passed:true,completedAt:'terminal',process:{pid:30,exitCode:0,signal:null,treePeakKiB:100},child,originalDatabaseUnchanged:true,originalDatabaseSha256:'original-db',databaseSha256:'fresh-db'}]};
 const audit={id:'owned',passed:true,completedAt:'terminal',database:{sha256:'fresh-db',sha256After:'fresh-db',completeColumnLedgersMatch:true,tables},revisions:3,actualSnapshotIdentities:revisions.map(r=>({id:r.snapshot.id,seq:r.snapshot.seq,commit:r.commit}))},input={},columns=[{id:'owned',audit,input,child,job:{record:prior}}],value={corpus,receipt,baseline,columns};recapture(value);return value;
}
function recapture(value){const {receipt,columns}=value;columns[0].input={receiptUtf8:JSON.stringify(receipt),receiptSha256:hash(JSON.stringify(receipt))};columns[0].audit.inputReceiptSha256=columns[0].input.receiptSha256;}

test('fresh history qualification joins exact UUIDs and original graph/source digests despite reversed worker birth order',()=>{
 const value=fixture(),result=verifyEntrypointQualification(value);assert.equal(result.revisions,3);assert.equal(result.workers,2);assert.equal(result.cachedFirstParentSnapshots,2);assert.equal(result.offFirstParentSnapshots,1);assert.equal(result.publicViewNodes,6);assert.equal(result.independentCompleteColumnLedgers,7);assert.equal(result.full195RevisionEntrypointQualified,undefined,'Owned fixtures cannot declare a full-production gate');
});

const cases=[
 ['unterminated job',v=>delete v.receipt.completedAt],
 ['equal-count commit replacement',v=>{v.receipt.repositories[0].child.revisions[0].commit='d'.repeat(40);}],
 ['duplicate repository',v=>v.receipt.repositories.push(v.receipt.repositories[0])],
 ['reordered contiguous chunk',v=>v.receipt.repositories[0].child.workers[1].job.commits.reverse()],
 ['lost worker acknowledgement',v=>v.receipt.repositories[0].child.workers[1].acknowledgements.pop()],
 ['signal-terminated actual worker',v=>{v.receipt.repositories[0].child.workers[0].signal='SIGTERM';}],
 ['normalized worker payload',v=>{v.receipt.repositories[0].child.revisions[0].logical.normalization=['hidden'];}],
 ['extra cross-run normalization',v=>v.receipt.repositories[0].child.revisions[0].baselineComparison.volatileFields.push('storage')],
 ['different original source bytes',v=>{v.receipt.repositories[0].child.revisions[0].original.recordDigest=hash('changed');}],
 ['lost gitlink inventory',v=>{v.receipt.repositories[0].child.revisions[0].original.entries=2;}],
 ['equal-count different baseline graph',v=>{v.receipt.repositories[0].child.revisions[0].baselineComparison.sha256=hash('changed');}],
 ['substituted worker UUID',v=>{v.receipt.repositories[0].child.revisions[0].snapshot.id='other-uuid';}],
 ['hidden SQLite column loss',v=>{v.columns[0].audit.database.tables=structuredClone(v.columns[0].audit.database.tables);v.columns[0].audit.database.tables.entity_versions.sha256=hash('hidden');}],
 ['public-view hole',v=>{v.receipt.repositories[0].child.views.snapshots[0].holes=1;}],
 ['different indexed-event UUID',v=>{v.receipt.repositories[0].child.stages[0].events[2].snapshot={...v.receipt.repositories[0].child.stages[0].events[2].snapshot,id:'other-event-uuid'};}],
 ['resume still has pending commits',v=>{v.receipt.repositories[0].child.stages[1].events[0].pending=1;}],
 ['resume rebuilt registry',v=>{v.receipt.repositories[0].child.stages[1].events[1].rebuilt=true;}],
 ['changed persisted registry',v=>{v.receipt.repositories[0].child.views.persistedBaseRegistryUnchanged=false;}],
 ['changed read-only bytes',v=>{v.columns[0].audit.database.sha256After='changed';}],
 ['unqualified job input record',v=>{v.columns[0].job.record={...v.columns[0].job.record,head:'changed'};}],
];
for(const [name,mutate] of cases)test('fresh history qualification rejects '+name,()=>{const value=fixture();mutate(value);recapture(value);assert.throws(()=>verifyEntrypointQualification(value));});
test('fresh history qualification refuses an independent audit captured from another equal-count terminal row',()=>{
 const value=fixture();value.columns[0].input.receiptUtf8=value.columns[0].input.receiptUtf8.replace('fresh-db','substituted-db');value.columns[0].input.receiptSha256=hash(value.columns[0].input.receiptUtf8);value.columns[0].audit.inputReceiptSha256=value.columns[0].input.receiptSha256;assert.throws(()=>verifyEntrypointQualification(value),/terminal row differs/);
});
