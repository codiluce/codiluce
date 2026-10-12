import assert from 'node:assert/strict';
import test from 'node:test';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {stringify} from 'yaml';
import {HistoryStore} from '../../src/history/store.ts';
import {measureProductionWorker} from '../production-cache-measure.mjs';
import {prepareProductionGit,productionGitEnvironment} from '../production-cache-git.mjs';
import {qualifyHistoryPerformance} from '../production-history-performance-results.mjs';
import {observeHistoryPerformance} from '../observe-production-history-performance.mjs';
import {readRevision} from '../production-history-inputs.mjs';

const execute=promisify(execFile),project=fileURLToPath(new URL('../../',import.meta.url)),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function observations(){
 const commits=['a'.repeat(40),'b'.repeat(40)],corpus={repositories:[{id:'owned',revisions:commits.map(commit=>({commit})),extraRevisions:[]}]},baseline={repositories:[{id:'owned',revisions:commits.map(commit=>({commit,logical:{sha256:hash(commit),bytes:100}}))}]};
 const runs=Array.from({length:3},(_,repetition)=>['baseline','current'].map(label=>({id:'owned',label,repetition,status:'complete',milliseconds:100,treePeakKiB:100,samples:3,processes:3,exitCode:0,signal:null,databaseSha256:'owned-db',columns:{passed:true,databaseSha256:'owned-db'},revisions:commits.map(commit=>({commit,status:'verified',canonical:{sha256:hash(commit),bytes:100},logical:{normalization:[]},volatileFields:['run.id','run.analyzedAt']}))}))).flat();return {runs,corpus,baseline};
}
test('full-history gates keep exactly three raw pairs and unchanged 10% median thresholds',()=>{
 const {runs,corpus,baseline}=observations();for(const row of runs.filter(r=>r.label==='current')){row.milliseconds=110;row.treePeakKiB=110;}runs.find(r=>r.label==='current').milliseconds=10000;const result=qualifyHistoryPerformance(runs,corpus,baseline,3);assert.equal(result.passed,true);assert.equal(result.comparisons[0].timeRatio,1.1);assert.equal(runs.length,6);for(const row of runs.filter(r=>r.label==='current'))row.treePeakKiB=111;assert.equal(qualifyHistoryPerformance(runs,corpus,baseline,3).passed,false);
});
test('full-history gates reject incomplete/duplicate/failed pairs and missing real child RSS',()=>{
 for(const change of [r=>r.pop(),r=>r.push({...r[0]}),r=>r[0].status='failed',r=>r[1]={...r[0]},r=>r[0].label='other',r=>r[0].repetition=5,r=>r[0].milliseconds=Infinity,r=>r[0].samples=0,r=>r[0].treePeakKiB=0,r=>r[0].processes=1,r=>delete r[0].processes,r=>r[0].exitCode=7,r=>r[0].signal='SIGTERM']){const {runs,corpus,baseline}=observations();change(runs);assert.equal(qualifyHistoryPerformance(runs,corpus,baseline,3).passed,false);}
});
test('equal-count substitutions, hidden graph changes and unverified columns cannot qualify',()=>{
 for(const change of [r=>r[0].revisions.pop(),r=>r[0].revisions[1]={...r[0].revisions[0]},r=>r[0].revisions[0].commit='c'.repeat(40),r=>r[0].revisions[0].canonical.sha256=hash('hidden original field'),r=>r[0].revisions[0].canonical.bytes=101,r=>r[0].revisions[0].logical.normalization=['storage'],r=>r[0].revisions[0].volatileFields.push('analyzerVersions'),r=>r[0].columns.passed=false,r=>r[0].columns.databaseSha256='other-db']){const {runs,corpus,baseline}=observations();change(runs);assert.equal(qualifyHistoryPerformance(runs,corpus,baseline,3).passed,false);}
});
test('full-history comparisons require three predetermined pairs rather than a selected subset',()=>{
 const {runs,corpus,baseline}=observations();assert.throws(()=>qualifyHistoryPerformance(runs,corpus,baseline,2));assert.throws(()=>qualifyHistoryPerformance(runs,corpus,baseline,21));assert.equal(qualifyHistoryPerformance(runs,corpus,baseline,4).passed,false);for(const row of runs.filter(r=>r.label==='current'))row.milliseconds=111;assert.equal(qualifyHistoryPerformance(runs,corpus,baseline,3).passed,false);
});

test('actual history measurement uses both native workers, ends before full audits, and preserves hidden-payload failures',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'codiluce-history-performance-'));let passed=false;
 try{
  const source=path.join(root,'source');await mkdir(source);const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'});
  const git=async args=>(await execute('git',['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-C',source,...args],{env})).stdout.trim();await git(['init','--template=']);await git(['config','user.name','Owned history measurement']);await git(['config','user.email','fixture@example.invalid']);await symlink('../never-follow-foreign-target',path.join(source,'literal-link'));const revisions=[];
  for(let index=0;index<4;index++){await writeFile(path.join(source,'original.py'),`# 😀 original ${index}\r\ndef original():\r\n    return ${index}\r\nraise RuntimeError('target must never execute')\r\n`);await git(['add','.']);await git(['commit','-m','original '+index]);revisions.push(await readRevision(source,await git(['rev-parse','HEAD'])));}
  const head=revisions.at(-1).commit,config={repository:{name:'Owned history measurement',id:'owned-history-measurement'},applications:[{name:'owned',path:'.',frameworks:[],ecosystems:['python']}],ignore:['**/.git/**'],maxFileBytes:8388608},corpus={schema:1,repositories:[{id:'owned',repository:'https://github.com/owned/fixture',head,coverageIntent:'Owned actual history measurement boundary',policy:'consecutive-first-parent',revisions,extraRevisions:[]}]},profiles={schema:1,repositories:[{id:'owned',commit:head,config}]},group=await prepareProductionGit({source,tree:source,commit:head,output:path.join(root,'metadata')}),metadata={schema:1,completedAt:new Date().toISOString(),repositories:{owned:group}},files=await Promise.all(['src/history/git.ts','src/history/indexer.ts','src/history/store.ts','src/history/worker.ts'].sort().map(async file=>({file,sha256:hash(await readFile(path.join(project,file)))}))),identity={files,sha256:hash(JSON.stringify(files))};
  for(const [name,value] of Object.entries({corpus,profiles,metadata,identity}))await writeFile(path.join(root,name+'.json'),JSON.stringify(value));
  const baseline=path.join(root,'baseline');await execute(process.execPath,['--experimental-sqlite','--import','tsx','scripts/observe-production-history.mjs','--corpus',path.join(root,'corpus.json'),'--profiles',path.join(root,'profiles.json'),'--engine-identity',path.join(root,'identity.json'),'--git-metadata',path.join(root,'metadata.json'),'--source','owned='+source,'--output',baseline],{cwd:project,maxBuffer:1024*1024});
  const originalDb=path.join(baseline,'owned/state/history.db'),originalSha=hash(await readFile(originalDb)),record=JSON.parse(await readFile(path.join(baseline,'receipt.json'))).repositories[0];
  const run=async(name,changed=false)=>{
   const unit=path.join(root,name),state=path.join(unit,'state'),tree=path.join(unit,'metadata-root'),scratch=path.join(unit,'scratch');for(const dir of [state,tree,scratch])await mkdir(dir,{recursive:true});await writeFile(path.join(state,'config.yml'),stringify(config));const selected=structuredClone(record);if(changed)selected.revisions[0].logical.sha256='0'.repeat(64);const request={engine:project,root:tree,state,scratch,record:selected,baselineDirectory:baseline,result:path.join(unit,'worker-result.json')},file=path.join(unit,'request.json');await writeFile(file,JSON.stringify(request));const args={worker:path.join(project,'scripts/production-history-performance-worker.mjs'),request:file,log:path.join(unit,'worker.log'),cwd:project,env:{...productionGitEnvironment(group,tree),TMPDIR:scratch}};
   if(changed){await assert.rejects(measureProductionWorker(args),error=>error.worker.exitCode===1&&error.worker.ended===true);const result=JSON.parse(await readFile(request.result));assert.equal(result.passed,false);assert.ok((await readFile(path.join(state,'history.db'))).length>0);return;}
   const observed=await measureProductionWorker(args);assert.equal(observed.passed,true);assert.equal(observed.indexed.indexed,4);assert.equal(observed.plan.jobs,2);assert.ok(observed.processes>=3);assert.ok(observed.treePeakKiB>0);assert.ok(observed.milliseconds>0);assert.equal(observed.revisions.length,4);assert.equal(observed.snapshotColumnLedger.tables.snapshots.rows,4);for(const r of observed.revisions){assert.deepEqual(r.logical.normalization,[]);assert.deepEqual(r.volatileFields,['run.id','run.analyzedAt']);}
   const output=path.join(unit,'columns.json');await execute('python3',['scripts/audit-history-performance-columns.py','--result',request.result,'--output',output],{cwd:project});const columns=JSON.parse(await readFile(output));assert.equal(columns.passed,true);assert.equal(Object.keys(columns.database.tables).length,7);assert.equal(columns.measurementResultSha256,hash(await readFile(request.result)));
   const db=new HistoryStore(path.join(state,'history.db'));try{const item=db.db.prepare("SELECT vid,data FROM entity_versions WHERE type='file'").get(),value=JSON.parse(item.data);value.metadata.hidden='lost original field';db.db.prepare('UPDATE entity_versions SET data=? WHERE vid=?').run(JSON.stringify(value),item.vid);db.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();}finally{db.close();}
   const failure=path.join(unit,'changed-columns.json');await assert.rejects(execute('python3',['scripts/audit-history-performance-columns.py','--result',request.result,'--output',failure],{cwd:project}),error=>error.code===1);assert.match(JSON.parse(await readFile(failure)).error,/Complete column ledger differs: entity_versions/);
  };
  await run('measured');await run('failed-full-graph',true);assert.equal(hash(await readFile(originalDb)),originalSha);
  // A correct small owned history, even with a claimed broad flag, cannot
  // become the real production performance gate or start a smaller run.
  const baselineFile=path.join(baseline,'receipt.json'),claimed=path.join(root,'claimed-full-qualification.json');await writeFile(claimed,JSON.stringify({passed:true,completedAt:new Date().toISOString(),full195RevisionEntrypointQualified:true,artifacts:[{file:baselineFile,sha256:hash(await readFile(baselineFile))}]}));await assert.rejects(observeHistoryPerformance({qualification:claimed,baseline:baselineFile,corpus:path.join(root,'corpus.json'),profiles:path.join(root,'profiles.json'),gitMetadata:path.join(root,'metadata.json'),baselineEngine:project,output:path.join(root,'forbidden-smaller-performance')},{owned:source}),error=>error.code==='ERR_ASSERTION'&&/owned/.test(error.message));
  passed=true;
 }finally{if(passed)await rm(root,{recursive:true,force:true});else console.error('Retained history performance conformance fixture:',root);}
});
