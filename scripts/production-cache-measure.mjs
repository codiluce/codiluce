import {spawn} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {finished} from 'node:stream/promises';
import {sampleProcessTreeRssKiB} from './process-memory.mjs';

// The parent observes synchronous index work. Verification starts only after
// the parent has taken its last sample and stopped the timer.
export async function measureProductionWorker({worker,request,log,cwd,env=process.env,pollMilliseconds=25,execArgv=['--experimental-sqlite','--import','tsx']}){
 const child=spawn(process.execPath,[...execArgv,worker,request],{cwd,env,stdio:['ignore','pipe','pipe','ipc']});
 const output=createWriteStream(log,{flags:'wx'}),sample={treePeakKiB:0,childPeakKiB:0,processes:0,samples:0,incompleteSamples:0};
 let timer,result,began=false,ended=false,failure;
 const poll=()=>{const value=sampleProcessTreeRssKiB(child.pid);sample.samples++;if(value.incomplete)sample.incompleteSamples++;if(value.available){sample.treePeakKiB=Math.max(sample.treePeakKiB,value.rssKiB);sample.childPeakKiB=Math.max(sample.childPeakKiB,value.childRssKiB);sample.processes=Math.max(sample.processes,value.processes);}};
 const stop=()=>{clearInterval(timer);timer=undefined;};
 const send=type=>child.send({type},error=>{if(error)failure??=error;});
 child.stdout.pipe(output,{end:false});child.stderr.pipe(output,{end:false});
 output.on('error',error=>{failure??=error;});
 child.on('error',error=>{failure??=error;});
 child.on('message',message=>{
  try{
   if(message?.type==='begin'){if(began||ended)throw Error('Duplicate or reversed measurement boundary');began=true;poll();timer=setInterval(poll,pollMilliseconds);send('go');}
   else if(message?.type==='end'){if(!began||ended)throw Error('Missing or duplicate measurement boundary');poll();stop();ended=true;send('digest-go');}
   else if(message?.type==='result'){if(!ended||result)throw Error('Result outside completed measurement');result=message.result;}
   else throw Error('Unknown production worker message');
  }catch(error){failure??=error;stop();child.disconnect();}
 });
 const terminal=await new Promise(resolve=>child.on('close',(exitCode,signal)=>resolve({exitCode,signal})));
 stop();output.end();try{await finished(output);}catch(error){failure??=error;}
 if(failure||terminal.exitCode!==0||!began||!ended||!result||!sample.samples||!sample.treePeakKiB){
  throw Object.assign(Error(failure?.message??'Production worker failed or lacks completed measurement'),{worker:{pid:child.pid,...terminal,sample,log,began,ended}});
 }
 return {...result,...sample,pid:child.pid,...terminal};
}
