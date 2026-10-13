// Compare declared runtime ledgers without conflating engine growth with target
// input changes. Actual file-byte/alias verification remains the observer's job.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

function ledger(identity){
 assert.ok(identity&&Array.isArray(identity.files)&&identity.files.length,'Missing runtime input ledger');
 const files=new Map();
 for(const row of identity.files){
  assert.ok(row&&typeof row.file==='string'&&row.file.length,'Missing runtime input path');
  assert.ok(!row.file.includes('\\')&&!row.file.startsWith('/')&&!row.file.split('/').some(part=>!part||part==='.'||part==='..'),'Runtime input path must be relative and canonical');
  assert.match(row.sha256,/^[a-f\d]{64}$/,'Invalid runtime input byte digest');
  assert.ok(!files.has(row.file),'Duplicate runtime input path');files.set(row.file,row.sha256);
 }
 assert.equal(createHash('sha256').update(JSON.stringify(identity.files)).digest('hex'),identity.sha256,'Runtime input ledger identity differs');
 return files;
}

export function compareHistoryRuntimeInputs(candidate,baseline){
 const current=ledger(candidate),previous=ledger(baseline);
 for(const file of previous.keys())assert.ok(current.has(file),'Candidate runtime omitted baseline input: '+file);
 const added=[...current.keys()].filter(file=>!previous.has(file)).sort();
 const changed=[...previous.keys()].filter(file=>current.get(file)!==previous.get(file)).sort();
 return {baselineSha256:baseline.sha256,candidateSha256:candidate.sha256,baselineInputs:previous.size,candidateInputs:current.size,added,changed,retainedBaselineInputs:true};
}
