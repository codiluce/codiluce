import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat,readFile,readlink,realpath,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateCorpus} from './production-history-inputs.mjs';
import {compareHistoryRuntimeInputs} from './production-history-runtime-inputs.mjs';
import {historySourceIdentity,historyRuntimeLayout,historyRuntimeLedgers} from './production-history-runtime-layout.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const tableNames=['snapshots','entity_versions','relation_versions','diagnostic_versions','snapshot_entities','snapshot_relations','snapshot_diagnostics'];
const terminal=value=>{assert.equal(value.passed,true);assert.ok(value.completedAt,'Observation is not terminal');};
const unique=(rows,key,label)=>{
 const result=new Map();for(const row of rows){assert.ok(row[key]&&!result.has(row[key]),'Missing or duplicate '+label);result.set(row[key],row);}return result;
};
const sameSet=(a,b,message)=>assert.deepEqual([...a].sort(),[...b].sort(),message);
const exact=(a,b)=>{assert.deepEqual(a,b,'Complete graph digest differs');assert.deepEqual(a.normalization,[]);};
const inputKeys=['schema','startedAt','phase','engineIdentity','baselineEngineSha256','observer','corpusSha256','profilesSha256','baselineReceiptSha256','baselineQualificationSha256','runtimeInputComparison'];

/** Exact coverage and identity join. This pure verifier also accepts smaller
 * owned fixtures; only the artifact command can qualify the full real corpus. */
export function verifyEntrypointQualification({corpus,receipt,baseline,columns}){
 terminal(receipt);terminal(baseline);
 assert.equal(receipt.phase,'fresh-production-indexHistory-entrypoint-workers-and-resume');
 assert.equal(receipt.baselineEngineSha256,baseline.engineIdentity.sha256);
 const runtimeInputComparison=compareHistoryRuntimeInputs(historySourceIdentity(receipt.engineIdentity),historySourceIdentity(baseline.engineIdentity));
 if(Object.hasOwn(receipt,'runtimeInputComparison'))assert.deepEqual(receipt.runtimeInputComparison,runtimeInputComparison,'Observed runtime input comparison differs');
 else assert.equal(runtimeInputComparison.added.length,0,'Added runtime inputs require the observer comparison');
 for(const key of ['corpusSha256','profilesSha256'])assert.equal(receipt[key],baseline[key]);
 const specifications=unique(corpus.repositories,'id','corpus repository'),observed=unique(receipt.repositories,'id','entrypoint repository'),original=unique(baseline.repositories,'id','baseline repository'),audited=unique(columns,'id','column audit');
 for(const inventory of [observed,original,audited])sameSet(inventory.keys(),specifications.keys(),'Repository coverage differs');
 const repositories=[];
 for(const [id,specification] of specifications){
  const row=observed.get(id),prior=original.get(id),unit=audited.get(id),{audit,input,child,job}=unit;terminal(row);terminal(child);terminal(audit);
  assert.equal(prior.status,'verified');assert.equal(prior.readOnlyReopenVerified,true);assert.equal(prior.worker.exitCode,0);assert.equal(prior.worker.signal,null);
  assert.deepEqual(child,row.child);assert.equal(child.id,id);assert.equal(child.pid,row.process.pid);assert.equal(row.process.exitCode,0);assert.equal(row.process.signal,null);assert.equal(row.originalDatabaseUnchanged,true);assert.equal(child.readOnlyReopenVerified,true);
  assert.deepEqual(job.record,prior,'Fresh job does not use the qualified original record');
  const capture=JSON.parse(input.receiptUtf8);assert.equal(hash(input.receiptUtf8),input.receiptSha256);assert.equal(audit.inputReceiptSha256,input.receiptSha256);
  assert.deepEqual(unique(capture.repositories,'id','captured repository').get(id),row,'Independently audited terminal row differs');for(const key of inputKeys)assert.deepEqual(capture[key],receipt[key],'Captured frozen input differs');
  assert.equal(audit.id,id);assert.equal(audit.database.sha256,row.databaseSha256);assert.equal(audit.database.sha256After,row.databaseSha256);assert.equal(audit.database.completeColumnLedgersMatch,true);
  sameSet(Object.keys(child.snapshotColumnLedger.tables),tableNames,'Incomplete SQLite table coverage');assert.deepEqual(audit.database.tables,child.snapshotColumnLedger.tables);
  const commits=[...specification.revisions,...specification.extraRevisions].map(r=>r.commit),byCommit=unique(child.revisions,'commit','fresh revision'),byPrior=unique(prior.revisions,'commit','baseline revision'),views=unique(child.views.snapshots,'commit','public view'),snapshots=unique(audit.actualSnapshotIdentities,'commit','independent snapshot');
  assert.equal(new Set(commits).size,commits.length);for(const inventory of [byCommit,byPrior,views,snapshots])sameSet(inventory.keys(),commits,'Revision coverage differs');
  assert.equal(audit.revisions,commits.length);assert.equal(child.snapshotColumnLedger.tables.snapshots.rows,commits.length);unique(child.revisions.map(r=>r.snapshot),'id','fresh snapshot UUID');
  assert.equal(child.workers.length,2);unique(child.workers,'pid','worker PID');const size=Math.ceil(commits.length/2),chunks=[commits.slice(0,size),commits.slice(size)];assert.ok(chunks.every(c=>c.length));sameSet(child.workers.map(w=>JSON.stringify(w.job.commits)),chunks.map(c=>JSON.stringify(c)),'Actual contiguous worker chunks differ');
  for(const worker of child.workers){assert.equal(worker.exitCode,0);assert.equal(worker.signal,null);assert.deepEqual(worker.results,worker.job.commits);assert.deepEqual(worker.acknowledgements,worker.job.commits);for(const commit of worker.job.commits)assert.equal(byCommit.get(commit).workerPid,worker.pid);}
  for(const commit of commits){
   const revision=byCommit.get(commit),previous=byPrior.get(commit),view=views.get(commit),snapshot=snapshots.get(commit);
   assert.equal(revision.status,'verified');assert.equal(revision.acknowledged,true);exact(revision.logical,revision.readback);exact(previous.logical,previous.readback);
   assert.equal(revision.original.commit,commit);assert.equal(revision.original.recordDigest,previous.original.recordDigest,'Complete original tree receipt differs');assert.equal(revision.original.entries,previous.original.regularFiles+previous.original.literalSymlinks+previous.original.unhydratedGitlinks);assert.equal(revision.original.bytes,previous.original.originalBytes);assert.equal(revision.original.literalSymlinks,previous.original.literalSymlinks);assert.equal(revision.original.symlinkTargetsFollowed,false);assert.deepEqual(revision.graphInputs,previous.graphInputs);
   assert.deepEqual(revision.baselineComparison.volatileFields,['run.id','run.analyzedAt']);for(const key of ['sha256','bytes'])assert.equal(revision.baselineComparison[key],previous.logical[key]);
   assert.deepEqual(revision.logical.counts,previous.logical.counts);assert.deepEqual(revision.logical.storage,previous.logical.storage);
   assert.deepEqual(snapshot,{id:revision.snapshot.id,seq:revision.snapshot.seq,commit});assert.equal(view.id,snapshot.id);assert.equal(view.entities,revision.logical.counts.entities);assert.ok(Number.isSafeInteger(view.projectedNodes)&&view.projectedNodes>=view.entities);assert.equal(view.holes,0);assert.match(view.rectangleSha256,/^[a-f0-9]{64}$/);
  }
  assert.deepEqual(child.stages.map(s=>s.name),['fresh','resume']);
  for(const [index,stage] of child.stages.entries()){
   assert.deepEqual(stage.indexed,{ref:specification.head,head:specification.head,indexed:index===0?commits.length:0,failed:0,skipped:index===0?0:commits.length,snapshots:commits.length});
   const plans=stage.events.filter(e=>e.type==='plan'),layouts=stage.events.filter(e=>e.type==='layout');assert.equal(plans.length,1);assert.equal(layouts.length,1);assert.equal(plans[0].targets,commits.length);assert.equal(plans[0].head,specification.head);assert.equal(plans[0].pending,index===0?commits.length:0);if(index===0)assert.equal(plans[0].jobs,2);
   assert.equal(layouts[0].rebuilt,index===0);assert.equal(layouts[0].snapshots,child.views.snapshots.filter(v=>v.cachedFirstParent).length);assert.equal(stage.events.filter(e=>e.type==='failed').length,0);
   const saved=unique(stage.events.filter(e=>e.type==='indexed').map(e=>({commit:e.commit.sha,snapshot:e.snapshot})),'commit','indexed event');sameSet(saved.keys(),index===0?commits:[],'Indexed event coverage differs');for(const [commit,event] of saved){const revision=byCommit.get(commit);assert.equal(event.snapshot.id,revision.snapshot.id);assert.equal(event.snapshot.seq,revision.snapshot.seq);assert.deepEqual(event.snapshot.stats,revision.snapshot.stats);}
  }
  assert.equal(child.views.passed,true);assert.equal(child.views.freshServicePasses,2);assert.equal(child.views.persistedBaseRegistryUnchanged,true);assert.equal(child.views.offFirstParentSnapshots,child.views.snapshots.filter(v=>!v.cachedFirstParent).length);
  repositories.push({id,head:specification.head,revisions:commits.length,workers:child.workers.map(w=>w.pid),databaseSha256:row.databaseSha256,originalDatabaseSha256:row.originalDatabaseSha256,cachedFirstParentSnapshots:child.views.snapshots.filter(v=>v.cachedFirstParent).length,offFirstParentSnapshots:child.views.offFirstParentSnapshots,publicViewNodes:child.views.snapshots.reduce((n,v)=>n+v.projectedNodes,0),independentCompleteColumnLedgers:7,treePeakKiB:row.process.treePeakKiB});
 }
 return {runtimeInputComparison,repositories,revisions:repositories.reduce((n,r)=>n+r.revisions,0),workers:repositories.length*2,cachedFirstParentSnapshots:repositories.reduce((n,r)=>n+r.cachedFirstParentSnapshots,0),offFirstParentSnapshots:repositories.reduce((n,r)=>n+r.offFirstParentSnapshots,0),publicViewNodes:repositories.reduce((n,r)=>n+r.publicViewNodes,0),independentCompleteColumnLedgers:repositories.length*7};
}

async function fileHash(file){const h=createHash('sha256');for await(const chunk of createReadStream(file))h.update(chunk);return h.digest('hex');}
async function regular(file){assert.equal(await realpath(file),file,'Input crosses an alias');assert.equal((await lstat(file)).isFile(),true);}
function dead(pid){assert.ok(Number.isSafeInteger(pid)&&pid>0);try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH')return;throw error;}assert.fail('Completed process is still live: '+pid);}

export async function qualifyEntrypointArtifacts({manifest:manifestFile,output,engine,observerRoot}){
 manifestFile=path.resolve(manifestFile);output=path.resolve(output);engine=await realpath(engine??fileURLToPath(new URL('../',import.meta.url)));observerRoot=await realpath(observerRoot??engine);assert.equal(await realpath(path.dirname(output)),path.dirname(output));
 const artifacts=new Map(),databases=[],load=async file=>{file=path.resolve(file);await regular(file);const bytes=await readFile(file),sha256=hash(bytes);if(artifacts.has(file))assert.equal(artifacts.get(file),sha256,'Evidence changed between reads');artifacts.set(file,sha256);return {file,bytes,value:JSON.parse(bytes)};};
 const runtimeHelper=fileURLToPath(new URL('./production-history-runtime-inputs.mjs',import.meta.url));await regular(runtimeHelper);artifacts.set(runtimeHelper,await fileHash(runtimeHelper));
 const manifest=(await load(manifestFile)).value;assert.equal(manifest.schema,1);
 const [fresh,old,qualification,corpus,profiles,terminalReceipt,controller,launch]=await Promise.all([load(manifest.entrypointReceipt),load(manifest.baselineReceipt),load(manifest.baselineQualification),load(manifest.corpus),load(manifest.profiles),load(manifest.terminal),load(manifest.controller),load(manifest.controllerLaunch)]),receipt=fresh.value,baseline=old.value;
 validateCorpus(corpus.value);terminal(receipt);terminal(qualification.value);terminal(baseline);assert.equal(receipt.full195RevisionEntrypointQualified,true);assert.equal(qualification.value.full195RevisionOriginalWorkerStorageResumeViewsQualified,true);
 assert.equal(receipt.baselineQualificationSha256,hash(qualification.bytes));assert.equal(receipt.baselineReceiptSha256,hash(old.bytes));assert.equal(receipt.corpusSha256,hash(corpus.bytes));assert.equal(receipt.profilesSha256,hash(profiles.bytes));assert.equal(qualification.value.artifacts.find(a=>a.file===old.file)?.sha256,hash(old.bytes));
 assert.deepEqual(corpus.value.repositories.map(r=>r.id).sort(),['axum','bookstack','firefly-iii','flask','full-stack-fastapi','memos']);for(const r of corpus.value.repositories){assert.equal(r.revisions.length,32);assert.equal(r.extraRevisions.length,r.id==='flask'?3:0);}
 sameSet(unique(manifest.columns,'id','manifest column audit').keys(),corpus.value.repositories.map(r=>r.id),'Manifest repository coverage differs');
 const outside=(root,file)=>{const relative=path.relative(root,file);return relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative);};assert.ok(outside(path.dirname(fresh.file),output));assert.ok(outside(path.dirname(old.file),output));
 assert.equal(terminalReceipt.value.exitCode,0);assert.ok(terminalReceipt.value.completedAt&&terminalReceipt.value.seconds>0);assert.equal(terminalReceipt.value.pid,controller.value.pid);assert.equal(terminalReceipt.value.childPid,controller.value.childPid);assert.equal(launch.value.pid,controller.value.pid);assert.equal(launch.value.engineSha256,receipt.engineIdentity.sha256);dead(terminalReceipt.value.childPid);dead(terminalReceipt.value.pid);
 const controllerSource=path.join(path.dirname(controller.file),'corpus-controller.py');await regular(controllerSource);assert.equal(await fileHash(controllerSource),launch.value.controllerSha256);artifacts.set(controllerSource,launch.value.controllerSha256);
 const args=controller.value.args;for(const [flag,expected] of [['--output',path.dirname(fresh.file)],['--baseline',old.file],['--qualification',qualification.file]])assert.equal(args[args.indexOf(flag)+1],expected);
 assert.deepEqual((await load(args[args.indexOf('--engine-identity')+1])).value,receipt.engineIdentity);
 assert.equal(receipt.engineIdentity.node,process.version);assert.equal(receipt.engineIdentity.platform,process.platform);assert.equal(receipt.engineIdentity.architecture,process.arch);assert.equal(hash(JSON.stringify(receipt.engineIdentity.files)),receipt.engineIdentity.sha256);
 compareHistoryRuntimeInputs(historySourceIdentity(receipt.engineIdentity),historySourceIdentity(baseline.engineIdentity));
 for(const ledger of historyRuntimeLedgers(receipt.engineIdentity,engine)){assert.equal(hash(JSON.stringify(ledger.identity.files)),ledger.identity.sha256);for(const r of ledger.identity.files){const file=path.resolve(ledger.root,r.file);assert.ok(!outside(ledger.root,file));await regular(file);assert.equal(await fileHash(file),r.sha256,'Frozen '+ledger.role+' runtime differs');artifacts.set(file,r.sha256);}for(const link of ledger.identity.links??[]){const file=path.resolve(ledger.root,link.file);assert.ok(!outside(ledger.root,file));assert.equal(await readlink(file),link.target);}}
 for(const [name,expected] of Object.entries(receipt.observer)){const file=path.resolve(observerRoot,'scripts',name);assert.ok(!outside(path.join(observerRoot,'scripts'),file));await regular(file);assert.equal(await fileHash(file),expected);artifacts.set(file,expected);}
 for(const [name,expected] of [['input-corpus.json',corpus.bytes],['input-profiles.json',profiles.bytes],['input-baseline.json',old.bytes],['input-qualification.json',qualification.bytes]])assert.deepEqual((await load(path.join(path.dirname(fresh.file),name))).bytes,expected);
 assert.deepEqual((await load(path.join(path.dirname(fresh.file),'input-engine.json'))).value,receipt.engineIdentity);
 const columns=[];
 for(const item of manifest.columns){
  const audit=await load(item.audit),captured=await load(audit.value.inputSnapshot.file),unit=path.join(path.dirname(fresh.file),item.id),child=await load(path.join(unit,'child-receipt.json')),job=await load(path.join(unit,'job.json'));
  assert.equal(hash(captured.bytes),audit.value.inputSnapshot.sha256);assert.equal(hash(child.bytes),audit.value.childReceiptSha256);assert.equal(hash(job.bytes),audit.value.jobSha256);assert.equal(path.resolve(captured.value.receiptFile),fresh.file);
  for(const [name,expected] of [['audit-history-entrypoint-columns.py',audit.value.auditorSha256],['audit-history-columns.py',audit.value.columnAuditorSha256]]){const file=path.join(observerRoot,'scripts',name);await regular(file);assert.equal(await fileHash(file),expected);artifacts.set(file,expected);}
  const row=receipt.repositories.find(r=>r.id===item.id);assert.ok(row);dead(row.process.pid);for(const worker of row.child.workers)dead(worker.pid);
  const original=baseline.repositories.find(r=>r.id===item.id);dead(original.worker.pid);const originalDb=path.resolve(path.dirname(old.file),original.database);assert.equal(originalDb,path.join(path.dirname(old.file),item.id,'state/history.db'));assert.equal(row.originalDatabaseSha256,qualification.value.repositories.find(r=>r.id===item.id).originalDatabaseSha256);
  for(const revision of original.revisions){const source=(await load(path.join(path.dirname(old.file),item.id,revision.commit+'-original.json'))).value;assert.equal(source.commit,revision.commit);assert.equal(source.recordDigest,revision.original.recordDigest);assert.equal(hash(JSON.stringify(source.entries)),source.recordDigest);assert.equal(source.allOriginalBytesVerified,true);assert.equal(source.symlinkTargetsFollowed,false);}
  for(const [file,expected] of [[path.join(unit,'state/history.db'),row.databaseSha256],[originalDb,row.originalDatabaseSha256]]){
   await regular(file);assert.equal(await fileHash(file),expected);try{assert.equal((await lstat(file+'-wal')).size,0);}catch(error){if(error.code!=='ENOENT')throw error;}databases.push({file,sha256:expected,bytes:(await lstat(file)).size});
  }
  columns.push({id:item.id,audit:audit.value,input:captured.value,child:child.value,job:job.value});
 }
 if(receipt.executionLayout)assert.deepEqual(receipt.executionLayout,historyRuntimeLayout(receipt.engineIdentity));
 const coverage=verifyEntrypointQualification({corpus:corpus.value,receipt,baseline,columns});assert.equal(coverage.revisions,195);
 for(const [file,expected] of artifacts)assert.equal(await fileHash(file),expected,'Frozen evidence changed');for(const d of databases){assert.equal(await fileHash(d.file),d.sha256);try{assert.equal((await lstat(d.file+'-wal')).size,0);}catch(error){if(error.code!=='ENOENT')throw error;}}
 const result={schema:1,passed:true,completedAt:new Date().toISOString(),phase:'complete-fresh-production-indexHistory-entrypoint-and-independent-storage-qualification',engineSha256:receipt.engineIdentity.sha256,baselineEngineSha256:receipt.baselineEngineSha256,...coverage,databases,artifacts:[...artifacts].map(([file,sha256])=>({file,sha256})),manifestSha256:await fileHash(manifestFile),qualifierSha256:await fileHash(fileURLToPath(import.meta.url)),full195RevisionEntrypointQualified:true,relativeHistoryTimeRssQualified:false,nativeWindowsMacOSQualified:false,sourceAccuracyQualified:false,method:'Exact terminal six-repository/195-revision join of actual fresh indexHistory contiguous workers, original bytes/full graphs, real store/readback/ACKs, pending-zero resume, complete public views and 42 independent Python raw SQLite column ledgers. Only cross-run UUID/time changes; same-worker/store graphs never normalized. Frozen runtime/evidence and original/fresh database bytes checked before and after. Observation overhead is included; targets never execute.'};
 await writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});return result;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const options={};for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i],value=process.argv[i+1];assert.ok(['--manifest','--output','--engine','--observer-root'].includes(key)&&value&&!Object.hasOwn(options,key));options[key==='--observer-root'?'observerRoot':key.slice(2)]=value;}
 const result=await qualifyEntrypointArtifacts(options);console.log(JSON.stringify({passed:result.passed,revisions:result.revisions,workers:result.workers,independentCompleteColumnLedgers:result.independentCompleteColumnLedgers}));
}
