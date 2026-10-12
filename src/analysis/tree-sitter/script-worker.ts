// Original literal JavaScript only. Never imports or evaluates target code,
// reads a target library, resolves a module or emits a render program.
import type {StructureFacts} from '../facts.js';
import {serialize} from 'node:v8';
import {extractLiteralScripts} from './erb-script.js';
import {finishErb,finishRazor,finishLiquid} from './template-facts.js';

function reply(id:number,response:{facts?:StructureFacts;error?:string}):void {
  const payload=serialize(response);
  process.send?.({id,type:'completed',completedAtNs:process.hrtime.bigint().toString(),bytes:payload.byteLength});
  process.send?.({id,type:'result',payload});
}

async function handle(job:{id:number;content:string;facts:StructureFacts;template:'erb'|'razor'|'liquid'}):Promise<void> {
  try{
    const compiler=(await import('typescript')).default;
    extractLiteralScripts(compiler,job.content,job.facts,job.template);
    const facts=job.template==='erb'?finishErb(job.facts):job.template==='razor'?finishRazor(job.facts):finishLiquid(job.facts);
    reply(job.id,{facts});
  }catch(error){reply(job.id,{error:error instanceof Error?error.message:String(error)});}
}
let pending=Promise.resolve();
process.on('message',(job:Parameters<typeof handle>[0])=>{pending=pending.then(()=>handle(job));});
process.once('disconnect',()=>process.exit(0));
