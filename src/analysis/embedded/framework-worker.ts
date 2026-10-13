// Parse only original component syntax with Codiluce's own parser packages.
// Never compile a render program, resolve target imports or evaluate source.
import {serialize} from 'node:v8';
import type {FrameworkParseFailure,FrameworkParseFacts} from './framework-parser.js';
function reply(id:number,facts:FrameworkParseFacts):void {
  const payload=serialize({facts});
  process.send?.({id,type:'completed',completedAtNs:process.hrtime.bigint().toString(),bytes:payload.byteLength});
  process.send?.({id,type:'result',payload});
}
async function handle(job:{id:number;language:'svelte'|'astro';content:string;file?:string}):Promise<void>{
  try{
    if(job.language==='svelte'){
      const {parse}=await import('svelte/compiler');reply(job.id,{value:parse(job.content,{modern:true,filename:job.file})});
    }else if(job.language==='astro'){
      const {parse}=await import('@astrojs/compiler-rs');reply(job.id,{value:parse(job.content)});
    }else throw Error('Unknown framework parser language');
  }catch(error){
    const native=error as {message?:string;name?:string;position?:number[];start?:{character?:number}};
    const failure:FrameworkParseFailure={display:String(error),...typeof native?.message==='string'?{message:native.message}:{},...typeof native?.name==='string'?{name:native.name}:{},...native?.position?{position:native.position}:{},...native?.start?{start:native.start}:{}};
    reply(job.id,{failure});
  }
}
let pending=Promise.resolve();
process.on('message',(job:Parameters<typeof handle>[0])=>{pending=pending.then(()=>handle(job));});
process.once('disconnect',()=>process.exit(0));
