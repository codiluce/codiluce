import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {historyRuntimeLayout,historySourceIdentity,historyRuntimeLedgers} from '../production-history-runtime-layout.mjs';
import {compareHistoryRuntimeInputs} from '../production-history-runtime-inputs.mjs';
const roles=['history/indexer','history/worker','history/store','history/git','projection/service','storage/sqlite'];
const sha=value=>createHash('sha256').update(value).digest('hex');
const identity=(files,extra={})=>({node:'v22.12.0',platform:'linux',architecture:'x64',files,sha256:sha(JSON.stringify(files)),...extra});
const source=()=>identity(roles.map(name=>({file:'src/'+name+'.ts',sha256:sha(name)})));
const installed=()=>identity([...roles.map(name=>({file:'codiluce/dist/src/'+name+'.js',sha256:sha('compiled '+name)})),{file:'typescript/lib/typescript.js',sha256:sha('installed vendor')}],{executionLayout:{schema:1,kind:'installed-package',packageDirectory:'codiluce'},sourceQualification:{root:'/qualified-source',identity:source()}});

test('source history imports retain their actual worker and loader paths',()=>{
 const layout=historyRuntimeLayout(source());assert.equal(layout.kind,'source');assert.equal(layout.modules.worker,'src/history/worker.ts');assert.equal(layout.modules.projection,'src/projection/service.ts');assert.deepEqual(layout.execArgv,['--experimental-sqlite','--import','tsx']);
});
test('installed history imports use only packaged JS and never add a source loader',()=>{
 const layout=historyRuntimeLayout(installed());assert.equal(layout.kind,'installed-package');assert.deepEqual(Object.values(layout.modules),roles.map(name=>'codiluce/dist/src/'+name+'.js'));assert.deepEqual(layout.execArgv,['--experimental-sqlite']);
});
test('installed vendor bytes remain distinct from the separately qualified source input lineage',()=>{
 const value=installed(),baseline=source();assert.equal(historySourceIdentity(value),value.sourceQualification.identity);assert.equal(historySourceIdentity(baseline),baseline);
 const comparison=compareHistoryRuntimeInputs(historySourceIdentity(value),baseline);assert.deepEqual(comparison.added,[]);assert.deepEqual(comparison.changed,[]);
 const ledgers=historyRuntimeLedgers(value,'/actual-installation');assert.equal(ledgers.length,2);assert.equal(ledgers[0].identity,value);assert.equal(ledgers[0].root,'/actual-installation');assert.equal(ledgers[1].identity,value.sourceQualification.identity);assert.equal(ledgers[1].root,'/qualified-source');assert.equal(value.files.some(row=>row.file.startsWith('src/')),false);
});
test('source executions retain one ledger and legacy source comparison fixtures remain usable',()=>{
 const value=source();assert.deepEqual(historyRuntimeLedgers(value,'/source'),[{role:'execution',root:'/source',identity:value}]);
 const tiny=identity([{file:'src/history/worker.ts',sha256:sha('original')}]);assert.equal(historySourceIdentity(tiny),tiny);
});
test('every imported source or installed module must be present in its actual execution ledger',()=>{
 for(const template of [source(),installed()])for(const name of Object.values(historyRuntimeLayout(template).modules)){
  const value=structuredClone(template);value.files=value.files.filter(row=>row.file!==name);assert.throws(()=>historyRuntimeLayout(value),/Execution module absent/);
 }
});
test('unknown layouts, foreign package paths and source-loader impersonation are rejected',()=>{
 for(const change of [{schema:2},{kind:'source'},{packageDirectory:'../outside'},{packageDirectory:'/outside'},{packageDirectory:'another-package'}]){
  const value=installed();Object.assign(value.executionLayout,change);assert.throws(()=>historyRuntimeLayout(value));
 }
 const value=source();value.sourceQualification={root:'/other',identity:source()};assert.throws(()=>historyRuntimeLayout(value));assert.throws(()=>historySourceIdentity(value));
});
test('installed qualification requires a real source descriptor with matching host and no nested installed pair',()=>{
 for(const change of [value=>{delete value.sourceQualification;},value=>{value.sourceQualification.root='relative';},value=>{value.sourceQualification.identity.node='v24.21.0';},value=>{value.sourceQualification.identity=installed();}]){
  const value=installed();change(value);assert.throws(()=>historyRuntimeLayout(value));
 }
});
test('aliases, malformed digests and duplicate execution paths cannot hide unverified runtime modules',()=>{
 for(const name of ['../escape','src/./extra.ts','src//extra.ts','/absolute','src\\extra.ts']){const value=source();value.files.push({file:name,sha256:sha('extra')});assert.throws(()=>historyRuntimeLayout(value),/Invalid execution runtime path/);}
 const malformed=source();malformed.files[0].sha256='invalid';assert.throws(()=>historyRuntimeLayout(malformed));const duplicate=source();duplicate.files.push(duplicate.files[0]);assert.throws(()=>historyRuntimeLayout(duplicate),/Duplicate execution runtime path/);
 assert.throws(()=>historyRuntimeLedgers(installed(),'relative'),/Execution root must be absolute/);
});
