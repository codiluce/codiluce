import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {validateHistoryRecovery,verifyHistoryRecoveryJoin} from '../production-history-recovery.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fixture(){
 const files=[{file:'src/history/worker.ts',sha256:'1'.repeat(64)}],identity={files,sha256:hash(files)},corpus={repositories:['complete','partial','unstarted'].map((id,index)=>({id,head:String(index+1).repeat(40),revisions:[{commit:String(index+1).repeat(40)}],extraRevisions:[]}))};
 const logical={sha256:'2'.repeat(64),bytes:100,normalization:[],counts:{entities:1,relations:0,diagnostics:0}};
 const row={id:'complete',head:corpus.repositories[0].head,expectedRevisions:1,status:'verified',error:null,worker:{pid:100,exitCode:0,signal:null},readOnlyReopenVerified:true,completedAt:'terminal',storage:{snapshots:1},revisions:[{commit:corpus.repositories[0].head,status:'verified',completedAt:'terminal',logical,readback:logical}]};
 const partial={id:'partial',head:corpus.repositories[1].head,expectedRevisions:1,status:'starting',error:null,worker:{pid:101},revisions:[{commit:corpus.repositories[1].head,status:'verified'}]};
 const previous={schema:1,phase:'full-original-corpus-history-worker-store-readback',engineIdentity:identity,corpusSha256:'corpus',profilesSha256:'profiles',passed:false,completedAt:null,repositories:[row,partial]};
 return {previous,identity,corpus,corpusSha256:'corpus',profilesSha256:'profiles'};
}
test('interrupted recovery distinguishes actual terminal repositories from partial and unstarted units',()=>{
 const result=validateHistoryRecovery(fixture());assert.deepEqual(result.completed.map(row=>row.id),['complete']);assert.deepEqual(result.incomplete,['partial']);assert.deepEqual(result.unstarted,['unstarted']);
});
for(const [name,mutate]of [
 ['completed whole observation',v=>{v.previous.passed=true;v.previous.completedAt='terminal';}],
 ['terminal failed observation',v=>v.previous.completedAt='terminal'],
 ['runtime drift',v=>v.previous.engineIdentity={files:[],sha256:'changed'}],
 ['corpus drift',v=>v.corpusSha256='changed'],
 ['profile drift',v=>v.profilesSha256='changed'],
 ['duplicate repository',v=>v.previous.repositories.push(v.previous.repositories[0])],
 ['unknown repository',v=>v.previous.repositories[0].id='other'],
 ['changed original head',v=>v.previous.repositories[0].head='9'.repeat(40)],
 ['failed repository',v=>v.previous.repositories[1].status='failed'],
 ['failed partial revision',v=>v.previous.repositories[1].revisions[0].status='failed'],
 ['hidden error',v=>v.previous.repositories[0].error='lost payload'],
 ['no actual worker terminal',v=>delete v.previous.repositories[0].worker.exitCode],
 ['signal-terminated worker',v=>v.previous.repositories[0].worker.signal='SIGTERM'],
 ['unverified reopen',v=>v.previous.repositories[0].readOnlyReopenVerified=false],
 ['missing repository completion',v=>delete v.previous.repositories[0].completedAt],
 ['equal-count replaced commit',v=>v.previous.repositories[0].revisions[0].commit='9'.repeat(40)],
 ['wrong durable snapshot count',v=>v.previous.repositories[0].storage.snapshots=2],
 ['hidden graph field change',v=>v.previous.repositories[0].revisions[0].readback={...v.previous.repositories[0].revisions[0].logical,sha256:'changed'}],
 ['normalized payload',v=>v.previous.repositories[0].revisions[0].logical.normalization=['producer']],
])test('recovery rejects '+name,()=>{const value=fixture();mutate(value);assert.throws(()=>validateHistoryRecovery(value));});
test('recovery qualification joins unchanged terminal rows and refuses promoting an interrupted worker',()=>{
 const value=fixture(),selection=validateHistoryRecovery(value),current={...value.previous,passed:true,completedAt:'terminal',repositories:[value.previous.repositories[0],{...value.previous.repositories[1],worker:{pid:102}}],recovery:{completedRepositories:['complete'],incompleteRepositoriesRecapturedInFull:['partial'],unstartedRepositories:['unstarted']}};
 verifyHistoryRecoveryJoin({previous:value.previous,current,corpus:value.corpus});
 for(const mutate of [v=>v.recovery.completedRepositories.push('partial'),v=>v.recovery.incompleteRepositoriesRecapturedInFull=[],v=>v.recovery.unstartedRepositories=[],v=>v.repositories[0]={...v.repositories[0],completedAt:'invented'},v=>v.repositories[1].worker.pid=101]){
  const changed=structuredClone(current);mutate(changed);assert.throws(()=>verifyHistoryRecoveryJoin({previous:value.previous,current:changed,corpus:value.corpus}));
 }
 assert.equal(selection.completed.length,1);
});
