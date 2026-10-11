import {readFileSync,readdirSync} from 'node:fs';

/** Linux's per-address-space high-water mark, reset on exec. getrusage's
 * ru_maxrss can retain a pre-exec image containing memory from the launcher. */
export function parseProcessPeakRssKiB(status) {
 const match=/^VmHWM:\s*(\d+)\s+kB\s*$/m.exec(status),value=match&&Number(match[1]);
 if(!Number.isSafeInteger(value)||value<=0)throw Error('Linux process VmHWM missing or invalid; refusing an inherited RSS fallback');
 return value;
}
export function processPeakRssKiB() {
 if(process.platform!=='linux')throw Error('Process peak RSS qualification currently requires Linux /proc; native platform readers remain a release gate');
 return parseProcessPeakRssKiB(readFileSync('/proc/self/status','utf8'));
}

/** An external sampler can observe synchronous indexer work and all parser /
 * history children. Read every thread's children: Node can fork from a worker
 * thread, whose children are absent from task/<leader>/children. RSS is summed
 * at one polling instant; shared pages may be counted more than once and short
 * peaks or processes between polls can be missed. Exits never fabricate RSS. */
export function sampleProcessTreeRssKiB(pid,procRoot='/proc') {
 if(!Number.isSafeInteger(pid)||pid<=0)throw Error('Process PID must be a positive safe integer');
 const seen=new Set(),pids=[];
 let incomplete=false,parentKiB=0;
 function visit(current) {
  if(seen.has(current))return 0;seen.add(current);
  const base=`${procRoot}/${current}`;
  let status;
  try{status=readFileSync(`${base}/status`,'utf8');}catch{incomplete=true;return 0;}
  const match=/^VmRSS:\s*(\d+)\s+kB\s*$/m.exec(status),own=match?Number(match[1]):0;
  if(!Number.isSafeInteger(own)||own<0){incomplete=true;return 0;}
  if(current===pid)parentKiB=own;
  // Zombies have no resident address space; they can still have a readable
  // status while their parent is collecting them.
  if(!match&&!/^State:\s*Z\b/m.test(status))incomplete=true;
  pids.push(current);
  const children=new Set();
  try{
   for(const thread of readdirSync(`${base}/task`).filter(name=>/^\d+$/.test(name))) {
    try{for(const child of readFileSync(`${base}/task/${thread}/children`,'utf8').trim().split(/\s+/)){if(!child)continue;const childPid=Number(child);if(Number.isSafeInteger(childPid)&&childPid>0)children.add(childPid);else incomplete=true;}}
    catch{incomplete=true;}
   }
  }catch{incomplete=true;}
  let rss=own;for(const child of children)rss+=visit(child);return rss;
 }
 const rssKiB=visit(pid),available=pids.includes(pid);
 return {available,rssKiB,childRssKiB:Math.max(0,rssKiB-parentKiB),processes:pids.length,incomplete,pids};
}
