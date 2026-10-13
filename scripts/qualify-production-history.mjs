import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat,readFile,realpath,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyProductionHistoryRunInputs} from './audit-production-history.mjs';
import {verifyHistoryRecovery,verifyHistoryRecoveryJoin} from './production-history-recovery.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const tableNames=['snapshots','entity_versions','relation_versions','diagnostic_versions','snapshot_entities','snapshot_relations','snapshot_diagnostics'];
const unique=(rows,key,label)=>{
 const result=new Map();
 for(const row of rows){assert.ok(row[key]&&!result.has(row[key]),`Missing or duplicate ${label}`);result.set(row[key],row);}
 return result;
};
const complete=value=>{assert.equal(value.passed,true,'Receipt did not pass');assert.ok(value.completedAt,'Receipt is not terminal');};
const digestEqual=(actual,expected)=>{
 for(const key of ['sha256','bytes','counts','normalization'])assert.deepEqual(actual[key],expected[key],`Complete graph ${key} differs`);
 assert.deepEqual(actual.normalization,[],'Original graph normalization is forbidden');
};
const sameInputs=(actual,expected)=>{
 for(const key of ['engineSha256','corpusSha256','profilesSha256'])assert.equal(actual[key],expected[key],`Input ${key} differs`);
};
const geometry=rows=>{
 const result=unique(rows,'id','geometry snapshot');
 for(const row of rows){assert.equal(row.holes,0);assert.ok(Number.isSafeInteger(row.projectedNodes)&&row.projectedNodes>=row.entities);assert.match(row.rectangleSha256,/^[a-f0-9]{64}$/);}
 return result;
};

/** Join independent completed observations by exact revisions, UUIDs, original
 * graph/source digests, database identities and every immutable SQLite column.
 * Coverage cannot be inferred from counts, filenames or individual scope flags.
 */
export function verifyHistoryQualification({corpus,original,inputs,units}){
 complete(original);
 const expected=unique(corpus.repositories,'id','corpus repository'),observed=unique(original.repositories,'id','original repository'),byUnit=unique(units,'id','qualification repository');
 assert.deepEqual([...observed.keys()].sort(),[...expected.keys()].sort(),'Original repository coverage differs');
 assert.deepEqual([...byUnit.keys()].sort(),[...expected.keys()].sort(),'Independent repository coverage differs');
 const repositories=[];
 for(const [id,repository] of expected){
  const row=observed.get(id),unit=byUnit.get(id),{audit,resume,views,columns,auditInputOriginal,resumeInputOriginal}=unit;
  assert.equal(row.status,'verified');assert.equal(row.error,null);assert.equal(row.worker.exitCode,0);assert.equal(row.worker.signal,null);assert.equal(row.readOnlyReopenVerified,true);assert.ok(row.completedAt);
  assert.equal(row.head,repository.head);
  const selected=unique([...repository.revisions,...repository.extraRevisions],'commit','selected revision'),stored=unique(row.revisions,'commit','stored revision');
  assert.equal(row.expectedRevisions,selected.size);assert.deepEqual([...stored.keys()].sort(),[...selected.keys()].sort(),'Original revision coverage differs');
  complete(audit);complete(resume);complete(views);complete(columns);
  for(const receipt of [audit,resume,views])sameInputs(receipt.runInputs,inputs);
  assert.equal(audit.repositories.length,1);assert.equal(resume.repositories.length,1);
  const audited=audit.repositories[0],resumed=resume.repositories[0];
  assert.equal(audited.id,id);assert.equal(resumed.id,id);assert.equal(views.id,id);
  assert.deepEqual(auditInputOriginal.repositories.find(r=>r.id===id),row,'Audited original repository differs from terminal observation');
  assert.deepEqual(resumeInputOriginal.repositories.find(r=>r.id===id),row,'Resumed original repository differs from terminal observation');
  assert.equal(audited.status,'verified');assert.ok(audited.completedAt);
  assert.equal(audited.database,row.database);assert.equal(audited.databaseSha256,resumed.originalDatabaseSha256);
  assert.deepEqual(audited.wal,audited.walAfter);assert.equal(audited.wal.bytes,0,'Closed original database has nonempty WAL');
  assert.equal(resumed.passed,true);assert.equal(resumed.worker.exitCode,0);assert.equal(resumed.worker.signal,null);assert.ok(resumed.completedAt);assert.equal(resumed.originalObservationUnchanged,true);
  assert.equal(resumed.originalDatabaseSha256After,resumed.originalDatabaseSha256);
  const child=resumed.child;complete(child);assert.equal(child.id,id);
  assert.deepEqual(Object.keys(child.originalSnapshotLedger.tables).sort(),[...tableNames].sort());
  assert.equal(child.originalSnapshotLedger.tables.snapshots.rows,selected.size);
  const auditedRevisions=unique(audited.revisions,'commit','audited revision'),viewRevisions=unique(views.views.snapshots,'commit','public view revision');
  assert.deepEqual([...auditedRevisions.keys()].sort(),[...selected.keys()].sort(),'Audit revision coverage differs');
  assert.deepEqual([...viewRevisions.keys()].sort(),[...selected.keys()].sort(),'Public view revision coverage differs');
  unique(row.revisions.map(r=>r.snapshot),'id','original snapshot');
  geometry(views.views.snapshots);assert.equal(views.views.passed,true);assert.equal(views.views.freshServicePasses,2);assert.equal(views.views.persistedBaseRegistryUnchanged,true);assert.equal(views.databaseUnchanged,true);assert.equal(views.databaseSha256After,views.databaseSha256);
  for(const [commit,revision] of stored){
   assert.equal(revision.status,'verified');assert.ok(revision.completedAt);
   digestEqual(revision.logical,revision.readback);
   const checked=auditedRevisions.get(commit),view=viewRevisions.get(commit);
   digestEqual(checked.exact,revision.logical);assert.equal(checked.id,revision.snapshot.id);assert.equal(checked.seq,revision.snapshot.seq);
   assert.equal(checked.originalRecordDigest,revision.original.recordDigest);assert.equal(checked.hashedOriginalSources,revision.graphInputs.hashedOriginalSources);
   assert.equal(view.id,revision.snapshot.id);assert.equal(view.entities,revision.logical.counts.entities);
  }
  assert.deepEqual(child.stages.map(stage=>stage.name),['layout-build','resume']);
  for(const [index,stage] of child.stages.entries()){
   assert.equal(stage.plan.pending,0);assert.equal(stage.plan.targets,selected.size);assert.equal(stage.plan.head,repository.head);
   assert.equal(stage.indexed.indexed,0);assert.equal(stage.indexed.failed,0);assert.equal(stage.indexed.skipped,selected.size);assert.equal(stage.indexed.snapshots,selected.size);
   assert.equal(stage.layout.rebuilt,index===0);assert.equal(stage.layout.snapshots,child.originalGitTimeline.selectedSnapshots);
   const placed=geometry(stage.geometry.snapshots),cached=views.views.snapshots.filter(view=>view.cachedFirstParent);
   assert.deepEqual([...placed.keys()].sort(),cached.map(view=>view.id).sort(),'Cached first-parent geometry coverage differs');
   assert.equal(placed.size,child.originalGitTimeline.selectedSnapshots);
   for(const view of cached){const placement=placed.get(view.id);assert.equal(placement.commit,view.commit);assert.equal(placement.rectangleSha256,view.rectangleSha256);}
  }
  assert.deepEqual(child.stages[0].geometry,child.stages[1].geometry,'Resume geometry changed');
  assert.equal(views.views.offFirstParentSnapshots,selected.size-child.originalGitTimeline.selectedSnapshots);
  const columnRows=unique(columns.databases,'role','column-audit database');
  assert.deepEqual([...columnRows.keys()].sort(),['original','resumed-copy']);
  for(const [role,database] of columnRows){
   assert.equal(database.id,id);assert.equal(database.completeColumnLedgersMatch,true);assert.equal(database.sha256After,database.sha256);
   assert.equal(database.sha256,role==='original'?audited.databaseSha256:views.databaseSha256);
   assert.deepEqual(database.tables,child.originalSnapshotLedger.tables,'Complete SQLite columns differ');
  }
  repositories.push({id,head:repository.head,revisions:selected.size,originalDatabaseSha256:audited.databaseSha256,resumedDatabaseSha256:views.databaseSha256,originalBlobObjects:audited.originalBlobObjects,cachedFirstParentSnapshots:child.originalGitTimeline.selectedSnapshots,offFirstParentSnapshots:views.views.offFirstParentSnapshots,firstParentRectangles:child.stages[0].geometry.positions,stableRelativePositions:child.stages[0].geometry.stableRelativePositions,publicViewNodes:views.views.snapshots.reduce((sum,r)=>sum+r.projectedNodes,0),completeColumnLedgers:14});
 }
 return {repositories,revisions:repositories.reduce((sum,r)=>sum+r.revisions,0),cachedFirstParentSnapshots:repositories.reduce((sum,r)=>sum+r.cachedFirstParentSnapshots,0),offFirstParentSnapshots:repositories.reduce((sum,r)=>sum+r.offFirstParentSnapshots,0),firstParentRectangles:repositories.reduce((sum,r)=>sum+r.firstParentRectangles,0),stableRelativePositions:repositories.reduce((sum,r)=>sum+r.stableRelativePositions,0),publicViewNodes:repositories.reduce((sum,r)=>sum+r.publicViewNodes,0),completeColumnLedgers:repositories.length*14};
}

async function fileHash(file){const digest=createHash('sha256');for await(const bytes of createReadStream(file))digest.update(bytes);return digest.digest('hex');}
const dead=pid=>{assert.ok(Number.isSafeInteger(pid)&&pid>0);try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH')return;throw error;}assert.fail(`Completed observation process ${pid} is still live`);};
async function regular(file){assert.equal(await realpath(file),file,'Input crosses an alias');assert.equal((await lstat(file)).isFile(),true,'Input must be a regular file');}

export async function qualifyHistoryArtifacts({manifest:manifestFile,output,engine}){
 manifestFile=path.resolve(manifestFile);output=path.resolve(output);engine=await realpath(engine??fileURLToPath(new URL('../',import.meta.url)));
 await regular(manifestFile);assert.equal(await realpath(path.dirname(output)),path.dirname(output));
 const manifestBytes=await readFile(manifestFile),manifest=JSON.parse(manifestBytes),originalFile=path.resolve(manifest.originalReceipt),originalDirectory=path.dirname(originalFile),artifactFiles=new Map([[manifestFile,hash(manifestBytes)]]);
 assert.equal(manifest.schema,1);
 const load=async file=>{file=path.resolve(file);await regular(file);const bytes=await readFile(file);artifactFiles.set(file,hash(bytes));return {value:JSON.parse(bytes),bytes,file};};
 const [{value:original},{value:corpus,bytes:corpusBytes},{bytes:profilesBytes}]=await Promise.all([load(originalFile),load(manifest.corpus),load(manifest.profiles)]);
 const confined=[originalDirectory,...manifest.repositories.map(r=>path.dirname(path.resolve(r.resume)))];
 for(const directory of confined){const relative=path.relative(directory,output);assert.ok(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative),'Output is inside an observation');}
 complete(original);
 // Exact immutable production corpus breadth. Smaller authored fixtures can
 // exercise the join function, but cannot emit a full-production gate receipt.
 assert.deepEqual(corpus.repositories.map(r=>r.id).sort(),['axum','bookstack','firefly-iii','flask','full-stack-fastapi','memos']);
 for(const r of corpus.repositories){assert.equal(r.revisions.length,32);assert.equal(r.extraRevisions.length,r.id==='flask'?3:0);}
 const inputs=await verifyProductionHistoryRunInputs({receipt:original,corpusBytes,profilesBytes,engine}),units=[],databases=[];
 if(original.recovery){
  const captured=await load(path.join(originalDirectory,'input-recovery-receipt.json'));assert.equal(hash(captured.bytes),original.recovery.previousReceiptSha256);
  const previous=await load(original.recovery.previousReceipt);assert.deepEqual(previous.bytes,captured.bytes);verifyHistoryRecoveryJoin({previous:previous.value,current:original,corpus});await verifyHistoryRecovery(original.recovery);
  for(const row of [...original.recovery.originalInputs,...original.recovery.copiedInputs]){await regular(row.file);assert.equal(await fileHash(row.file),row.sha256);artifactFiles.set(row.file,row.sha256);}
  const helper=fileURLToPath(new URL('production-history-recovery.mjs',import.meta.url));artifactFiles.set(helper,await fileHash(helper));
 }
 for(const item of manifest.repositories){
  const [audit,resume,views,columns,auditInputs,resumeOriginal]=await Promise.all([load(item.audit),load(item.resume),load(item.views),load(item.columns),load(item.audit+'.inputs.json'),load(path.join(path.dirname(item.resume),'input-receipt.json'))]);
  const snapshot=auditInputs.value;
  assert.equal(hash(auditInputs.bytes),audit.value.inputSnapshot.sha256);
  for(const name of ['corpus','profiles','receipt'])assert.equal(hash(snapshot.files[name].utf8),snapshot.files[name].sha256);
  assert.equal(snapshot.files.corpus.sha256,inputs.corpusSha256);assert.equal(snapshot.files.profiles.sha256,inputs.profilesSha256);assert.equal(snapshot.files.receipt.sha256,audit.value.receiptSha256);
  assert.equal(hash(resumeOriginal.bytes),resume.value.originalReceiptSha256);
  for(const [name,expected] of [['input-corpus.json',corpusBytes],['input-profiles.json',profilesBytes]]){const bytes=await readFile(path.join(path.dirname(item.resume),name));assert.deepEqual(bytes,expected);artifactFiles.set(path.join(path.dirname(item.resume),name),hash(bytes));}
  assert.equal(hash(resume.bytes),views.value.resumeReceiptSha256);assert.equal(hash(resume.bytes),columns.value.resumeReceiptSha256);
  const frozen=new Map([[path.join(engine,'scripts/audit-production-history.mjs'),audit.value.auditorSha256],[path.join(engine,'scripts/audit-history-columns.py'),columns.value.auditorSha256]]);
  for(const receipt of [resume.value,views.value])for(const [name,expected] of Object.entries(receipt.frozen)){
   const file=path.resolve(engine,'scripts',name);assert.ok(file.startsWith(path.join(engine,'scripts')+path.sep));
   if(frozen.has(file))assert.equal(frozen.get(file),expected);frozen.set(file,expected);
  }
  for(const [file,expected] of frozen){await regular(file);assert.equal(await fileHash(file),expected);if(artifactFiles.has(file))assert.equal(artifactFiles.get(file),expected);artifactFiles.set(file,expected);}
  const originalRow=original.repositories.find(r=>r.id===item.id);dead(originalRow.worker.pid);dead(resume.value.repositories[0].worker.pid);
  const originalDatabase=path.resolve(originalDirectory,originalRow.database),copyDatabase=path.resolve(path.dirname(item.resume),item.id,'state/history.db');
  for(const [file,expected] of [[originalDatabase,audit.value.repositories[0].databaseSha256],[copyDatabase,views.value.databaseSha256]]){
   await regular(file);const sha256=await fileHash(file);assert.equal(sha256,expected,'Current database bytes differ from audited observation');
   const wal=file+'-wal';try{assert.equal((await lstat(wal)).size,0,'Nonempty current WAL');}catch(error){if(error.code!=='ENOENT')throw error;}
   databases.push({file,sha256,bytes:(await lstat(file)).size});
  }
  units.push({id:item.id,audit:audit.value,resume:resume.value,views:views.value,columns:columns.value,auditInputOriginal:JSON.parse(snapshot.files.receipt.utf8),resumeInputOriginal:resumeOriginal.value});
 }
 const coverage=verifyHistoryQualification({corpus,original,inputs,units});assert.equal(coverage.revisions,195);
 assert.deepEqual(await verifyProductionHistoryRunInputs({receipt:original,corpusBytes,profilesBytes,engine}),inputs);
 for(const [file,expected] of artifactFiles)assert.equal(await fileHash(file),expected,'Receipt changed during qualification');
 for(const database of databases){
  assert.equal(await fileHash(database.file),database.sha256,'Database changed during qualification');
  try{assert.equal((await lstat(database.file+'-wal')).size,0,'Database WAL changed during qualification');}catch(error){if(error.code!=='ENOENT')throw error;}
 }
 const result={schema:1,passed:true,completedAt:new Date().toISOString(),phase:'complete-original-corpus-worker-storage-independent-audit-layout-resume-and-public-views',runInputs:inputs,...coverage,databases,artifacts:[...artifactFiles].map(([file,sha256])=>({file,sha256})),manifestSha256:await fileHash(manifestFile),qualifierSha256:await fileHash(fileURLToPath(import.meta.url)),full195RevisionOriginalWorkerStorageResumeViewsQualified:true,freshIndexHistoryWorkerOrchestrationQualified:false,relativeHistoryTimeRssQualified:false,nativeWindowsMacOSQualified:false,sourceAccuracyQualified:false,method:'Exact terminal six-repository receipt join; complete original graph/source digests, UUIDs and revisions; actual indexHistory cached resume and complete public views; 84 independent Python SQLite column ledgers. Current original/copied database bytes, frozen runtime/observer and all receipt bytes verified before/after. Targets never execute.'};
 await writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});return result;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const options={};for(let index=2;index<process.argv.length;index+=2){const key=process.argv[index],value=process.argv[index+1];assert.ok(['--manifest','--output','--engine'].includes(key)&&value&&!Object.hasOwn(options,key));options[key.slice(2)]=value;}
 const result=await qualifyHistoryArtifacts(options);console.log(JSON.stringify({passed:result.passed,repositories:result.repositories.length,revisions:result.revisions,completeColumnLedgers:result.completeColumnLedgers}));
}
