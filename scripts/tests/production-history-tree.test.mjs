import assert from 'node:assert/strict';
import test from 'node:test';
import {execFile} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm,symlink,readlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {TreeMirror} from '../../src/history/git.ts';
import {readRevision} from '../production-history-inputs.mjs';
import {inspectProductionHistoryTree,verifyHistoryGraphInputs} from '../production-history-tree.mjs';

const execute=promisify(execFile);
test('production incremental mirrors verify original regular, literal-link and gitlink inputs without following aliases',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'codiluce-original-history-'));
 try{
  const source=path.join(root,'owned-source'),directory=path.join(root,'actual-mirror');await mkdir(source);
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'});
  const git=async args=>(await execute('git',['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-C',source,...args],{env})).stdout.trim();
  await git(['init','--template=']);await git(['config','user.name','Owned fixture']);await git(['config','user.email','fixture@example.invalid']);
  await writeFile(path.join(source,'original.txt'),'original 😀 bytes\r\n');await symlink('../absent-foreign-target',path.join(source,'original-link'));await git(['add','.']);await git(['commit','-m','original']);const first=await git(['rev-parse','HEAD']);
  await git(['update-index','--add','--cacheinfo','160000,'+first+',unhydrated']);await writeFile(path.join(source,'original.txt'),'second original\n');await git(['add','original.txt']);await git(['commit','-m','with gitlink']);const second=await git(['rev-parse','HEAD']);
  const mirror=new TreeMirror(source,directory);
  for(const commit of [first,second,first]){
   await mirror.checkout(commit);const revision=await readRevision(source,commit),result=await inspectProductionHistoryTree({source,directory,revision});assert.equal(result.allOriginalBytesVerified,true);assert.equal(result.literalSymlinks,1);assert.equal(result.symlinkTargetsFollowed,false);assert.equal(result.unhydratedGitlinks,commit===second?1:0);assert.equal(await readlink(path.join(directory,'original-link')),'../absent-foreign-target');
   const entry=result.entries.find(row=>row.path==='original.txt'),graph={run:{commitSha:commit},entities:[{type:'file',path:entry.path,metadata:{bytes:entry.bytes,contentHash:entry.sha256}}]};assert.equal(verifyHistoryGraphInputs(graph,result).hashedOriginalSources,1);graph.entities[0].metadata.contentHash='invented';assert.throws(()=>verifyHistoryGraphInputs(graph,result),/hash differs/);
  }
  const revision=await readRevision(source,first);await writeFile(path.join(directory,'original.txt'),'mutated');await assert.rejects(inspectProductionHistoryTree({source,directory,revision}),/bytes differ/);
  await rm(path.join(directory,'original.txt'));await symlink('../absent-foreign-target',path.join(directory,'original.txt'));await assert.rejects(inspectProductionHistoryTree({source,directory,revision}),/replaced by an alias/);
 }finally{await rm(root,{recursive:true});}
});
test('actual mirror verification refuses missing inventories, unexpected files and input-budget failures',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'codiluce-original-history-negative-'));
 try{
  const source=path.join(root,'source'),directory=path.join(root,'mirror');await mkdir(source);
  const git=async args=>(await execute('git',['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-C',source,...args])).stdout.trim();
  await git(['init','--template=']);await git(['config','user.name','Owned fixture']);await git(['config','user.email','fixture@example.invalid']);await writeFile(path.join(source,'source.txt'),'original');await git(['add','.']);await git(['commit','-m','original']);const commit=await git(['rev-parse','HEAD']),revision=await readRevision(source,commit),mirror=new TreeMirror(source,directory);await mirror.checkout(commit);
  await assert.rejects(inspectProductionHistoryTree({source,directory,revision,maxBlobBytes:1}));await assert.rejects(inspectProductionHistoryTree({source,directory,revision:{...revision,inventory:{...revision.inventory,sha256:'0'.repeat(64)}}}));
  await writeFile(path.join(directory,'unexpected.txt'),'invented');await assert.rejects(inspectProductionHistoryTree({source,directory,revision}),/Unexpected/);await rm(path.join(directory,'unexpected.txt'));await rm(path.join(directory,'source.txt'));await assert.rejects(inspectProductionHistoryTree({source,directory,revision}),/missing/);
 }finally{await rm(root,{recursive:true});}
});
