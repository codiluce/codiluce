// Original literal JavaScript only. Never imports or evaluates target code,
// reads a target library, resolves a module or emits a render program.
import type {StructureFacts} from '../facts.js';
import {replyParserFrame,parserJob} from './frames.js';
import {extractLiteralScripts} from './erb-script.js';
import {finishErb,finishRazor,finishLiquid} from './template-facts.js';



async function handle(job:{id:number;content:string;facts:StructureFacts;template:'erb'|'razor'|'liquid'}):Promise<void> {
  try{
    const compiler=(await import('typescript')).default;
    extractLiteralScripts(compiler,job.content,job.facts,job.template);
    const facts=job.template==='erb'?finishErb(job.facts):job.template==='razor'?finishRazor(job.facts):finishLiquid(job.facts);
    replyParserFrame(job.id,{facts});
  }catch(error){replyParserFrame(job.id,{error:error instanceof Error?error.message:String(error)});}
}
let pending=Promise.resolve();
process.on('message',(message:Parameters<typeof parserJob>[0])=>{
 pending=pending.then(async()=>{try{await handle(parserJob(message) as Parameters<typeof handle>[0]);}catch(error){replyParserFrame(message.id,{error:error instanceof Error?error.message:String(error),fatal:true});}});
});
process.once('disconnect',()=>process.exit(0));
