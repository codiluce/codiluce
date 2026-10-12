// Actual indexHistory layout/resume on copies of closed worker/store databases.
// Original observations remain immutable; no target working tree or code runs.
import assert from 'node:assert/strict';
import {fork,execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream,createWriteStream} from 'node:fs';
import {finished} from 'node:stream/promises';
import {access,copyFile,lstat,mkdir,readFile,realpath,statfs,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {stringify} from 'yaml';
import {productionGitEnvironment} from './production-cache-git.mjs';
import {readGit,validateCorpus} from './production-history-inputs.mjs';
import {verifyProductionHistoryRunInputs} from './audit-production-history.mjs';
import {snapshotStorageLedger} from './production-history-storage-ledger.mjs';
import {sampleProcessTreeRssKiB} from './process-memory.mjs';

const execute=promisify(execFile),sha=bytes=>createHash('sha256').update(bytes).digest('hex'),self=fileURLToPath(import.meta.url),project=fileURLToPath(new URL('../',import.meta.url));
async function fileHash(file){const hash=createHash('sha256');for await(const bytes of createReadStream(file))hash.update(bytes);return hash.digest('hex');}
const outside=(root,file)=>{const relative=path.relative(root,file);return relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative);};
const options={},sources={},args=process.argv.slice(2);
for(let i=0;i<args.length;i++){
 const flag=args[i],value=args[++i];assert.ok(value&&!value.startsWith('--'));
 if(flag==='--source'){const at=value.indexOf('=');assert.ok(at>0&&at<value.length-1&&!Object.hasOwn(sources,value.slice(0,at)));sources[value.slice(0,at)]=path.resolve(value.slice(at+1));}
 else{assert.ok(['--child','--corpus','--profiles','--engine','--git-metadata','--receipt','--repository','--output'].includes(flag)&&!Object.hasOwn(options,flag));options[flag]=value;}
}

async function geometry(history,persisted,{ProjectionIndex,timelineLayout,placeOnTimeline}){
 const rows=[],layouts=new Map();let prior=new Map(),positions=0,stableRelativePositions=0;
 const key=id=>persisted.state.alias[id]??id;
 for(const id of persisted.snapshots){
  const snapshot=history.snapshot(id);assert.ok(snapshot);const entities=history.entities(snapshot.seq),index=new ProjectionIndex(id,entities,[],[]),nodes=index.layoutNodes();
  for(const entity of entities)assert.equal(index.nodes.get(entity.id)?.kind,'entity','Original entity disappeared from history projection');
  const root=key(index.rootId);if(!layouts.has(root))layouts.set(root,timelineLayout(persisted.state,root));
  const placed=placeOnTimeline(nodes,index.rootId,persisted.state,layouts.get(root));assert.equal(placed.holes,0,'A projected node has no reserved timeline slot');assert.equal(placed.rects.size,nodes.size);
  const current=new Map();
  for(const node of nodes.values()){
   const rect=placed.rects.get(node.id);assert.ok(rect&&Object.values(rect).every(Number.isSafeInteger)&&rect.w>0&&rect.h>0,'Invalid history rectangle');positions++;
   const projected=index.nodes.get(node.id),parentId=projected.spatialParentId;
   if(parentId){
    const parent=placed.rects.get(parentId),padding=nodes.get(parentId).padding;assert.ok(rect.x>=parent.x&&rect.y>=parent.y&&rect.x+rect.w<=parent.x+parent.w&&rect.y+rect.h<=parent.y+parent.h,'History rectangle escapes its parent');
    const location={slot:key(node.id),parent:key(parentId),padding,x:rect.x-parent.x,y:rect.y-parent.y},previous=prior.get(node.id);
    if(previous&&previous.slot===location.slot&&previous.parent===location.parent&&previous.padding===location.padding){assert.deepEqual(location,previous,'An unchanged slot moved relative to its parent');stableRelativePositions++;}
    current.set(node.id,location);
   }
   const siblings=node.children.map(child=>placed.rects.get(child)).sort((a,b)=>a.x-b.x);
   for(let left=0;left<siblings.length;left++)for(let right=left+1;right<siblings.length&&siblings[right].x<siblings[left].x+siblings[left].w;right++)assert.ok(siblings[right].y>=siblings[left].y+siblings[left].h||siblings[right].y+siblings[right].h<=siblings[left].y,'History siblings overlap');
  }
  prior=current;const rectangles=[...placed.rects].sort(([a],[b])=>a<b?-1:a>b?1:0);rows.push({id,commit:snapshot.commitSha,entities:entities.length,projectedNodes:nodes.size,holes:placed.holes,rectangleSha256:sha(JSON.stringify(rectangles))});
 }
 return {snapshots:rows,positions,stableRelativePositions,roots:layouts.size};
}

if(options['--child']){
 const job=JSON.parse(await readFile(options['--child'])),unit=path.dirname(options['--child']),result={schema:1,id:job.record.id,pid:process.pid,startedAt:new Date().toISOString(),passed:false,stages:[]};
 try{
  const load=file=>import(pathToFileURL(path.join(job.engine,file)).href),[{indexHistory,historyIdentity},{HistoryStore},{ProjectionIndex},layout]=await Promise.all([load('src/history/indexer.ts'),load('src/history/store.ts'),load('src/projection/hierarchy.ts'),load('src/projection/layout.ts')]);
  assert.equal(historyIdentity(job.record.config),job.record.historyIdentity,'Configuration/producer identity changed; refuse to analyze new graphs');
  const open=()=>new HistoryStore(path.join(job.state,'history.db'),true);let before=open(),snapshots,baseline;
  try{snapshots=before.snapshots();assert.deepEqual(snapshots.map(row=>row.id),job.record.revisions.map(row=>row.snapshot.id));for(const row of snapshots)assert.equal(row.identity,job.record.historyIdentity);assert.equal(before.layoutRegistry(),undefined);baseline=snapshotStorageLedger(before.db);}finally{before.close();}
  result.originalSnapshotLedger=baseline;
  const timeline=(await execute('git',['--no-replace-objects','rev-list','--first-parent','--reverse',job.record.head,'--'],{env:process.env,cwd:job.root,maxBuffer:64*1024*1024})).stdout.trim().split('\n'),byCommit=new Map(snapshots.map(row=>[row.commitSha,row])),expected=timeline.map(commit=>byCommit.get(commit)).filter(Boolean).map(row=>row.id);
  assert.ok(expected.length>=job.specification.revisions.length,'Original first-parent timeline lost a selected snapshot');result.originalGitTimeline={commits:timeline.length,sha256:sha(JSON.stringify(timeline)),selectedSnapshots:expected.length};
  let registry,firstGeometry;
  for(const name of ['layout-build','resume']){
   const events=[],started=performance.now(),indexed=await indexHistory({root:job.root,stateDirectory:job.state,ref:job.record.head,commits:job.record.revisions.map(row=>row.commit),jobs:2,onProgress:event=>{events.push(event);if(event.type==='plan')assert.equal(event.pending,0,'Unexpected analysis work during a stored-snapshot resume');if(['indexed','failed'].includes(event.type))throw Error('Stored original snapshot was reanalyzed');}}),durationMs=performance.now()-started;
   assert.deepEqual(indexed,{ref:job.record.head,head:job.record.head,indexed:0,failed:0,skipped:job.record.revisions.length,snapshots:snapshots.length});assert.equal(events.filter(row=>row.type==='plan').length,1);assert.equal(events.filter(row=>row.type==='layout').length,1);const plan=events.find(row=>row.type==='plan'),layoutEvent=events.find(row=>row.type==='layout');assert.equal(plan.targets,job.record.revisions.length);assert.equal(plan.pending,0);assert.equal(layoutEvent.snapshots,expected.length);assert.equal(layoutEvent.rebuilt,name==='layout-build');
   const durable=open();try{
    assert.deepEqual(snapshotStorageLedger(durable.db),baseline,'Complete stored snapshot columns/payloads/memberships changed during indexHistory');const persisted=durable.layoutRegistry();assert.ok(persisted);assert.deepEqual(persisted.snapshots,expected);assert.equal(persisted.state.version,layout.TIMELINE_LAYOUT_VERSION);
    const observed=await geometry(durable,persisted,{ProjectionIndex,...layout});if(name==='layout-build'){registry=persisted;firstGeometry=observed;await writeFile(path.join(unit,'registry.json'),JSON.stringify(registry,null,2)+'\n',{flag:'wx'});}else{assert.deepEqual(persisted,registry,'Resume changed the complete persisted registry');assert.deepEqual(observed,firstGeometry,'Resume moved an original snapshot rectangle');}
    result.stages.push({name,indexed,plan,layout:layoutEvent,durationMs,geometry:observed});
   }finally{durable.close();}
  }
  result.passed=true;
 }catch(error){result.error=error.message;result.stack=error.stack;process.exitCode=1;}
 result.completedAt=new Date().toISOString();await writeFile(path.join(unit,'child-receipt.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({id:result.id,passed:result.passed,error:result.error}));
}else{
 const corpusFile=path.resolve(options['--corpus']??path.join(project,'docs/production-history-corpus.json')),profilesFile=path.resolve(options['--profiles']??path.join(project,'docs/production-head-profiles.json')),receiptFile=path.resolve(options['--receipt']),destination=path.resolve(options['--output']),engine=await realpath(options['--engine']??project),corpusBytes=await readFile(corpusFile),profilesBytes=await readFile(profilesFile),receiptBytes=await readFile(receiptFile),receipt=JSON.parse(receiptBytes),corpus=validateCorpus(JSON.parse(corpusBytes)),metadata=JSON.parse(await readFile(path.resolve(options['--git-metadata'])));
 assert.equal(process.platform,'linux','Native platform runs are separate');const selected=options['--repository']?corpus.repositories.filter(row=>row.id===options['--repository']):corpus.repositories;assert.ok(selected.length);assert.ok(metadata.completedAt);
 assert.deepEqual(Object.keys(sources).sort(),corpus.repositories.map(row=>row.id).sort());
 assert.equal(await realpath(path.dirname(destination)),path.dirname(destination));assert.ok(outside(await realpath(path.dirname(receiptFile)),destination),'Resume observation must be outside the original history observation');
 for(const [id,source] of Object.entries(sources)){assert.ok(outside(await realpath(source),destination),'Resume output is inside an original working tree');const objects=await realpath(path.resolve(source,(await readGit(source,['rev-parse','--git-path','objects'])).trim()));assert.equal(objects,metadata.repositories[id].objectDirectory,'Original Git object provider differs');}
 for(const group of Object.values(metadata.repositories)){assert.ok(outside(await realpath(path.dirname(group.objectDirectory)),destination),'Resume output is inside an original Git repository');}
 await mkdir(destination);const frozenFiles=['observe-production-history-resume.mjs','production-history-storage-ledger.mjs','audit-production-history.mjs','production-history-inputs.mjs','production-cache-git.mjs','process-memory.mjs'],frozen=Object.fromEntries(await Promise.all(frozenFiles.map(async file=>[file,await fileHash(fileURLToPath(new URL(file,import.meta.url)))])));
 const verify=async()=>{for(const [file,digest] of Object.entries(frozen))assert.equal(await fileHash(fileURLToPath(new URL(file,import.meta.url))),digest,'Resume observer input changed');return verifyProductionHistoryRunInputs({receipt,corpusBytes:await readFile(corpusFile),profilesBytes:await readFile(profilesFile),engine});};
 const runInputs=await verify(),report={schema:1,startedAt:new Date().toISOString(),passed:false,phase:'actual-production-indexHistory-layout-resume-on-closed-snapshot-copies',runInputs,frozen,originalReceiptSha256:sha(receiptBytes),repositories:[],full195RevisionResumeQualified:false,relativeHistoryTimeRssQualified:false,nativeWindowsMacOSQualified:false,execution:'Actual owned indexHistory and projection on copied closed snapshots; owned metadata-only Git root exposes exact original ancestry/shallow bytes. No source analysis pending, and target applications/dependencies/hooks/compilers never execute.',memoryMethod:'25 ms sampled all-thread descendant RSS over the complete probe lifetime, including raw payload/storage/geometry checks. No relative history performance gate claimed.'};
 await writeFile(path.join(destination,'input-receipt.json'),receiptBytes,{flag:'wx'});await writeFile(path.join(destination,'input-corpus.json'),corpusBytes,{flag:'wx'});await writeFile(path.join(destination,'input-profiles.json'),profilesBytes,{flag:'wx'});
 for(const specification of selected){
  const record=receipt.repositories.find(row=>row.id===specification.id),row={id:specification.id,passed:false};report.repositories.push(row);let sourceHash,sourceDatabase;
  try{
   assert.ok(record);assert.equal(record.status,'verified','Repository worker/store observation is not complete');assert.equal(record.worker.exitCode,0);assert.equal(record.readOnlyReopenVerified,true);assert.equal(record.error,null);await assert.rejects(access('/proc/'+record.worker.pid),{code:'ENOENT'});
   assert.deepEqual(record.revisions.map(revision=>revision.commit),[...specification.revisions,...specification.extraRevisions].map(revision=>revision.commit));for(const revision of record.revisions){assert.equal(revision.status,'verified');assert.deepEqual(revision.logical.normalization,[]);assert.deepEqual(revision.logical,revision.readback);}
   const originalRoot=await realpath(path.dirname(receiptFile));sourceDatabase=path.resolve(originalRoot,record.database);assert.equal(sourceDatabase,path.join(originalRoot,specification.id,'state/history.db'));assert.equal(await realpath(sourceDatabase),sourceDatabase);const info=await lstat(sourceDatabase),free=await statfs(destination);assert.ok(Number(free.bavail)*Number(free.bsize)>=info.size+1024*1024*1024,'Insufficient free space for a complete database copy plus the 1 GiB reserve');
   try{assert.equal((await lstat(sourceDatabase+'-wal')).size,0,'Original database has pending WAL bytes');}catch(error){if(error.code!=='ENOENT')throw error;}
   sourceHash=await fileHash(sourceDatabase);row.originalDatabaseSha256=sourceHash;const unit=path.join(destination,specification.id),state=path.join(unit,'state'),root=path.join(unit,'metadata-root'),gitDirectory=path.join(unit,'git');await mkdir(state,{recursive:true});await mkdir(root);await mkdir(gitDirectory);await mkdir(path.join(gitDirectory,'refs'));await copyFile(sourceDatabase,path.join(state,'history.db'));assert.equal(await fileHash(path.join(state,'history.db')),sourceHash);await writeFile(path.join(state,'config.yml'),stringify(record.config));
   const group=metadata.repositories[specification.id];assert.ok(group&&group.commit===specification.head);const copied={...group,directory:gitDirectory};
   for(const file of group.files){const original=path.resolve(group.directory,file.file),target=path.resolve(gitDirectory,file.file);assert.ok(original.startsWith(group.directory+path.sep)&&target.startsWith(gitDirectory+path.sep));assert.equal(await realpath(original),original);assert.equal(await fileHash(original),file.sha256,'Original isolated Git metadata changed');await mkdir(path.dirname(target),{recursive:true});await copyFile(original,target);assert.equal(await fileHash(target),file.sha256);}
   const job=path.join(unit,'job.json');await writeFile(job,JSON.stringify({engine,state,root,specification,record},null,2)+'\n',{flag:'wx'});await writeFile(path.join(unit,'git-metadata.json'),JSON.stringify(copied,null,2)+'\n',{flag:'wx'});await verify();
   const stream=createWriteStream(path.join(unit,'child.log'),{flags:'wx'}),child=fork(self,['--child',job],{execArgv:['--experimental-sqlite','--import','tsx'],env:productionGitEnvironment(copied,root),cwd:project,stdio:['ignore','pipe','pipe','ipc']});child.stdout.pipe(stream,{end:false});child.stderr.pipe(stream,{end:false});row.worker={pid:child.pid,samples:0,incompleteSamples:0,treePeakKiB:0};
   const poll=()=>{const value=sampleProcessTreeRssKiB(child.pid);row.worker.samples++;if(value.incomplete)row.worker.incompleteSamples++;if(value.available)row.worker.treePeakKiB=Math.max(row.worker.treePeakKiB,value.rssKiB);};poll();const timer=setInterval(poll,25);const terminal=await new Promise(resolve=>{child.once('error',error=>{row.spawnError=error.message;});child.once('close',(exitCode,signal)=>resolve({exitCode,signal}));});clearInterval(timer);Object.assign(row.worker,terminal);stream.end();await finished(stream);
   row.child=JSON.parse(await readFile(path.join(unit,'child-receipt.json')));assert.equal(row.child.pid,child.pid);assert.equal(terminal.exitCode,0,'Actual indexHistory resume probe failed');assert.equal(row.child.passed,true);await verify();
   for(const file of group.files){assert.equal(await fileHash(path.join(group.directory,file.file)),file.sha256);assert.equal(await fileHash(path.join(gitDirectory,file.file)),file.sha256,'Probe mutated isolated Git inputs');}
   row.passed=true;
  }catch(error){row.error=error.message;}
  if(sourceDatabase&&sourceHash){row.originalDatabaseSha256After=await fileHash(sourceDatabase);row.originalObservationUnchanged=row.originalDatabaseSha256After===sourceHash;if(!row.originalObservationUnchanged){row.passed=false;row.error='Original history observation database changed';}}
  row.completedAt=new Date().toISOString();await writeFile(path.join(destination,'receipt.json'),JSON.stringify(report,null,2)+'\n');
 }
 await verify();report.completedAt=new Date().toISOString();report.passed=report.repositories.every(row=>row.passed);report.full195RevisionResumeQualified=!options['--repository']&&receipt.passed===true&&Boolean(receipt.completedAt)&&selected.length===6&&report.repositories.reduce((count,row)=>count+(row.child?.stages[0]?.indexed.skipped??0),0)===195&&report.passed;
 await writeFile(path.join(destination,'receipt.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({passed:report.passed,repositories:report.repositories.map(row=>({id:row.id,passed:row.passed,error:row.error})),full195RevisionResumeQualified:report.full195RevisionResumeQualified}));if(!report.passed)process.exitCode=1;
}
