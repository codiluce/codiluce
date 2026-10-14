import {serialize} from 'node:v8';
process.on('message',({id,content})=>{
 const payload=serialize({facts:{pid:process.pid,source:'é😀\r\n',missing:undefined}});
 if(content==='oversized'){process.send({id,type:'completed',completedAtNs:process.hrtime.bigint().toString(),bytes:64*1024*1024+1});return;}
 const encoding=content==='unknown-encoding'?'owned-unknown':content==='changed-encoding'?'bounded-v1':undefined;
 process.send({id,type:'completed',completedAtNs:process.hrtime.bigint().toString(),bytes:payload.byteLength,...encoding?{encoding}:{}});
 process.send({id,type:'result',payload,...content==='unknown-encoding'?{encoding}:{}});
});
process.once('disconnect',()=>process.exit(0));
