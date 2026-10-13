import {serialize} from 'node:v8';
function reply(id,facts){const payload=serialize({facts});process.send?.({id,type:'completed',completedAtNs:process.hrtime.bigint().toString(),bytes:payload.length});process.send?.({id,type:'result',payload});}
process.on('message',async job=>{if(job.content==='hang')await new Promise(r=>setTimeout(r,2000));reply(job.id,{value:{original:job.content,language:job.language}});});
process.once('disconnect',()=>process.exit(0));
