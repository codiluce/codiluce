import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {measureProductionWorker} from '../production-cache-measure.mjs';
import {qualifyProductionRuns} from '../production-cache-results.mjs';

function runs(){return Array.from({length:3},(_,repetition)=>['baseline','current'].flatMap(label=>['cold','population','warm'].map(mode=>({id:'source',label,repetition,mode,status:'complete',milliseconds:100,treePeakKiB:100,samples:3,logical:{sha256:'a'.repeat(64)},contracts:{graphContractsVerified:true},cacheEvents:mode==='cold'?[]:[{analyzer:'git-metrics',hit:mode==='warm'}]})))).flat();}
test('unmodified 10% gates use medians, and population results remain required',()=>{const rows=runs();for(const row of rows.filter(row=>row.label==='current')){row.milliseconds=110;row.treePeakKiB=110;}rows.find(row=>row.label==='current'&&row.mode==='cold').milliseconds=10000;assert.equal(qualifyProductionRuns(rows,['source'],3).passed,true);for(const row of rows.filter(row=>row.label==='current'))row.treePeakKiB=111;assert.equal(qualifyProductionRuns(rows,['source'],3).passed,false);});
test('one missing, failed, duplicated, unverified or invalid observation cannot qualify',()=>{
 for(const change of [rows=>rows.pop(),rows=>rows[0].status='failed',rows=>rows[1]={...rows[0]},rows=>rows[0].contracts.graphContractsVerified=false,rows=>rows[0].milliseconds=Infinity,rows=>rows[0].treePeakKiB=0,rows=>rows[0].samples=0,rows=>rows[0].logical.sha256='invalid']){const rows=runs();change(rows);assert.equal(qualifyProductionRuns(rows,['source'],3).passed,false);}
});
test('all graph fields must agree across populations, implementations and repetitions',()=>{for(const mode of ['cold','population','warm']){const rows=runs();for(const row of rows.filter(row=>row.repetition===1&&row.mode===mode))row.logical.sha256='b'.repeat(64);assert.equal(qualifyProductionRuns(rows,['source'],3).passed,false);}});
test('a cache-disabled revision run cannot masquerade as a warm replay',()=>{const rows=runs();for(const row of rows)row.cacheEvents=[];assert.equal(qualifyProductionRuns(rows,['source'],3).passed,false);});
test('fresh worker handshake excludes verification RSS and retains actual terminal failures',{skip:process.platform!=='linux'&&'This observer measures Linux /proc RSS; native package/history checks run separately'},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'codiluce-cache-observer-'));
 try{
  const worker=path.join(root,'owned-worker.mjs');await writeFile(worker,`import {readFileSync} from 'node:fs';
const mode=process.argv[2];
if(mode==='failed'){console.error('retained original failure');process.exit(7);}
const ack=type=>new Promise(resolve=>{const receive=m=>{if(m.type===type){process.off('message',receive);resolve();}};process.on('message',receive);process.send({type:type==='go'?'begin':'end'});});
await ack('go');const index=Buffer.alloc(128*1024*1024,1);await ack('digest-go');const verification=Buffer.alloc(384*1024*1024,2);
const hwm=Number(/^VmHWM:\\s*(\\d+)/m.exec(readFileSync('/proc/self/status','utf8'))[1]);
process.send({type:'result',result:{verificationHwm:hwm,marker:index[0]+verification[0]}},()=>process.disconnect());
`);
  const result=await measureProductionWorker({worker,request:'complete',log:path.join(root,'success.log'),cwd:process.cwd()});assert.equal(result.exitCode,0);assert.equal(result.marker,3);assert.ok(result.treePeakKiB>128*1024);assert.ok(result.verificationHwm-result.treePeakKiB>256*1024,'Verification memory must remain outside the sample boundary');
  const log=path.join(root,'failed.log');await assert.rejects(measureProductionWorker({worker,request:'failed',log,cwd:process.cwd()}),error=>error.worker.exitCode===7&&error.worker.ended===false);assert.match(await readFile(log,'utf8'),/retained original failure/);
 }finally{await rm(root,{recursive:true});}
});
