import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {contractSpan,inspectContractSource,inspectContractGraph,validateSourceContracts,verifySourceContracts} from '../production-source-contracts.mjs';

const execute=promisify(execFile),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const original=Buffer.from('// 😀 original\r\nclass Demo {\r\n  method() { return "é"; }\r\n}\r\n');
const span='method() { return "é"; }',pin='b'.repeat(40),previous='a'.repeat(40);
const contract={id:'owned-method',repository:'owned',commit:pin,path:'src/source.ts',name:'method',entityType:'method',language:'typescript',range:{startLine:3,startColumn:3,endLine:3,endColumn:27},header:'method()',owner:'Demo',fileSha256:sha(original),spanSha256:sha(Buffer.from(span))};
const revision=(commit,parents)=>({commit,tree:'c'.repeat(40),parents,inventory:{sha256:'d'.repeat(64),entries:1,regularFiles:1,symlinks:0,gitlinks:0}});
const corpus={schema:1,repositories:[{id:'owned',repository:'https://github.com/example/owned',head:pin,coverageIntent:'Owned conformance data only',policy:'consecutive-first-parent',revisions:[revision(previous,[]),revision(pin,[previous])],extraRevisions:[]}]};
const manifest={schema:1,contracts:[contract]};
function graph(){return {schemaVersion:1,run:{commitSha:pin},entities:[
  {id:'file',type:'file',path:contract.path,metadata:{contentHash:contract.fileSha256,analysis:{features:{structure:{status:'supported'}}}}},
  {id:'class',type:'class',name:'Demo',path:contract.path,parentId:'file'},
  {id:'method',type:'method',name:'method',path:contract.path,language:'typescript',parentId:'class',sourceRange:{...contract.range},metadata:{contentHash:contract.spanSha256},evidence:[{file:contract.path}]},
],relations:[{from:'class',to:'method',type:'contains'}],diagnostics:[]};}
async function fixture(t){
  const root=await mkdtemp(path.join(tmpdir(),'codiluce-source-contract-test-')),observation=path.join(root,'input');t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(path.join(observation,'tree','src'),{recursive:true});await writeFile(path.join(observation,'tree',contract.path),original);
  const receipt={commit:pin,materializationCompleted:true,verifierUnchanged:true,entries:[{path:contract.path,status:'materialized',bytes:original.length,sha256:contract.fileSha256,writtenSha256:contract.fileSha256,blobIdentityVerified:true}]};await writeFile(path.join(observation,'receipt.json'),JSON.stringify(receipt));return {root,observation,receipt};
}

test('reviewed manifests require unique identities, complete corpus pins and original safe coordinates',()=>{
  validateSourceContracts(manifest,corpus);
  for(const mutate of [copy=>copy.contracts.push(copy.contracts[0]),copy=>copy.contracts[0].commit=pin.slice(0,7),copy=>copy.contracts[0].path='../escape',copy=>copy.contracts[0].range.startColumn=0,copy=>copy.contracts[0].range.endLine=1,copy=>copy.contracts[0].fileSha256='incomplete',copy=>copy.contracts[0].repository='unknown']){const copy=structuredClone(manifest);mutate(copy);assert.throws(()=>validateSourceContracts(copy,corpus));}
});

test('independent spans preserve CRLF, Unicode separators, BOM and one-based UTF-16 columns',()=>{
  assert.equal(contractSpan(original.toString(),contract.range),span);
  assert.equal(contractSpan('\uFEFFa😀b\r\nnext\u2028last',{startLine:1,startColumn:3,endLine:1,endColumn:5}),'😀');
  assert.equal(contractSpan('a\r\nb\nc\rd\u2028e\u2029f',{startLine:2,startColumn:1,endLine:6,endColumn:2}),'b\nc\rd\u2028e\u2029f');
  assert.throws(()=>contractSpan('one',{startLine:1,startColumn:1,endLine:2,endColumn:1}),/outside/);assert.throws(()=>contractSpan('one',{startLine:1,startColumn:1,endLine:1,endColumn:5}),/outside/);
});

test('original file bytes and exact reviewed declaration span must both agree',()=>{
  assert.equal(inspectContractSource(contract,original).originalBytesVerified,true);
  assert.throws(()=>inspectContractSource(contract,Buffer.from(original.toString().replace('é','e'))),/file-byte/);
  assert.throws(()=>inspectContractSource({...contract,spanSha256:'0'.repeat(64)},original),/span differs/);
  assert.throws(()=>inspectContractSource({...contract,header:'methodWrong()'},original),/header differs/);
  const bytes=Buffer.from([255]);assert.throws(()=>inspectContractSource({...contract,fileSha256:sha(bytes)},bytes),/encoded data|encoding|UTF/i);
});

test('a reviewed graph must retain exact original identity, span, ownership, containment and evidence',()=>{
  assert.deepEqual(inspectContractGraph(contract,graph()),{entityId:'method',parentId:'class',graphOriginalVerified:true});
  const top={...contract,owner:undefined},direct=graph();direct.entities[2].parentId='file';direct.relations[0].from='file';assert.equal(inspectContractGraph(top,direct).graphOriginalVerified,true);
});

test('wrong input pins, missing graph arrays and missing or ambiguous originals cannot pass',()=>{
  for(const mutate of [value=>value.run.commitSha=previous,value=>delete value.diagnostics,value=>value.entities[0].metadata.contentHash='0'.repeat(64),value=>value.entities[2].type='function',value=>value.entities.push({...value.entities[2],id:'duplicate'}),value=>value.entities.push({...value.entities[0],id:'another-file'}),value=>value.entities.push({...value.entities[1]})]){const value=graph();mutate(value);assert.throws(()=>inspectContractGraph(contract,value));}
});

test('every exact coordinate and source hash is enforced without widening reviewed ranges',()=>{
  for(const key of Object.keys(contract.range)){const value=graph();value.entities[2].sourceRange[key]++;assert.throws(()=>inspectContractGraph(contract,value),/differs/);}
  const value=graph();value.entities[2].metadata.contentHash='0'.repeat(64);assert.throws(()=>inspectContractGraph(contract,value),/declaration hash/);
});

test('partial, unsupported or failed structure and wrong lexical owners are explicit failures',()=>{
  for(const status of ['partial','unsupported','failed','disabled']){const value=graph();value.entities[0].metadata.analysis.features.structure.status=status;assert.throws(()=>inspectContractGraph(contract,value),/not supported/);}
  for(const mutate of [value=>value.entities[1].name='Different',value=>value.relations=[],value=>value.entities[2].evidence=[],value=>value.entities[2].parentId='missing']){const value=graph();mutate(value);assert.throws(()=>inspectContractGraph(contract,value));}
});

test('source-only observations never qualify missing graph assertions or complete analysis',async t=>{
  const {observation}=await fixture(t),result=await verifySourceContracts({manifest,corpus,observations:{owned:observation}});
  assert.equal(result.originalSourcesVerified,true);assert.equal(result.graphContractsVerified,false);assert.equal(result.analysisQualified,false);assert.equal(result.contracts[0].status,'source-verified-graph-pending');
  const verified=await verifySourceContracts({manifest,corpus,observations:{owned:observation},graphs:{owned:graph()}});assert.equal(verified.graphContractsVerified,true);assert.equal(verified.analysisQualified,false);
});

test('changed originals, mismatched receipts and source-read limits retain terminal failures',async t=>{
  const {observation,receipt}=await fixture(t);
  const run=options=>verifySourceContracts({manifest,corpus,observations:{owned:observation},...options});
  const small=await run({maxSourceBytes:1});assert.equal(small.originalSourcesVerified,false);assert.match(small.contracts[0].error,/source-read limit/);
  receipt.commit=previous;await writeFile(path.join(observation,'receipt.json'),JSON.stringify(receipt));assert.match((await run()).contracts[0].error,/revision differs/);
  receipt.commit=pin;await writeFile(path.join(observation,'receipt.json'),JSON.stringify(receipt));await writeFile(path.join(observation,'tree',contract.path),original.toString().replace('é','e'));assert.equal((await run()).originalSourcesVerified,false);
});

test('filesystem aliases cannot substitute other original source files',async t=>{
  const {root,observation}=await fixture(t),elsewhere=path.join(root,'elsewhere');await mkdir(elsewhere);await writeFile(path.join(elsewhere,'source.ts'),original);await rm(path.join(observation,'tree','src'),{recursive:true});await symlink(elsewhere,path.join(observation,'tree','src'),process.platform==='win32'?'junction':'dir');
  const result=await verifySourceContracts({manifest,corpus,observations:{owned:observation}});assert.equal(result.originalSourcesVerified,false);assert.match(result.contracts[0].error,/filesystem alias/);
});

test('independent contract failures and graph-load errors are retained alongside healthy assertions',async t=>{
  const {observation}=await fixture(t),copy=structuredClone(manifest);copy.contracts.push({...contract,id:'owned-missing',path:'src/missing.ts'});
  const result=await verifySourceContracts({manifest:copy,corpus,observations:{owned:observation},graphs:{owned:graph()}});assert.deepEqual(result.contracts.map(item=>item.status),['graph-and-source-verified','failed']);assert.equal(result.originalSourcesVerified,false);assert.equal(result.graphContractsVerified,false);
  const failed=await verifySourceContracts({manifest,corpus,observations:{owned:observation},graphs:{owned:{graphLoadError:'retained <original> JSON failure'}}});assert.equal(failed.originalSourcesVerified,true);assert.equal(failed.graphContractsVerified,false);assert.match(failed.contracts[0].error,/retained <original>/);
});

test('CLI keeps source-only and graph evidence distinct, refuses overwrite and escapes failures',async t=>{
  const {root,observation}=await fixture(t),manifestFile=path.join(root,'manifest.json'),corpusFile=path.join(root,'corpus.json'),graphFile=path.join(root,'graph.json');await writeFile(manifestFile,JSON.stringify(manifest));await writeFile(corpusFile,JSON.stringify(corpus));await writeFile(graphFile,JSON.stringify(graph()));
  const args=['scripts/qualify-production-source-contracts.mjs','--manifest',manifestFile,'--corpus',corpusFile,'--source-observation',`owned=${observation}`,'--output',path.join(root,'source-only')];
  const first=JSON.parse((await execute(process.execPath,args)).stdout);assert.equal(first.originalSourcesVerified,true);assert.equal(first.graphContractsVerified,false);await assert.rejects(execute(process.execPath,args),/EEXIST/);
  args[args.indexOf('--output')+1]=path.join(root,'with-graph');args.push('--graph',`owned=${graphFile}`);const second=JSON.parse((await execute(process.execPath,args)).stdout);assert.equal(second.graphContractsVerified,true);assert.equal(second.analysisQualified,false);
  args[args.indexOf('--output')+1]=path.join(root,'failed-graph');await writeFile(graphFile,'<script>not JSON</script>');await assert.rejects(execute(process.execPath,args));const failed=JSON.parse(await readFile(path.join(root,'failed-graph','receipt.json'),'utf8'));assert.equal(failed.graphContractsVerified,false);assert.equal(failed.contracts[0].status,'failed');const html=await readFile(path.join(root,'failed-graph','index.html'),'utf8');assert.ok(!html.includes('<script>'));assert.match(html,/GRAPH CONTRACTS FAILED; ORIGINAL SOURCE ANCHORS VERIFIED/);
  args[args.indexOf('--output')+1]=path.join(observation,'refused-output');await assert.rejects(execute(process.execPath,args),/outside every original/);
});
