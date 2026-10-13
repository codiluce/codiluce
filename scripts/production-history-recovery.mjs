// Recover closed repository units after an interrupted observer. Original
// evidence is never modified; incomplete worker units must run in full again.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {copyFile,lstat,mkdir,readFile,realpath,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {productionSnapshotDigest} from './production-history-storage.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const names=['observe-production-history.mjs','production-history-tree.mjs','production-history-storage.mjs','production-graph-digest.mjs','production-cache-git.mjs','production-history-inputs.mjs','production-history-blobs.mjs','graph-json-artifact.mjs','process-memory.mjs'];
const outside=(root,file)=>{const relative=path.relative(root,file);return relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative);};
async function regular(file){assert.equal(await realpath(file),file,'Recovery input crosses an alias');assert.equal((await lstat(file)).isFile(),true,'Recovery input must be regular');}
async function fileHash(file){const h=createHash('sha256');for await(const bytes of createReadStream(file))h.update(bytes);return h.digest('hex');}
function dead(pid){assert.ok(Number.isSafeInteger(pid)&&pid>0);try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH')return;throw error;}assert.fail('Previous history worker is still live: '+pid);}

export function validateHistoryRecovery({previous,identity,corpus,corpusSha256,profilesSha256}){
 assert.equal(previous.schema,1);assert.equal(previous.phase,'full-original-corpus-history-worker-store-readback');
 assert.equal(previous.passed,false,'Recovery requires an interrupted observation');assert.equal(previous.completedAt,null,'Terminal observations cannot be silently retried');
 assert.equal(previous.corpusSha256,corpusSha256);assert.equal(previous.profilesSha256,profilesSha256);assert.deepEqual(previous.engineIdentity,identity,'Recovery runtime differs');
 assert.equal(hash(JSON.stringify(identity.files)),identity.sha256);
 const expected=new Map(corpus.repositories.map(row=>[row.id,row])),seen=new Set(),completed=[],incomplete=[];
 for(const row of previous.repositories){
  assert.ok(expected.has(row.id)&&!seen.has(row.id),'Unknown or duplicate recovery repository');seen.add(row.id);
  const specification=expected.get(row.id),commits=[...specification.revisions,...specification.extraRevisions].map(r=>r.commit);
  assert.equal(row.head,specification.head);assert.equal(row.expectedRevisions,commits.length);assert.equal(row.error,null,'Failed units require a separate investigation');
  assert.ok(['starting','verified'].includes(row.status),'Recovery cannot hide a failed repository');
  if(row.status==='verified'){
   assert.equal(row.worker.exitCode,0);assert.equal(row.worker.signal,null);assert.equal(row.readOnlyReopenVerified,true);assert.ok(row.completedAt);
   assert.deepEqual(row.revisions.map(r=>r.commit),commits,'Recovered repository revision coverage differs');
   assert.equal(row.storage.snapshots,commits.length);
   for(const revision of row.revisions){assert.equal(revision.status,'verified');assert.ok(revision.completedAt);assert.deepEqual(revision.logical,revision.readback);assert.deepEqual(revision.logical.normalization,[]);}
   completed.push(row);
  }else{
   for(const revision of row.revisions)assert.ok(['verifying','verified'].includes(revision.status),'Failed revision cannot be hidden by recovery');
   incomplete.push(row.id);
  }
 }
 return {completed,incomplete,unstarted:corpus.repositories.filter(row=>!seen.has(row.id)).map(row=>row.id)};
}

export function verifyHistoryRecoveryJoin({previous,current,corpus}){
 const selection=validateHistoryRecovery({previous,identity:current.engineIdentity,corpus,corpusSha256:current.corpusSha256,profilesSha256:current.profilesSha256});
 assert.deepEqual(current.recovery.completedRepositories,selection.completed.map(row=>row.id));
 assert.deepEqual(current.recovery.incompleteRepositoriesRecapturedInFull,selection.incomplete);assert.deepEqual(current.recovery.unstartedRepositories,selection.unstarted);
 for(const row of selection.completed)assert.deepEqual(current.repositories.find(candidate=>candidate.id===row.id),row,'Recovered terminal repository row differs');
 for(const id of selection.incomplete){const original=previous.repositories.find(row=>row.id===id),fresh=current.repositories.find(row=>row.id===id);assert.ok(fresh);assert.notEqual(fresh.worker.pid,original.worker?.pid,'Interrupted worker cannot be promoted to terminal');}
}

export async function prepareHistoryRecovery({receiptFile,previousEngine,identity,corpus,corpusSha256,profilesSha256,destination,HistoryStore}){
 receiptFile=path.resolve(receiptFile);previousEngine=await realpath(previousEngine);destination=await realpath(destination);await regular(receiptFile);
 const previousDirectory=path.dirname(receiptFile);assert.ok(outside(previousDirectory,destination),'Recovery output is inside original observation');
 const bytes=await readFile(receiptFile),previous=JSON.parse(bytes),selection=validateHistoryRecovery({previous,identity,corpus,corpusSha256,profilesSha256}),inputs=new Map([[receiptFile,hash(bytes)]]),copies=[];
 const expectedNames=previous.observer['production-history-recovery.mjs']?[...names,'production-history-recovery.mjs']:names;
 assert.deepEqual(Object.keys(previous.observer).sort(),[...expectedNames].sort());
 for(const [name,digest]of Object.entries(previous.observer)){const file=path.join(previousEngine,'scripts',name);await regular(file);assert.equal(await fileHash(file),digest,'Previous observer bytes differ');inputs.set(file,digest);}
 for(const row of previous.repositories)if(row.worker)dead(row.worker.pid);
 await writeFile(path.join(destination,'input-recovery-receipt.json'),bytes,{flag:'wx'});
 async function copy(source,target){await regular(source);const digest=await fileHash(source);inputs.set(source,digest);await copyFile(source,target);await regular(target);assert.equal(await fileHash(target),digest);copies.push({file:target,sha256:digest});return digest;}
 for(const row of selection.completed){
  const relative=row.id+'/state/history.db';assert.equal(row.database,relative);const original=path.join(previousDirectory,relative),unit=path.join(destination,row.id);await regular(original);
  try{assert.equal((await lstat(original+'-wal')).size,0,'Recovered database has a nonempty WAL');}catch(error){if(error.code!=='ENOENT')throw error;}
  const originalHash=await fileHash(original);inputs.set(original,originalHash);let store=new HistoryStore(original,true);
  try{
   assert.deepEqual(store.status(),row.storage,'Recovered original database inventory differs');
   for(const revision of row.revisions){assert.deepEqual(productionSnapshotDigest(store,revision.snapshot.id),revision.logical,'Recovered original full graph differs');const snapshot=store.snapshot(revision.snapshot.id);assert.equal(snapshot.seq,revision.snapshot.seq);assert.equal(snapshot.commitSha,revision.commit);}
  }finally{store.close();}
  await mkdir(path.join(unit,'state'),{recursive:true});await copy(original,path.join(destination,relative));
  for(const name of ['state/config.yml','worker.log'])await copy(path.join(previousDirectory,row.id,name),path.join(unit,name));
  for(const revision of row.revisions){
   const source=path.join(previousDirectory,row.id,revision.commit+'-original.json'),originalBytes=await readFile(source),receipt=JSON.parse(originalBytes);
   assert.equal(receipt.commit,revision.commit);assert.equal(receipt.recordDigest,revision.original.recordDigest);assert.equal(hash(JSON.stringify(receipt.entries)),receipt.recordDigest);assert.equal(receipt.allOriginalBytesVerified,true);assert.equal(receipt.symlinkTargetsFollowed,false);
   await copy(source,path.join(unit,revision.commit+'-original.json'));
  }
  store=new HistoryStore(path.join(destination,relative),true);try{for(const revision of row.revisions)assert.deepEqual(productionSnapshotDigest(store,revision.snapshot.id),revision.logical,'Recovered copied graph differs');}finally{store.close();}
  assert.equal(await fileHash(original),originalHash,'Original changed while copying');
 }
 const recovery={schema:1,previousReceipt:receiptFile,previousReceiptSha256:hash(bytes),previousStartedAt:previous.startedAt,previousCompletedAt:previous.completedAt,previousPassed:previous.passed,
  completedRepositories:selection.completed.map(r=>r.id),incompleteRepositoriesRecapturedInFull:selection.incomplete,unstartedRepositories:selection.unstarted,
  originalInputs:[...inputs].map(([file,sha256])=>({file,sha256})),copiedInputs:copies,
  method:'Actual previously terminal workers only; complete original and copied read-only snapshot graphs reverified without normalization. Original bytes retained. Incomplete worker units cannot become terminal through snapshot counts and are recaptured in full.',relativePerformanceQualified:false};
 await verifyHistoryRecovery(recovery);return {repositories:selection.completed,recovery};
}

export async function verifyHistoryRecovery(recovery){
 for(const row of [...recovery.originalInputs,...recovery.copiedInputs]){await regular(row.file);assert.equal(await fileHash(row.file),row.sha256,'Frozen recovery evidence changed');}
}
