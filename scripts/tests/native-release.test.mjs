import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {afterEach,test} from 'node:test';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {parse as parseYaml} from 'yaml';
import {npmCliPath,qualify,renderReceipt,runLoggedCommand,sourceIdentity} from '../native-release-runner.mjs';

const roots=[],execute=promisify(execFile);
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function directory(){const root=await mkdtemp(path.join(tmpdir(),'codiluce-release-runner-'));roots.push(root);return root;}
const identity=async()=>({revision:'owned-test-revision',sourceDigest:'owned-test-source',dirty:false});
const command=(name,code)=>({name,executable:process.execPath,parameters:['-e',code]});

test('native command evidence waits for complete stdout/stderr and distinguishes nonzero and spawn failures',async()=>{
  const root=await directory(),log=path.join(root,'passed.log');
  const passed=await runLoggedCommand(process.execPath,['-e','process.stdout.write("out");process.stderr.write("err");'],{root,log});
  const bytes=await readFile(log);assert.equal(passed.status,'passed');assert.equal(passed.exitCode,0);assert.equal(passed.signal,null);assert.equal(passed.logBytes,bytes.length);assert.equal(passed.logSha256,createHash('sha256').update(bytes).digest('hex'));assert.match(bytes.toString(),/out/);assert.match(bytes.toString(),/err/);
  const failed=await runLoggedCommand(process.execPath,['-e','process.stderr.write("original failure");process.exitCode=7;'],{root,log:path.join(root,'failed.log')});assert.equal(failed.status,'failed');assert.equal(failed.exitCode,7);
  const missing=await runLoggedCommand(path.join(root,'missing-executable'),[],{root,log:path.join(root,'missing.log')});assert.equal(missing.status,'failed');assert.match(missing.error,/ENOENT/);
});

test('qualification preserves a failed check and still completes independent checks',async()=>{
  const root=await directory(),output=path.join(root,'report');
  const result=await qualify({root,output,identity,commands:[command('first','process.exitCode=3'),command('second','process.stdout.write("complete")')]});
  assert.equal(result.qualified,false);assert.equal(result.sourceUnchanged,true);assert.deepEqual(result.checks.map(check=>check.status),['failed','passed']);assert.ok(result.completedAt);
  assert.deepEqual(JSON.parse(await readFile(path.join(output,'receipt.json'),'utf8')),result);assert.match(await readFile(path.join(output,'index.html'),'utf8'),/NOT QUALIFIED/);
  await assert.rejects(qualify({root,output,identity,commands:[]}),/EEXIST/,'Existing observations must never be replaced');
});

test('failed dependency installation records skips without dropping unrelated evidence',async()=>{
  const root=await directory(),output=path.join(root,'report');
  const result=await qualify({root,output,identity,commands:[{...command('dependencies','process.exitCode=1'),install:true},{...command('dependent','throw Error("must not run")'),requiresInstall:true},command('independent','process.stdout.write("retained")')]});
  assert.equal(result.qualified,false);assert.deepEqual(result.checks.map(check=>check.status),['failed','skipped','passed']);assert.equal(result.checks[1].reason,'Dependency installation failed');
});

test('changed, dirty and unavailable source identity cannot qualify zero-exit commands',async()=>{
  const root=await directory();
  for(const reason of ['changed','dirty','unavailable']){
    let count=0;const observed=async()=>{count++;if(reason==='unavailable'&&count===2)throw Error('identity unavailable');return {revision:'owned',sourceDigest:reason==='changed'&&count===2?'changed':'original',dirty:reason==='dirty'};};
    const result=await qualify({root,output:path.join(root,reason),identity:observed,commands:[command('valid','')]});
    assert.equal(result.checks[0].status,'passed');assert.equal(result.qualified,false);assert.ok(result.completedAt);if(reason==='unavailable')assert.match(result.error,/identity unavailable/);
  }
});

test('a clean unchanged native run qualifies only after every required check finishes',async()=>{
  const root=await directory(),result=await qualify({root,output:path.join(root,'report'),identity,commands:[command('valid','')]});
  assert.equal(result.qualified,true);assert.ok(result.completedAt);assert.equal(result.sourceUnchanged,true);
  const pending={host:{platform:'<script>',architecture:'x',osType:'OS',osRelease:'1',node:'test'},checks:[{name:'pending',status:'running'}],qualified:false};
  const html=renderReceipt(pending);assert.match(html,/INCOMPLETE/);assert.ok(!html.includes('<script>'));assert.match(html,/&lt;script&gt;/);
});

test('npm lookup supports the standard Windows sibling and Unix global install layouts',async()=>{
  const root=await directory(),node=path.join(root,'bin','node'),unix=path.join(root,'lib/node_modules/npm/bin/npm-cli.js'),windows=path.join(root,'bin/node_modules/npm/bin/npm-cli.js');
  await mkdir(path.dirname(unix),{recursive:true});await writeFile(unix,'owned placeholder');assert.equal(await npmCliPath(node,{}),unix);
  await mkdir(path.dirname(windows),{recursive:true});await writeFile(windows,'owned placeholder');assert.equal(await npmCliPath(node,{}),windows);
  assert.equal(await npmCliPath(node,{npm_execpath:unix}),unix);await assert.rejects(npmCliPath(path.join(root,'isolated','bin','node'),{}),/Cannot locate/);
});

test('source identity records exact tracked bytes and revision without running repository hooks',async()=>{
  const root=await directory(),git=async parameters=>execute('git',['-c',`core.hooksPath=${path.join(root,'disabled-hooks')}`,'-c','core.fsmonitor=false','-c','commit.gpgsign=false',...parameters],{cwd:root});
  await git(['init','--quiet']);await git(['config','user.email','fixture@example.test']);await git(['config','user.name','Owned fixture']);await writeFile(path.join(root,'source.txt'),'original');await git(['add','source.txt']);await git(['commit','--quiet','-m','owned fixture']);
  const first=await sourceIdentity(root);assert.equal(first.trackedFiles,1);assert.equal(first.dirty,false);assert.match(first.revision,/^[a-f0-9]{40}$/);assert.match(first.sourceDigest,/^[a-f0-9]{64}$/);
  await writeFile(path.join(root,'source.txt'),'changed');const second=await sourceIdentity(root);assert.equal(second.revision,first.revision);assert.equal(second.dirty,true);assert.notEqual(second.sourceDigest,first.sourceDigest);
});

test('the production plan includes the complete native release gates without running them',async()=>{
  const project=fileURLToPath(new URL('../../',import.meta.url)),output=path.join(await directory(),'uncreated-report');
  const {stdout}=await execute(process.execPath,['scripts/qualify-native-release.mjs','--install','--plan','--output',output],{cwd:project});
  const plan=JSON.parse(stdout);assert.deepEqual(plan.commands.map(item=>item.name),['dependencies','tests','typecheck','capability-docs','installed-package']);
  assert.ok(plan.commands[0].parameters.includes('--ignore-scripts'));assert.ok(plan.commands[1].parameters.includes('tests/mixed-release.test.ts'));assert.ok(plan.commands[1].parameters.includes('tests/indexed-sources.test.ts'));assert.ok(plan.commands[1].parameters.includes('web/tests/request-flows.test.ts'));assert.ok(plan.commands[1].parameters.includes('scripts/tests/native-release.test.mjs'));
  await assert.rejects(readFile(path.join(output,'receipt.json')),/ENOENT/,'Planning must not execute checks or publish a receipt');
  const workflow=parseYaml(await readFile(path.join(project,'.github/workflows/native-compatibility.yml'),'utf8')),matrix=workflow.jobs.qualify.strategy.matrix;
  assert.deepEqual(new Set(matrix.os),new Set(['ubuntu-latest','windows-latest','macos-latest']));assert.ok(matrix.node.includes(plan.minimum.slice(2)));assert.equal(workflow.jobs.qualify.strategy['fail-fast'],false);
  const artifact=workflow.jobs.qualify.steps.find(step=>step.uses?.startsWith('actions/upload-artifact@'));assert.equal(artifact.if,'always()');assert.equal(artifact.with['if-no-files-found'],'error');
  for(const step of workflow.jobs.qualify.steps.filter(step=>step.uses))assert.match(step.uses,/@[a-f0-9]{40}$/,'CI action versions must be immutable');
});
