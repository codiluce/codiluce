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
