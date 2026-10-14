import {serialize} from 'node:v8';
process.on('message',({id,content})=>{
 const response=content==='ordinary'?{error:'Owned ordinary source error'}:content==='fatal'?{error:'Owned fatal parser error',fatal:true}:content==='invalid'?{error:'Owned source error',fatal:'yes'}:content==='invalid-facts'?{facts:{pid:process.pid},fatal:true}:{facts:{pid:process.pid}};
 const payload=serialize(response);
 process.send({id,type:'completed',completedAtNs:process.hrtime.bigint().toString(),bytes:payload.byteLength});
 process.send({id,type:'result',payload});
});
process.once('disconnect',()=>process.exit(0));
