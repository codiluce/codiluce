import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat,readlink,realpath} from 'node:fs/promises';
import path from 'node:path';
import {historyRuntimeLayout,historyRuntimeLedgers,historySourceIdentity} from './production-history-runtime-layout.mjs';

export const performanceScriptNames=['observe-production-history-performance.mjs','production-history-performance-worker.mjs','production-history-performance-runtime.mjs','production-history-runtime-layout.mjs','production-history-performance-results.mjs','audit-history-performance-columns.py','audit-history-columns.py','production-cache-measure.mjs','process-memory.mjs','production-cache-git.mjs','production-history-storage.mjs','production-history-storage-ledger.mjs','production-graph-digest.mjs','production-history-inputs.mjs'];

/** The source correctness baseline remains the graph oracle. An installed
 * baseline must have its own completed full-history execution qualification. */
export function performanceRuntimeSelection({baseline,qualification,currentIdentity,baselineExecutionReceipt,baselineExecutionQualification}){
 assert.equal(qualification.engineSha256,currentIdentity.sha256);
 assert.equal(qualification.baselineEngineSha256,baseline.engineIdentity.sha256);
 let baselineIdentity=baseline.engineIdentity;
 if(baselineExecutionReceipt!==undefined||baselineExecutionQualification!==undefined){
  assert.ok(baselineExecutionReceipt&&baselineExecutionQualification,'Both installed baseline receipts are required');
  const receipt=baselineExecutionReceipt,qualified=baselineExecutionQualification;
  for(const value of [receipt,qualified]){assert.equal(value.passed,true);assert.ok(Number.isFinite(Date.parse(value.completedAt)));assert.equal(value.full195RevisionEntrypointQualified,true);}
  assert.equal(qualified.revisions,195);assert.equal(qualified.workers,12);assert.equal(qualified.independentCompleteColumnLedgers,42);
  assert.equal(receipt.baselineEngineSha256,baseline.engineIdentity.sha256);
  assert.equal(qualified.baselineEngineSha256,baseline.engineIdentity.sha256);
  assert.equal(qualified.engineSha256,receipt.engineIdentity.sha256);
  assert.equal(historyRuntimeLayout(receipt.engineIdentity).kind,'installed-package');
  assert.deepEqual(historySourceIdentity(receipt.engineIdentity),historySourceIdentity(baseline.engineIdentity),'Installed baseline has a different qualified source ledger');
  assert.equal(receipt.corpusSha256,baseline.corpusSha256);assert.equal(receipt.profilesSha256,baseline.profilesSha256);
  baselineIdentity=receipt.engineIdentity;
 }
 return {baseline:baselineIdentity,current:currentIdentity};
}

/** Verify regular bytes and literal links in execution and source ledgers.
 * Counts come from the exact qualified ledgers, not a historical source count. */
export async function verifyPerformanceRuntimeFiles(identity,root,record=()=>{}){
 for(const ledger of historyRuntimeLedgers(identity,root)){
  assert.equal(await realpath(ledger.root),ledger.root);
  assert.equal(ledger.identity.sha256,createHash('sha256').update(JSON.stringify(ledger.identity.files)).digest('hex'));
  assert.equal(ledger.identity.node,process.version);assert.equal(ledger.identity.platform,process.platform);assert.equal(ledger.identity.architecture,process.arch);
  const names=new Set();
  for(const row of ledger.identity.files){
   names.add(row.file);const file=path.resolve(ledger.root,row.file);
   assert.ok(file.startsWith(ledger.root+path.sep));assert.equal(await realpath(file),file);assert.equal((await lstat(file)).isFile(),true);
   const digest=createHash('sha256');for await(const bytes of createReadStream(file))digest.update(bytes);
   assert.equal(digest.digest('hex'),row.sha256,'Frozen '+ledger.role+' runtime changed: '+row.file);record(file,row.sha256);
  }
  for(const link of ledger.identity.links??[]){
   assert.ok(link&&typeof link.file==='string'&&typeof link.target==='string');
   assert.ok(link.file.split('/').every(part=>part&&part!=='.'&&part!=='..')&&!link.file.includes('\\')&&!path.isAbsolute(link.file),'Invalid literal runtime link');
   assert.ok(!names.has(link.file),'Duplicate runtime file/link');names.add(link.file);
   const file=path.resolve(ledger.root,link.file);assert.ok(file.startsWith(ledger.root+path.sep));assert.equal(await realpath(path.dirname(file)),path.dirname(file));assert.equal((await lstat(file)).isSymbolicLink(),true);assert.equal(await readlink(file),link.target);
  }
 }
}
