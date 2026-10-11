import type { AnalysisContext, ScannedFile } from '../../core/analyzer.js';
import type { Ast } from '../../analyzers/php-ast.js';
import type { StructureFacts } from '../facts.js';
import { IndexedSources } from '../indexed-sources.js';
import { fileKey } from '../../pipeline/cache.js';
import { PhpParser } from './client.js';
import { PHP_PARSER_VERSION, PHP_SOURCE_PROFILE, PHP_SOURCE_PROVIDER_VERSION, PHP_STRUCTURE_VERSION } from './version.js';

export interface PhpSource { content:string; facts:StructureFacts; ast?:Ast; astBytes:number; astGap?:string }
/** One indexed original-source parse for structure, binding and Laravel.
 * Cache hits still validate the scanned source before replay. Native trees
 * remain service data and never become graph metadata or executable code. */
export class PhpSources {
  private readonly parser=new PhpParser();
  private readonly units=new Map<string,PhpSource>();
  private readonly pending=new Map<string,Promise<PhpSource>>();
  private preparation?:Promise<void>;
  private released=false;
  readonly failures=new Map<string,string>();
  private readonly sources:IndexedSources;
  constructor(private readonly context:AnalysisContext) {this.sources=new IndexedSources(context);}
  get(file:string):PhpSource|undefined {return this.units.get(file);}
  /** Keep a small bounded queue in flight while other language services work.
   * Each worker parses synchronously; original extraction stays on the parent.
   * Preparation catches per-file failures, which consumers report explicitly. */
  prepare(files:ScannedFile[]):void {
    if(this.preparation)return;
    this.preparation=(async()=>{
      let cursor=0;
      const next=async()=>{while(!this.released&&cursor<files.length){const file=files[cursor++]!;try{await this.read(file);}catch{/* Reported by the consuming analyzer. */}}};
      return Promise.all(Array.from({length:6},next)).then(()=>{});
    })();
  }
  async prepared():Promise<void>{await this.preparation;}
  async read(file:ScannedFile):Promise<PhpSource> {
    if(this.released)throw Error('PHP source service has been released');
    let content:string;
    try {content=this.sources.readText(file.path,{revalidate:true});}
    catch(error){this.units.delete(file.path);this.failures.set(file.path,error instanceof Error?error.message:String(error));throw error;}
    const known=this.units.get(file.path);if(known)return known;
    const pending=this.pending.get(file.path);if(pending)return pending;
    const failure=this.failures.get(file.path);if(failure)throw Error(failure);
    const compute=async()=>{
      try {
        const parse=()=>this.parser.parseUnit(content);
        const unit=this.context.cache?await this.context.cache.value('php-syntax-facts',file.path,{version:PHP_STRUCTURE_VERSION,provider:PHP_SOURCE_PROVIDER_VERSION,file:fileKey(this.context,file.path),parser:{name:'php-parser',version:PHP_PARSER_VERSION},profile:PHP_SOURCE_PROFILE},parse):await parse();
        if(this.released)throw Error('PHP source service has been released');
        const {phpAst,phpAstBytes,phpAstGap,...facts}=unit;
        if(!facts.php||phpAst&&phpAst.kind!=='program')throw Error('Invalid PHP native source-unit payload');
        const result:PhpSource={content,facts,ast:phpAst,astBytes:phpAstBytes??0,astGap:phpAstGap};this.failures.delete(file.path);this.units.set(file.path,result);return result;
      }catch(error){if(!this.released)this.failures.set(file.path,error instanceof Error?error.message:String(error));throw error;}
      finally{this.pending.delete(file.path);}
    };
    const promise=compute();this.pending.set(file.path,promise);return promise;
  }
  closeParser():void {this.parser.close();}
  release():void {this.released=true;this.closeParser();this.units.clear();this.pending.clear();this.failures.clear();}
}
