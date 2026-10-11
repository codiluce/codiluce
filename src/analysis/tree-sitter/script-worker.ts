// Original literal JavaScript only. Never imports or evaluates target code,
// reads a target library, resolves a module or emits a render program.
import type {StructureFacts} from '../facts.js';
import {extractLiteralScripts} from './erb-script.js';
import {finishErb,finishRazor,finishLiquid} from './template-facts.js';

async function handle(job:{id:number;content:string;facts:StructureFacts;template:'erb'|'razor'|'liquid'}):Promise<void> {
  try{
    const compiler=(await import('typescript')).default;
    extractLiteralScripts(compiler,job.content,job.facts,job.template);
    const facts=job.template==='erb'?finishErb(job.facts):job.template==='razor'?finishRazor(job.facts):finishLiquid(job.facts);
    process.send?.({id:job.id,facts});
  }catch(error){process.send?.({id:job.id,error:error instanceof Error?error.message:String(error)});}
}
let pending=Promise.resolve();
process.on('message',(job:Parameters<typeof handle>[0])=>{pending=pending.then(()=>handle(job));});
process.once('disconnect',()=>process.exit(0));
