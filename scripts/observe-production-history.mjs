// Complete pinned corpus through the shipped history worker/channel/store.
// One acknowledged graph at a time; no duplicate full-graph artifacts.
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import {finished} from 'node:stream/promises';
import {cp,lstat,mkdir,readFile,realpath,rename,statfs,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {stringify} from 'yaml';
import {validateCorpus,readGit} from './production-history-inputs.mjs';
import {productionGitEnvironment} from './production-cache-git.mjs';
import {inspectProductionHistoryTree,verifyHistoryGraphInputs} from './production-history-tree.mjs';
import {productionGraphDigest} from './production-graph-digest.mjs';
import {productionSnapshotDigest} from './production-history-storage.mjs';
import {writeGraphArtifact} from './graph-json-artifact.mjs';
import {sampleProcessTreeRssKiB,processPeakRssKiB} from './process-memory.mjs';
import {prepareHistoryRecovery,verifyHistoryRecovery} from './production-history-recovery.mjs';

const project=fileURLToPath(new URL('../',import.meta.url)),args=process.argv.slice(2),options={},sources={};
for(let i=0;i<args.length;i++){
 const flag=args[i],value=args[++i];assert.ok(value&&!value.startsWith('--'),'Every option requires a value');
 if(flag==='--source'){const at=value.indexOf('=');assert.ok(at>0&&at<value.length-1&&!Object.hasOwn(sources,value.slice(0,at)));sources[value.slice(0,at)]=path.resolve(value.slice(at+1));}
 else{assert.ok(['--corpus','--profiles','--engine','--engine-identity','--git-metadata','--output','--resume','--resume-engine'].includes(flag)&&!Object.hasOwn(options,flag));options[flag]=path.resolve(value);}
}
assert.equal(Boolean(options['--resume']),Boolean(options['--resume-engine']),'Resume requires both the previous receipt and frozen observer engine');
const corpus=validateCorpus(JSON.parse(await readFile(options['--corpus']??path.join(project,'docs/production-history-corpus.json')))),profiles=JSON.parse(await readFile(options['--profiles']??path.join(project,'docs/production-head-profiles.json'))),metadata=JSON.parse(await readFile(options['--git-metadata'])),engine=await realpath(options['--engine']??project),identity=JSON.parse(await readFile(options['--engine-identity']));
assert.equal(process.platform,'linux','Actual worker RSS qualification requires Linux /proc; native OS gates remain separate');
assert.ok(Array.isArray(identity.files)&&identity.files.length>0);assert.equal(createHash('sha256').update(JSON.stringify(identity.files)).digest('hex'),identity.sha256,'Provided engine ledger identity differs');
for(const required of ['src/history/worker.ts','src/history/git.ts','src/history/indexer.ts','src/history/store.ts'])assert.ok(identity.files.some(row=>row.file===required),'Missing history runtime input');
assert.equal(profiles.schema,1);assert.deepEqual(Object.keys(sources).sort(),corpus.repositories.map(row=>row.id).sort());assert.deepEqual(Object.keys(metadata.repositories).sort(),Object.keys(sources).sort());assert.ok(metadata.completedAt);
for(const repository of corpus.repositories){const profile=profiles.repositories.find(row=>row.id===repository.id);assert.ok(profile&&profile.commit===repository.head&&profile.config.maxFileBytes===8*1024*1024);assert.equal(metadata.repositories[repository.id].commit,repository.head);}
const destination=options['--output'];await mkdir(destination);assert.equal(await realpath(destination),destination);
for(const source of Object.values(sources)){const relative=path.relative(await realpath(source),destination);assert.ok(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative));}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),observerNames=['observe-production-history.mjs','production-history-tree.mjs','production-history-storage.mjs','production-graph-digest.mjs','production-cache-git.mjs','production-history-inputs.mjs','production-history-blobs.mjs','graph-json-artifact.mjs','process-memory.mjs','production-history-recovery.mjs'];
const observer=Object.fromEntries(await Promise.all(observerNames.map(async name=>[name,sha(await readFile(new URL(name,import.meta.url)))])));
async function verify(){
 for(const [file,digest] of Object.entries(observer))assert.equal(sha(await readFile(new URL(file,import.meta.url))),digest,'Observer changed');
 for(const row of identity.files)assert.equal(sha(await readFile(path.resolve(engine,row.file))),row.sha256,'Engine changed');
 for(const group of Object.values(metadata.repositories))for(const row of group.files)assert.equal(sha(await readFile(path.join(group.directory,row.file))),row.sha256,'Isolated original metadata changed');
}
async function publish(file,value){const pending=path.join(destination,file+'.pending');await writeFile(pending,JSON.stringify(value,null,2)+'\n');await rename(pending,path.join(destination,file));}
const receipt={schema:1,startedAt:new Date().toISOString(),completedAt:null,phase:'full-original-corpus-history-worker-store-readback',node:process.version,platform:process.platform,engineIdentity:identity,observer,corpusSha256:sha(await readFile(options['--corpus']??path.join(project,'docs/production-history-corpus.json'))),profilesSha256:sha(await readFile(options['--profiles']??path.join(project,'docs/production-head-profiles.json'))),inputProfile:'Complete original regular inputs and literal symlink bytes from Git; symlinks are recreated by production TreeMirror and verified by readlink only; gitlinks remain empty directories. All original byte identities and graph scan hashes checked.',storage:'Complete sorted SQLite JSON records read back one payload at a time; exact public graph JSON digest, without any UUID/time/producer/storage normalization, must match every original field/proof/diagnostic. No projection/count-only parity.',execution:'Owned Node/TypeScript/WASM indexers and read-only isolated Git metadata only; targets never execute',workerPolicy:'One actual shipped worker per repository; one advanced-IPC graph awaits original-byte/storage/readback handling before its stored acknowledgment. Actual failed graphs/trees/database/receipts retained.',memoryMethod:'25 ms sampled all-thread descendant RSS over the complete worker lifetime, including materialization/indexing/IPC waits; parent VmHWM covers the cumulative observer lifetime including verification/storage. No relative full-history time/RSS gate is claimed.',repositories:[],passed:false,fullHistoryRelativePerformanceQualified:false,nativeWindowsMacOSQualified:false};await publish('receipt.json',receipt);await verify();
const [{HistoryStore},{historyIdentity}]=await Promise.all([import(pathToFileURL(path.join(engine,'src/history/store.ts')).href),import(pathToFileURL(path.join(engine,'src/history/indexer.ts')).href)]);
if(options['--resume']){
 const recovered=await prepareHistoryRecovery({receiptFile:options['--resume'],previousEngine:options['--resume-engine'],identity,corpus,corpusSha256:receipt.corpusSha256,profilesSha256:receipt.profilesSha256,destination,HistoryStore});
 receipt.repositories=recovered.repositories;receipt.recovery=recovered.recovery;await publish('receipt.json',receipt);await verify();
}
for(const repository of corpus.repositories){
 if(receipt.repositories.some(row=>row.id===repository.id))continue;
 const profile=profiles.repositories.find(row=>row.id===repository.id),unit=path.join(destination,repository.id);await mkdir(unit);const state=path.join(unit,'state'),tree=path.join(unit,'tree');await mkdir(state);await writeFile(path.join(state,'config.yml'),stringify(profile.config));
 const revisions=[...repository.revisions,...repository.extraRevisions],byCommit=new Map(revisions.map(row=>[row.commit,row])),snapshotIdentity=historyIdentity(profile.config),database=path.join(state,'history.db'),store=new HistoryStore(database);
 const record={id:repository.id,head:repository.head,expectedRevisions:revisions.length,config:profile.config,historyIdentity:snapshotIdentity,status:'starting',revisions:[],database:path.relative(destination,database),worker:null,storage:null,error:null};receipt.repositories.push(record);await publish('receipt.json',receipt);
 let child,processing=Promise.resolve(),busy=false,stop=false,workerTerminal;
 try{
  await verify();const commits=[];
  for(const revision of revisions){const fields=(await readGit(sources[repository.id],['show','-s','--format=%H%x00%T%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%s%x00%b',revision.commit,'--'])).trimEnd().split('\0');assert.equal(fields.length,9);const [commit,gitTree,parents,authorName,authorEmail,authoredAt,committedAt,subject,body]=fields;assert.equal(commit,revision.commit);assert.equal(gitTree,revision.tree);assert.deepEqual(parents?parents.split(' '):[],revision.parents);commits.push({sha:commit,tree:gitTree,parents:revision.parents,authorName,authorEmail,authoredAt,committedAt,subject,body:body.trim()});}
  store.saveCommits(commits);store.saveTimeline(repository.head,repository.head,repository.revisions.map(row=>row.commit),true);
  const stream=createWriteStream(path.join(unit,'worker.log'),{flags:'wx'});let streamError;stream.on('error',error=>{streamError=error;});
  const env=productionGitEnvironment(metadata.repositories[repository.id],tree);
  child=fork(path.join(engine,'src/history/worker.ts'),[],{execArgv:['--experimental-sqlite','--import','tsx'],env,cwd:project,serialization:'advanced',stdio:['ignore','pipe','pipe','ipc']});record.worker={pid:child.pid,samples:0,incompleteSamples:0,treePeakKiB:0,childPeakKiB:0,processes:0};child.stdout.pipe(stream,{end:false});child.stderr.pipe(stream,{end:false});
  const poll=()=>{const value=sampleProcessTreeRssKiB(child.pid);record.worker.samples++;if(value.incomplete)record.worker.incompleteSamples++;if(value.available){record.worker.treePeakKiB=Math.max(record.worker.treePeakKiB,value.rssKiB);record.worker.childPeakKiB=Math.max(record.worker.childPeakKiB,value.childRssKiB);record.worker.processes=Math.max(record.worker.processes,value.processes);}};poll();const timer=setInterval(poll,25);
  child.on('message',message=>{
   if(busy||stop){record.error='Unexpected queued production worker result';stop=true;child.kill('SIGTERM');return;}
   busy=true;processing=(async()=>{
    const commit=message?.type==='result'?message.result?.sha:message?.sha,revision=byCommit.get(commit),row={commit,status:'verifying',startedAt:new Date().toISOString()};record.revisions.push(row);await publish('receipt.json',receipt);
    try{
     assert.ok(revision&&!record.revisions.slice(0,-1).some(row=>row.commit===commit),'Unknown or duplicate corpus result');await verify();
     const free=await statfs(destination);assert.ok(Number(free.bavail)*Number(free.bsize)>=1024*1024*1024,'Less than 1 GiB free; retain failure evidence and stop this unit');
     if(message.type!=='result')throw Error('Production worker analysis failed: '+message.message);
     const original=await inspectProductionHistoryTree({source:sources[repository.id],directory:tree,revision});await publish(repository.id+'/'+commit+'-original.json',original);row.original={recordDigest:original.recordDigest,regularFiles:original.regularFiles,literalSymlinks:original.literalSymlinks,unhydratedGitlinks:original.unhydratedGitlinks,originalBytes:original.originalBytes};
     row.graphInputs=verifyHistoryGraphInputs(message.result.graph,original);row.logical=productionGraphDigest(message.result.graph,{normalize:false});row.analysisDurationMs=message.result.durationMs;row.applications=message.result.applications;
     const started=performance.now(),snapshot=store.saveSnapshot(message.result.graph,snapshotIdentity,{durationMs:message.result.durationMs,applicationSource:message.result.applications.source,substitutedApplications:message.result.applications.substituted,missingApplications:message.result.applications.missing});row.storeMilliseconds=performance.now()-started;row.snapshot={id:snapshot.id,seq:snapshot.seq,stats:snapshot.stats};
     const readbackStarted=performance.now();row.readback=productionSnapshotDigest(store,snapshot.id);row.readbackMilliseconds=performance.now()-readbackStarted;assert.deepEqual(row.readback,row.logical,'Full stored graph differs from the shipped worker output');assert.deepEqual(await inspectProductionHistoryTree({source:sources[repository.id],directory:tree,revision}),original,'Original mirror changed during proof handling');await verify();row.status='verified';
     const checkpoint=store.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();assert.equal(Number(checkpoint.busy),0,'Database checkpoint remained busy');row.database=store.status();
    }catch(error){
     row.status='failed';row.error=error.message;record.error=error.message;stop=true;
     const failed=path.join(unit,'failed-'+(commit??'unknown'));await mkdir(failed);try{await cp(tree,path.join(failed,'tree'),{recursive:true,dereference:false,verbatimSymlinks:true});row.failedTree=path.relative(destination,path.join(failed,'tree'));}catch(copyError){row.failedTreeError=copyError.message;}
     if(message?.type==='result')try{row.failedGraph=await writeGraphArtifact(path.join(failed,'graph.json'),message.result.graph);}catch(artifactError){row.failedGraphError=artifactError.message;}
    }
    row.parentCumulativeVmHwmKiB=processPeakRssKiB();row.completedAt=new Date().toISOString();await publish('receipt.json',receipt);busy=false;
    if(stop)child.kill('SIGTERM');else child.send({type:'stored',sha:commit},error=>{if(error){record.error=error.message;stop=true;}});
   })().catch(error=>{record.error=error.message;stop=true;busy=false;child.kill('SIGTERM');});
  });
  child.once('error',error=>{record.error=error.message;stop=true;});child.send({root:tree,directory:tree,raw:profile.config,commits:revisions.map(row=>row.commit)});
  workerTerminal=await new Promise(resolve=>child.once('close',(exitCode,signal)=>resolve({exitCode,signal})));clearInterval(timer);await processing;stream.end();await finished(stream);if(streamError)throw streamError;Object.assign(record.worker,workerTerminal);assert.equal(workerTerminal.exitCode,0,'Production history worker exited unsuccessfully');assert.ok(!record.error);assert.equal(record.revisions.length,revisions.length);assert.ok(record.revisions.every(row=>row.status==='verified'));record.storage=store.status();record.status='verified';
 }catch(error){record.status='failed';record.error??=error.message;if(workerTerminal&&record.worker)Object.assign(record.worker,workerTerminal);}
 finally{store.close();}
 // Reopen actual durable bytes read-only and verify every full snapshot again.
 if(record.status==='verified'){
  const durable=new HistoryStore(database,true);try{for(const row of record.revisions)assert.deepEqual(productionSnapshotDigest(durable,row.snapshot.id),row.logical);record.readOnlyReopenVerified=true;record.storage=durable.status();}catch(error){record.status='failed';record.error=error.message;}finally{durable.close();}
 }
 record.completedAt=new Date().toISOString();await publish('receipt.json',receipt);
}
await verify();if(receipt.recovery)await verifyHistoryRecovery(receipt.recovery);receipt.completedAt=new Date().toISOString();receipt.passed=receipt.repositories.length===corpus.repositories.length&&receipt.repositories.every(row=>row.status==='verified');await publish('receipt.json',receipt);console.log(JSON.stringify({output:destination,passed:receipt.passed,revisions:receipt.repositories.reduce((sum,row)=>sum+row.revisions.filter(item=>item.status==='verified').length,0)}));if(!receipt.passed)process.exitCode=1;
