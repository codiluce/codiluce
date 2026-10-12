import assert from 'node:assert/strict';
import test from 'node:test';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink,cp,stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {readRevision} from '../production-history-inputs.mjs';
import {prepareProductionGit} from '../production-cache-git.mjs';

const execute=promisify(execFile),project=fileURLToPath(new URL('../../',import.meta.url)),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
test('actual shipped history worker and acknowledgment/store/readback verify two original revisions and real symlinks',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'codiluce-history-observer-'));
 try{
  const source=path.join(root,'source');await mkdir(source);const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'});
  const git=async args=>(await execute('git',['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-C',source,...args],{env})).stdout.trim();await git(['init','--template=']);await git(['config','user.name','Owned history fixture']);await git(['config','user.email','fixture@example.invalid']);
  await writeFile(path.join(source,'Cargo.toml'),'[package]\nname="owned_history"\nversion="0.1.0"\nedition="2021"\n');await mkdir(path.join(source,'src'));await writeFile(path.join(source,'src/main.rs'),'fn original() -> u32 { 1 }\nfn main() { original(); }\n');await symlink('../missing-target',path.join(source,'original-link'));
  await git(['add','.']);await git(['commit','-m','original']);const first=await git(['rev-parse','HEAD']);await writeFile(path.join(source,'src/main.rs'),'fn original() -> u32 { 2 }\nfn main() { original(); }\n');await git(['add','.']);await git(['commit','-m','changed original']);const second=await git(['rev-parse','HEAD']);
  const revisions=[await readRevision(source,first),await readRevision(source,second)],corpus={schema:1,repositories:[{id:'owned-history',repository:'https://github.com/owned/fixture',head:second,coverageIntent:'Owned actual history observer fixture',policy:'consecutive-first-parent',revisions,extraRevisions:[]}]},profile={id:'owned-history',commit:second,config:{repository:{name:'Owned history',id:'owned-history'},applications:[{name:'owned',path:'.',frameworks:[],ecosystems:['rust']}],ignore:['**/.git/**'],maxFileBytes:8388608}},profiles={schema:1,repositories:[profile]};
  const metadata=await prepareProductionGit({source,tree:source,commit:second,output:path.join(root,'isolated-git')});const gitMetadata={schema:1,completedAt:new Date().toISOString(),repositories:{'owned-history':metadata}};
  const files=await Promise.all(['src/history/worker.ts','src/history/git.ts','src/history/indexer.ts','src/history/store.ts'].sort().map(async file=>({file,sha256:sha(await readFile(path.join(project,file)))})));const identity={files,sha256:sha(JSON.stringify(files))};
  for(const [name,value] of Object.entries({corpus,profiles,metadata:gitMetadata,identity}))await writeFile(path.join(root,name+'.json'),JSON.stringify(value));const output=path.join(root,'observation');
  const args=['--experimental-sqlite','--import','tsx','scripts/observe-production-history.mjs','--corpus',path.join(root,'corpus.json'),'--profiles',path.join(root,'profiles.json'),'--engine-identity',path.join(root,'identity.json'),'--git-metadata',path.join(root,'metadata.json'),'--source','owned-history='+source,'--output',output];
  const terminal=await execute(process.execPath,args,{cwd:project,maxBuffer:1024*1024});assert.match(terminal.stdout,/"passed":true/);const receipt=JSON.parse(await readFile(path.join(output,'receipt.json')));assert.equal(receipt.passed,true);const row=receipt.repositories[0];assert.equal(row.status,'verified');assert.equal(row.worker.exitCode,0);assert.equal(row.readOnlyReopenVerified,true);assert.equal(row.storage.snapshots,2);assert.equal(row.revisions.length,2);assert.ok(row.worker.treePeakKiB>0&&row.worker.samples>0);
  for(const revision of row.revisions){assert.equal(revision.status,'verified');assert.equal(revision.original.literalSymlinks,1);assert.deepEqual(revision.readback,revision.logical);assert.ok(revision.graphInputs.hashedOriginalSources>0);assert.ok(revision.parentCumulativeVmHwmKiB>0);}
  assert.notEqual(row.revisions[0].logical.sha256,row.revisions[1].logical.sha256);assert.equal(receipt.fullHistoryRelativePerformanceQualified,false);
  // A deliberately corrupted owned worker result must leave reviewable
  // actual tree/graph evidence before the worker's cleanup can remove it.
  const fakeEngine=path.join(root,'owned-corrupt-engine');await mkdir(fakeEngine);await cp(path.join(project,'src'),path.join(fakeEngine,'src'),{recursive:true});await writeFile(path.join(fakeEngine,'package.json'),'{"type":"module"}');await symlink(path.join(project,'node_modules'),path.join(fakeEngine,'node_modules'), 'dir');
  const stub=`import {analyzeCommit} from ${JSON.stringify(path.join(project,'src/history/indexer.ts'))};
import {TreeMirror} from ${JSON.stringify(path.join(project,'src/history/git.ts'))};
import {rmSync} from 'node:fs';
process.once('message',async job=>{process.once('disconnect',()=>{rmSync(job.directory,{recursive:true,force:true});process.exit(1);});const result=await analyzeCommit(new TreeMirror(job.root,job.directory),job.raw,job.commits[0]);result.graph.entities.find(e=>e.type==='file'&&e.path==='src/main.rs').metadata.contentHash='invented';process.send({type:'result',result});});`;
  await writeFile(path.join(fakeEngine,'src/history/worker.ts'),stub);const fakeFiles=await Promise.all(files.map(async row=>({...row,sha256:sha(await readFile(path.join(fakeEngine,row.file)))})));await writeFile(path.join(root,'fake-identity.json'),JSON.stringify({files:fakeFiles,sha256:sha(JSON.stringify(fakeFiles))}));const failedOutput=path.join(root,'failed-observation');const failedArgs=[...args];failedArgs[failedArgs.indexOf('--engine-identity')+1]=path.join(root,'fake-identity.json');failedArgs[failedArgs.indexOf('--output')+1]=failedOutput;failedArgs.push('--engine',fakeEngine);
  await assert.rejects(execute(process.execPath,failedArgs,{cwd:project,maxBuffer:1024*1024}),error=>error.code===1);const failedReceipt=JSON.parse(await readFile(path.join(failedOutput,'receipt.json'))),failedRow=failedReceipt.repositories[0].revisions[0];assert.equal(failedReceipt.passed,false);assert.equal(failedRow.status,'failed');assert.match(failedRow.error,/source-byte hash differs/);assert.ok((await stat(path.join(failedOutput,failedRow.failedTree,'src/main.rs'))).isFile());assert.ok(failedRow.failedGraph.bytes>0);assert.equal(failedRow.failedGraphError,undefined);
 }finally{await rm(root,{recursive:true});}
});
