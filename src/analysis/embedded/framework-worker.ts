// Parse only original component syntax with Codiluce's own parser packages.
// Never compile a render program, resolve target imports or evaluate source.
import {replyParserFrame,parserJob} from '../tree-sitter/frames.js';
import type {FrameworkParseFailure,FrameworkParseFacts} from './framework-parser.js';
function reply(id:number,facts:FrameworkParseFacts):void {replyParserFrame(id,{facts});}
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
process.on('message',(message:Parameters<typeof parserJob>[0])=>{
  pending=pending.then(async()=>{try{await handle(parserJob(message) as Parameters<typeof handle>[0]);}catch(error){replyParserFrame(message.id,{error:error instanceof Error?error.message:String(error),fatal:true});}});
});
process.once('disconnect',()=>process.exit(0));
