import type { AnalysisContext, ScannedFile } from '../../core/analyzer.js';
import type { Ast } from '../../analyzers/php-ast.js';
import type { StructureFacts } from '../facts.js';
import { IndexedSources } from '../indexed-sources.js';
import { fileKey } from '../../pipeline/cache.js';
import { PhpParser } from './client.js';
import { PHP_PARSER_VERSION, PHP_SOURCE_PROFILE, PHP_SOURCE_PROVIDER_VERSION, PHP_STRUCTURE_VERSION } from './version.js';
import {PhpResidency,PhpInputAdmission,type ResidencyLimits,type PhpInputLimits} from './residency.js';

export interface PhpSource { content:string; facts:StructureFacts; ast?:Ast; astBytes:number; astGap?:string }
export interface PhpSourceBudgets {residency?:ResidencyLimits;input?:PhpInputLimits}
/** One indexed original-source parse for structure, binding and Laravel.
 * Cache hits still validate the scanned source before replay. Native trees
 * remain service data and never become graph metadata or executable code. */
export class PhpSources {
  private readonly parser=new PhpParser();
  private readonly units:PhpResidency<PhpSource>;
  private readonly admission:PhpInputAdmission;
  private readonly qualified=new Set<string>();
  private readonly pending=new Map<string,Promise<PhpSource>>();
  private preparation?:Promise<void>;
  private released=false;
  readonly failures=new Map<string,string>();
  private readonly sources:IndexedSources;
  // Units already own their original text. Revalidation reads must not keep
  // a second, independently decoded copy in the resolver's text memo.
  constructor(private readonly context:AnalysisContext,budgets:PhpSourceBudgets={}) {
    this.sources=new IndexedSources(context,{maxBytes:0});this.units=new PhpResidency(budgets.residency);this.admission=new PhpInputAdmission(budgets.input);
  }
  get(file:string):PhpSource|undefined {return this.units.get(file);}
  hasQualified(file:string):boolean{return !this.released&&this.qualified.has(file);}
  residencyStats(){return {units:this.units.stats(),input:this.admission.stats()};}
  /** Keep a small bounded queue in flight while other language services work.
   * Each worker parses synchronously; original extraction stays on the parent.
   * Preparation catches per-file failures, which consumers report explicitly. */
  prepare(files:ScannedFile[]):void {
    if(this.preparation)return;
    this.preparation=(async()=>{
      let cursor=0;
      const next=async()=>{while(!this.released&&cursor<files.length){const file=files[cursor++]!;try{await this.read(file);}catch{/* Reported by the consuming analyzer. */}}};
      return Promise.all(Array.from({length:this.admission.limits.maxJobs},next)).then(()=>{});
    })();
  }
  async prepared():Promise<void>{await this.preparation;}
  async read(file:ScannedFile):Promise<PhpSource> {
    if(this.released)throw Error('PHP source service has been released');
    const scannedBytes=this.context.graph.entities.get(file.id)?.metadata.bytes;
    const done=await this.admission.acquire(typeof scannedBytes==='number'&&Number.isSafeInteger(scannedBytes)&&scannedBytes>=0?scannedBytes:this.context.config.maxFileBytes);
    try {
    if(this.released)throw Error('PHP source service has been released');
    let content:string;
    try {content=this.sources.readText(file.path,{revalidate:true});}
    catch(error){this.units.forget(file.path);this.qualified.delete(file.path);this.failures.set(file.path,error instanceof Error?error.message:String(error));throw error;}
    const known=this.units.get(file.path);if(known&&known.content===content)return known;
    if(known){this.units.forget(file.path);this.qualified.delete(file.path);}
    const pending=this.pending.get(file.path);if(pending)return await pending;
    const failure=this.failures.get(file.path);if(failure)throw Error(failure);
    const compute=async()=>{
      try {
        const parse=()=>this.parser.parseUnit(content);
        const unit=this.context.cache?await this.context.cache.value('php-syntax-facts',file.path,{version:PHP_STRUCTURE_VERSION,provider:PHP_SOURCE_PROVIDER_VERSION,file:fileKey(this.context,file.path),parser:{name:'php-parser',version:PHP_PARSER_VERSION},profile:PHP_SOURCE_PROFILE},parse):await parse();
        if(this.released)throw Error('PHP source service has been released');
        const {phpAst,phpAstBytes,phpAstGap,...facts}=unit;
        if(!facts.php||phpAst&&phpAst.kind!=='program')throw Error('Invalid PHP native source-unit payload');
        const result:PhpSource={content,facts,ast:phpAst,astBytes:phpAstBytes??0,astGap:phpAstGap};this.failures.delete(file.path);
        // Twice the native serialized representation (including its original
        // token payload) plus UTF-16 text/key payload. Facts have their own
        // shared semantic lifetime; decoded AST object overhead is not RSS.
        const astCost=phpAst?(typeof phpAstBytes==='number'&&Number.isSafeInteger(phpAstBytes)&&phpAstBytes>0?phpAstBytes:Buffer.byteLength(JSON.stringify(phpAst))):0;
        this.units.put(file.path,result,2*(astCost+content.length+file.path.length));
        if(phpAst&&!facts.truncated&&!facts.issues.some(issue=>issue.code==='php-original-token-gap'))this.qualified.add(file.path);else this.qualified.delete(file.path);
        return result;
      }catch(error){if(!this.released){this.qualified.delete(file.path);this.failures.set(file.path,error instanceof Error?error.message:String(error));}throw error;}
      finally{this.pending.delete(file.path);}
    };
    const promise=compute();this.pending.set(file.path,promise);return await promise;
    }finally{done();}
  }
  closeParser():void {this.parser.close();}
  release():void {this.released=true;this.admission.close();this.closeParser();try{this.units.clear();}finally{this.pending.clear();this.qualified.clear();this.failures.clear();}}
  /** Index completion must prove every retired parser address space exited. */
  async releaseAndWait():Promise<void> {try{this.release();}finally{await this.parser.closeAndWait();}}
}
