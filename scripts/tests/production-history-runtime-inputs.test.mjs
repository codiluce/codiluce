import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {compareHistoryRuntimeInputs} from '../production-history-runtime-inputs.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const identity=files=>({files,sha256:sha(JSON.stringify(files))});
const baseline=()=>identity([{file:'src/history/worker.ts',sha256:sha('original worker')},{file:'node_modules/parser/index.js',sha256:sha('original parser')}]);

test('New analyzer modules are reported alongside changed worker bytes while all old inputs remain required',()=>{
 const old=baseline(),files=[...old.files,{file:'src/analysis/embedded/native-framework-worker.mjs',sha256:sha('new module')},{file:'src/analysis/resolution/jvm-gradle-compiler.ts',sha256:sha('new compiler reader')}];
 files[0]={...files[0],sha256:sha('updated worker')};
 const current=identity(files),result=compareHistoryRuntimeInputs(current,old);
 assert.equal(result.baselineSha256,old.sha256);assert.equal(result.candidateSha256,current.sha256);
 assert.deepEqual(result.added,['src/analysis/embedded/native-framework-worker.mjs','src/analysis/resolution/jvm-gradle-compiler.ts']);
 assert.deepEqual(result.changed,['src/history/worker.ts']);assert.equal(result.baselineInputs,2);assert.equal(result.candidateInputs,4);assert.equal(result.retainedBaselineInputs,true);
 assert.equal(old.files[0].sha256,sha('original worker'));
});

test('Reordered declarations keep distinct ledger identities and unchanged file contents',()=>{
 const old=baseline(),current=identity([...old.files].reverse()),result=compareHistoryRuntimeInputs(current,old);
 assert.notEqual(result.candidateSha256,result.baselineSha256);assert.deepEqual(result.added,[]);assert.deepEqual(result.changed,[]);
});

test('Renaming or dropping an old input fails even with a valid equal-count candidate ledger',()=>{
 const old=baseline();
 assert.throws(()=>compareHistoryRuntimeInputs(identity(old.files.slice(0,1)),old),/omitted baseline input/);
 assert.throws(()=>compareHistoryRuntimeInputs(identity([old.files[0],{...old.files[1],file:'node_modules/parser/replacement.js'}]),old),/omitted baseline input/);
});

test('Every additional module needs a valid digest and unique canonical confined path',()=>{
 const old=baseline();
 for(const file of ['', '/etc/passwd','../outside','src/../outside','src/./worker.ts','src//worker.ts','src\\worker.ts'])
  assert.throws(()=>compareHistoryRuntimeInputs(identity([...old.files,{file,sha256:sha('new')}]),old));
 for(const digest of ['', 'invalid', 'A'.repeat(64), 'a'.repeat(63), 42, null])
  assert.throws(()=>compareHistoryRuntimeInputs(identity([...old.files,{file:'src/new.ts',sha256:digest}]),old));
 assert.throws(()=>compareHistoryRuntimeInputs(identity([...old.files,old.files[0]]),old),/Duplicate runtime input/);
});

test('Neither candidate nor baseline ledger identities can conceal edited or unlisted inputs',()=>{
 const old=baseline(),changed=structuredClone(old);changed.files[0].sha256=sha('tampered');
 assert.throws(()=>compareHistoryRuntimeInputs(changed,old),/ledger identity differs/);
 assert.throws(()=>compareHistoryRuntimeInputs(old,changed),/ledger identity differs/);
 const unlisted=structuredClone(old);unlisted.files.push({file:'src/new.ts',sha256:sha('new')});
 assert.throws(()=>compareHistoryRuntimeInputs(unlisted,old),/ledger identity differs/);
 assert.throws(()=>compareHistoryRuntimeInputs(old,identity([])),/Missing runtime input ledger/);
});
