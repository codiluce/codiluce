import assert from 'node:assert/strict';
import test from 'node:test';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,rm,symlink,writeFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {readRevision} from '../production-history-inputs.mjs';
import {DEFAULT_BLOB_LIMITS,materializedPathReason,materializeProductionRevision,renderBlobReceipt} from '../production-history-blobs.mjs';

const execute=promisify(execFile),sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t,files={'original.py':Buffer.from('def original():\n    return "é"\n'),'bytes.bin':Buffer.from([0,255,13,10,128])}){
  const directory=await mkdtemp(path.join(tmpdir(),'codiluce-history-blob-test-')),root=path.join(directory,'source');
  t.after(()=>rm(directory,{recursive:true,force:true}));await mkdir(root);
  const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_'))),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_AUTHOR_NAME:'Owned fixture',GIT_AUTHOR_EMAIL:'fixture@example.test',GIT_COMMITTER_NAME:'Owned fixture',GIT_COMMITTER_EMAIL:'fixture@example.test'};
  const git=async(...parameters)=>(await execute('git',['-c',`core.hooksPath=${path.join(directory,'disabled-hooks')}`,'-c','core.fsmonitor=false','-c','commit.gpgsign=false','-C',root,...parameters],{env,encoding:'utf8'})).stdout.trim();
  await git('init','-q','-b','main');
  for(const [file,bytes]of Object.entries(files)){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),bytes);}
  await git('add','.');await git('commit','-q','-m','Owned original');
  const revision=await readRevision(root,await git('rev-parse','HEAD'));
  return {directory,root,git,revision,files,output:path.join(directory,'observation')};
}

test('every original binary/Unicode byte has independent blob and materialized SHA-256 proof',async t=>{
  const input=await fixture(t),before=await input.git('status','--porcelain');
  const receipt=await materializeProductionRevision({...input,source:input.root});
  assert.equal(receipt.status,'materialized');assert.equal(receipt.materializationCompleted,true);assert.equal(receipt.allRegularFilesMaterialized,true);assert.equal(receipt.originalBlobBytesComplete,true);assert.equal(receipt.analysisQualified,false);assert.equal(receipt.verifierUnchanged,true);
  for(const entry of receipt.entries){const expected=input.files[entry.path];assert.equal(entry.sha256,sha256(expected));assert.equal(entry.writtenSha256,sha256(expected));assert.deepEqual(await readFile(path.join(input.output,'tree',entry.path)),expected);assert.equal(entry.object,createHash('sha1').update(`blob ${expected.length}\0`).update(expected).digest('hex'));}
  assert.equal(await input.git('status','--porcelain'),before);assert.deepEqual(JSON.parse(await readFile(path.join(input.output,'receipt.json'),'utf8')),receipt);
});

test('dirty working trees, different HEAD and replacement objects cannot substitute original bytes',async t=>{
  const input=await fixture(t);await writeFile(path.join(input.root,'original.py'),'unrelated later bytes');await input.git('add','.');await input.git('commit','-q','-m','Later original');
  const newer=await input.git('rev-parse','HEAD');await input.git('replace',input.revision.commit,newer);
  const record=await materializeProductionRevision({...input,source:input.root});assert.equal(record.status,'materialized');assert.deepEqual(await readFile(path.join(input.output,'tree','original.py')),input.files['original.py']);assert.equal(await readFile(path.join(input.root,'original.py'),'utf8'),'unrelated later bytes');
});

test('executable modes preserve original bytes as non-executable source files',async t=>{
  const input=await fixture(t,{'do-not-run.sh':Buffer.from('exit 97\n')});await input.git('update-index','--chmod=+x','do-not-run.sh');await input.git('commit','-q','-m','Executable original');input.revision=await readRevision(input.root,await input.git('rev-parse','HEAD'));
  const record=await materializeProductionRevision({...input,source:input.root});assert.equal(record.entries[0].mode,'100755');assert.equal(record.entries[0].status,'materialized');
  if(process.platform!=='win32')assert.equal((await stat(path.join(input.output,'tree','do-not-run.sh'))).mode&0o111,0);
});

test('symlinks and gitlinks are inventoried without following or hydrating them',async t=>{
  const input=await fixture(t,{'outside-link':Buffer.from('../../outside-secret')});await input.git('update-index','--cacheinfo',`120000,${await input.git('rev-parse','HEAD:outside-link')},outside-link`);await input.git('update-index','--add','--cacheinfo',`160000,${input.revision.commit},submodule`);await input.git('commit','-q','-m','Special modes');input.revision=await readRevision(input.root,await input.git('rev-parse','HEAD'));
  const record=await materializeProductionRevision({...input,source:input.root});assert.equal(record.status,'materialized-with-skips');assert.deepEqual(record.entries.map(entry=>entry.reason),['symlink-not-followed','gitlink-not-hydrated']);assert.equal(record.entries[0].blobIdentityVerified,true);assert.equal(record.entries[0].sha256,sha256(Buffer.from('../../outside-secret')));assert.equal(record.originalBlobBytesComplete,true);await assert.rejects(readFile(path.join(input.output,'tree','outside-link')),/ENOENT/);
});

test('LFS pointers are byte-verified and explicitly skipped without invoking filters',async t=>{
  const input=await fixture(t,{'pointer.dat':Buffer.from('version https://git-lfs.github.com/spec/v1\r\noid sha256:'+'a'.repeat(64)+'\r\nsize 99999999\r\n')});
  await input.git('config','filter.lfs.smudge','target-runtime-must-never-run');await input.git('config','core.fsmonitor','target-runtime-must-never-run');
  const record=await materializeProductionRevision({...input,source:input.root});assert.equal(record.status,'materialized-with-skips');assert.equal(record.entries[0].reason,'lfs-pointer-not-hydrated');assert.equal(record.entries[0].sha256,sha256(input.files['pointer.dat']));assert.equal(record.allRegularFilesMaterialized,false);assert.equal(record.originalBlobBytesComplete,true);
});

test('blob and cumulative byte limits retain every skipped original and healthy small files',async t=>{
  const input=await fixture(t,{'a-large.txt':Buffer.alloc(25,65),'b-small.txt':Buffer.from('1234'),'c-small.txt':Buffer.from('5678'),'d-empty.txt':Buffer.alloc(0)});
  const record=await materializeProductionRevision({...input,source:input.root,limits:{maxBlobBytes:10,maxTotalBytes:6}});
  assert.equal(record.materializationCompleted,true);assert.equal(record.originalBlobBytesComplete,false);assert.equal(record.allRegularFilesMaterialized,false);assert.equal(record.admittedBytes,4);assert.deepEqual(record.entries.map(entry=>[entry.status,entry.reason]),[['skipped','maxBlobBytes'],['materialized',undefined],['skipped','maxTotalBytes'],['materialized',undefined]]);assert.deepEqual(record.counts,{materialized:2,skipped:2,failed:0});
});

test('invalid pinned inventories and entry limits produce completed failure receipts',async t=>{
  const input=await fixture(t),changed=structuredClone(input.revision);changed.inventory.sha256='0'.repeat(64);
  const record=await materializeProductionRevision({...input,source:input.root,revision:changed});assert.equal(record.status,'failed');assert.equal(record.materializationCompleted,false);assert.match(record.error,/metadata differs/);assert.ok(record.completedAt);assert.equal(JSON.parse(await readFile(path.join(input.output,'receipt.json'),'utf8')).status,'failed');
  const limited=await materializeProductionRevision({...input,source:input.root,output:input.output+'-limited',limits:{maxEntries:1}});assert.equal(limited.status,'failed');assert.match(limited.error,/maxEntries/);
});

test('fresh output refuses target roots and symlink aliases, including other protected repositories',async t=>{
  const input=await fixture(t);await assert.rejects(materializeProductionRevision({...input,source:input.root,output:path.join(input.root,'nested','result')}),/outside/);
  const alias=path.join(input.directory,'alias');await symlink(input.root,alias,process.platform==='win32'?'junction':'dir');await assert.rejects(materializeProductionRevision({...input,source:input.root,output:path.join(alias,'result')}),/outside/);
  const other=path.join(input.directory,'other');await mkdir(other);await assert.rejects(materializeProductionRevision({...input,source:input.root,output:path.join(other,'result'),protectedRoots:[other]}),/outside/);
  await materializeProductionRevision({...input,source:input.root});await assert.rejects(materializeProductionRevision({...input,source:input.root}),/EEXIST/);
});

test('path traversal, reserved names, alias collisions and nonportable names cannot be silently renamed',async t=>{
  for(const candidate of ['../escape','/absolute','a/../b','.git/config','a\\b','C:drive','CON.txt','nul','trailing.','space ','a//b'])assert.equal(materializedPathReason(candidate),'unsafe-or-nonportable-path',candidate);
  assert.equal(materializedPathReason('docs/ñ-and-\uFEFF.txt'),undefined);
  if(process.platform==='win32')return;
  const input=await fixture(t,{'Folder/a.txt':Buffer.from('one'),'folder/b.txt':Buffer.from('two'),'literal`$(target)`file.txt':Buffer.from('literal original'),'safe.txt':Buffer.from('healthy')});
  const record=await materializeProductionRevision({...input,source:input.root});assert.equal(record.entries.filter(entry=>entry.reason==='portable-path-alias-collision').length,2);assert.deepEqual(await readFile(path.join(input.output,'tree','literal`$(target)`file.txt')),input.files['literal`$(target)`file.txt']);assert.equal(record.entries.find(entry=>entry.path==='safe.txt').status,'materialized');
});

test('CLI accepts only complete reviewed pins and receipt HTML escapes original metadata',async t=>{
  const input=await fixture(t);const corpus={schema:1,repositories:[{id:'owned',repository:'https://github.com/example/owned',head:input.revision.commit,coverageIntent:'Owned originals',policy:'consecutive-first-parent',revisions:[],extraRevisions:[]}]};
  await writeFile(path.join(input.root,'second.txt'),'next');await input.git('add','.');await input.git('commit','-q','-m','Second original');const second=await readRevision(input.root,await input.git('rev-parse','HEAD'));corpus.repositories[0].head=second.commit;corpus.repositories[0].revisions=[input.revision,second];const file=path.join(input.directory,'corpus.json');await writeFile(file,JSON.stringify(corpus));
  const params=['scripts/materialize-production-history.mjs','--corpus',file,'--repository','owned','--commit',input.revision.commit,'--source',input.root,'--output',input.output];
  const result=await execute(process.execPath,params,{cwd:path.resolve('.')});assert.equal(JSON.parse(result.stdout).status,'materialized');
  params[params.indexOf('--commit')+1]=input.revision.commit.slice(0,7);params[params.indexOf('--output')+1]=input.output+'-invalid';await assert.rejects(execute(process.execPath,params),/complete reviewed corpus pin/);
  const html=renderBlobReceipt({status:'failed',completedAt:'now',commit:'<script>bad</script>',entries:[{path:'</pre><script>bad</script>'}],analysisQualified:false});assert.ok(!html.includes('<script>'));assert.match(html,/&lt;script&gt;/);assert.match(html,/accuracy, history parity and performance remain pending/);assert.equal(DEFAULT_BLOB_LIMITS.maxBlobBytes,8*1024*1024);
});

test('missing original blob objects retain a failure receipt and cannot qualify materialization',async t=>{
  const input=await fixture(t),object=await input.git('rev-parse','HEAD:original.py');
  await rm(path.join(input.root,'.git','objects',object.slice(0,2),object.slice(2)));
  const receipt=await materializeProductionRevision({...input,source:input.root});assert.equal(receipt.status,'failed');assert.equal(receipt.materializationCompleted,false);assert.equal(receipt.originalBlobBytesComplete,false);assert.match(receipt.error,new RegExp(object));assert.equal(receipt.analysisQualified,false);
});

test('BOM path bytes remain original and unrepresentable UTF-8 paths remain explicit skips',async t=>{
  if(process.platform==='win32')return;
  const input=await fixture(t,{'\uFEFForiginal.txt':Buffer.from('BOM filename')});
  await writeFile(Buffer.concat([Buffer.from(input.root+'/'),Buffer.from([0xff])]),Buffer.from('non-UTF8 name'));
  await input.git('add','.');await input.git('commit','-q','-m','Original path bytes');input.revision=await readRevision(input.root,await input.git('rev-parse','HEAD'));
  const receipt=await materializeProductionRevision({...input,source:input.root});assert.deepEqual(await readFile(path.join(input.output,'tree','\uFEFForiginal.txt')),Buffer.from('BOM filename'));assert.ok(receipt.entries.some(entry=>entry.pathBytesHex==='ff'&&entry.reason==='non-utf8-path'&&entry.status==='skipped'));assert.equal(receipt.allRegularFilesMaterialized,false);assert.equal(receipt.originalBlobBytesComplete,false);
});
