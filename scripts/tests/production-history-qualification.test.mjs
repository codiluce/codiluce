import assert from 'node:assert/strict';
import test from 'node:test';
import {verifyHistoryQualification} from '../qualify-production-history.mjs';

const stamp='2026-10-12T00:00:00Z',digest='a'.repeat(64);
function fixture(){
 const inputs={engineSha256:digest,corpusSha256:digest,profilesSha256:digest};
 const graph={sha256:digest,bytes:400,counts:{entities:2,relations:0,diagnostics:0},normalization:[]};
 const placement={id:'original-uuid',commit:'original-commit',entities:2,projectedNodes:2,holes:0,rectangleSha256:digest};
 const stored={commit:'original-commit',status:'verified',completedAt:stamp,logical:graph,readback:structuredClone(graph),snapshot:{id:'original-uuid',seq:1},original:{recordDigest:digest},graphInputs:{hashedOriginalSources:1}};
 const originalRow={id:'owned',head:'original-commit',status:'verified',error:null,worker:{pid:100,exitCode:0,signal:null},readOnlyReopenVerified:true,completedAt:stamp,expectedRevisions:1,revisions:[stored],database:'owned/state/history.db'};
 const original={passed:true,completedAt:stamp,repositories:[originalRow]};
 const tables=Object.fromEntries(['snapshots','entity_versions','relation_versions','diagnostic_versions','snapshot_entities','snapshot_relations','snapshot_diagnostics'].map(name=>[name,{sha256:digest,bytes:80,rows:1,columns:['original_column'],largestTextBytes:20}]));
 const stage=name=>({name,plan:{pending:0,targets:1,head:'original-commit'},indexed:{indexed:0,failed:0,skipped:1,snapshots:1},layout:{rebuilt:name==='layout-build',snapshots:1},geometry:{snapshots:[structuredClone(placement)],positions:2,stableRelativePositions:0}});
 const audit={passed:true,completedAt:stamp,runInputs:inputs,repositories:[{id:'owned',status:'verified',completedAt:stamp,database:'owned/state/history.db',databaseSha256:digest,wal:{bytes:0},walAfter:{bytes:0},originalBlobObjects:1,revisions:[{commit:'original-commit',id:'original-uuid',seq:1,exact:structuredClone(graph),originalRecordDigest:digest,hashedOriginalSources:1}]}]};
 const resume={passed:true,completedAt:stamp,runInputs:inputs,repositories:[{id:'owned',passed:true,completedAt:stamp,worker:{pid:101,exitCode:0,signal:null},originalObservationUnchanged:true,originalDatabaseSha256:digest,originalDatabaseSha256After:digest,child:{id:'owned',passed:true,completedAt:stamp,originalSnapshotLedger:{tables},originalGitTimeline:{selectedSnapshots:1},stages:[stage('layout-build'),stage('resume')]}}]};
 const views={passed:true,completedAt:stamp,id:'owned',runInputs:inputs,databaseSha256:digest,databaseSha256After:digest,databaseUnchanged:true,views:{passed:true,freshServicePasses:2,persistedBaseRegistryUnchanged:true,offFirstParentSnapshots:0,snapshots:[{...placement,cachedFirstParent:true}]}};
 const columns={passed:true,completedAt:stamp,databases:['original','resumed-copy'].map(role=>({id:'owned',role,sha256:digest,sha256After:digest,completeColumnLedgersMatch:true,tables:structuredClone(tables)}))};
 // Independent JSON receipts have no shared object references. Preserve that
 // boundary so adversarial fixture edits cannot silently alter both operands.
 return JSON.parse(JSON.stringify({corpus:{repositories:[{id:'owned',head:'original-commit',revisions:[{commit:'original-commit'}],extraRevisions:[]}]},original,inputs,units:[{id:'owned',audit,resume,views,columns,auditInputOriginal:original,resumeInputOriginal:original}]}));
}

test('joins exact completed original, independent payload/source, resume, public view and column observations',()=>{
 const result=verifyHistoryQualification(fixture());assert.equal(result.revisions,1);assert.equal(result.cachedFirstParentSnapshots,1);assert.equal(result.completeColumnLedgers,14);assert.equal(result.publicViewNodes,2);
 assert.equal(Object.hasOwn(result,'full195RevisionOriginalWorkerStorageResumeViewsQualified'),false,'Authored small fixtures cannot declare a production gate');
});

for(const [name,change] of [
 ['missing repository',f=>f.units=[]],
 ['duplicate repository',f=>f.units.push(structuredClone(f.units[0]))],
 ['nonterminal observation',f=>delete f.original.completedAt],
 ['failed actual worker',f=>f.original.repositories[0].worker.exitCode=1],
 ['same revision count with substituted commit',f=>f.units[0].audit.repositories[0].revisions[0].commit='invented'],
 ['duplicate public view UUID',f=>f.units[0].views.views.snapshots.push(structuredClone(f.units[0].views.views.snapshots[0]))],
 ['unreviewed graph normalization',f=>f.original.repositories[0].revisions[0].readback.normalization=['run.uuid']],
 ['complete payload digest differs',f=>f.units[0].audit.repositories[0].revisions[0].exact.sha256='b'.repeat(64)],
 ['original source digest differs',f=>f.units[0].audit.repositories[0].revisions[0].originalRecordDigest='b'.repeat(64)],
 ['source engine changes',f=>f.units[0].views.runInputs.engineSha256='b'.repeat(64)],
 ['different original observation',f=>f.units[0].resumeInputOriginal.repositories[0].historyIdentity='different'],
 ['nonempty original WAL',f=>{f.units[0].audit.repositories[0].wal.bytes=1;f.units[0].audit.repositories[0].walAfter.bytes=1;}],
 ['missing complete column table',f=>delete f.units[0].columns.databases[1].tables.entity_versions],
 ['hidden complete column changed',f=>f.units[0].columns.databases[1].tables.entity_versions.sha256='b'.repeat(64)],
 ['same counts but different original UUID',f=>f.units[0].audit.repositories[0].revisions[0].id='different'],
 ['public placement differs',f=>f.units[0].views.views.snapshots[0].rectangleSha256='b'.repeat(64)],
 ['resume placement differs',f=>f.units[0].resume.repositories[0].child.stages[1].geometry.positions=3],
 ['source analysis unexpectedly pending on resume',f=>f.units[0].resume.repositories[0].child.stages[0].plan.pending=1],
 ['public view hole',f=>f.units[0].views.views.snapshots[0].holes=1],
 ['copied database mutated',f=>f.units[0].views.databaseSha256After='b'.repeat(64)]
])test(`rejects ${name} despite partial matching evidence`,()=>{const value=fixture();change(value);assert.throws(()=>verifyHistoryQualification(value));});
