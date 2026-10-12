// Codiluce's authored IPC fixture. It never imports or executes target input.
import {serialize} from 'node:v8';
function reply(id,response,options={}) {
  const payload=options.badPayload?Buffer.from('invalid owned encoding'):serialize(response);
  const completed={id,type:'completed',completedAtNs:options.badClock?'not-a-clock':process.hrtime.bigint().toString(),bytes:payload.byteLength+(options.badSize?1:0)};
  if(!options.missingCompletion)process.send?.(completed);
  if(options.duplicateCompletion)process.send?.(completed);
  if(options.noPayload)return;
  if(options.delayPayload)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,options.delayPayload);
  process.send?.({id,type:'result',payload});
}
process.on('message', job => {
  const options = JSON.parse(job.content);
  process.send?.({id: -1, kind: 'started', job: job.language, pid: process.pid});
  if (options.exit) process.exit(7);
  if (options.delay) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, options.delay);
  if (options.error) reply(job.id,{error:'Owned source error'},options);
  else reply(job.id,{facts:{declarations:[],issues:[],truncated:false,
    original:job.content,language:job.language,pid:process.pid,payload:'x'.repeat(options.bytes??0)}},options);
});
