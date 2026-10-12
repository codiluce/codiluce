import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {inspectHeadTree,observeProductionHeads,renderHeadReceipt,validateHeadProfiles} from '../production-head-graphs.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),bytes=Buffer.from('function original() { return "😀"; }\n'),file='src/original.ts',pin='b'.repeat(40),tree='c'.repeat(40);
const blob=createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
const inventory={entries:1,regularFiles:1,symlinks:0,gitlinks:0,sha256:sha(Buffer.from(`100644 blob ${blob}\t${file}\0`))};
const revision={commit:pin,tree,parents:['a'.repeat(40)],inventory};
function specification(ids=['owned']){
  const corpus={schema:1,repositories:ids.map(id=>({id,repository:'https://github.com/example/'+id,head:pin,coverageIntent:'Owned fixture only',policy:'consecutive-first-parent',revisions:[{commit:'a'.repeat(40),tree,parents:[],inventory},revision],extraRevisions:[]}))};
  const manifest={schema:1,contracts:ids.map(id=>({id:id+'-original',repository:id,commit:pin,path:file,name:'original',entityType:'function',language:'typescript',header:'function original()',range:{startLine:1,startColumn:1,endLine:1,endColumn:bytes.toString().trimEnd().length+1},fileSha256:sha(bytes),spanSha256:sha(bytes.subarray(0,bytes.length-1))}))};
  const profiles={schema:1,repositories:ids.map(id=>({id,commit:pin,scope:'Owned cold source-only conformance fixture',config:{repository:{name:id,id},applications:[{name:id,path:'.',frameworks:[],ecosystems:['node']}],ignore:[],maxFileBytes:8*1024*1024}}))};
  return {corpus,manifest,profiles};
}
function graph(id='owned'){
  const {manifest}=specification([id]),contract=manifest.contracts[0];return {schemaVersion:1,run:{commitSha:pin},entities:[{id:'file',type:'file',path:file,metadata:{contentHash:sha(bytes),analysis:{features:{structure:{status:'supported'}}}}},{id:'function',type:'function',name:'original',path:file,language:'typescript',parentId:'file',sourceRange:contract.range,metadata:{contentHash:contract.spanSha256},evidence:[{file}]}],relations:[{from:'file',to:'function',type:'contains'}],diagnostics:[]};
}
async function fixture(t,ids=['owned']){
  const root=await mkdtemp(path.join(tmpdir(),'codiluce-head-graphs-test-'));t.after(()=>rm(root,{recursive:true,force:true}));const observations={};
  for(const id of ids){const directory=path.join(root,id);await mkdir(path.join(directory,'tree','src'),{recursive:true});await writeFile(path.join(directory,'tree',file),bytes);await writeFile(path.join(directory,'receipt.json'),JSON.stringify({schema:1,commit:pin,tree,materializationCompleted:true,verifierUnchanged:true,allRegularFilesMaterialized:true,entries:[{path:file,pathBytesHex:Buffer.from(file).toString('hex'),mode:'100644',object:blob,status:'materialized',bytes:bytes.length,sha256:sha(bytes),writtenSha256:sha(bytes),blobIdentityVerified:true}]}));observations[id]=directory;}
  return {root,observations,...specification(ids)};
}
const identity=async()=>({compiled:'exact-owned-engine'});

test('head source profiles pin every selected head and record explicit bounded configurations',()=>{
  const {profiles,manifest,corpus}=specification();validateHeadProfiles(profiles,manifest,corpus);
  for(const mutate of [value=>value.repositories[0].commit='a'.repeat(40),value=>value.repositories[0].config.maxFileBytes=1,value=>value.repositories[0].config.applications[0].path='../escape',value=>value.repositories.push(value.repositories[0])]){const value=structuredClone(profiles);mutate(value);assert.throws(()=>validateHeadProfiles(value,manifest,corpus));}
});
test('complete original inventory, bytes and independently reconstructed Git blob identities agree',async t=>{
  const {observations}=await fixture(t),result=await inspectHeadTree(observations.owned,revision);assert.equal(result.regularFiles,1);assert.equal(result.originalBytes,bytes.length);assert.deepEqual(result.skipped,[]);
});
test('mutated original bytes, missing files and unexpected files cannot supply a graph input',async t=>{
  const {observations}=await fixture(t),original=path.join(observations.owned,'tree',file);await writeFile(original,Buffer.alloc(bytes.length));await assert.rejects(inspectHeadTree(observations.owned,revision),/bytes changed/);await writeFile(original,bytes);
  await writeFile(path.join(observations.owned,'tree','unexpected.ts'),bytes);await assert.rejects(inspectHeadTree(observations.owned,revision),/Unexpected original file/);await rm(path.join(observations.owned,'tree','unexpected.ts'));await rm(original);await assert.rejects(inspectHeadTree(observations.owned,revision),/disappeared/);
});
test('filesystem aliases and tampered original metadata stay explicit failures',async t=>{
  const {root,observations}=await fixture(t),original=path.join(observations.owned,'tree',file),elsewhere=path.join(root,'elsewhere');await writeFile(elsewhere,bytes);await rm(original);await symlink(elsewhere,original);await assert.rejects(inspectHeadTree(observations.owned,revision),/filesystem alias/);await rm(original);await writeFile(original,bytes);
  const filePath=path.join(observations.owned,'receipt.json'),receipt=JSON.parse(await readFile(filePath));receipt.entries[0].object='0'.repeat(40);await writeFile(filePath,JSON.stringify(receipt));await assert.rejects(inspectHeadTree(observations.owned,revision),/tree metadata differs/);
});
test('the original-head runner saves complete graphs and independently reviewed source assertions',async t=>{
  const value=await fixture(t),output=path.join(value.root,'result');const result=await observeProductionHeads({...value,output,identity,analyze:async(_root,options)=>{assert.equal(options.revision,pin);assert.equal(options.config.maxFileBytes,8*1024*1024);return graph();}});
  assert.equal(result.reviewedHeadsVerified,true);assert.equal(result.analysisQualified,false);assert.equal(result.repositories[0].contracts.graphContractsVerified,true);assert.deepEqual(JSON.parse(await readFile(path.join(output,'owned-graph.json'))),graph());
});
test('failed or inaccurate graph inputs remain retained while independent later repositories continue',async t=>{
  const value=await fixture(t,['owned','second']),output=path.join(value.root,'result');const result=await observeProductionHeads({...value,output,identity,analyze:async(_root,{config})=>{const result=graph(config.repository.name);if(config.repository.name==='owned')result.entities[1].sourceRange={...result.entities[1].sourceRange,startColumn:2};return result;}});
  assert.equal(result.reviewedHeadsVerified,false);assert.equal(result.repositories[0].status,'failed');assert.match(result.repositories[0].contracts.contracts[0].error,/startColumn/);assert.equal(result.repositories[1].status,'reviewed-contracts-verified');assert.ok(JSON.parse(await readFile(path.join(output,'owned-graph.json'))));
});
test('an analyzer exception and original-input mutation never qualify later unchecked outputs',async t=>{
  for(const mode of ['throw','mutate']){const value=await fixture(t),result=await observeProductionHeads({...value,output:path.join(value.root,mode),identity,analyze:async(root)=>{if(mode==='throw')throw Error('owned analyzer failure');await writeFile(path.join(root,file),Buffer.alloc(bytes.length));return graph();}});assert.equal(result.reviewedHeadsVerified,false);assert.match(result.repositories[0].error,mode==='throw'?/owned analyzer failure/:/bytes changed/);}
});
test('changing engine identity before indexing or during indexing invalidates qualification',async t=>{
  const value=await fixture(t);let version=0,called=false;const result=await observeProductionHeads({...value,output:path.join(value.root,'result'),identity:async()=>({version:version++}),analyze:async()=>{called=true;return graph();}});assert.equal(called,false);assert.equal(result.reviewedHeadsVerified,false);assert.equal(result.engineUnchanged,false);
  version=0;const changed=await observeProductionHeads({...value,output:path.join(value.root,'changed'),identity:async()=>({version}),analyze:async()=>{version++;return graph();}});assert.equal(changed.reviewedHeadsVerified,false);assert.match(changed.repositories[0].error,/Engine changed during/);assert.ok(changed.repositories[0].graph);
});
test('fresh output cannot overwrite an observation or enter any source tree, including aliases',async t=>{
  const value=await fixture(t),options={...value,identity,analyze:async()=>graph()};await assert.rejects(observeProductionHeads({...options,output:path.join(value.observations.owned,'result')}),/outside/);const output=path.join(value.root,'result');await observeProductionHeads({...options,output});await assert.rejects(observeProductionHeads({...options,output}),{code:'EEXIST'});await symlink(value.observations.owned,path.join(value.root,'alias'),process.platform==='win32'?'junction':'dir');await assert.rejects(observeProductionHeads({...options,output:path.join(value.root,'alias','result')}),/outside/);
});
test('incomplete observations and HTML rendering keep failures and full-corpus boundary visible',async t=>{
  const value=await fixture(t),result=await observeProductionHeads({...value,observations:{},output:path.join(value.root,'result'),identity,analyze:async()=>graph()});assert.equal(result.reviewedHeadsVerified,false);result.repositories[0].error='<script>unsafe</script>';const html=renderHeadReceipt(result);assert.match(html,/QUALIFICATION FAILED/);assert.match(html,/&lt;script&gt;unsafe/);assert.doesNotMatch(html,/<script>unsafe/);assert.match(html,/Full-corpus accuracy/);
});

test('the installed CLI inventories ESM-only own dependencies and retains every missing source failure without indexing',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'codiluce-head-cli-test-'));t.after(()=>rm(root,{recursive:true,force:true}));const output=path.join(root,'observation'),project=fileURLToPath(new URL('../../',import.meta.url));
  await assert.rejects(promisify(execFile)(process.execPath,['--import','tsx','scripts/qualify-production-heads.mjs','--output',output],{cwd:project,maxBuffer:1024*1024}),error=>error.code===1);
  const receipt=JSON.parse(await readFile(path.join(output,'receipt.json')));assert.equal(receipt.reviewedHeadsVerified,false);assert.equal(receipt.analysisQualified,false);assert.equal(receipt.engineUnchanged,true);assert.equal(receipt.repositories.length,6);assert.ok(receipt.repositories.every(record=>record.status==='failed'&&record.error==='Missing original observation'&&!record.graph));
  assert.ok(receipt.engineBefore.packages.some(item=>item.name==='is-reference'));assert.ok(receipt.engineBefore.files.some(item=>item.file.endsWith('web-tree-sitter.wasm')));
});
