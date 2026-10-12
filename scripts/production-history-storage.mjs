import assert from 'node:assert/strict';
import {productionRecordDigest} from './production-graph-digest.mjs';

/** Minimum Node 22.12 has no StatementSync.iterate(). Load only sorted
 * membership IDs, then one complete JSON payload per primary-key lookup.
 * No entity/relationship/evidence projection is used for proof parity. */
export function productionSnapshotDigest(history,id,options={}){
 const snapshot=history.snapshot(id);assert.ok(snapshot,'Stored snapshot is missing');
 const groups={entities:['entity','entity_id'],relations:['relation','relation_id'],diagnostics:['diagnostic','id']},records={};
 for(const [group,[singular,key]] of Object.entries(groups)){
  const memberships=history.db.prepare(`SELECT v.vid,v.${key} AS id FROM snapshot_${group} m JOIN ${singular}_versions v ON v.vid=m.version WHERE m.snapshot=? ORDER BY v.${key}`).all(snapshot.seq);
  const payload=history.db.prepare(`SELECT data FROM ${singular}_versions WHERE vid=?`);
  records[group]={*[Symbol.iterator](){
   for(const member of memberships){const row=payload.get(member.vid);assert.ok(row&&typeof row.data==='string','Complete stored JSON payload is missing');const value=JSON.parse(row.data);assert.equal(value.id,member.id,'Stored payload identity differs from its membership');yield value;}
  }};
 }
 const digest=productionRecordDigest(snapshot.run,records,options);
 assert.deepEqual(digest.counts,{entities:snapshot.stats.entities,relations:snapshot.stats.relations,diagnostics:snapshot.stats.diagnostics},'Stored snapshot record inventory differs');return digest;
}
