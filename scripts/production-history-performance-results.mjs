import assert from 'node:assert/strict';

const median=values=>{const sorted=[...values].sort((a,b)=>a-b),middle=Math.floor(sorted.length/2);return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;};
const labels=['baseline','current'];

/** Complete repeated fresh-history work, rather than an instrumented
 * correctness run or an equal-count graph projection. No failed runs vanish. */
export function qualifyHistoryPerformance(runs,corpus,baseline,repetitions){
 assert.ok(Number.isSafeInteger(repetitions)&&repetitions>=3&&repetitions<=20);
 const comparisons=[];let complete=runs.length===corpus.repositories.length*repetitions*2;
 assert.equal(new Set(corpus.repositories.map(r=>r.id)).size,corpus.repositories.length);
 for(const specification of corpus.repositories){
  const selected=[...specification.revisions,...specification.extraRevisions].map(r=>r.commit),prior=baseline.repositories.find(r=>r.id===specification.id);assert.ok(prior);assert.equal(new Set(selected).size,selected.length);
  const group=runs.filter(r=>r.id===specification.id),keys=new Set();let valid=group.length===repetitions*2;
  for(const row of group){
   const key=row.label+':'+row.repetition;
   if(keys.has(key)||!labels.includes(row.label)||!Number.isSafeInteger(row.repetition)||row.repetition<0||row.repetition>=repetitions||row.status!=='complete'||!Number.isFinite(row.milliseconds)||row.milliseconds<=0||!Number.isSafeInteger(row.treePeakKiB)||row.treePeakKiB<=0||!Number.isSafeInteger(row.samples)||row.samples<=0||!Number.isSafeInteger(row.processes)||row.processes<3||row.exitCode!==0||row.signal!==null||row.columns?.passed!==true||row.columns.databaseSha256!==row.databaseSha256)valid=false;
   keys.add(key);
   if(!Array.isArray(row.revisions)||row.revisions.length!==selected.length||new Set(row.revisions.map(r=>r.commit)).size!==selected.length)valid=false;
   else for(const revision of row.revisions){
    const original=prior.revisions.find(r=>r.commit===revision.commit);
    if(!selected.includes(revision.commit)||!original||revision.status!=='verified'||revision.canonical?.sha256!==original.logical.sha256||revision.canonical.bytes!==original.logical.bytes||JSON.stringify(revision.volatileFields)!==JSON.stringify(['run.id','run.analyzedAt'])||JSON.stringify(revision.logical?.normalization)!=='[]')valid=false;
   }
  }
  const record={id:specification.id,revisions:selected.length,repetitions,complete:valid,passed:false};
  if(valid){
   for(const label of labels){const rows=group.filter(r=>r.label===label);record[label]={milliseconds:median(rows.map(r=>r.milliseconds)),treePeakKiB:median(rows.map(r=>r.treePeakKiB))};}
   record.timeRatio=record.current.milliseconds/record.baseline.milliseconds;record.memoryRatio=record.current.treePeakKiB/record.baseline.treePeakKiB;record.passed=record.timeRatio<=1.1&&record.memoryRatio<=1.1;
  }
  complete&&=valid;comparisons.push(record);
 }
 return {comparisons,complete,passed:complete&&comparisons.every(r=>r.passed)};
}
