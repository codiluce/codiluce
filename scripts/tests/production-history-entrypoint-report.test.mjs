import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {renderEntrypointReport} from '../render-production-history-entrypoint.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fixture(runtimeInputs=1924){
 const files=Array.from({length:runtimeInputs},(_,index)=>({file:'owned/input-'+index+'.ts',sha256:'1'.repeat(64)}));
 const ids=['flask','memos','bookstack','firefly-iii','axum','full-stack-fastapi'],receipt={passed:true,completedAt:'terminal',full195RevisionEntrypointQualified:true,engineIdentity:{sha256:hash(files),files},baselineEngineSha256:'2'.repeat(64),repositories:[]},qualified={passed:true,completedAt:'terminal',full195RevisionEntrypointQualified:true,engineSha256:receipt.engineIdentity.sha256,baselineEngineSha256:receipt.baselineEngineSha256,workers:12,method:'Owned in-memory report fixture; <script>unsafe source text</script>',repositories:[]};
 ids.forEach((id,index)=>{
  const revisions=id==='flask'?35:32,cached=id==='flask'?33:32,workers=[{pid:100+2*index},{pid:101+2*index}],snapshots=Array.from({length:revisions},(_,i)=>({cachedFirstParent:i<cached,projectedNodes:2})),child={passed:true,completedAt:'terminal',revisions:Array(revisions).fill({}),workers,views:{passed:true,freshServicePasses:2,snapshots,offFirstParentSnapshots:revisions-cached},stages:[{name:'fresh',indexed:{indexed:revisions,failed:0}},{name:'resume',indexed:{indexed:0,skipped:revisions},events:[{type:'plan',pending:0},{type:'layout',rebuilt:false}]}]};
  qualified.repositories.push({id,revisions,workers:workers.map(w=>w.pid),databaseSha256:'fresh-'+id,originalDatabaseSha256:'original-'+id,cachedFirstParentSnapshots:cached,offFirstParentSnapshots:revisions-cached,publicViewNodes:revisions*2,independentCompleteColumnLedgers:7});receipt.repositories.push({id,passed:true,completedAt:'terminal',process:{exitCode:0,signal:null},originalDatabaseUnchanged:true,databaseSha256:'fresh-'+id,originalDatabaseSha256:'original-'+id,child});
 });
 for(const key of ['revisions','cachedFirstParentSnapshots','offFirstParentSnapshots','publicViewNodes','independentCompleteColumnLedgers'])qualified[key]=qualified.repositories.reduce((n,r)=>n+r[key],0);return {qualified,receipt};
}
test('full entrypoint report renders the qualified scope and escapes source text and URL attributes',()=>{
 const {qualified,receipt}=fixture(),html=renderEntrypointReport(qualified,receipt,{archiveUrl:'http://127.0.0.1:37858/evidence.tar.gz?first=1&second=2'});assert.match(html,/195 revisions · 12 actual workers · 42/);assert.match(html,/193 cached first-parent snapshots and 2 side-branch snapshots/);assert.equal((html.match(/<tr><td>/g)||[]).length,6);assert.match(html,/&lt;script&gt;unsafe source text&lt;\/script&gt;/);assert.doesNotMatch(html,/<script>/);assert.match(html,/first=1&amp;second=2/);assert.match(html,/remaining semantic\/compiler\/WASM budgets/);assert.doesNotMatch(renderEntrypointReport(qualified,receipt),/linked fresh-state archive includes/);
});
test('report uses the verified runtime inventory for both the original and extended engines',()=>{
 for(const inputs of [1924,1928,1930]){
  const {qualified,receipt}=fixture(inputs),html=renderEntrypointReport(qualified,receipt);
  assert.ok(html.includes('the frozen '+new Intl.NumberFormat('en-US').format(inputs)+'-file runtime'));
 }
});
test('report refuses corrupt, duplicate or escaping runtime ledgers even with a matching declared profile',()=>{
 const stale=fixture();stale.receipt.engineIdentity.files.pop();assert.throws(()=>renderEntrypointReport(stale.qualified,stale.receipt));
 for(const change of [v=>v.receipt.engineIdentity.files.push(v.receipt.engineIdentity.files[0]),v=>v.receipt.engineIdentity.files[0].file='../outside',v=>v.receipt.engineIdentity.files[0].sha256='invalid',v=>v.receipt.engineIdentity.files=[]]){
  for(const rehash of [false,true]){
   const value=fixture();change(value);
   if(rehash){value.receipt.engineIdentity.sha256=hash(value.receipt.engineIdentity.files);value.qualified.engineSha256=value.receipt.engineIdentity.sha256;}
   assert.throws(()=>renderEntrypointReport(value.qualified,value.receipt));
  }
 }
});
test('report refuses pending jobs, smaller scopes, equal-count substitutions and mismatched aggregates',()=>{
 for(const change of [v=>v.qualified.full195RevisionEntrypointQualified=false,v=>delete v.receipt.completedAt,v=>v.receipt.repositories.pop(),v=>v.receipt.repositories[1].id='other',v=>v.receipt.repositories[0].child.revisions.pop(),v=>v.qualified.publicViewNodes++,v=>v.qualified.repositories[0].databaseSha256='changed',v=>v.receipt.repositories[0].child.stages[1].events[1].rebuilt=true,v=>v.receipt.repositories[0].process.signal='SIGTERM',v=>v.receipt.repositories[0].child.views.freshServicePasses=1]){const value=fixture();change(value);assert.throws(()=>renderEntrypointReport(value.qualified,value.receipt));}
});
test('report cannot turn arbitrary source URLs into executable links',()=>{
 const {qualified,receipt}=fixture();for(const archiveUrl of ['javascript:alert(1)','data:text/html,unsafe','not a URL'])assert.throws(()=>renderEntrypointReport(qualified,receipt,{archiveUrl}));
});

function installedFixture(){
 const value=fixture(1939),roles=['history/indexer','history/worker','history/store','history/git','projection/service','storage/sqlite'];
 const source=value.receipt.engineIdentity;
 Object.assign(source,{node:'v22.12.0',platform:'linux',architecture:'x64'});
 roles.forEach((name,index)=>{source.files[index].file='src/'+name+'.ts';});source.sha256=hash(source.files);
 const files=Array.from({length:1971},(_,index)=>({file:index<roles.length?'codiluce/dist/src/'+roles[index]+'.js':'owned/dependency-'+index+'.js',sha256:'3'.repeat(64)}));
 value.receipt.engineIdentity={node:source.node,platform:source.platform,architecture:source.architecture,files,sha256:hash(files),executionLayout:{schema:1,kind:'installed-package',packageDirectory:'codiluce'},sourceQualification:{root:'/separately-qualified-source',identity:source}};
 value.receipt.executionLayout={kind:'installed-package',modules:Object.fromEntries(['indexer','worker','store','git','projection','graphStore'].map((role,index)=>[role,'codiluce/dist/src/'+roles[index]+'.js'])),execArgv:['--experimental-sqlite']};
 value.receipt.qualificationSourceRuntimeSha256=source.sha256;value.qualified.engineSha256=value.receipt.engineIdentity.sha256;
 return value;
}
test('installed report distinguishes actual packaged execution from the separate qualified source inventory',()=>{
 const {qualified,receipt}=installedFixture(),html=renderEntrypointReport(qualified,receipt,{receiptName:'new-history-receipt.json',validationName:'new-history-validation.json'});
 assert.match(html,/1,971-file installed execution ledger and separate 1,939-file qualification source ledger/);
 assert.ok(html.includes('installed execution SHA-256 is <code>'+receipt.engineIdentity.sha256));
 assert.ok(html.includes('separately qualified source SHA-256 is <code>'+receipt.engineIdentity.sourceQualification.identity.sha256));
 assert.match(html,/--engine \/existing\/consumer\/node_modules/);assert.match(html,/--observer-root \/existing\/owned\/observer/);
 assert.doesNotMatch(html,/--import tsx/);assert.doesNotMatch(html,/the frozen 1,971-file runtime/);
 assert.match(html,/href="new-history-receipt.json"/);assert.match(html,/href="new-history-validation.json"/);assert.doesNotMatch(html,/href="production-history-entrypoint-complete-receipt.json"/);
});
test('installed report rejects stale source pairs, absent packaged modules and false loader or lineage claims',()=>{
 for(const change of [
  v=>{v.receipt.engineIdentity.sourceQualification.identity.sha256='4'.repeat(64);},
  v=>{const identity=v.receipt.engineIdentity;identity.files.shift();identity.sha256=hash(identity.files);v.qualified.engineSha256=identity.sha256;},
  v=>{v.receipt.executionLayout.execArgv.push('--import','tsx');},
  v=>{v.receipt.qualificationSourceRuntimeSha256='5'.repeat(64);},
  v=>{v.receipt.engineIdentity.sourceQualification.identity.files[0].file='../outside';}
 ]){const value=installedFixture();change(value);assert.throws(()=>renderEntrypointReport(value.qualified,value.receipt));}
 const source=fixture();source.receipt.engineIdentity.sourceQualification={root:'/other',identity:fixture().receipt.engineIdentity};assert.throws(()=>renderEntrypointReport(source.qualified,source.receipt));
});
test('report artifact names cannot escape the report directory or alias the two evidence inputs',()=>{
 const {qualified,receipt}=fixture();
 for(const name of ['../outside.json','/outside.json','folder/input.json','input\\other.json','javascript:alert(1)','unsafe".json','input.html','']){
  for(const key of ['receiptName','validationName'])assert.throws(()=>renderEntrypointReport(qualified,receipt,{[key]:name}));
 }
 assert.throws(()=>renderEntrypointReport(qualified,receipt,{receiptName:'same.json',validationName:'same.json'}));
});
