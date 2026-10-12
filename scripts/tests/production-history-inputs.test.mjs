import assert from 'node:assert/strict';
import test from 'node:test';
import {execFile} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {inspectHistoryInput,readGit,readRevision,renderInputReceipt,validateCorpus,verifyHistoryInputs} from '../production-history-inputs.mjs';

const execute=promisify(execFile);
async function fixture(t){
  const directory=await mkdtemp(path.join(tmpdir(),'codiluce-history-input-test-')),root=path.join(directory,'source');
  t.after(()=>rm(directory,{recursive:true,force:true}));await mkdir(root);
  const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_'))),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_AUTHOR_NAME:'Owned fixture',GIT_AUTHOR_EMAIL:'fixture@example.test',GIT_COMMITTER_NAME:'Owned fixture',GIT_COMMITTER_EMAIL:'fixture@example.test'};
  const git=async(...parameters)=>(await execute('git',['-c',`core.hooksPath=${path.join(directory,'disabled-hooks')}`,'-c','core.fsmonitor=false','-c','commit.gpgsign=false','-C',root,...parameters],{env,encoding:'utf8'})).stdout.trim();
  await git('init','-q','-b','main');const revisions=[];
  for(let index=0;index<3;index++){
    await writeFile(path.join(root,'original.py'),`def original():\n    return ${index}\n`);
    await git('add','original.py');await git('commit','-q','-m',`Owned revision ${index}`);
    revisions.push(await readRevision(root,await git('rev-parse','HEAD')));
  }
  const repository={id:'owned',repository:'https://github.com/example/owned',head:revisions.at(-1).commit,coverageIntent:'Owned fixture only',policy:'consecutive-first-parent',revisions,extraRevisions:[]};
  return {directory,root,git,repository,corpus:{schema:1,repositories:[repository]}};
}

test('pinned complete parent/tree/inventory metadata verifies without changing the target',async t=>{
  const input=await fixture(t),before=await input.git('status','--porcelain');
  const result=await inspectHistoryInput(input.root,input.repository);
  assert.equal(result.status,'verified');assert.equal(result.revisions,3);assert.equal(result.workingTreeUsed,false);assert.equal(result.blobBytesVerified,false);
  assert.equal(await input.git('status','--porcelain'),before);
  const original=input.repository.revisions[0];
  assert.deepEqual({...original.inventory,sha256:undefined},{sha256:undefined,entries:1,regularFiles:1,symlinks:0,gitlinks:0});
  assert.equal(original.tree,await input.git('rev-parse',`${original.commit}^{tree}`));
  assert.equal(original.inventory.sha256,createHash('sha256').update(await input.git('ls-tree','-r','-z','--full-tree',original.commit)).digest('hex'));
});

test('working-tree edits, untracked inputs and a different checked-out head cannot replace pinned Git inputs',async t=>{
  const input=await fixture(t);
  await writeFile(path.join(input.root,'original.py'),'This is unrelated working-tree content');
  await writeFile(path.join(input.root,'untracked.py'),'raise RuntimeError("never execute")');
  await input.git('add','original.py');await input.git('commit','-q','-m','Outside the pinned chain');
  const result=await inspectHistoryInput(input.root,input.repository);
  assert.equal(result.status,'verified');assert.notEqual(result.checkedOutHead,result.pinnedHead);
  assert.equal(await readFile(path.join(input.root,'untracked.py'),'utf8'),'raise RuntimeError("never execute")');
});

test('replacement Git objects cannot rewrite original input identities',async t=>{
  const input=await fixture(t),old=input.repository.revisions[0].commit,newer=input.repository.head;
  await input.git('replace',old,newer);
  assert.notEqual(await input.git('show','-s','--format=%T',old),input.repository.revisions[0].tree);
  assert.deepEqual(await readRevision(input.root,old),input.repository.revisions[0]);
  assert.equal((await inspectHistoryInput(input.root,input.repository)).status,'verified');
});

test('altered tree inventories, missing objects and incomplete first-parent chains cannot verify',async t=>{
  const input=await fixture(t),altered=structuredClone(input.repository);
  altered.revisions[0].inventory.sha256='0'.repeat(64);
  await assert.rejects(inspectHistoryInput(input.root,altered),/inventory differs/);
  await assert.rejects(readRevision(input.root,'0'.repeat(40)));
  await assert.rejects(inspectHistoryInput(input.root,{...input.repository,revisions:input.repository.revisions.slice(0,2)}),/chain differs/);
});

test('corpus validation rejects duplicate identities, gaps, wrong heads and incomplete pins',async t=>{
  const {corpus}=await fixture(t);validateCorpus(corpus);
  const invalid=mutate=>{const copy=structuredClone(corpus);mutate(copy);assert.throws(()=>validateCorpus(copy));};
  invalid(copy=>copy.repositories.push(copy.repositories[0]));
  invalid(copy=>copy.repositories[0].revisions[1].parents=[]);
  invalid(copy=>copy.repositories[0].head=copy.repositories[0].revisions[0].commit);
  invalid(copy=>copy.repositories[0].revisions[0].tree='abbreviated');
  invalid(copy=>copy.repositories[0].revisions[0].inventory.entries++);
  invalid(copy=>copy.repositories[0].extraRevisions=[{...copy.repositories[0].revisions[0],reason:'Duplicate'}]);
});

test('extra original refactor revisions must have matching metadata and be reachable from the pinned head',async t=>{
  const input=await fixture(t),selection={...input.repository,revisions:input.repository.revisions.slice(1),extraRevisions:[{...input.repository.revisions[0],reason:'Original refactor baseline'}]};
  assert.equal((await inspectHistoryInput(input.root,selection)).extraRevisions,1);
  await input.git('checkout','-q','--orphan','unrelated');await input.git('commit','-q','--allow-empty','-m','Unrelated original');
  selection.extraRevisions=[{...await readRevision(input.root,await input.git('rev-parse','HEAD')),reason:'Not reachable'}];
  await assert.rejects(inspectHistoryInput(input.root,selection));
});

test('fresh receipts retain all independent failures and cannot claim production analysis',async t=>{
  const input=await fixture(t),missing={...input.repository,id:'missing'},corpus={schema:1,repositories:[missing,input.repository]},output=path.join(input.directory,'evidence');
  const receipt=await verifyHistoryInputs({corpus,sources:{owned:input.root},output});
  assert.equal(receipt.inputsVerified,false);assert.equal(receipt.analysisQualified,false);
  assert.deepEqual(receipt.repositories.map(({status})=>status),['failed','verified']);assert.match(receipt.repositories[0].error,/Missing --source/);
  assert.deepEqual(JSON.parse(await readFile(path.join(output,'receipt.json'),'utf8')),receipt);
  assert.deepEqual(JSON.parse(await readFile(path.join(output,'corpus.json'),'utf8')),corpus);
  assert.equal(receipt.verifierUnchanged,true);assert.equal(receipt.verifierBefore.length,2);
  assert.match(await readFile(path.join(output,'index.html'),'utf8'),/INPUT VERIFICATION FAILED/);
  await assert.rejects(verifyHistoryInputs({corpus,sources:{owned:input.root},output}),{code:'EEXIST'});
  await assert.rejects(verifyHistoryInputs({corpus,sources:{unknown:input.root},output:path.join(input.directory,'unknown')}),/Unknown source/);
});

test('input evidence stays outside target repositories, including through output symlinks',async t=>{
  const input=await fixture(t);
  await assert.rejects(verifyHistoryInputs({corpus:input.corpus,sources:{owned:input.root},output:path.join(input.root,'evidence')}),/outside every target/);
  const link=path.join(input.directory,'alias');await symlink(input.root,link,process.platform==='win32'?'junction':'dir');
  await assert.rejects(verifyHistoryInputs({corpus:input.corpus,sources:{owned:input.root},output:path.join(link,'evidence')}),/outside every target/);
  assert.equal(await input.git('status','--porcelain'),'');
});

test('an unavailable supplied root retains its failure and does not stop independent input verification',async t=>{
  const input=await fixture(t),missing={...input.repository,id:'unavailable'},corpus={schema:1,repositories:[missing,input.repository]};
  const receipt=await verifyHistoryInputs({corpus,sources:{unavailable:path.join(input.directory,'absent'),owned:input.root},output:path.join(input.directory,'independent-evidence')});
  assert.equal(receipt.inputsVerified,false);assert.deepEqual(receipt.repositories.map(({status})=>status),['failed','verified']);assert.match(receipt.repositories[0].error,/ENOENT/);
});

test('HTML escapes input failures and shows verification separately from qualification',()=>{
  const receipt={repositories:[{id:'<owned>',status:'failed',error:'<script>alert("never")</script>'}],inputsVerified:false,analysisQualified:false,completedAt:'now'};
  const html=renderInputReceipt(receipt);assert.ok(!html.includes('<script>'));assert.match(html,/&lt;owned&gt;/);assert.match(html,/Production analysis and performance are pending/);
});
