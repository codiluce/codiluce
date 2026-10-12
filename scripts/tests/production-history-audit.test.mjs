import assert from 'node:assert/strict';
import test from 'node:test';
import {execFile} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {access,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {GraphBuilder} from '../../src/core/graph.ts';
import {HistoryStore} from '../../src/history/store.ts';
import {productionGraphDigest} from '../production-graph-digest.mjs';
import {productionSnapshotDigest} from '../production-history-storage.mjs';
import {readRevision} from '../production-history-inputs.mjs';
import {inspectProductionHistoryTree,verifyHistoryGraphInputs} from '../production-history-tree.mjs';
import {auditProductionHistory,independentHistoryJSONDigest,verifyProductionHistoryRunInputs} from '../audit-production-history.mjs';

const execute=promisify(execFile),hash=bytes=>createHash('sha256').update(bytes).digest('hex'),proof={source:'filesystem',analyzer:'owned-audit',analyzerVersion:'1',confidence:1};
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
test('separate exact JSON implementation preserves native escapes, numbers, every producer/storage field and array position',()=>{
 const run={schemaVersion:1,id:'original UUID',analyzedAt:'original time',analyzerVersions:{'rust-symbols':'2'},unknown:{unicode:'😀\ud800',number:1e30,zero:-0}},records={entities:[{id:'a',metadata:{rustSymbolEvidence:{version:1,entries:[{source:'original'}],limits:{original:2}},proofRefs:[0,0],unknown:['one','two']}}],relations:[],diagnostics:[]};
 const parsed=JSON.parse(JSON.stringify({schemaVersion:1,run,...records})),expected='{'+['schemaVersion','run','entities','relations','diagnostics'].map(key=>JSON.stringify(key)+':'+canonical(parsed[key])).join(',')+'}',result=independentHistoryJSONDigest(parsed.run,records);
 assert.equal(result.sha256,hash(expected));assert.equal(result.bytes,Buffer.byteLength(expected));assert.deepEqual(result.normalization,[]);
 for(const change of [value=>value.run.id='changed',value=>value.run.analyzedAt='changed',value=>value.run.analyzerVersions['rust-symbols']='1',value=>value.entities[0].metadata.proofRefs.pop(),value=>value.entities[0].metadata.unknown.reverse(),value=>delete value.entities[0].metadata.rustSymbolEvidence]){
  const value=structuredClone(parsed);change(value);assert.notEqual(independentHistoryJSONDigest(value.run,{entities:value.entities,relations:[],diagnostics:[]}).sha256,result.sha256);
 }
 assert.throws(()=>independentHistoryJSONDigest(run,records,{maxBytes:result.bytes-1}),/byte budget/);
 assert.throws(()=>independentHistoryJSONDigest(run,{...records,entities:[...records.entities,...records.entities]}),/duplicate/);
});

async function fixture(){
 const root=await mkdtemp(path.join(os.tmpdir(),'codiluce-independent-history-audit-')),source=path.join(root,'source'),directory=path.join(root,'observation'),unit=path.join(directory,'owned'),state=path.join(unit,'state'),tree=path.join(unit,'tree');
 await mkdir(source);await mkdir(state,{recursive:true});await mkdir(tree);
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'});
 const git=async args=>(await execute('git',['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-C',source,...args],{env})).stdout.trim();
 await git(['init','--template=']);await git(['config','user.name','Owned audit fixture']);await git(['config','user.email','fixture@example.invalid']);
 const database=path.join(state,'history.db'),store=new HistoryStore(database),revisions=[],observations=[],identity='owned-exact-history';let head;
 try{
  for(const text of ['original source\n','changed source\n']){
   await writeFile(path.join(source,'original.txt'),text);await git(['add','original.txt']);await git(['commit','-m',text.trim()]);head=await git(['rev-parse','HEAD']);const revision=await readRevision(source,head);revisions.push(revision);
   const fields=(await git(['show','-s','--format=%H%x00%T%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%s%x00%b',head])).trimEnd().split('\0');const [sha,gitTree,parents,authorName,authorEmail,authoredAt,committedAt,subject,body]=fields;
   store.saveCommits([{sha,tree:gitTree,parents:parents?parents.split(' '):[],authorName,authorEmail,authoredAt,committedAt,subject,body:body.trim()}]);
   await writeFile(path.join(tree,'original.txt'),text);const original=await inspectProductionHistoryTree({source,directory:tree,revision});await writeFile(path.join(unit,head+'-original.json'),JSON.stringify(original));
   const builder=new GraphBuilder('owned-audit'),repositoryId=builder.id('repository');builder.addEntity({id:repositoryId,type:'repository',name:'Owned',metadata:{},evidence:[proof]});builder.contain({id:builder.id('file','original.txt'),type:'file',name:'original.txt',path:'original.txt',parentId:repositoryId,metadata:{bytes:Buffer.byteLength(text),contentHash:hash(text),unknown:{source:'Keep every field'}},metrics:{loc:1},evidence:[{...proof,file:'original.txt'}]});
   const graph=builder.finish({id:randomUUID(),repositoryId,repositoryName:'Owned',commitSha:head,dirty:false,analyzedAt:new Date().toISOString(),schemaVersion:1,configDigest:'owned',analyzerVersions:{'rust-symbols':'2'}}),snapshot=store.saveSnapshot(graph,identity,{durationMs:1.5,applicationSource:'configured'}),logical=productionGraphDigest(graph,{normalize:false});
   observations.push({commit:head,status:'verified',completedAt:new Date().toISOString(),original:{recordDigest:original.recordDigest,regularFiles:original.regularFiles,literalSymlinks:original.literalSymlinks,unhydratedGitlinks:original.unhydratedGitlinks,originalBytes:original.originalBytes},graphInputs:verifyHistoryGraphInputs(graph,original),logical,readback:productionSnapshotDigest(store,snapshot.id),snapshot:{id:snapshot.id,seq:snapshot.seq,stats:snapshot.stats},analysisDurationMs:1.5,applications:{source:'configured',substituted:{},missing:[]}});
  }
  store.saveTimeline(head,head,revisions.map(row=>row.commit),true);store.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  // Completed-worker fixture PID has actually exited, rather than a guessed PID.
  const exited=await execute(process.execPath,['-e','process.stdout.write(String(process.pid))']);const workerPid=Number(exited.stdout);await assert.rejects(access('/proc/'+workerPid),{code:'ENOENT'});
  const specification={id:'owned',repository:'https://github.com/owned/fixture',head,coverageIntent:'Owned exact SQLite history audit',policy:'consecutive-first-parent',revisions,extraRevisions:[]},record={id:'owned',head,expectedRevisions:2,status:'verified',error:null,worker:{pid:workerPid,exitCode:0,signal:null,samples:1,treePeakKiB:1},readOnlyReopenVerified:true,completedAt:new Date().toISOString(),database:'owned/state/history.db',historyIdentity:identity,revisions:observations,storage:store.status()},corpus={schema:1,repositories:[specification]},receipt={schema:1,platform:'linux',repositories:[record],passed:true,completedAt:new Date().toISOString()};
  return {root,source,directory,database,corpus,receipt};
 }catch(error){await rm(root,{recursive:true,force:true});throw error;}finally{store.close();}
}

test('independent read-only audit verifies original blobs, all exact SQLite payloads, deduplication and commit metadata',async()=>{
 const value=await fixture();try{
  const before=hash(await readFile(value.database)),result=await auditProductionHistory({...value,sources:{owned:value.source}});assert.equal(result.passed,true);assert.equal(result.full195RevisionGateQualified,false);assert.equal(result.repositories[0].revisions.length,2);assert.equal(result.repositories[0].originalBlobObjects,2);assert.equal(result.repositories[0].storage.versions.entities,3);assert.equal(hash(await readFile(value.database)),before);assert.equal(result.layoutResumeQualified,false);assert.equal(result.relativeHistoryTimeRssQualified,false);
 }finally{await rm(value.root,{recursive:true,force:true});}
});

test('actual SQLite metadata, payload, dangling memberships and original receipt corruption cannot qualify',async()=>{
 const value=await fixture();try{
  const audit=()=>auditProductionHistory({...value,sources:{owned:value.source}}),originalPath=path.join(value.directory,'owned',value.corpus.repositories[0].revisions[0].commit+'-original.json'),originalBytes=await readFile(originalPath),db=new DatabaseSync(value.database);
  try{
   const row=db.prepare('SELECT seq,run FROM snapshots ORDER BY seq LIMIT 1').get(),run=JSON.parse(row.run);run.id='invented UUID';db.prepare('UPDATE snapshots SET run=? WHERE seq=?').run(JSON.stringify(run),row.seq);await assert.rejects(audit(),/strictly equal/);db.prepare('UPDATE snapshots SET run=? WHERE seq=?').run(row.run,row.seq);
   const entity=db.prepare("SELECT vid,data FROM entity_versions WHERE type='file' LIMIT 1").get(),payload=JSON.parse(entity.data);payload.metadata.unknown.source='lost source field';db.prepare('UPDATE entity_versions SET data=? WHERE vid=?').run(JSON.stringify(payload),entity.vid);await assert.rejects(audit(),/Independent exact JSON digest differs/);db.prepare('UPDATE entity_versions SET data=? WHERE vid=?').run(entity.data,entity.vid);
   db.prepare('INSERT INTO snapshot_entities VALUES (?,?)').run(999999,entity.vid);await assert.rejects(audit(),/Dangling snapshot membership/);db.prepare('DELETE FROM snapshot_entities WHERE snapshot=?').run(999999);
   const sha=value.corpus.repositories[0].head,commit=db.prepare('SELECT subject FROM commits WHERE sha=?').get(sha);db.prepare('UPDATE commits SET subject=? WHERE sha=?').run('invented subject',sha);await assert.rejects(audit());db.prepare('UPDATE commits SET subject=? WHERE sha=?').run(commit.subject,sha);
  }finally{db.close();}
  const original=JSON.parse(originalBytes);original.entries[0].sha256='0'.repeat(64);original.recordDigest=hash(JSON.stringify(original.entries));await writeFile(originalPath,JSON.stringify(original));await assert.rejects(audit(),/SHA-256 differs/);await writeFile(originalPath,originalBytes);
  const mutable=structuredClone(value.receipt);mutable.repositories[0].worker.pid=process.pid;await assert.rejects(auditProductionHistory({...value,receipt:mutable,sources:{owned:value.source}}),/worker is still live/);
  const normalized=structuredClone(value.receipt);normalized.repositories[0].revisions[0].logical.normalization=['run UUID/time'];await assert.rejects(auditProductionHistory({...value,receipt:normalized,sources:{owned:value.source}}));
 }finally{await rm(value.root,{recursive:true,force:true});}
});

test('qualified engine, frozen observer and original profile drift fail the independent run-input audit',async()=>{
 const value=await fixture();try{
  const engine=path.join(value.root,'engine');await mkdir(path.join(engine,'src/history'),{recursive:true});
  const files=[];for(const file of ['src/history/git.ts','src/history/indexer.ts','src/history/store.ts','src/history/worker.ts']){await writeFile(path.join(engine,file),'Owned ledger fixture bytes for '+file);files.push({file,sha256:hash(await readFile(path.join(engine,file)))});}
  const observer={};for(const name of ['observe-production-history.mjs','production-history-tree.mjs','production-history-storage.mjs','production-graph-digest.mjs','production-cache-git.mjs','production-history-inputs.mjs','production-history-blobs.mjs','graph-json-artifact.mjs','process-memory.mjs'])observer[name]=hash(await readFile(new URL('../'+name,import.meta.url)));
  const config={maxFileBytes:8*1024*1024},corpusBytes=Buffer.from(JSON.stringify(value.corpus)),profilesBytes=Buffer.from(JSON.stringify({schema:1,repositories:[{id:'owned',commit:value.corpus.repositories[0].head,config}]})),receipt={...structuredClone(value.receipt),corpusSha256:hash(corpusBytes),profilesSha256:hash(profilesBytes),engineIdentity:{files,sha256:hash(JSON.stringify(files))},observer};receipt.repositories[0].config=config;
  const options={receipt,corpusBytes,profilesBytes,engine};assert.equal((await verifyProductionHistoryRunInputs(options)).engineFiles,4);
  await writeFile(path.join(engine,files[0].file),'Changed qualified engine bytes');await assert.rejects(verifyProductionHistoryRunInputs(options),/Qualified engine input changed/);await writeFile(path.join(engine,files[0].file),'Owned ledger fixture bytes for '+files[0].file);
  const changedObserver=structuredClone(receipt);changedObserver.observer['production-history-storage.mjs']='0'.repeat(64);await assert.rejects(verifyProductionHistoryRunInputs({...options,receipt:changedObserver}),/Frozen observer input changed/);
  const changedProfile=structuredClone(receipt);changedProfile.repositories[0].config={maxFileBytes:1};await assert.rejects(verifyProductionHistoryRunInputs({...options,receipt:changedProfile}),/configuration differs/);
  const corpusFile=path.join(value.root,'corpus.json'),profilesFile=path.join(value.root,'profiles.json'),receiptFile=path.join(value.directory,'receipt.json'),output=path.join(value.root,'audit.json');await writeFile(corpusFile,corpusBytes);await writeFile(profilesFile,profilesBytes);await writeFile(receiptFile,JSON.stringify(receipt));
  const args=['--experimental-sqlite',new URL('../audit-production-history.mjs',import.meta.url).pathname,'--corpus',corpusFile,'--profiles',profilesFile,'--engine',engine,'--receipt',receiptFile,'--source','owned='+value.source,'--output',output];
  await execute(process.execPath,args);const retained=JSON.parse(await readFile(output)),inputBytes=await readFile(output+'.inputs.json'),input=JSON.parse(inputBytes);assert.equal(retained.passed,true);assert.equal(retained.full195RevisionGateQualified,false);assert.equal(retained.inputSnapshot.sha256,hash(inputBytes));assert.equal(input.files.receipt.utf8,(await readFile(receiptFile)).toString());assert.equal(input.files.receipt.sha256,retained.receiptSha256);
  const unsafe=[...args];unsafe[unsafe.indexOf('--output')+1]=path.join(value.source,'audit.json');await assert.rejects(execute(process.execPath,unsafe),error=>/outside original inputs/.test(error.stderr));await assert.rejects(access(path.join(value.source,'audit.json.inputs.json')),{code:'ENOENT'});
 }finally{await rm(value.root,{recursive:true,force:true});}
});
