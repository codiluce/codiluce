const median=values=>{const sorted=[...values].sort((a,b)=>a-b),middle=Math.floor(sorted.length/2);return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;};
const modes=['cold','population','warm'],labels=['baseline','current'];

export function qualifyProductionRuns(runs,ids,repetitions){
 const comparisons=[],parity=[];let complete=runs.length===ids.length*repetitions*6;
 for(const id of ids){
  const group=runs.filter(row=>row.id===id),keys=new Set();let valid=group.length===repetitions*6;
  for(const row of group){
   const key=row.label+':'+row.repetition+':'+row.mode;
   if(keys.has(key)||!labels.includes(row.label)||!modes.includes(row.mode)||!Number.isInteger(row.repetition)||row.repetition<0||row.repetition>=repetitions||row.status!=='complete'||!Number.isFinite(row.milliseconds)||row.milliseconds<=0||!Number.isSafeInteger(row.treePeakKiB)||row.treePeakKiB<=0||!Number.isSafeInteger(row.samples)||row.samples<=0||!/^([a-f\d]{64})$/.test(row.logical?.sha256??'')||row.contracts?.graphContractsVerified!==true)valid=false;
   if(!Array.isArray(row.cacheEvents)||row.mode==='cold'&&row.cacheEvents.length!==0||row.mode==='population'&&row.cacheEvents.length===0||row.mode==='warm'&&!row.cacheEvents.some(event=>event.analyzer==='git-metrics'&&event.hit===true))valid=false;
   keys.add(key);
  }
  const equal=valid&&group.every(row=>row.logical.sha256===group[0].logical.sha256);
  parity.push({id,complete:valid,equal});complete&&=valid;
  for(const mode of ['cold','warm']){
   const record={id,mode,complete:valid,passed:false};
   if(valid){
    for(const label of labels){const rows=group.filter(row=>row.mode===mode&&row.label===label);record[label]={milliseconds:median(rows.map(row=>row.milliseconds)),treePeakKiB:median(rows.map(row=>row.treePeakKiB))};}
    record.timeRatio=record.current.milliseconds/record.baseline.milliseconds;record.memoryRatio=record.current.treePeakKiB/record.baseline.treePeakKiB;record.passed=equal&&record.timeRatio<=1.1&&record.memoryRatio<=1.1;
   }
   comparisons.push(record);
  }
 }
 return {comparisons,allRepetitionParity:parity,passed:complete&&parity.every(row=>row.equal)&&comparisons.every(row=>row.passed)};
}
