import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {qualifyHistoryPerformance} from '../production-history-performance-results.mjs';
import {qualifyHistoryPerformanceArtifacts,verifyHistoryPerformanceEvidence} from '../qualify-production-history-performance.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),date=seconds=>new Date(Date.UTC(2026,9,12,0,0,seconds)).toISOString();
function fixture(){
 const commits=['a'.repeat(40),'b'.repeat(40)],head=commits[1],old={sha256:hash('baseline'),files:[]},current={sha256:hash('current'),files:[]},corpus={repositories:[{id:'owned',head,revisions:commits.map(commit=>({commit})),extraRevisions:[]}]},prior={id:'owned',head,config:{maxFileBytes:8388608},revisions:commits.map(commit=>({commit,logical:{sha256:hash(commit),bytes:100,counts:{entities:2,relations:1,diagnostics:0},storage:{entries:3}}}))},baseline={passed:true,completedAt:date(0),engineIdentity:old,repositories:[prior]},qualification={passed:true,completedAt:date(0),full195RevisionEntrypointQualified:true,engineSha256:current.sha256,baselineEngineSha256:old.sha256},receipt={phase:'repeated-full-original-fresh-indexHistory-time-and-tree-RSS',startedAt:date(0),completedAt:date(100),repetitions:3,threshold:1.1,engineIdentities:{baseline:old,current},runs:[],nativeWindowsMacOSQualified:false},units=[],auditorSha256=hash('python-wrapper'),columnAuditorSha256=hash('python-columns');
 for(let repetition=0;repetition<3;repetition++)for(const label of repetition%2?['current','baseline']:['baseline','current']){
  const index=units.length,unit='owned-'+label+'-'+repetition,database=path.resolve('owned-performance-conformance',unit,'state/history.db'),databaseSha256=hash(unit+'database'),tables=Object.fromEntries(['snapshots','entity_versions','relation_versions','diagnostic_versions','snapshot_entities','snapshot_relations','snapshot_diagnostics'].map(name=>[name,{rows:2,bytes:100,sha256:hash(unit+name),columns:['complete_column'],largestTextBytes:10}])),result={schema:1,passed:true,milliseconds:100,parentVmHwmKiB:1000,indexed:{ref:head,head,indexed:2,failed:0,skipped:0,snapshots:2},plan:{type:'plan',ref:head,head,targets:2,pending:2,jobs:2},database,snapshotColumnLedger:{tables},revisions:commits.map((commit,i)=>({commit,status:'verified',snapshot:{id:unit+'-'+i,seq:i+1},logical:{sha256:hash(unit+commit),bytes:100,normalization:[],counts:prior.revisions[i].logical.counts,storage:prior.revisions[i].logical.storage},canonical:{sha256:prior.revisions[i].logical.sha256,bytes:100},volatileFields:['run.id','run.analyzedAt']}))},resultSha256=hash(JSON.stringify(result)),audit={schema:1,passed:true,startedAt:date(index*10+2),completedAt:date(index*10+3),measurementResultSha256:resultSha256,auditorSha256,columnAuditorSha256,databaseSha256,database:{database,sha256:databaseSha256,sha256After:databaseSha256,completeColumnLedgersMatch:true,tables}},row={id:'owned',label,repetition,unit,status:'complete',startedAt:date(index*10+1),completedAt:date(index*10+5),...structuredClone(result),treePeakKiB:4000,childPeakKiB:2000,processes:3,samples:3,incompleteSamples:0,pid:index+100,exitCode:0,signal:null,databaseSha256,columns:structuredClone(audit),retirement:{databaseSha256,afterCompleteGraphAndIndependentColumns:true,completedAt:date(index*10+4)}};
  receipt.runs.push(row);units.push({unit,request:{record:structuredClone(prior)},result:structuredClone(result),resultSha256,audit:structuredClone(audit)});
 }
 Object.assign(receipt,qualifyHistoryPerformance(receipt.runs,corpus,baseline,3));receipt.relativeHistoryTimeRssQualified=receipt.passed;return {receipt,corpus,baseline,qualification,units,auditorSha256,columnAuditorSha256};
}
function rebind(value,index=0){const row=value.receipt.runs[index],unit=value.units[index];for(const key of Object.keys(unit.result))unit.result[key]=structuredClone(row[key]);unit.resultSha256=hash(JSON.stringify(unit.result));row.columns.measurementResultSha256=unit.resultSha256;unit.audit=structuredClone(row.columns);}
function compare(value){Object.assign(value.receipt,qualifyHistoryPerformance(value.receipt.runs,value.corpus,value.baseline,3));value.receipt.relativeHistoryTimeRssQualified=value.receipt.passed;}

test('performance qualification joins raw results, seven independent ledgers and all predetermined pairs without emitting a production flag',()=>{
 const result=verifyHistoryPerformanceEvidence(fixture());assert.equal(result.passed,true);assert.equal(result.probes,6);assert.equal(result.revisions,2);assert.equal(result.independentCompleteColumnLedgers,42);assert.equal(result.relativeHistoryTimeRssQualified,undefined);assert.equal(result.full195RevisionEntrypointQualified,undefined);
});
test('complete terminal threshold failures remain complete failures with every outlier retained',()=>{
 const value=fixture();for(const [index,row]of value.receipt.runs.entries())if(row.label==='current'){row.milliseconds=111;rebind(value,index);}compare(value);const result=verifyHistoryPerformanceEvidence(value);assert.equal(result.complete,true);assert.equal(result.passed,false);assert.equal(result.comparisons[0].timeRatio,1.11);assert.equal(value.receipt.runs.length,6);
});

const cases=[
 ['live aggregate',v=>delete v.receipt.completedAt],
 ['missing sample',v=>v.receipt.runs.pop()],
 ['duplicate raw unit',v=>v.units.push(v.units[0])],
 ['selectively reordered pairs',v=>v.receipt.runs.reverse()],
 ['outlier replacement',v=>v.receipt.runs[0].milliseconds=99],
 ['changed raw result hash',v=>v.units[0].resultSha256=hash('other raw worker')],
 ['changed request history',v=>v.units[0].request.record.config.maxFileBytes=1],
 ['changed raw independent audit',v=>v.units[0].audit.database.tables.entity_versions.bytes++],
 ['unqualified auditor',v=>{v.receipt.runs[0].columns.auditorSha256=hash('other auditor');rebind(v);}],
 ['normalized hidden graph field',v=>{v.receipt.runs[0].revisions[0].logical.normalization=['storage'];rebind(v);}],
 ['extra cross-run normalization',v=>{v.receipt.runs[0].revisions[0].volatileFields.push('analyzerVersions');rebind(v);}],
 ['equal-count original graph substitution',v=>{v.receipt.runs[0].revisions[0].canonical.sha256=hash('hidden value');rebind(v);}],
 ['equal-count commit substitution',v=>{v.receipt.runs[0].revisions[0].commit='c'.repeat(40);rebind(v);}],
 ['duplicate snapshot UUID',v=>{v.receipt.runs[0].revisions[1].snapshot.id=v.receipt.runs[0].revisions[0].snapshot.id;rebind(v);}],
 ['lost graph counts',v=>{v.receipt.runs[0].revisions[0].logical.counts.entities++;rebind(v);}],
 ['changed read-only database',v=>{v.receipt.runs[0].columns.database.sha256After=hash('changed');rebind(v);}],
 ['hidden complete-column loss',v=>{v.receipt.runs[0].columns.database.tables.entity_versions.sha256=hash('hidden payload');rebind(v);}],
 ['missing table',v=>{delete v.receipt.runs[0].snapshotColumnLedger.tables.snapshot_diagnostics;rebind(v);}],
 ['parent-only RSS',v=>v.receipt.runs[0].processes=1],
 ['fractional sample count',v=>v.receipt.runs[0].samples=1.5],
 ['signal-terminated process',v=>v.receipt.runs[0].signal='SIGTERM'],
 ['repeated native process identity',v=>v.receipt.runs[1].pid=v.receipt.runs[0].pid],
 ['overlapping measured histories',v=>v.receipt.runs[1].startedAt=v.receipt.runs[0].startedAt],
 ['impossible measurement lifetime',v=>{v.receipt.runs[0].milliseconds=100000;rebind(v);compare(v);}],
 ['premature database retirement',v=>v.receipt.runs[0].retirement.completedAt=v.receipt.runs[0].startedAt],
 ['unverified retirement',v=>v.receipt.runs[0].retirement.afterCompleteGraphAndIndependentColumns=false],
 ['changed original runtime',v=>v.receipt.engineIdentities.baseline.sha256=hash('changed engine')],
 ['unqualified fresh entrypoint',v=>v.qualification.full195RevisionEntrypointQualified=false],
 ['unqualified original history',v=>v.baseline.passed=false],
 ['relaxed threshold',v=>v.receipt.threshold=1.2],
 ['selected repetitions',v=>v.receipt.repetitions=2],
 ['nonterminating repetitions',v=>v.receipt.repetitions=Infinity],
 ['invented native qualification',v=>v.receipt.nativeWindowsMacOSQualified=true],
 ['invented median',v=>v.receipt.comparisons[0].timeRatio=0.1],
];
for(const [name,change]of cases)test('performance qualification refuses '+name,()=>{const value=fixture();change(value);assert.throws(()=>verifyHistoryPerformanceEvidence(value));});

test('artifact command refuses a smaller authored corpus before runtime/process inspection and writes no machine-readable production gate',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'codiluce-performance-qualification-'));try{
  const value=fixture(),corpus={schema:1,repositories:[{...value.corpus.repositories[0],repository:'https://github.com/owned/fixture',policy:'consecutive-first-parent',coverageIntent:'Owned artifact scope guard',revisions:value.corpus.repositories[0].revisions.map((r,index)=>({...r,tree:'c'.repeat(40),parents:index?[value.corpus.repositories[0].revisions[index-1].commit]:[],inventory:{sha256:hash('inventory'),entries:1,regularFiles:1,symlinks:0,gitlinks:0}}))}]},manifest={schema:1};
  for(const [name,data]of Object.entries({performanceReceipt:value.receipt,baselineReceipt:value.baseline,qualification:value.qualification,corpus,profiles:{},gitMetadata:{},controller:{},controllerLaunch:{},terminal:{}})){manifest[name]=path.join(root,name+'.json');await writeFile(manifest[name],JSON.stringify(data));}
  const manifestFile=path.join(root,'manifest.json'),output=path.join(root,'forbidden.json');await writeFile(manifestFile,JSON.stringify(manifest));await assert.rejects(qualifyHistoryPerformanceArtifacts({manifest:manifestFile,output}),error=>error.code==='ERR_ASSERTION'&&/owned/.test(error.message));await assert.rejects(readFile(output),error=>error.code==='ENOENT');
 }finally{await rm(root,{recursive:true,force:true});}
});
