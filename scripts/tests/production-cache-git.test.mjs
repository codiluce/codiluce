import assert from 'node:assert/strict';
import test from 'node:test';
import {execFile} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,rm,stat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {promisify} from 'node:util';
import {prepareProductionGit,productionGitEnvironment} from '../production-cache-git.mjs';

const execute=promisify(execFile);
test('isolated Git metrics preserve exact shallow boundaries and ignore target config/hooks',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'codiluce-owned-shallow-'));
 try{
  const source=path.join(root,'source'),tree=path.join(root,'originals'),output=path.join(root,'isolated');await mkdir(source);await mkdir(tree);
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'});
  const git=async args=>(await execute('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','commit.gpgsign=false','-C',source,...args],{env})).stdout;
  await git(['init','--template=']);await git(['config','user.name','Owned fixture']);await git(['config','user.email','fixture@example.invalid']);
  for(const text of ['first\n','second\n']){await writeFile(path.join(source,'original.txt'),text);await git(['add','original.txt']);await git(['commit','-m',text.trim()]);}
  const commit=(await git(['rev-parse','HEAD'])).trim();await writeFile(path.join(tree,'original.txt'),'second\n');const shallow=commit+'\n';await writeFile(path.join(source,'.git/shallow'),shallow);
  const marker=path.join(root,'target-hook-ran'),hook=path.join(root,'target-monitor');await writeFile(hook,'#!/bin/sh\ntouch '+marker+'\n',{mode:0o755});await git(['config','core.fsmonitor',hook]);await git(['config','core.hooksPath',root]);
  const metadata=await prepareProductionGit({source,tree,commit,output});assert.equal(metadata.logPreflight.commits,1);assert.equal(metadata.shallow.boundaries,1);assert.equal(await readFile(path.join(output,'shallow'),'utf8'),shallow);assert.equal(metadata.status,'');assert.ok(metadata.files.some(row=>row.file==='shallow'));assert.equal((await readFile(path.join(output,'config'),'utf8')).includes(hook),false);
  const isolatedEnv=productionGitEnvironment(metadata,tree),log=(await execute('git',['log','--format=%H','HEAD'],{cwd:tree,env:isolatedEnv})).stdout.trim().split('\n');assert.deepEqual(log,[commit]);await assert.rejects(stat(marker),{code:'ENOENT'});
  await assert.rejects(prepareProductionGit({source,tree,commit,output}),{code:'EEXIST'});
 }finally{await rm(root,{recursive:true});}
});
test('malformed original shallow boundaries fail before they can supply timed metrics',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'codiluce-owned-shallow-invalid-'));
 try{
  const source=path.join(root,'source'),tree=path.join(root,'originals');await mkdir(source);await mkdir(tree);
  await execute('git',['-c','core.hooksPath=/dev/null','init','--template=',source]);await writeFile(path.join(source,'.git/shallow'),'../invented\n');
  await assert.rejects(prepareProductionGit({source,tree,commit:'a'.repeat(40),output:path.join(root,'isolated')}),/Invalid original shallow/);
 }finally{await rm(root,{recursive:true});}
});
