import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readlink,rm,symlink,unlink,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {performanceEntrypointArtifact,performanceRuntimeSelection,verifyPerformanceRuntimeFiles} from '../production-history-performance-runtime.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const roles=['history/indexer','history/worker','history/store','history/git','projection/service','storage/sqlite'];
const identity=(prefix,extension,extra={})=>{const files=roles.map(role=>({file:prefix+'/'+role+extension,sha256:sha(role)}));return {node:process.version,platform:process.platform,architecture:process.arch,files,sha256:sha(JSON.stringify(files)),...extra};};
function fixture(){
 const source=identity('src','.ts'),installed=identity('codiluce/dist/src','.js',{executionLayout:{schema:1,kind:'installed-package',packageDirectory:'codiluce'},sourceQualification:{root:'/qualified-source',identity:structuredClone(source)}}),current=identity('codiluce/dist/src','.js',{executionLayout:{schema:1,kind:'installed-package',packageDirectory:'codiluce'},sourceQualification:{root:'/current-source',identity:identity('src','.ts')}});
 const baseline={engineIdentity:source,corpusSha256:sha('corpus'),profilesSha256:sha('profiles')},qualification={engineSha256:current.sha256,baselineEngineSha256:source.sha256},baselineExecutionReceipt={passed:true,completedAt:'2026-10-14T00:00:00Z',full195RevisionEntrypointQualified:true,engineIdentity:installed,baselineEngineSha256:source.sha256,corpusSha256:baseline.corpusSha256,profilesSha256:baseline.profilesSha256},baselineExecutionQualification={passed:true,completedAt:'2026-10-14T00:00:00Z',full195RevisionEntrypointQualified:true,engineSha256:installed.sha256,baselineEngineSha256:source.sha256,revisions:195,workers:12,independentCompleteColumnLedgers:42};
 return {baseline,qualification,currentIdentity:current,baselineExecutionReceipt,baselineExecutionQualification};
}
test('performance selection keeps installed execution distinct from the source correctness oracle',()=>{
 const value=fixture(),result=performanceRuntimeSelection(value);assert.equal(result.baseline,value.baselineExecutionReceipt.engineIdentity);assert.equal(result.current,value.currentIdentity);assert.notEqual(result.baseline.sha256,value.baseline.engineIdentity.sha256);
 delete value.baselineExecutionReceipt;delete value.baselineExecutionQualification;assert.equal(performanceRuntimeSelection(value).baseline,value.baseline.engineIdentity);
});
test('performance selection refuses an unfinished or incomplete installed baseline qualification',()=>{
 for(const change of [v=>delete v.baselineExecutionReceipt,v=>delete v.baselineExecutionQualification,v=>v.baselineExecutionReceipt.passed=false,v=>delete v.baselineExecutionReceipt.completedAt,v=>v.baselineExecutionQualification.full195RevisionEntrypointQualified=false,v=>v.baselineExecutionQualification.revisions=194,v=>v.baselineExecutionQualification.workers=11,v=>v.baselineExecutionQualification.independentCompleteColumnLedgers=41]){const value=fixture();change(value);assert.throws(()=>performanceRuntimeSelection(value));}
});
test('performance selection rejects source lineage, execution identity or corpus substitutions',()=>{
 for(const change of [v=>v.qualification.engineSha256=sha('other'),v=>v.baselineExecutionQualification.engineSha256=sha('other'),v=>v.baselineExecutionReceipt.baselineEngineSha256=sha('other'),v=>v.baselineExecutionReceipt.corpusSha256=sha('other'),v=>v.baselineExecutionReceipt.profilesSha256=sha('other'),v=>v.baselineExecutionReceipt.engineIdentity.sourceQualification.identity.files[0].sha256=sha('other')]){const value=structuredClone(fixture());change(value);assert.throws(()=>performanceRuntimeSelection(value));}
});

async function withFiles(check){
 const root=await mkdtemp(path.join(os.tmpdir(),'codiluce-performance-runtime-'));let passed=false;
 try{
  const sourceRoot=path.join(root,'source'),installedRoot=path.join(root,'installed'),value=fixture().baselineExecutionReceipt.engineIdentity;value.sourceQualification.root=sourceRoot;
  for(const [directory,ledger] of [[sourceRoot,value.sourceQualification.identity],[installedRoot,value]])for(const row of ledger.files){const file=path.join(directory,row.file);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,roles[ledger.files.indexOf(row)]);}
  await symlink('history/indexer.js',path.join(installedRoot,'codiluce/dist/src/literal-link'));value.links=[{file:'codiluce/dist/src/literal-link',target:'history/indexer.js'}];
  await check({value,sourceRoot,installedRoot});passed=true;
 }finally{if(passed)await rm(root,{recursive:true});else console.error('Retained performance runtime fixture:',root);}
}
test('performance runtime verification hashes both actual ledgers and preserves literal links',()=>withFiles(async({value,installedRoot})=>{
 const recorded=[];await verifyPerformanceRuntimeFiles(value,installedRoot,(file,digest)=>recorded.push({file,digest}));assert.equal(recorded.length,12);assert.equal(recorded.filter(r=>r.file.includes('/source/')).length,6);assert.equal(await readlink(path.join(installedRoot,value.links[0].file)),value.links[0].target);
}));
test('performance runtime verification catches changed installed bytes and separately changed source bytes',()=>withFiles(async({value,installedRoot,sourceRoot})=>{
 for(const [directory,ledger] of [[installedRoot,value],[sourceRoot,value.sourceQualification.identity]]){const file=path.join(directory,ledger.files[0].file);await writeFile(file,'changed runtime');await assert.rejects(verifyPerformanceRuntimeFiles(value,installedRoot),/runtime changed/);await writeFile(file,roles[0]);}
 await verifyPerformanceRuntimeFiles(value,installedRoot);
}));
test('performance runtime verification refuses changed, aliased or duplicate literal links',()=>withFiles(async({value,installedRoot})=>{
 const link=path.join(installedRoot,value.links[0].file);await unlink(link);await symlink('../different',link);await assert.rejects(verifyPerformanceRuntimeFiles(value,installedRoot));await unlink(link);await symlink(value.links[0].target,link);
 for(const file of ['../escape','/absolute','codiluce/./alias','codiluce\\alias',value.files[0].file]){const changed=structuredClone(value);changed.links.push({file,target:'anything'});await assert.rejects(verifyPerformanceRuntimeFiles(changed,installedRoot));}
 await verifyPerformanceRuntimeFiles(value,installedRoot);
}));


test('performance entrypoint selection excludes the source baseline regardless of artifact completion order',()=>{
 const baseline={file:'/owned/source/corpus/receipt.json',sha256:sha('baseline')},current={file:'/owned/installed/corpus/receipt.json',sha256:sha('installed')};
 for(const artifacts of [[baseline,current],[current,baseline]])assert.equal(performanceEntrypointArtifact({artifacts},baseline.file),current);
});
test('performance entrypoint selection refuses missing, duplicate, ambiguous or malformed current artifacts',()=>{
 const baseline={file:'/owned/source/corpus/receipt.json',sha256:sha('baseline')},current={file:'/owned/installed/corpus/receipt.json',sha256:sha('installed')};
 for(const artifacts of [[baseline],[baseline,current,current],[baseline,current,{file:'/other/corpus/receipt.json',sha256:sha('other')}],[baseline,{...current,sha256:'invalid'}],[baseline,{...current,file:'relative/corpus/receipt.json'}]])assert.throws(()=>performanceEntrypointArtifact({artifacts},baseline.file));
 assert.throws(()=>performanceEntrypointArtifact({artifacts:[current]},'relative-baseline'));
});
