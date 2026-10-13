import {fileURLToPath} from 'node:url';
import {Buffer} from 'node:buffer';
import type {AST} from 'svelte/compiler';
import {StructureParser} from '../tree-sitter/client.js';

export interface FrameworkParseFailure {message?:string;name?:string;display:string;position?:number[];start?:{character?:number}}
export interface FrameworkParseFacts {value?:unknown;failure?:FrameworkParseFailure}
export interface FrameworkParserLimits {maxJobs:number;maxSourceBytes:number}
export const FRAMEWORK_PARSER_LIMITS:Readonly<FrameworkParserLimits>=Object.freeze({maxJobs:64,maxSourceBytes:16*1024*1024});
class FrameworkTransport extends StructureParser<FrameworkParseFacts> {
  constructor(timeoutMs:number,worker:string){super(timeoutMs,worker,['--max-old-space-size=256']);}
  submit(language:'svelte'|'astro',content:string,file?:string){return this.request(`${language}-framework`,{language,content,file});}
}
class ReportedFrameworkError extends Error {
  readonly position?:number[];readonly start?:{character?:number};
  constructor(private readonly failure:FrameworkParseFailure){super(failure.message??failure.display);this.name=failure.name??'Error';this.position=failure.position;this.start=failure.start;}
  override toString(){return this.failure.display;}
}
/** Optional native/compiler libraries live only in the source worker. Its
 * generation retires after bounded jobs/input volume and before replacement.
 * These are ownership/lifetime limits, separately from AST or physical RSS. */
export class TemplateFrameworkParser {
  private readonly transport:FrameworkTransport;
  private pending:Promise<void>=Promise.resolve();private generation=0;private closing=0;
  private jobs=0;private bytes=0;private generations=0;private peakJobs=0;private peakSourceBytes=0;
  readonly limits:Readonly<FrameworkParserLimits>;
  constructor(limits:FrameworkParserLimits=FRAMEWORK_PARSER_LIMITS,timeoutMs=10_000,worker=fileURLToPath(new URL('./native-framework-worker.mjs',import.meta.url))){
    for(const n of [limits.maxJobs,limits.maxSourceBytes])if(!Number.isSafeInteger(n)||n<1)throw Error('Framework parser limits require positive safe integers');
    this.limits=Object.freeze({...limits});this.transport=new FrameworkTransport(timeoutMs,worker);
  }
  stats(){return {limits:this.limits,jobs:this.jobs,sourceBytes:this.bytes,generations:this.generations,peakJobs:this.peakJobs,peakSourceBytes:this.peakSourceBytes};}
  svelte(content:string,file:string):Promise<AST.Root>{return this.parse('svelte',content,file)as Promise<AST.Root>;}
  astro(content:string):Promise<ReturnType<typeof import('@astrojs/compiler-rs').parse>>{return this.parse('astro',content)as Promise<ReturnType<typeof import('@astrojs/compiler-rs').parse>>;}
  private async retire():Promise<void>{await this.transport.closeAndWait();this.jobs=0;this.bytes=0;}
  private parse(language:'svelte'|'astro',content:string,file?:string):Promise<unknown>{
    if(this.closing)return Promise.reject(Error('Framework parser is retiring'));
    const generation=this.generation,sourceBytes=Buffer.byteLength(content);
    const result=this.pending.then(async()=>{
      if(generation!==this.generation)throw Error('Framework parser request closed before dispatch');
      if(this.jobs&&(this.jobs>=this.limits.maxJobs||this.bytes+sourceBytes>this.limits.maxSourceBytes))await this.retire();
      if(generation!==this.generation)throw Error('Framework parser request closed before dispatch');
      if(!this.jobs)this.generations++;
      let facts:FrameworkParseFacts;
      try{facts=await this.transport.submit(language,content,file);}
      catch(error){await this.retire();throw error;}
      if(generation!==this.generation)throw Error('Framework parser request closed during dispatch');
      this.jobs++;this.bytes+=sourceBytes;this.peakJobs=Math.max(this.peakJobs,this.jobs);this.peakSourceBytes=Math.max(this.peakSourceBytes,this.bytes);
      if(this.jobs>=this.limits.maxJobs||this.bytes>=this.limits.maxSourceBytes)await this.retire();
      if(generation!==this.generation)throw Error('Framework parser request closed during retirement');
      if(facts.failure){await this.retire();throw new ReportedFrameworkError(facts.failure);}
      if(facts.value===undefined){await this.retire();throw Error('Invalid framework parser result');}
      return facts.value;
    });this.pending=result.then(()=>{},()=>{});return result;
  }
  async closeAndWait():Promise<void>{
    this.closing++;this.generation++;
    try{await this.transport.closeAndWait();await this.pending;this.jobs=0;this.bytes=0;}
    finally{this.closing--;}
  }
}
