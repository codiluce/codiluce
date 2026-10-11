import type {ChildProcess} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import type {StructureFacts} from '../facts.js';
import {StructureParser} from './client.js';
import {finishErb,finishRazor,finishLiquid} from './template-facts.js';

export function finishTemplateFacts(facts:StructureFacts):StructureFacts {
  return facts.erb?finishErb(facts):facts.razor?finishRazor(facts):facts.liquid?finishLiquid(facts):facts;
}

export function literalScriptTemplate(facts:StructureFacts):'erb'|'razor'|'liquid'|undefined {
  for(const template of ['erb','razor','liquid']as const){
    const syntax=facts[template];
    if(syntax&&(template==='erb'||!facts.truncated)&&syntax.host.regions.some(region=>region.kind==='script'&&region.supported&&region.language==='javascript'))return template;
  }
  return undefined;
}
/** Compiler parsing keeps the original worker deadline and heap budget. The
 * indexing pipeline runs this service only after its native grammar worker
 * has exited, so the active compiler heap and native WASM assets do not overlap.
 * Its source-free bootstrap may start during native extraction. */
export class TemplateScriptParser extends StructureParser {
  private readonly bootstrapped=new WeakSet<ChildProcess>();
  // The checked bundle needs no source TypeScript loader in either checkout or
  // installed package. Loading the optional compiler remains inside a job.
  constructor(timeoutMs=10_000){super(timeoutMs,fileURLToPath(new URL('./native-script-worker.mjs',import.meta.url)),['--max-old-space-size=256']);}
  /** Bootstrap imports contain no TypeScript compiler or target source. */
  prewarm():void {
    const child=this.start();
    if(!this.bootstrapped.has(child)){
      this.bootstrapped.add(child);
      // A spawn failure can arrive before any source job installs its error
      // handler. One observer per generation avoids per-file listener growth.
      child.once('error',()=>{});
    }
  }
  async finish(content:string,facts:StructureFacts):Promise<StructureFacts> {
    const template=literalScriptTemplate(facts);if(!template)return finishTemplateFacts(facts);
    return this.request(`${template}-literal-scripts`,{content,facts,template});
  }
}
