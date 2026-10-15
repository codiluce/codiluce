// Fresh analysis via the actual shipped indexHistory entrypoint and workers.
// Node's fork is observed without changing jobs, messages, acknowledgements,
// the indexer, worker, store or target source. Verification time is included;
// this is correctness evidence, never an indexing performance benchmark.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import {createReadStream,createWriteStream,cpSync,readFileSync,statfsSync,writeFileSync,mkdirSync,realpathSync} from 'node:fs';
import {finished} from 'node:stream/promises';
import {copyFile,lstat,mkdir,readFile,readlink,realpath,rename,statfs,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {stringify} from 'yaml';
import {productionGitEnvironment} from './production-cache-git.mjs';
import {readGit,readRevision,validateCorpus} from './production-history-inputs.mjs';
import {inspectHistoryTreeSync} from './production-history-tree-sync.mjs';
import {verifyHistoryGraphInputs} from './production-history-tree.mjs';
import {productionGraphDigest} from './production-graph-digest.mjs';
import {productionSnapshotDigest} from './production-history-storage.mjs';
import {snapshotStorageLedger} from './production-history-storage-ledger.mjs';
import {verifyPublicHistoryViews} from './production-history-public-views.mjs';
import {sampleProcessTreeRssKiB} from './process-memory.mjs';
import {compareHistoryRuntimeInputs} from './production-history-runtime-inputs.mjs';
import {historyRuntimeLayout,historySourceIdentity,historyRuntimeLedgers} from './production-history-runtime-layout.mjs';

const self=fileURLToPath(import.meta.url),project=fileURLToPath(new URL('../',import.meta.url)),hash=bytes=>createHash('sha256').update(bytes).digest('hex'),options={},sources={};
for(let index=2;index<process.argv.length;index+=2){
 const key=process.argv[index],value=process.argv[index+1];assert.ok(value&&!value.startsWith('--'));
 if(key==='--source'){const at=value.indexOf('=');assert.ok(at>0&&!Object.hasOwn(sources,value.slice(0,at)));sources[value.slice(0,at)]=path.resolve(value.slice(at+1));}
 else{assert.ok(['--child','--corpus','--profiles','--engine','--engine-identity','--git-metadata','--baseline','--qualification','--repository','--output'].includes(key)&&!Object.hasOwn(options,key));options[key]=value;}
}
async function fileHash(file){const digest=createHash('sha256');for await(const bytes of createReadStream(file))digest.update(bytes);return digest.digest('hex');}
const outside=(root,file)=>{const relative=path.relative(root,file);return relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative);};
const withoutVolatile=run=>{const {id,analyzedAt,...rest}=run;assert.equal(typeof id,'string');assert.equal(typeof analyzedAt,'string');return rest;};

if(options['--child']){
 const job=JSON.parse(await readFile(options['--child'])),unit=path.dirname(options['--child']),database=path.join(job.state,'history.db'),result={schema:1,id:job.record.id,pid:process.pid,startedAt:new Date().toISOString(),passed:false,workers:[],revisions:[],stages:[]};
 const nativeFork=childProcess.fork,workers=new Set(),pendingGraphs=new Map(),byCommit=new Map(job.record.revisions.map(row=>[row.commit,row])),rows=new Map(),layout=historyRuntimeLayout(job.identity);let HistoryStore,baselineStore;
 function preserve(worker,graph,error){
  const row=graph?rows.get(graph.run.commitSha):undefined;if(row){row.status='failed';row.error=error.message;}
  result.error??=error.message;
  const target=path.join(unit,'failed-'+(graph?.run.commitSha??worker?.pid??'probe'));mkdirSync(target,{recursive:true});
  try{if(worker?.job)cpSync(worker.job.directory,path.join(target,'tree'),{recursive:true,dereference:false,verbatimSymlinks:true});}catch(copyError){result.failedTreeError=copyError.message;}
  if(graph)try{const text=JSON.stringify(graph);assert.ok(Buffer.byteLength(text)<=1024*1024*1024);writeFileSync(path.join(target,'graph.json'),text,{flag:'wx'});}catch(artifactError){result.failedGraphError=artifactError.message;}
  for(const child of workers)child.kill('SIGTERM');
 }
 childProcess.fork=function(module,...args){
  const child=nativeFork.call(this,module,...args);if(path.resolve(String(module))!==path.join(job.engine,layout.modules.worker))return child;
  workers.add(child);const worker={pid:child.pid,job:null,results:[],acknowledgements:[]};result.workers.push(worker);
  const send=child.send;
  child.send=function(message,...rest){
   if(message?.commits){assert.equal(worker.job,null);assert.equal(message.root,job.root);assert.ok(path.resolve(message.directory).startsWith(job.scratch+path.sep));assert.equal(realpathSync(path.dirname(message.directory)),path.dirname(message.directory));assert.deepEqual(message.raw,job.record.config);worker.job={root:message.root,directory:message.directory,commits:[...message.commits]};}
   else if(message?.type==='stored'){worker.acknowledgements.push(message.sha);const row=rows.get(message.sha);assert.ok(row&&row.workerPid===child.pid);row.acknowledged=true;pendingGraphs.delete(child.pid);}
   return send.call(this,message,...rest);
  };
  child.on('message',message=>{
   if(message?.type==='done')return;
   if(message?.type!=='result'){
    const row={commit:message?.sha,workerPid:child.pid,status:'failed',error:message?.message,acknowledged:false};rows.set(row.commit,row);result.revisions.push(row);preserve(worker,undefined,new Error('Actual history worker reported '+message?.message));return;
   }
   const graph=message.result.graph,commit=message.result.sha,row={commit,workerPid:child.pid,status:'observing',acknowledged:false};rows.set(commit,row);result.revisions.push(row);pendingGraphs.set(child.pid,graph);
   try{
    assert.ok(worker.job?.commits.includes(commit)&&byCommit.has(commit));assert.ok(!worker.results.includes(commit),'Duplicate actual worker result');worker.results.push(commit);
    const prior=byCommit.get(commit),original=JSON.parse(readFileSync(path.join(job.baselineDirectory,job.record.id,commit+'-original.json')));assert.equal(original.recordDigest,prior.original.recordDigest);assert.equal(original.commit,commit);
    row.original=inspectHistoryTreeSync(worker.job.directory,original);row.graphInputs=verifyHistoryGraphInputs(graph,original);row.logical=productionGraphDigest(graph,{normalize:false});
    const recorded=baselineStore.snapshot(prior.snapshot.id);assert.ok(recorded);assert.deepEqual(withoutVolatile(graph.run),withoutVolatile(recorded.run),'Fresh graph run changes exceed UUID/time');
    const compared=productionGraphDigest({...graph,run:{...graph.run,id:recorded.run.id,analyzedAt:recorded.run.analyzedAt}},{normalize:false});assert.deepEqual(compared,prior.logical,'Fresh original graph fields/storage/proofs differ');
    row.baselineComparison={sha256:compared.sha256,bytes:compared.bytes,volatileFields:['run.id','run.analyzedAt']};row.status='worker-verified';
   }catch(error){preserve(worker,graph,error);}
  });
  child.once('close',(exitCode,signal)=>{worker.exitCode=exitCode;worker.signal=signal;workers.delete(child);});return child;
 };
 syncBuiltinESMExports();
 try{
  const load=file=>import(pathToFileURL(path.join(job.engine,file)).href),[indexer,store,projection]=await Promise.all([load(layout.modules.indexer),load(layout.modules.store),load(layout.modules.projection)]);HistoryStore=store.HistoryStore;
  assert.equal(indexer.historyIdentity(job.record.config),job.record.historyIdentity);baselineStore=new HistoryStore(path.join(job.baselineDirectory,job.record.database),true);
  const events=[],started=performance.now(),indexed=await indexer.indexHistory({root:job.root,stateDirectory:job.state,ref:job.record.head,commits:job.record.revisions.map(row=>row.commit),jobs:2,onProgress:event=>{
   events.push(event);
   if(event.type==='indexed'){
    const row=rows.get(event.commit.sha);assert.ok(row,'Actual indexed event has no observed worker graph');row.snapshot={id:event.snapshot.id,seq:event.snapshot.seq,stats:event.snapshot.stats};
    const worker=result.workers.find(worker=>worker.pid===row.workerPid);let durable;
    try{assert.equal(row.status,'worker-verified');durable=new HistoryStore(database,true);row.readback=productionSnapshotDigest(durable,event.snapshot.id);assert.deepEqual(row.readback,row.logical,'Actual entrypoint save changed full worker graph');assert.ok(Number(statfsSync(unit).bavail)*Number(statfsSync(unit).bsize)>=1024*1024*1024,'Fresh history exceeded disk reserve');row.status='verified';}
    catch(error){preserve(worker,pendingGraphs.get(row.workerPid),error);row.status='failed';row.error=error.message;}finally{durable?.close();}
   }else if(event.type==='failed')result.error??=event.error;
  }}),durationMs=performance.now()-started;
  result.stages.push({name:'fresh',indexed,events,durationMs});assert.ok(!result.error,result.error);
  assert.deepEqual(indexed,{ref:job.record.head,head:job.record.head,indexed:job.record.revisions.length,failed:0,skipped:0,snapshots:job.record.revisions.length});
  const plan=events.find(event=>event.type==='plan');assert.equal(plan.pending,job.record.revisions.length);assert.equal(plan.jobs,2);assert.equal(result.workers.length,2);assert.equal(workers.size,0);
  // scratch() awaits asynchronous filesystem I/O for each chunk. Either
  // worker may be born first; each exact contiguous job remains prescribed.
  const size=Math.ceil(job.record.revisions.length/2),expectedChunks=[job.record.revisions.slice(0,size),job.record.revisions.slice(size)].map(chunk=>chunk.map(row=>row.commit)),byFirst=new Map(result.workers.map(worker=>[worker.job.commits[0],worker]));assert.equal(byFirst.size,2);
  for(const chunk of expectedChunks)assert.deepEqual(byFirst.get(chunk[0])?.job.commits,chunk);
  for(const worker of result.workers){assert.equal(worker.exitCode,0);assert.equal(worker.signal,null);assert.deepEqual(worker.results,worker.job.commits);assert.deepEqual(worker.acknowledgements,worker.job.commits);}
  assert.equal(rows.size,job.record.revisions.length);assert.ok(result.revisions.every(row=>row.status==='verified'&&row.acknowledged));
  // Checkpoint only the new owned database, after the actual indexer closes.
  let history=new HistoryStore(database);history.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();history.close();history=new HistoryStore(database,true);let before,registry;
  try{for(const row of result.revisions)assert.deepEqual(productionSnapshotDigest(history,row.snapshot.id),row.logical);before=snapshotStorageLedger(history.db);registry=history.layoutRegistry();assert.ok(registry);await writeFile(path.join(unit,'registry.json'),JSON.stringify(registry,null,2)+'\n',{flag:'wx'});}finally{history.close();}
  result.snapshotColumnLedger=before;result.readOnlyReopenVerified=true;
  const resumeEvents=[],resumeStarted=performance.now(),resumed=await indexer.indexHistory({root:job.root,stateDirectory:job.state,ref:job.record.head,commits:job.record.revisions.map(row=>row.commit),jobs:2,onProgress:event=>resumeEvents.push(event)});
  result.stages.push({name:'resume',indexed:resumed,events:resumeEvents,durationMs:performance.now()-resumeStarted});assert.deepEqual(resumed,{ref:job.record.head,head:job.record.head,indexed:0,failed:0,skipped:job.record.revisions.length,snapshots:job.record.revisions.length});assert.equal(resumeEvents.find(event=>event.type==='plan').pending,0);assert.equal(resumeEvents.find(event=>event.type==='layout').rebuilt,false);assert.equal(result.workers.length,2);
  history=new HistoryStore(database,true);try{
   assert.deepEqual(snapshotStorageLedger(history.db),before,'Resume changed complete snapshot columns');assert.deepEqual(history.layoutRegistry(),registry);
   const {GraphStore}=await load(layout.modules.graphStore);result.views=await verifyPublicHistoryViews(history,{GraphStore,ProjectionService:projection.ProjectionService});assert.deepEqual(snapshotStorageLedger(history.db),before);assert.deepEqual(history.layoutRegistry(),registry);
  }finally{history.close();}
  result.passed=true;
 }catch(error){result.error??=error.message;result.stack=error.stack;process.exitCode=1;}
 finally{baselineStore?.close();childProcess.fork=nativeFork;syncBuiltinESMExports();for(const child of workers)child.kill('SIGTERM');}
 result.completedAt=new Date().toISOString();await writeFile(path.join(unit,'child-receipt.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({id:result.id,passed:result.passed,revisions:result.revisions.length,error:result.error}));
}else{
 const corpusFile=path.resolve(options['--corpus']??path.join(project,'docs/production-history-corpus.json')),profilesFile=path.resolve(options['--profiles']??path.join(project,'docs/production-head-profiles.json')),baselineFile=path.resolve(options['--baseline']),destination=path.resolve(options['--output']),engine=await realpath(options['--engine']??project),corpusBytes=await readFile(corpusFile),profilesBytes=await readFile(profilesFile),baselineBytes=await readFile(baselineFile),baseline=JSON.parse(baselineBytes),corpus=validateCorpus(JSON.parse(corpusBytes)),profiles=JSON.parse(profilesBytes),identity=JSON.parse(await readFile(path.resolve(options['--engine-identity']))),metadata=JSON.parse(await readFile(path.resolve(options['--git-metadata'])));
 assert.equal(process.platform,'linux');assert.equal(baseline.passed,true);assert.ok(baseline.completedAt);assert.equal(hash(JSON.stringify(identity.files)),identity.sha256);assert.equal(baseline.corpusSha256,hash(corpusBytes));assert.equal(baseline.profilesSha256,hash(profilesBytes));
 const layout=historyRuntimeLayout(identity);
 const runtimeInputComparison=compareHistoryRuntimeInputs(historySourceIdentity(identity),historySourceIdentity(baseline.engineIdentity));assert.ok(metadata.completedAt);
 assert.deepEqual(Object.keys(sources).sort(),corpus.repositories.map(row=>row.id).sort());assert.equal(await realpath(path.dirname(destination)),path.dirname(destination));assert.ok(outside(path.dirname(baselineFile),destination));
 for(const source of Object.values(sources))assert.ok(outside(await realpath(source),destination),'Output is inside original source');
 const selected=options['--repository']?corpus.repositories.filter(row=>row.id===options['--repository']):corpus.repositories;assert.ok(selected.length);
 const frozenNames=['observe-production-history-entrypoint.mjs','production-history-runtime-inputs.mjs','production-history-runtime-layout.mjs','production-history-tree-sync.mjs','production-history-tree.mjs','production-history-storage.mjs','production-graph-digest.mjs','production-history-storage-ledger.mjs','production-history-public-views.mjs','production-cache-git.mjs','production-history-inputs.mjs','production-history-blobs.mjs','process-memory.mjs'],frozen=Object.fromEntries(await Promise.all(frozenNames.map(async name=>[name,await fileHash(path.join(project,'scripts',name))]))),originalHashes=new Map();
 let qualification,qualificationSha256;
 if(options['--qualification']){
  const bytes=await readFile(options['--qualification']);qualificationSha256=hash(bytes);qualification=JSON.parse(bytes);assert.equal(qualification.passed,true);assert.equal(qualification.full195RevisionOriginalWorkerStorageResumeViewsQualified,true);const receipt=qualification.artifacts.find(row=>row.file===baselineFile);assert.ok(receipt);assert.equal(receipt.sha256,hash(baselineBytes));
  assert.deepEqual(corpus.repositories.map(row=>row.id).sort(),['axum','bookstack','firefly-iii','flask','full-stack-fastapi','memos']);for(const row of corpus.repositories){assert.equal(row.revisions.length,32);assert.equal(row.extraRevisions.length,row.id==='flask'?3:0);}
 }
 async function verify(){
  for(const [name,expected] of Object.entries(frozen))assert.equal(await fileHash(path.join(project,'scripts',name)),expected,'Frozen observer changed');
  for(const ledger of historyRuntimeLedgers(identity,engine)){assert.equal(hash(JSON.stringify(ledger.identity.files)),ledger.identity.sha256);for(const row of ledger.identity.files){const file=path.resolve(ledger.root,row.file);assert.ok(file.startsWith(ledger.root+path.sep));assert.equal(await realpath(file),file);assert.equal(await fileHash(file),row.sha256,'Frozen '+ledger.role+' runtime changed');}for(const link of ledger.identity.links??[]){assert.ok(link&&typeof link.file==='string'&&typeof link.target==='string');const file=path.resolve(ledger.root,link.file);assert.ok(file.startsWith(ledger.root+path.sep));assert.equal(await readlink(file),link.target);}}
  assert.equal(await fileHash(corpusFile),hash(corpusBytes));assert.equal(await fileHash(profilesFile),hash(profilesBytes));assert.equal(await fileHash(baselineFile),hash(baselineBytes));if(qualificationSha256)assert.equal(await fileHash(options['--qualification']),qualificationSha256);
  for(const [file,expected] of originalHashes)assert.equal(await fileHash(file),expected,'Original database/source receipt changed');
 }
 await verify();await mkdir(destination);const report={schema:1,startedAt:new Date().toISOString(),passed:false,phase:'fresh-production-indexHistory-entrypoint-workers-and-resume',engineIdentity:identity,baselineEngineSha256:baseline.engineIdentity.sha256,observer:frozen,corpusSha256:hash(corpusBytes),profilesSha256:hash(profilesBytes),baselineReceiptSha256:hash(baselineBytes),repositories:[],full195RevisionEntrypointQualified:false,relativeHistoryTimeRssQualified:false,nativeWindowsMacOSQualified:false,method:'Actual fresh indexHistory jobs=2, unmodified contiguous worker jobs/messages/store/acknowledgements; synchronous complete original-tree and worker graph observations plus actual durable save/read-only readback. Previous graph comparison replaces run.id/analyzedAt only. Complete columns and registry survive real resume; all public nodes checked twice. Verification overhead included, no relative performance claim. Targets never execute.'};
 if(qualification){report.baselineQualificationSha256=qualificationSha256;await writeFile(path.join(destination,'input-qualification.json'),await readFile(options['--qualification']),{flag:'wx'});}
 report.runtimeInputComparison=runtimeInputComparison;report.executionLayout=layout;report.qualificationSourceRuntimeSha256=historySourceIdentity(identity).sha256;report.observerRoot=project;
 const publish=async()=>{const file=path.join(destination,'receipt.json.pending');await writeFile(file,JSON.stringify(report,null,2)+'\n');await rename(file,path.join(destination,'receipt.json'));};
 for(const [name,bytes] of [['input-corpus.json',corpusBytes],['input-profiles.json',profilesBytes],['input-baseline.json',baselineBytes],['input-engine.json',JSON.stringify(identity)]])await writeFile(path.join(destination,name),bytes,{flag:'wx'});await publish();
 for(const specification of selected){
  const record=baseline.repositories.find(row=>row.id===specification.id),row={id:specification.id,passed:false};report.repositories.push(row);
  try{
   assert.ok(record&&record.status==='verified'&&record.readOnlyReopenVerified&&record.worker.exitCode===0);try{process.kill(record.worker.pid,0);assert.fail('Baseline worker is live');}catch(error){if(error.code!=='ESRCH')throw error;}
   const profile=profiles.repositories.find(row=>row.id===specification.id);assert.equal(profile.commit,specification.head);assert.deepEqual(profile.config,record.config);assert.equal(profile.config.maxFileBytes,8*1024*1024);assert.deepEqual(record.revisions.map(row=>row.commit),[...specification.revisions,...specification.extraRevisions].map(row=>row.commit));
   const originalDatabase=path.resolve(path.dirname(baselineFile),record.database);assert.equal(originalDatabase,path.join(path.dirname(baselineFile),record.id,'state/history.db'));assert.equal(await realpath(originalDatabase),originalDatabase);const originalSha=await fileHash(originalDatabase);originalHashes.set(originalDatabase,originalSha);if(qualification)assert.equal(originalSha,qualification.repositories.find(row=>row.id===record.id).originalDatabaseSha256);
   const free=await statfs(destination);assert.ok(Number(free.bavail)*Number(free.bsize)>=(await lstat(originalDatabase)).size+1024*1024*1024,'Insufficient space for a fresh unit plus reserve');
   for(const revision of [...specification.revisions,...specification.extraRevisions]){const {reason,...expected}=revision;assert.deepEqual(await readRevision(sources[record.id],revision.commit),expected);const file=path.join(path.dirname(baselineFile),record.id,revision.commit+'-original.json');originalHashes.set(file,await fileHash(file));}
   const group=metadata.repositories[record.id];assert.ok(group&&group.commit===specification.head);const objects=await realpath(path.resolve(sources[record.id],(await readGit(sources[record.id],['rev-parse','--git-path','objects'])).trim()));assert.equal(objects,group.objectDirectory);
   const unit=path.join(destination,record.id),state=path.join(unit,'state'),root=path.join(unit,'metadata-root'),scratch=path.join(unit,'scratch'),gitDirectory=path.join(unit,'git');for(const directory of [state,root,scratch,path.join(gitDirectory,'refs')])await mkdir(directory,{recursive:true});await writeFile(path.join(state,'config.yml'),stringify(record.config));
   for(const item of group.files){const source=path.resolve(group.directory,item.file),target=path.resolve(gitDirectory,item.file);assert.ok(source.startsWith(group.directory+path.sep)&&target.startsWith(gitDirectory+path.sep));assert.equal(await realpath(source),source);assert.equal(await fileHash(source),item.sha256);await mkdir(path.dirname(target),{recursive:true});await copyFile(source,target);assert.equal(await fileHash(target),item.sha256);}
   const jobFile=path.join(unit,'job.json');await writeFile(jobFile,JSON.stringify({engine,identity,state,root,scratch,record,baselineDirectory:path.dirname(baselineFile)},null,2)+'\n',{flag:'wx'});await verify();
   const stream=createWriteStream(path.join(unit,'child.log'),{flags:'wx'}),child=childProcess.fork(self,['--child',jobFile],{execArgv:layout.execArgv,env:{...productionGitEnvironment({...group,directory:gitDirectory},root),TMPDIR:scratch},cwd:project,stdio:['ignore','pipe','pipe','ipc']});child.stdout.pipe(stream,{end:false});child.stderr.pipe(stream,{end:false});row.process={pid:child.pid,samples:0,incompleteSamples:0,treePeakKiB:0};await publish();
   const sample=()=>{const value=sampleProcessTreeRssKiB(child.pid);row.process.samples++;if(value.incomplete)row.process.incompleteSamples++;if(value.available)row.process.treePeakKiB=Math.max(row.process.treePeakKiB,value.rssKiB);};sample();const timer=setInterval(sample,25),terminal=await new Promise(resolve=>{child.once('error',error=>{row.spawnError=error.message;});child.once('close',(exitCode,signal)=>resolve({exitCode,signal}));});clearInterval(timer);Object.assign(row.process,terminal);stream.end();await finished(stream);
   row.child=JSON.parse(await readFile(path.join(unit,'child-receipt.json')));assert.equal(row.child.pid,child.pid);assert.equal(terminal.exitCode,0);assert.equal(row.child.passed,true);await verify();
   for(const item of group.files){assert.equal(await fileHash(path.join(group.directory,item.file)),item.sha256);assert.equal(await fileHash(path.join(gitDirectory,item.file)),item.sha256);}
   row.originalDatabaseSha256=originalSha;row.originalDatabaseUnchanged=true;row.databaseSha256=await fileHash(path.join(state,'history.db'));row.passed=true;
  }catch(error){row.error=error.message;}
  row.completedAt=new Date().toISOString();await publish();if(!row.passed)break;
 }
 await verify();report.completedAt=new Date().toISOString();report.passed=report.repositories.length===selected.length&&report.repositories.every(row=>row.passed);report.full195RevisionEntrypointQualified=report.passed&&Boolean(qualification)&&!options['--repository']&&selected.length===6&&report.repositories.reduce((sum,row)=>sum+row.child.revisions.length,0)===195;await publish();console.log(JSON.stringify({passed:report.passed,repositories:report.repositories.map(row=>({id:row.id,passed:row.passed,error:row.error})),full195RevisionEntrypointQualified:report.full195RevisionEntrypointQualified}));if(!report.passed)process.exitCode=1;
}
