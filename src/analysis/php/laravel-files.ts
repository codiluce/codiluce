import type {AnalysisContext, ScannedFile} from '../../core/analyzer.js';
import {ast, nodes, walk, type Ast, type ParsedFile} from '../../analyzers/php-ast.js';
import {bindingNode} from './binding-node.js';

/** Application passes retain indexed identities, never a map of original
 * text/trees. Each later use validates and hydrates through the shared provider. */
export class LaravelFiles {
  private readonly indexed=new Map<string,ScannedFile>();
  private readonly withoutFortify=new Set<string>();
  private reads=0;
  constructor(private readonly context:AnalysisContext){}
  register(file:ScannedFile,options:{mentionsFortify?:boolean}={}):void{
    this.indexed.set(file.path,file);
    if(options.mentionsFortify===false)this.withoutFortify.add(file.path);else this.withoutFortify.delete(file.path);
  }
  /** Only a negative check of an already validated original can skip this
   * pass. Unknown callers remain candidates; positive candidates revalidate
   * through get before reading any application declarations. */
  *fortifyFiles():IterableIterator<ScannedFile>{
    for(const file of this.indexed.values())if(!this.withoutFortify.has(file.path))yield file;
  }
  has(file:string):boolean{return this.indexed.has(file);}
  values():IterableIterator<ScannedFile>{return this.indexed.values();}
  retentionStats(){return {files:this.indexed.size,originalBytes:0,trees:0,reads:this.reads};}
  async get(file:string):Promise<ParsedFile|undefined>{
    const indexed=this.indexed.get(file);if(!indexed)return undefined;
    try{
      this.reads++;const source=await this.context.phpSources!.read(indexed);
      if(source.ast)return {file:indexed,ast:source.ast,content:source.content};
      throw Error(source.astGap??'Bounded indexed original PHP source is unavailable');
    }catch(error){
      this.context.graph.diagnose({analyzer:'php-laravel',severity:'error',code:'php-parse-error',file,entityId:indexed.id,reason:error instanceof Error?error.message:String(error)});
      return undefined;
    }
  }
}

/** Class catalog inputs: property/attribute values and callable signatures,
 * with no method bodies, comments, original strings or parser-owned nodes. */
export function laravelClassHeader(node:Ast):Ast {
  const known=new WeakMap<Ast,Ast>(),result=bindingNode(node,known);
  result.body=nodes(node.body).flatMap(item=>{
    if(item.kind==='method')return [bindingNode(item,known)];
    if(item.kind!=='propertystatement')return [];
    return [{kind:item.kind,loc:item.loc?{start:{...item.loc.start},end:{...item.loc.end}}:undefined,isStatic:item.isStatic,type:ast(item.type)?bindingNode(ast(item.type)!,known):undefined,
      properties:nodes(item.properties).map(property=>({...bindingNode(property,known),value:ast(property.value)?bindingNode(ast(property.value)!,known):undefined}))}];
  });
  result.attrGroups=nodes(node.attrGroups).map(group=>({kind:group.kind,attrs:nodes(group.attrs).map(attribute=>({...bindingNode(attribute,known),arguments:nodes(attribute.arguments).map(argument=>bindingNode(argument,known))}))}));
  return result;
}

export function originalPhpNode(parsed:ParsedFile,header:Ast):Ast|undefined {
  let found:Ast|undefined;
  walk(parsed.ast,node=>{if(node.kind===header.kind&&node.loc?.start.offset===header.loc?.start.offset&&node.loc?.end.offset===header.loc?.end.offset)found=node;});
  return found;
}
