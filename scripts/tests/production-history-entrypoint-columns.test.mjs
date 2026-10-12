import assert from 'node:assert/strict';
import test from 'node:test';
import {execFile} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {HistoryStore} from '../../src/history/store.ts';
import {GraphBuilder} from '../../src/core/graph.ts';
import {productionGraphDigest} from '../production-graph-digest.mjs';
import {snapshotStorageLedger} from '../production-history-storage-ledger.mjs';

const execute=promisify(execFile),project=fileURLToPath(new URL('../../',import.meta.url)),sha=bytes=>createHash('sha256').update(bytes).digest('hex'),python=process.platform==='win32'?'python':'python3';
test('independent fresh-entrypoint column audit joins terminal worker UUIDs and retains failed evidence',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'codiluce-fresh-columns-'));let store,passed=false;
 try{
  const observation=path.join(root,'observation'),unit=path.join(observation,'owned'),database=path.join(unit,'state/history.db'),receiptFile=path.join(observation,'receipt.json'),childFile=path.join(unit,'child-receipt.json');await mkdir(path.dirname(database),{recursive:true});
  const pids=[];for(let i=0;i<3;i++)pids.push(Number((await execute(process.execPath,['-e','process.stdout.write(String(process.pid))'])).stdout));
  store=new HistoryStore(database);const commits=['a'.repeat(40),'b'.repeat(40)];store.saveCommits(commits.map((commit,index)=>({sha:commit,tree:'c'.repeat(40),parents:index?[commits[0]]:[],authorName:'Owned',authorEmail:'fixture@example.invalid',authoredAt:'2026-01-01T00:00:00Z',committedAt:'2026-01-01T00:00:00Z',subject:'Owned '+index,body:''})));
  const revisions=commits.map((commit,index)=>{
   const builder=new GraphBuilder('owned-fresh-columns'),repository=builder.id('repository'),proof={source:'filesystem',analyzer:'owned',analyzerVersion:'1',confidence:1};builder.addEntity({id:repository,type:'repository',name:'Owned',metadata:{},evidence:[proof]});builder.contain({id:builder.id('file','😀.txt'),type:'file',name:'😀.txt',path:'😀.txt',parentId:repository,metadata:{unknown:'😀β;row:'.repeat(1000)},metrics:{loc:1},evidence:[proof]});const graph=builder.finish({id:randomUUID(),repositoryId:repository,repositoryName:'Owned',commitSha:commit,dirty:false,analyzedAt:new Date().toISOString(),schemaVersion:1,configDigest:'owned',analyzerVersions:{owned:'1'}}),snapshot=store.saveSnapshot(graph,'owned'),logical=productionGraphDigest(graph,{normalize:false});return {commit,workerPid:pids[index+1],status:'verified',acknowledged:true,snapshot,logical,readback:logical};
  });
  const child={schema:1,id:'owned',pid:pids[0],passed:true,completedAt:new Date().toISOString(),readOnlyReopenVerified:true,revisions,snapshotColumnLedger:snapshotStorageLedger(store.db),workers:commits.map((commit,index)=>({pid:pids[index+1],job:{commits:[commit]},results:[commit],acknowledgements:[commit],exitCode:0,signal:null}))};store.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();store.close();store=undefined;
  const original=sha(await readFile(database)),receipt={schema:1,startedAt:new Date().toISOString(),phase:'fresh-production-indexHistory-entrypoint-workers-and-resume',engineIdentity:{sha256:'owned',files:[]},observer:{},corpusSha256:'owned',profilesSha256:'owned',baselineReceiptSha256:'owned',baselineEngineSha256:'owned',repositories:[{id:'owned',passed:true,completedAt:new Date().toISOString(),originalDatabaseUnchanged:true,databaseSha256:original,process:{pid:pids[0],exitCode:0,signal:null},child}]};
  await writeFile(receiptFile,JSON.stringify(receipt));await writeFile(childFile,JSON.stringify(child));await writeFile(path.join(unit,'job.json'),JSON.stringify({state:path.dirname(database),record:{id:'owned',revisions:commits.map(commit=>({commit}))}}));
  const audit=async(name,success=true)=>{
   const output=path.join(root,name+'.json'),args=['scripts/audit-history-entrypoint-columns.py','--receipt',receiptFile,'--repository','owned','--output',output];
   if(success)await execute(python,args,{cwd:project,maxBuffer:1024*1024});else await assert.rejects(execute(python,args,{cwd:project,maxBuffer:1024*1024}),error=>error.code===1);
   const value=JSON.parse(await readFile(output)),captured=JSON.parse(await readFile(output+'.inputs.json'));assert.equal(value.passed,success);assert.equal(value.inputSnapshot.sha256,sha(await readFile(output+'.inputs.json')));assert.equal(value.inputReceiptSha256,sha(Buffer.from(captured.receiptUtf8)));return value;
  };
  const observed=await audit('passed');assert.equal(observed.revisions,2);assert.equal(observed.full195RevisionEntrypointQualified,false);assert.equal(Object.keys(observed.database.tables).length,7);assert.deepEqual(observed.actualSnapshotIdentities,revisions.map(row=>({id:row.snapshot.id,seq:row.snapshot.seq,commit:row.commit})));
  receipt.repositories[0].passed=false;await writeFile(receiptFile,JSON.stringify(receipt));assert.match((await audit('pending',false)).error,/not terminal/);receipt.repositories[0].passed=true;
  receipt.repositories[0].process.pid=process.pid;await writeFile(receiptFile,JSON.stringify(receipt));assert.match((await audit('live',false)).error,/still live/);receipt.repositories[0].process.pid=pids[0];
  child.revisions[0].snapshot.id=randomUUID();await writeFile(receiptFile,JSON.stringify(receipt));await writeFile(childFile,JSON.stringify(child));assert.match((await audit('uuid',false)).error,/snapshot UUID/);child.revisions[0].snapshot.id=observed.actualSnapshotIdentities[0].id;
  const hidden=new HistoryStore(database);try{const row=hidden.db.prepare("SELECT vid,data FROM entity_versions WHERE type='file'").get(),value=JSON.parse(row.data);value.metadata.unknown='Hidden detail lost';hidden.db.prepare('UPDATE entity_versions SET data=? WHERE vid=?').run(JSON.stringify(value),row.vid);hidden.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();}finally{hidden.close();}
  receipt.repositories[0].databaseSha256=sha(await readFile(database));await writeFile(receiptFile,JSON.stringify(receipt));await writeFile(childFile,JSON.stringify(child));assert.match((await audit('hidden-column',false)).error,/Complete column ledger differs: entity_versions/);
  await assert.rejects(execute(python,['scripts/audit-history-entrypoint-columns.py','--receipt',receiptFile,'--repository','owned','--output',path.join(observation,'unsafe.json')],{cwd:project}),error=>/inside an observation/.test(error.stderr));
  passed=true;
 }finally{store?.close();if(passed)await rm(root,{recursive:true,force:true});else console.error('Retained fresh column fixture',root);}
});
