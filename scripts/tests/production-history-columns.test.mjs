import assert from 'node:assert/strict';
import test from 'node:test';
import {execFile} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {copyFile,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {HistoryStore} from '../../src/history/store.ts';
import {GraphBuilder} from '../../src/core/graph.ts';
import {snapshotStorageLedger} from '../production-history-storage-ledger.mjs';

const execute=promisify(execFile),project=fileURLToPath(new URL('../../',import.meta.url)),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
test('independent Python audits all original/copy SQLite columns and rejects Unicode payload loss and unsafe output',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'codiluce-history-column-audit-'));let store;
 try{
  const original=path.join(root,'original'),resume=path.join(root,'resume'),source=path.join(original,'owned/state/history.db'),copy=path.join(resume,'owned/state/history.db');await mkdir(path.dirname(source),{recursive:true});await mkdir(path.dirname(copy),{recursive:true});store=new HistoryStore(source);
  const commit='a'.repeat(40);store.saveCommits([{sha:commit,tree:'b'.repeat(40),parents:[],authorName:'Owned',authorEmail:'fixture@example.invalid',authoredAt:'2026-01-01T00:00:00Z',committedAt:'2026-01-01T00:00:00Z',subject:'Original',body:''}]);
  const builder=new GraphBuilder('owned-columns'),proof={source:'filesystem',analyzer:'owned',analyzerVersion:'1',confidence:1},repository=builder.id('repository');builder.addEntity({id:repository,type:'repository',name:'Owned',metadata:{},evidence:[proof]});builder.contain({id:builder.id('file','😀-original.txt'),type:'file',name:'😀-original.txt',path:'😀-original.txt',parentId:repository,metadata:{bytes:12,unknown:{unicode:'😀β;row:'.repeat(100000),surrogate:'\ud800',nullable:null}},metrics:{loc:1},evidence:[proof]});const graph=builder.finish({id:randomUUID(),repositoryId:repository,repositoryName:'Owned',commitSha:commit,dirty:false,analyzedAt:new Date().toISOString(),schemaVersion:1,configDigest:'owned',analyzerVersions:{owned:'1'}});store.saveSnapshot(graph,'owned');const expected=snapshotStorageLedger(store.db);store.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();store.close();store=undefined;
  await copyFile(source,copy);const before=sha(await readFile(source)),receipt={schema:1,passed:true,completedAt:new Date().toISOString(),repositories:[{id:'owned',passed:true,originalObservationUnchanged:true,originalDatabaseSha256:before,child:{originalSnapshotLedger:expected}}]};await writeFile(path.join(resume,'receipt.json'),JSON.stringify(receipt));
  const args=['scripts/audit-history-columns.py','--resume',resume,'--original',original,'--output',path.join(root,'audit.json')];await execute('python3',args,{cwd:project,maxBuffer:1024*1024});const audit=JSON.parse(await readFile(path.join(root,'audit.json')));assert.equal(audit.passed,true);assert.equal(audit.databases.length,2);assert.equal(audit.full195RevisionGateQualified,false);assert.equal(audit.databases[0].tables.entity_versions.sha256,expected.tables.entity_versions.sha256);assert.ok(audit.databases[0].tables.entity_versions.largestTextBytes>1000000);assert.equal(sha(await readFile(source)),before);
  store=new HistoryStore(copy);const row=store.db.prepare("SELECT vid,data FROM entity_versions WHERE type='file'").get(),value=JSON.parse(row.data);value.metadata.unknown.unicode='Lost original Unicode detail';store.db.prepare('UPDATE entity_versions SET data=? WHERE vid=?').run(JSON.stringify(value),row.vid);store.close();store=undefined;
  const changed=[...args];changed[changed.indexOf('--output')+1]=path.join(root,'failed.json');await assert.rejects(execute('python3',changed,{cwd:project,maxBuffer:1024*1024}),error=>error.code===1);const failure=JSON.parse(await readFile(path.join(root,'failed.json')));assert.equal(failure.passed,false);assert.match(failure.error,/Complete column ledger differs: entity_versions/);assert.equal(failure.databases.length,1,'Keep the completed original audit when the copy fails');assert.equal(sha(await readFile(source)),before);
  const unsafe=[...args];unsafe[unsafe.indexOf('--output')+1]=path.join(original,'forbidden.json');await assert.rejects(execute('python3',unsafe,{cwd:project,maxBuffer:1024*1024}),error=>/inside an observation/.test(error.stderr));
 }finally{store?.close();await rm(root,{recursive:true,force:true});}
});
