// Owned transport fault controls. This file is never selected by target configuration.
import {deserialize,serialize,getHeapStatistics} from 'node:v8';
import {fork} from 'node:child_process';
if(process.argv.includes('--child'))setInterval(()=>{},1000);
else process.once('message',message=>{
 const request=deserialize(message),mode=request.context.config.repository.name;
 const result={protocol:3,patch:{entities:[],patches:[],relations:[],merged:[],diagnostics:[],http:[]},typescriptFiles:[],sourceReads:[],sourceFailures:[],cacheEvents:[],usage:{pid:process.pid,heapLimitBytes:getHeapStatistics().heap_size_limit,heapUsedBytes:process.memoryUsage().heapUsed,maxRssKiB:process.resourceUsage().maxRSS}};
 const finish=code=>{process.exitCode=code;process.disconnect();};
 if(mode==='unexpected-exit'){process.exit(17);}
 if(mode==='owner-hang'){setInterval(()=>{},1000);return;}
 if(mode==='owned-child-fatal-exit'){
  const child=fork(new URL(import.meta.url),['--child'],{execArgv:[],stdio:['ignore','ignore','ignore','ipc']});
  process.stderr.write(`owned-child-pid:${child.pid}\n`);
  process.send({type:'child-started',pid:child.pid},()=>{process.exit(19);});return;
 }
 if(mode==='wrong-protocol')result.protocol=99;
 if(mode==='oversized-response'){process.send(Buffer.alloc(message.length+2),()=>finish(0));return;}
 const body=serialize(result);
 if(mode==='duplicate-response'){process.send(body);process.send(body,()=>finish(0));return;}
 process.send(body,()=>{if(mode==='delayed-exit')setTimeout(()=>finish(0),75);else finish(mode==='result-then-nonzero'?23:0);});
});
