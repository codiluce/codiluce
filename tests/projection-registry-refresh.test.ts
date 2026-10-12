import assert from 'node:assert/strict';
import {test,mock} from 'node:test';
import {copyFile,mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {GraphBuilder} from '../src/core/graph.js';
import {GraphStore} from '../src/storage/sqlite.js';
import {HistoryStore} from '../src/history/store.js';
import {ProjectionIndex} from '../src/projection/hierarchy.js';
import {ProjectionService} from '../src/projection/service.js';
import {emptyRegistry,extendRegistry} from '../src/projection/layout.js';

async function fixture(){
 const directory=await mkdtemp(path.join(os.tmpdir(),'codiluce-registry-refresh-')),writer=new HistoryStore(path.join(directory,'history.db')),live=new GraphStore(':memory:'),commit='a'.repeat(40),proof={source:'filesystem' as const,analyzer:'owned',analyzerVersion:'1',confidence:1};
 writer.saveCommits([{sha:commit,tree:'b'.repeat(40),parents:[],authorName:'Owned',authorEmail:'fixture@example.invalid',authoredAt:'2026-01-01T00:00:00Z',committedAt:'2026-01-01T00:00:00Z',subject:'Owned',body:''}]);
 const builder=new GraphBuilder('owned-registry'),root=builder.id('repository'),a=builder.id('file','a.txt'),b=builder.id('file','b.txt');builder.addEntity({id:root,type:'repository',name:'Owned',metadata:{},evidence:[proof]});
 for(const [id,name] of [[a,'a.txt'],[b,'b.txt']])builder.contain({id:id!,type:'file',name:name!,path:name!,parentId:root,metadata:{bytes:2,unknown:{retained:'every original field'}},metrics:{loc:2},evidence:[proof]});
 const graph=builder.finish({id:randomUUID(),repositoryId:root,repositoryName:'Owned',commitSha:commit,dirty:false,analyzedAt:new Date().toISOString(),schemaVersion:1,configDigest:'owned',analyzerVersions:{owned:'1'}}),snapshot=writer.saveSnapshot(graph,'owned'),projection=new ProjectionIndex(snapshot.id,writer.entities(snapshot.seq),[],[]),registry=emptyRegistry();extendRegistry(registry,projection.layoutNodes(),projection.rootId);writer.saveLayoutRegistry([snapshot.id],registry);
 const reader=new HistoryStore(writer.file,true),view={snapshot:snapshot.id};
 const payloads=()=>JSON.stringify(['snapshots','entity_versions','relation_versions','diagnostic_versions','snapshot_entities','snapshot_relations','snapshot_diagnostics'].map(table=>writer.db.prepare('SELECT * FROM '+table).all()));
 const enlarged=()=>{const value=structuredClone(registry);value.nodes[a]!.weight=4096;return value;};
 return {directory,writer,reader,live,view,snapshot,a,b,registry,enlarged,payloads,close:async()=>{reader.close();writer.close();live.close();await rm(directory,{recursive:true,force:true});}};
}

test('existing readonly public views refresh after same-ID registry changes by another connection',async()=>{
 const f=await fixture();try{const service=new ProjectionService(f.live,{history:()=>f.reader}),before=service.nodes([f.b],f.view).items[0]!.rect,payloads=f.payloads();f.writer.saveLayoutRegistry([f.snapshot.id],f.enlarged());const fresh=new ProjectionService(f.live,{history:()=>f.reader}).nodes([f.b],f.view).items[0]!.rect;assert.notDeepEqual(fresh,before);assert.deepEqual(service.nodes([f.b],f.view).items[0]!.rect,fresh);assert.equal(f.payloads(),payloads);}finally{await f.close();}
});

test('writable callers observe their own registry updates and rollback without stale cached geometry',async()=>{
 const f=await fixture();try{const service=new ProjectionService(f.live,{history:()=>f.writer}),before=service.nodes([f.b],f.view).items[0]!.rect;f.writer.db.exec('BEGIN');f.writer.saveLayoutRegistry([f.snapshot.id],f.enlarged());assert.notDeepEqual(service.nodes([f.b],f.view).items[0]!.rect,before);f.writer.db.exec('ROLLBACK');assert.deepEqual(service.nodes([f.b],f.view).items[0]!.rect,before);f.writer.saveLayoutRegistry([f.snapshot.id],f.enlarged());assert.deepEqual(service.nodes([f.b],f.view).items[0]!.rect,new ProjectionService(f.live,{history:()=>f.writer}).nodes([f.b],f.view).items[0]!.rect);}finally{await f.close();}
});

test('readonly node pages avoid repeated registry payload reads and unrelated commits preserve placement',async()=>{
 const f=await fixture();let spy;try{const original=f.reader.db.prepare;let reads=0;spy=mock.method(f.reader.db,'prepare',function(this:typeof f.reader.db,sql:string){if(sql.includes('FROM layout_registry'))reads++;return original.call(this,sql);});const service=new ProjectionService(f.live,{history:()=>f.reader}),before=service.nodes([f.b],f.view).items[0]!.rect;for(let index=0;index<100;index++)assert.deepEqual(service.nodes([f.b],f.view).items[0]!.rect,before);assert.equal(reads,1,'Unchanged readonly requests do not reread the full registry');f.writer.setMeta('unrelated-marker','new');assert.deepEqual(service.nodes([f.b],f.view).items[0]!.rect,before);assert.equal(reads,2);for(let index=0;index<20;index++)service.nodes([f.b],f.view);assert.equal(reads,2);}finally{spy?.mock.restore();await f.close();}
});

test('removed, incompatible and restored registries invalidate timeline views with unchanged snapshot IDs',async()=>{
 const f=await fixture();try{const service=new ProjectionService(f.live,{history:()=>f.reader});assert.equal(service.meta(f.view).layout.source,'timeline');f.writer.db.exec('DELETE FROM layout_registry');assert.equal(service.meta(f.view).layout.source,'fresh');f.writer.saveLayoutRegistry([f.snapshot.id],{...f.registry,version:999});assert.equal(service.meta(f.view).layout.source,'fresh');f.writer.saveLayoutRegistry([f.snapshot.id],f.enlarged());assert.equal(service.meta(f.view).layout.source,'timeline');assert.deepEqual(service.nodes([f.b],f.view).items[0]!.rect,new ProjectionService(f.live,{history:()=>f.reader}).nodes([f.b],f.view).items[0]!.rect);}finally{await f.close();}
});

test('changing the history connection cannot reuse another connection-local registry version',async()=>{
 const f=await fixture();let other:HistoryStore|undefined;try{let selected=f.reader;const service=new ProjectionService(f.live,{history:()=>selected}),before=service.nodes([f.b],f.view).items[0]!.rect;f.writer.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();const file=path.join(f.directory,'other.db');await copyFile(f.writer.file,file);other=new HistoryStore(file);other.saveLayoutRegistry([f.snapshot.id],f.enlarged());selected=other;const expected=new ProjectionService(f.live,{history:()=>other}).nodes([f.b],f.view).items[0]!.rect;assert.notDeepEqual(expected,before);assert.deepEqual(service.nodes([f.b],f.view).items[0]!.rect,expected);}finally{other?.close();await f.close();}
});

test('malformed registry JSON remains a visible failure until a valid replacement is committed',async()=>{
 const f=await fixture();try{const service=new ProjectionService(f.live,{history:()=>f.reader});service.meta(f.view);f.writer.db.prepare('UPDATE layout_registry SET state=? WHERE id=1').run('{broken');for(let index=0;index<3;index++)assert.throws(()=>service.meta(f.view),SyntaxError);f.writer.saveLayoutRegistry([f.snapshot.id],f.enlarged());assert.deepEqual(service.nodes([f.b],f.view).items[0]!.rect,new ProjectionService(f.live,{history:()=>f.reader}).nodes([f.b],f.view).items[0]!.rect);}finally{await f.close();}
});
