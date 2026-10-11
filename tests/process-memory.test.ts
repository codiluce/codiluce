import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync,mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {parseProcessPeakRssKiB,processPeakRssKiB,sampleProcessTreeRssKiB} from '../scripts/process-memory.mjs';

test('process tree sampling includes children of every thread and counts repeated descendants once',()=>{
 const root=mkdtempSync(path.join(tmpdir(),'codiluce-proc-test-'));
 const process=(pid:number,rss:number,threads:Record<number,string>)=>{mkdirSync(path.join(root,String(pid),'task'),{recursive:true});writeFileSync(path.join(root,String(pid),'status'),`VmRSS: ${rss} kB\n`);for(const [tid,children]of Object.entries(threads)){mkdirSync(path.join(root,String(pid),'task',tid));writeFileSync(path.join(root,String(pid),'task',tid,'children'),children);}};
 try{
  process(10,100,{10:'20',11:'30 20'});process(20,200,{20:'40'});process(30,300,{30:'40'});process(40,400,{40:'10'});
  const sample=sampleProcessTreeRssKiB(10,root);assert.equal(sample.rssKiB,1000);assert.equal(sample.childRssKiB,900);assert.equal(sample.processes,4);assert.equal(sample.incomplete,false);assert.deepEqual(sample.pids.sort((a,b)=>a-b),[10,20,30,40]);
  writeFileSync(path.join(root,'30/task/30/children'),'50');assert.equal(sampleProcessTreeRssKiB(10,root).incomplete,true);
  const missing=sampleProcessTreeRssKiB(99,root);assert.equal(missing.available,false);assert.equal(missing.rssKiB,0);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('live Linux sampler includes the current process with a finite resident sample',{skip:process.platform!=='linux'},()=>{
 const sample=sampleProcessTreeRssKiB(process.pid);assert.ok(sample.available);assert.ok(sample.pids.includes(process.pid));assert.ok(sample.rssKiB>0);assert.ok(sample.childRssKiB>=0);
 for(const pid of [0,-1,1.5,NaN])assert.throws(()=>sampleProcessTreeRssKiB(pid),/positive safe integer/);
});

test('Peak RSS requires an explicit positive Linux VmHWM in kB and never guesses from other counters',()=>{
 assert.equal(parseProcessPeakRssKiB('VmPeak: 700000 kB\nVmHWM:\t 123456 kB\nVmRSS: 123000 kB\n'),123456);
 for(const status of ['VmRSS: 123 kB','VmHWM: 0 kB','VmHWM: -1 kB','VmHWM: 1 MB','VmHWM: 123unknown kB','VmHWM: 9007199254740993 kB'])assert.throws(()=>parseProcessPeakRssKiB(status),/missing or invalid/);
});
test('Linux process peak reflects its own resident allocations', {skip:process.platform!=='linux'},()=>{
 const before=processPeakRssKiB(),buffer=Buffer.alloc(32*1024*1024,1),after=processPeakRssKiB();assert.equal(buffer[buffer.length-1],1);assert.ok(after>=before);assert.ok(after*1024>=process.memoryUsage().rss-8*1024*1024);assert.ok(after>=parseProcessPeakRssKiB(readFileSync('/proc/self/status','utf8'))-8192);
});
test('A fresh child excludes a large retained parent peak even if getrusage inherits it', {skip:process.platform!=='linux'},()=>{
 const buffer=Buffer.alloc(128*1024*1024,1),parentRssKiB=process.memoryUsage().rss/1024;
 const code=`import {processPeakRssKiB} from ${JSON.stringify(new URL('../scripts/process-memory.mjs',import.meta.url).href)};import {readFileSync} from 'node:fs';console.log(JSON.stringify({peakKiB:processPeakRssKiB(),legacyKiB:process.resourceUsage().maxRSS,status:readFileSync('/proc/self/status','utf8')}));`;
 const child=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',timeout:30000}));assert.equal(buffer[buffer.length-1],1);assert.ok(child.peakKiB<parentRssKiB-64*1024,'The child cannot inherit its parent allocation as its own resident peak');assert.ok(child.peakKiB>=parseProcessPeakRssKiB(child.status)-8192);assert.ok(child.legacyKiB>=child.peakKiB-8192);
});
