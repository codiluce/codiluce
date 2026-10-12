// Raw immutable snapshot storage audit. Includes every SQLite column, not a UI
// projection. Keyset pages bound ID inventories on minimum Node 22.12.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

export const SNAPSHOT_PAYLOAD_TABLES=Object.freeze({
 snapshots:['seq'],entity_versions:['vid'],relation_versions:['vid'],diagnostic_versions:['vid'],
 snapshot_entities:['snapshot','version'],snapshot_relations:['snapshot','version'],snapshot_diagnostics:['snapshot','version'],
});

export function snapshotStorageLedger(database,{pageSize=128,maxTableBytes=16*1024*1024*1024,maxRows=10000000}={}){
 for(const value of [pageSize,maxTableBytes,maxRows])assert.ok(Number.isSafeInteger(value)&&value>0);assert.ok(pageSize<=1024);
 const tables={};
 for(const [table,keys] of Object.entries(SNAPSHOT_PAYLOAD_TABLES)){
  const columns=database.prepare('PRAGMA table_info('+table+')').all().map(row=>row.name);assert.ok(columns.length&&keys.every(key=>columns.includes(key)),'Snapshot table schema is missing');
  const keyOrder=keys.join(','),keyTuple='('+keyOrder+')',placeholder='('+keys.map(()=>'?').join(',')+')',projection=table.startsWith('snapshot_')?'*':keyOrder;
  const first=database.prepare(`SELECT ${projection} FROM ${table} ORDER BY ${keyOrder} LIMIT ?`),next=database.prepare(`SELECT ${projection} FROM ${table} WHERE ${keyTuple}>${placeholder} ORDER BY ${keyOrder} LIMIT ?`),payload=table.startsWith('snapshot_')?null:database.prepare(`SELECT * FROM ${table} WHERE ${keys.map(key=>key+'=?').join(' AND ')}`);
  const digest=createHash('sha256');let bytes=0,rows=0,largestTextBytes=0,previous;
  const emit=text=>{bytes+=Buffer.byteLength(text);assert.ok(bytes<=maxTableBytes,'Snapshot table ledger byte budget exceeded');digest.update(text);};
  emit(JSON.stringify({table,columns})+'\n');
  for(;;){
   const page=previous?next.all(...previous,pageSize):first.all(pageSize);if(!page.length)break;assert.ok(page.length<=pageSize);
   for(const member of page){
    const values=keys.map(key=>member[key]);assert.ok(values.every(value=>Number.isSafeInteger(value)&&value>0),'Unexpected snapshot primary key');
    if(previous)assert.ok(values.some((value,index)=>value>previous[index]&&values.slice(0,index).every((prior,i)=>prior===previous[i])),'Snapshot keys did not advance');previous=values;
    const row=payload?payload.get(...values):member;assert.ok(row);emit('row:');assert.ok(++rows<=maxRows,'Snapshot table row budget exceeded');
    for(const column of columns){
     const value=row[column];if(value===null){emit('null;');continue;}
     assert.ok(typeof value==='string'||typeof value==='number','Unexpected SQLite snapshot column type');
     const text=typeof value==='number'?JSON.stringify(value):value;assert.equal(typeof text,'string');const size=Buffer.byteLength(text);if(typeof value==='string')largestTextBytes=Math.max(largestTextBytes,size);
     emit((typeof value==='number'?'n':'s')+size+':');emit(text);emit(';');
    }
    emit('\n');
   }
  }
  assert.equal(database.prepare('SELECT count(*) AS n FROM '+table).get().n,rows,'Snapshot table inventory changed');
  tables[table]={sha256:digest.digest('hex'),bytes,rows,columns,largestTextBytes};
 }
 return {schema:1,format:'complete-snapshot-sqlite-column-ledger-v1',pageSize,maxTableBytes,maxRows,tables};
}
