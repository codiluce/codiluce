import type { AnalysisContext, Analyzer, ScannedFile } from '../../core/analyzer.js';
import { ANALYZER_VERSION, evidence, type Evidence, type RelationType, type SourceRange } from '../../core/graph.js';
import { ast, name, nodes, type Ast } from '../../analyzers/php-ast.js';
import { fileAnalysis, type DeclarationFact, type ImportOutcome, type PhpImportFact } from '../facts.js';
import { PhpResolver } from '../resolution/php.js';
import { SourceText } from '../source-map.js';
import {bindingNode} from '../php/binding-node.js';
import type {PhpSource} from '../php/sources.js';

export const PHP_SYMBOL_VERSION=`${ANALYZER_VERSION}:php-source-binding:2`;
const fold=(value:string)=>value.replace(/[A-Z]/g,c=>c.toLowerCase());
const TYPE_KINDS=['class','interface','trait','enum'];
interface Definition {id:string;fact:DeclarationFact;node:Ast;unit:Unit;frame:Frame;type?:Ast;detached?:boolean}
interface Write {node:Ast;frame:Frame;value?:Ast;start:number;conditional:boolean;unsafe:boolean}
interface Variable {parameter?:Ast;writes:Write[];capture?:{frame:Frame;name:string;start:number;byref:boolean}}
interface Frame {key:string;kind:'file'|'namespace'|'type'|'function'|'closure'|'arrow';unit:Unit;namespace:string;importScope:string;owner?:string;definition?:Definition;cls?:Definition;thisClass?:Definition;parent?:Frame;variables:Map<string,Variable>;dynamic?:string}
interface Site {node:Ast;frame:Frame;kind:string;range:SourceRange;expression:string}
interface Unit {file:ScannedFile;definitions:Definition[];frames:Frame[];sites:Site[];work:number;gap?:string}
type Value=
 | {kind:'instance'|'class';definition:Definition;exact:boolean;nullable?:boolean;proof:Evidence[]}
 | {kind:'callable';definition:Definition;nominal?:boolean;proof:Evidence[]}
 | {kind:'gap';status:'unresolved'|'unsupported'|'ambiguous'|'external';reason:string;candidates?:string[];proof:Evidence[]};
const gap=(reason:string,proof:Evidence[]=[],status:Extract<Value,{kind:'gap'}>['status']='unsupported',candidates?:string[]):Value=>({kind:'gap',reason,proof,status,candidates});

/** Binding of original source declarations, never target PHP execution. PHP
 * variables live in callable scopes; namespaces only select name import tables.
 * Direct calls and nominal type references have distinct graph edge types. */
export class PhpSymbols {
  private readonly files=new Map<string,ScannedFile>();
  private active?:Unit;
  private totalSites=0;private totalExpressionBytes=0;private peakUnits=0;
  private readonly definitions=new Map<string,Definition>();
  private readonly boundClosures=new Map<string,Definition>();
  private readonly applicationTypes=new Map<string,Definition[]>();
  private readonly qualifiedNames=new Map<string,Value>();
  private readonly methods=new Map<string,Map<string,Definition[]>>();
  private readonly properties=new Map<string,Map<string,Definition[]>>();
  private peakOriginalBytes=0;
  constructor(private readonly context:AnalysisContext,private readonly resolver:PhpResolver){}
  /** Numeric ownership evidence only; never included in semantic graphs. */
  sourceRetentionStats(){return {units:this.files.size,sites:this.totalSites,originalBytes:0,expressionBytes:this.totalExpressionBytes,peakOriginalBytes:this.peakOriginalBytes,activeUnits:this.active?1:0,peakUnits:this.peakUnits,catalogDefinitions:this.definitions.size};}
  private closureKey(file:string,node:Ast){return JSON.stringify([file,node.kind,node.loc?.start.offset,node.loc?.end.offset]);}
  private async source(file:ScannedFile):Promise<PhpSource|undefined>{
    try{return await this.context.phpSources?.read(file);}
    catch(error){
      const reason=error instanceof Error?error.message:String(error),analysis=fileAnalysis(this.context.graph.entities.get(file.id)!.metadata.analysis);
      this.context.syntax?.delete(file.path);if(analysis)analysis.features.references={status:'failed',reason};
      this.context.graph.diagnose({analyzer:'php-symbols',severity:'warning',code:'php-binding-source-unavailable',file:file.path,entityId:file.id,reason});return undefined;
    }
  }
  async prepare():Promise<void> {
    for(const file of this.context.files.values()) {
      if(file.language!=='php'||!file.analyzable)continue;
      // Source availability and catalog construction share one validated read.
      // Unavailable/truncated inputs still retain their explicit outcomes; a
      // later emission read independently validates the original body again.
      const source=await this.source(file);
      if(!source?.ast){
        const analysis=fileAnalysis(this.context.graph.entities.get(file.id)!.metadata.analysis);
        if(analysis&&(source||analysis.features.references.status!=='failed'))analysis.features.references={status:'failed',reason:source?.astGap??'Qualified original PHP source tree is unavailable'};
        continue;
      }
      const syntax=this.context.syntax?.get(file.path);
      if(!syntax?.facts.php||syntax.facts.truncated)continue;
      const unit=this.unit(file,source,true);this.files.set(file.path,file);
      // The cross-file catalog owns signatures and lexical name context only.
      // Frames in this catalog cannot reach a unit's sites, writes or AST body.
      const stub:Unit={file,definitions:[],frames:[],sites:[],work:0},known=new WeakMap<Ast,Ast>();
      for(const definition of unit.definitions){
        definition.node=bindingNode(definition.node,known);if(definition.type)definition.type=bindingNode(definition.type,known);
        definition.detached=true;
        definition.unit=stub;
        definition.frame={...definition.frame,unit:stub,parent:undefined,variables:new Map()};
      }
    }
    for(const definition of this.definitions.values()) {
      const parent=definition.fact.parent?this.context.syntax?.get(definition.unit.file.path)?.declarations.get(definition.fact.parent):undefined;
      if(!parent)continue;
      const catalog=['method','constructor','destructor'].includes(definition.fact.kind)?this.methods:['property','promoted-property','class-constant','enum-case'].includes(definition.fact.kind)?this.properties:undefined;
      if(catalog){const entries=catalog.get(parent)??new Map(),key=catalog===this.methods?fold(definition.fact.name):definition.fact.name;entries.set(key,[...entries.get(key)??[],definition]);catalog.set(parent,entries);}
    }
  }
  private unit(file:ScannedFile,source:PhpSource,catalog:boolean):Unit {
      if(!source.ast)throw Error('Qualified PHP binding tree is unavailable');
      const syntax=this.context.syntax!.get(file.path)!;
      const original=catalog?undefined:new SourceText(source.content);this.peakOriginalBytes=Math.max(this.peakOriginalBytes,2*source.content.length);
      const unit:Unit={file,definitions:[],frames:[],sites:[],work:0};
      // Catalog traversal needs only ancestors of exact original declaration
      // names. A callable's enclosing end offset also covers its body, so end
      // offsets alone would keep every unrelated expression in that body.
      const declarationNames=catalog?syntax.facts.declarations.map(fact=>fact.nameEnd).sort((a,b)=>a-b):[];
      const hasDeclaration=(node:Ast):boolean=>{
        if(!node.loc)return true;
        let low=0,high=declarationNames.length;
        while(low<high){const middle=(low+high)>>>1;if(declarationNames[middle]!<=node.loc.start.offset)low=middle+1;else high=middle;}
        return low<declarationNames.length&&declarationNames[low]!<=node.loc.end.offset;
      };
      const matches=new Map<string,DeclarationFact>();
      for(const fact of syntax.facts.declarations)matches.set(`${fact.end}:${fact.kind}:${fact.name}`,fact);
      const anonymousOwners=new Map((syntax.facts.php?.regions??[]).filter(region=>region.callable&&!region.callable.binding).map(region=>[`${region.callable!.nativeStart}:${region.end}:${region.kind}`,syntax.declarations.get(region.callable!.key)]));
      const root:Frame={key:`php-file:0:${source.content.length}`,kind:'file',unit,namespace:'',importScope:`php-file:0:${source.content.length}`,owner:file.id,variables:new Map()};unit.frames.push(root);
      const pending=[{node:source.ast,frame:root,conditional:false,statement:undefined as Ast|undefined,parent:undefined as Ast|undefined,field:''}];
      while(pending.length) {
        const item=pending.pop()!,{node}=item;let {frame,conditional,statement}=item;
        if(++unit.work>200_000){unit.gap='Original PHP scope node budget exceeded';break;}
        let kind=node.kind,label=name(node.name);
        if(kind==='method')kind=fold(label??'')==='__construct'?'constructor':fold(label??'')==='__destruct'?'destructor':'method';
        if(kind==='assign'&&node.operator==='='&&['closure','arrowfunc'].includes(ast(node.right)?.kind??'')&&ast(node.left)?.kind==='variable'&&typeof ast(node.left)?.name==='string'){kind=ast(node.right)!.kind==='closure'?'closure-binding':'arrow-binding';label=`$${String(ast(node.left)!.name)}`;}
        if(kind==='parameter'&&Number(node.flags)!==0){kind='promoted-property';label=`$${label}`;}
        if(kind==='property')label=`$${label}`;
        if(kind==='constant')kind=frame.cls?'class-constant':'constant';
        if(kind==='enumcase')kind='enum-case';
        if(kind==='propertyhook')kind=`property-${label}`;
        const fact=matches.get(`${node.loc?.end.offset}:${kind}:${label}`),id=fact?syntax.declarations.get(fact.key):undefined;
        // The validated original still defines scopes and writes. Its exact
        // declaration identity can reuse the catalog's immutable signature;
        // the emission definition and lexical frame remain file-local.
        const header=!catalog&&id?this.definitions.get(id):undefined;
        const detached=header?.detached?header:undefined;
        const definition:Definition|undefined=fact&&id?{id,fact,node:detached?.node??(['closure-binding','arrow-binding'].includes(kind)?ast(node.right)!:node),unit,frame,type:detached?detached.type:ast(node.type)??ast(statement?.type),detached:!!detached}:undefined;
        if(definition){
          unit.definitions.push(definition);if(catalog)this.definitions.set(definition.id,definition);
          if(catalog&&TYPE_KINDS.includes(kind)){const key=JSON.stringify([file.application?.name,fold(fact!.qualifiedName)]),entries=this.applicationTypes.get(key)??[];entries.push(definition);this.applicationTypes.set(key,entries);}
          if(catalog&&['closure-binding','arrow-binding'].includes(kind))this.boundClosures.set(this.closureKey(file.path,ast(node.right)!),definition);
        }
        if(node.kind==='namespace') {
          frame={...root,key:`php-namespace:${node.loc!.start.offset}:${node.loc!.end.offset}`,kind:'namespace',namespace:String(node.name??''),importScope:`php-namespace:${node.loc!.start.offset}:${node.loc!.end.offset}`,parent:root};unit.frames.push(frame);
        }else if(TYPE_KINDS.includes(node.kind)) {
          frame={...frame,key:`php-type:${node.loc?.start.offset}`,kind:'type',owner:definition?.id,definition,cls:definition,thisClass:undefined,parent:frame,variables:new Map()};unit.frames.push(frame);
        }else if(['function','method','closure','arrowfunc','propertyhook'].includes(node.kind)) {
          const closure=['closure','arrowfunc'].includes(node.kind),owner=definition??this.boundClosures.get(this.closureKey(frame.unit.file.path,node));
          const parent=frame;
          frame={key:`php-callable:${node.loc?.start.offset}:${node.loc?.end.offset}`,kind:closure?node.kind==='closure'?'closure':'arrow':'function',unit,namespace:parent.namespace,importScope:parent.importScope,owner:owner?.id??(closure?anonymousOwners.get(`${node.loc?.start.offset}:${node.loc?.end.offset}:${node.kind==='closure'?'closure':'arrow-function'}`):undefined),definition:owner,parent,cls:node.kind==='function'?undefined:parent.cls,thisClass:node.isStatic?undefined:closure?parent.thisClass:['method','propertyhook'].includes(node.kind)?parent.cls:undefined,variables:new Map()};unit.frames.push(frame);
          // Named nested functions keep namespace identity but cannot inherit
          // their enclosing method's lexical self/parent return-type context.
          if(owner?.fact.kind==='function')owner.frame=frame;
          if(!catalog&&node.kind==='closure')for(const capture of nodes(node.uses))if(typeof capture.name==='string'){
            frame.variables.set(capture.name,{writes:[],capture:{frame:parent,name:capture.name,start:node.loc!.start.offset,byref:!!capture.byref}});
            if(capture.byref){const variable=this.variable(parent,capture.name);variable.writes.push({node:capture,frame:parent,start:capture.loc!.start.offset,conditional:false,unsafe:true});}
          }
          const parameters=nodes(node.arguments),hookParameter=ast(node.parameter);if(hookParameter)parameters.push(hookParameter);
          if(!catalog)for(const parameter of parameters)if(name(parameter.name))frame.variables.set(name(parameter.name)!,{parameter,writes:[]});
          conditional=false;
        }
        if(!catalog){
        if(node.kind==='assign'||node.kind==='assignref') {
          const left=ast(node.left);if(left?.kind==='variable'&&typeof left.name==='string')this.variable(frame,left.name).writes.push({node,frame,value:ast(node.right),start:node.loc!.start.offset,conditional,unsafe:node.kind==='assignref'||node.operator!=='='});
          else if(left?.kind==='variable')frame.dynamic='Dynamic original variable assignment';
          else if(left&&['list','array'].includes(left.kind))frame.dynamic='Original destructuring assignment needs an explicit write profile';
          const right=ast(node.right);if(node.kind==='assignref'&&right?.kind==='variable'&&typeof right.name==='string')this.variable(frame,right.name).writes.push({node,frame,start:node.loc!.start.offset,conditional,unsafe:true});
        }else if(['pre','post','unset','global','static','foreach','catch'].includes(node.kind)) {
          const targets=node.kind==='foreach'?[ast(node.key),ast(node.value)]:node.kind==='catch'?[ast(node.variable)]:node.kind==='global'||node.kind==='static'||node.kind==='unset'?nodes(node.items??node.variables):[ast(node.what)];
          for(const target of targets)if(target?.kind==='variable'&&typeof target.name==='string')this.variable(frame,target.name).writes.push({node,frame,start:node.loc!.start.offset,conditional,unsafe:true});
          if(targets.some(target=>target&&['list','array'].includes(target.kind)))frame.dynamic='Original destructuring binding needs an explicit write profile';
          if(node.kind==='global'||node.kind==='static')frame.dynamic=`Original ${node.kind} variable state requires a lifetime profile`;
        }
        if(['eval','yield','yieldfrom','include'].includes(node.kind))frame.dynamic=`Original ${node.kind} requires a separate callable/lifetime profile`;
        if(node.kind==='entry'&&node.byRef){const value=ast(node.value);if(value?.kind==='variable'&&typeof value.name==='string')this.variable(frame,value.name).writes.push({node,frame,start:node.loc!.start.offset,conditional,unsafe:true});}
        if(node.kind==='call'&&ast(node.what)?.kind==='name'&&['extract','\\extract'].includes(fold(name(node.what)??'')))frame.dynamic='Original extract call can overwrite callable-local bindings';
        if(node.kind==='call'&&ast(node.what)?.kind==='name'&&(this.resolver.facts(file.path)?.imports??[]).some(imported=>imported.scope===frame.importScope&&imported.kind==='function'&&fold(imported.specifier)==='extract'&&fold(imported.alias)===fold(name(node.what)??'')))frame.dynamic='Original aliased extract call can overwrite callable-local bindings';
        if(node.kind==='call'||node.kind==='new'||node.kind==='staticlookup'&&!(item.parent?.kind==='call'&&item.field==='what')||node.kind==='name'&&!['what','name','alias','traits'].includes(item.field)){
          const referenceKind=node.kind==='name'?['type','extends','implements'].includes(item.field)||['uniontype','intersectiontype'].includes(item.parent?.kind??'')?'type-reference':'constant-reference':node.kind;
          if(unit.sites.length<4096){
            // A substring can retain the entire original through a V8 sliced
            // string. Copy UTF-16 code units, including a truncated surrogate,
            // so bounded expressions own no original-source backing storage.
            const expression=Buffer.from(source.content.slice(node.loc!.start.offset,Math.min(node.loc!.end.offset,node.loc!.start.offset+2048)),'utf16le').toString('utf16le');
            unit.sites.push({node,frame,kind:referenceKind,range:original!.range(node.loc!.start.offset,node.loc!.end.offset),expression});
          }else unit.gap='Original PHP reference site budget exceeded';
        }
        }
        if(['propertystatement','classconstant','constantstatement'].includes(node.kind))statement=node;
        if(['if','while','do','for','foreach','switch','case','try','catch','finally','retif','match','matcharm'].includes(node.kind)||node.kind==='bin'&&['&&','||','and','or','??'].includes(String(node.type)))conditional=true;
        const children:{node:Ast;field:string}[]=[];for(const [field,value]of Object.entries(node)){if(['loc','tokens','comments','leadingComments','trailingComments'].includes(field))continue;if(Array.isArray(value))children.push(...nodes(value).map(node=>({node,field})));else if(ast(value))children.push({node:ast(value)!,field});}
        for(let index=children.length-1;index>=0;index--){
          const child=children[index]!;if(catalog&&!hasDeclaration(child.node))continue;
          pending.push({...child,frame,conditional,statement,parent:node});
        }
      }
      if(!catalog){
        const known=new WeakMap<Ast,Ast>();
        for(const definition of unit.definitions)if(!definition.detached){definition.node=bindingNode(definition.node,known);if(definition.type)definition.type=bindingNode(definition.type,known);definition.detached=true;}
        for(const frame of unit.frames)for(const variable of frame.variables.values()){
          if(variable.parameter)variable.parameter=bindingNode(variable.parameter,known);
          for(const write of variable.writes){write.node=bindingNode(write.node,known);if(write.value)write.value=bindingNode(write.value,known);}
        }
        for(const site of unit.sites)site.node=bindingNode(site.node,known);
      }
      return unit;
  }
  private invalidateArguments(unit:Unit):void {
    // A call can rebind an argument through a reference parameter. Unknown
    // callees cannot certify unchanged local bindings after such an escape.
    for(const {node,frame}of unit.sites)if(node.kind==='call'||node.kind==='new') {
      const arguments_=nodes(node.arguments);
      // Only direct variable arguments can escape through this profile's
      // reference parameters. Resolving every zero/literal-argument call here
      // duplicated emission's binding work without adding a mutation guard.
      if(!arguments_.some(argument=>{const value=argument.kind==='namedargument'?ast(argument.value):argument;return value?.kind==='variable'&&typeof value.name==='string';}))continue;
      let target=node.kind==='call'?this.call(frame,node):this.value(frame,node,node.loc!.start.offset);
      if(node.kind==='new'&&target.kind==='instance')target=this.member(target,'__construct',frame,false,0);
      const parameters=target.kind==='callable'?nodes(target.definition.node.arguments):undefined;
      for(const [index,argument]of arguments_.entries()) {
        const value=argument.kind==='namedargument'?ast(argument.value):argument;
        if(value?.kind!=='variable'||typeof value.name!=='string')continue;
        const parameter=argument.kind==='namedargument'?parameters?.find(param=>name(param.name)===name(argument.name)):parameters?.[index]??parameters?.find(param=>param.variadic);
        if(!parameters||!parameter||parameter.byref)this.variable(frame,value.name).writes.push({node,frame,start:node.loc!.start.offset,conditional:false,unsafe:true});
      }
    }
  }
  private variable(frame:Frame,name:string):Variable {let value=frame.variables.get(name);if(!value){value={writes:[]};frame.variables.set(name,value);}return value;}
  private proof(frame:Frame,node:Ast,reason:string):Evidence {return {...evidence('php','php-symbols',frame.unit.file.path,node.loc?.start.line,reason),endLine:node.loc?.end.line,analyzerVersion:PHP_SYMBOL_VERSION};}
  private outcome(outcome:ImportOutcome):Value {
    if(outcome.status==='resolved') {
      const definition=this.definitions.get(outcome.targets[0]!);
      if(!definition||outcome.targets.length!==1)return gap('Original target definition is unavailable');
      return {kind:TYPE_KINDS.includes(definition.fact.kind)?'class':'callable',definition,exact:true,proof:outcome.proof};
    }
    return gap('reason'in outcome?outcome.reason:`External source dependency: ${outcome.dependency}`,'proof'in outcome?outcome.proof:[],outcome.status==='excluded'?'unsupported':outcome.status,'candidates'in outcome?outcome.candidates:undefined);
  }
  private qualified(frame:Frame,kind:PhpImportFact['kind'],qualified:string):Value {
    const key=JSON.stringify([frame.unit.file.path,kind,qualified]),known=this.qualifiedNames.get(key);if(known)return known;
    const outcome=this.resolver.resolveQualified(frame.unit.file.path,kind,qualified);
    // Laravel's established application declaration catalog is an additional
    // source-binding profile, never evidence of executing an autoloader.
    if(kind==='class'&&outcome.status==='unresolved'&&frame.unit.file.application?.frameworks.includes('laravel')) {
      const candidates=this.applicationTypes.get(JSON.stringify([frame.unit.file.application.name,fold(qualified)]))??[];
      if(candidates.length){const value:Value=candidates.length===1?{kind:'class',definition:candidates[0]!,exact:true,proof:[this.proof(candidates[0]!.frame,candidates[0]!.node,'Original indexed Laravel application type; runtime loading remains unverified')]}:gap('Ambiguous original Laravel application type',[],'ambiguous',candidates.map(d=>d.id));this.qualifiedNames.set(key,value);return value;}
    }
    const value=this.outcome(outcome);this.qualifiedNames.set(key,value);return value;
  }
  private named(frame:Frame,node:Ast,kind:PhpImportFact['kind']):Value {
    const raw=name(node);if(!raw)return gap('Original static name is unavailable');
    if(node.resolution==='fqn'||raw.startsWith('\\'))return this.qualified(frame,kind,raw.replace(/^\\/,''));
    if(node.resolution==='rn'||raw.startsWith('namespace\\'))return this.qualified(frame,kind,[frame.namespace,raw.replace(/^namespace\\/,'')].filter(Boolean).join('\\'));
    const parts=raw.split('\\'),table=parts.length>1?'class':kind;
    const imports=(this.resolver.facts(frame.unit.file.path)?.imports??[]).filter(imported=>imported.scope===frame.importScope&&imported.kind===table&&(table==='const'?imported.alias===parts[0]:fold(imported.alias)===fold(parts[0]!)));
    if(imports.length>1)return gap('Duplicate original namespace aliases',[],'ambiguous',imports.map(i=>i.specifier));
    if(imports.length===1)return this.qualified(frame,kind,[imports[0]!.specifier,...parts.slice(1)].join('\\'));
    const qualified=[frame.namespace,raw].filter(Boolean).join('\\'),local=this.qualified(frame,kind,qualified);
    if(kind==='class'||parts.length>1||!frame.namespace||local.kind!=='gap'&&!(local.definition.fact.sourceConditions?.length))return local;
    if(local.kind==='gap'&&local.status!=='unresolved')return local;
    const global=this.qualified(frame,kind,raw);
    if(local.kind!=='gap'&&global.kind!=='gap')return gap('Conditional namespace declaration competes with the global runtime fallback',[...local.proof,...global.proof],'ambiguous',[local.definition.id,global.definition.id]);
    if(local.kind!=='gap')return local;
    if((this.resolver.facts(frame.unit.file.path)?.loaderChanges.length??0)>0||this.resolver.loads(frame.unit.file.path).some(load=>load.outcome.status!=='resolved'))return gap('Namespace fallback is unproven in a dynamic or unavailable loader profile');
    return global;
  }
  private type(frame:Frame,node:Ast|undefined,depth:number,nullable=false):Value {
    if(!node)return gap('Original named type is unavailable');
    const raw=fold(name(node)??String(node.raw??''));
    if(['selfreference','parentreference','staticreference'].includes(node.kind)||['self','parent','static'].includes(raw)){
      if(raw==='static'||node.kind==='staticreference')return gap('Late static binding requires a concrete runtime receiver');
      if(!frame.cls)return gap('No original lexical class for self/parent');
      const selected=raw==='parent'||node.kind==='parentreference'?this.base(frame.cls,depth+1):{kind:'class' as const,definition:frame.cls,exact:true,proof:[]};
      return selected.kind==='class'?{...selected,kind:'instance',exact:false,nullable}:selected;
    }
    if(node.kind!=='name')return gap(`Original ${node.kind} type needs a separate union/intersection/builtin profile`);
    const value=this.named(frame,node,'class');return value.kind==='class'?{...value,kind:'instance',exact:!!value.definition.node.isFinal,nullable}:value;
  }
  private base(definition:Definition,depth:number):Value {
    if(depth>32)return gap('Original PHP inheritance depth budget exceeded');
    const parent=ast(definition.node.extends);return parent?this.named(definition.frame,parent,'class'):gap('No original indexed parent class',[],'unresolved');
  }
  private member(receiver:Extract<Value,{kind:'class'|'instance'}>,member:string,caller:Frame,staticCall:boolean,depth:number,property=false):Value {
    if(depth>32)return gap('Original PHP member lookup budget exceeded');
    const owner=receiver.definition,catalog=property?this.properties:this.methods,entries=catalog.get(owner.id)?.get(property?member:fold(member))??[];
    if(entries.length>1)return gap('Duplicate original member declarations',receiver.proof,'ambiguous',entries.map(d=>d.id));
    if(entries.length===1){
      const definition=entries[0]!,visibility=definition.fact.visibility;
      if(visibility==='private'&&caller.cls?.id!==owner.id)return gap('Private member is outside its original lexical class');
      if(visibility==='protected'&&caller.cls?.id!==owner.id)return gap('Protected member access requires a qualified inheritance/access profile');
      if(!property&&staticCall&&!definition.node.isStatic)return gap('Original instance method cannot be certified as a static call');
      if(!property&&(definition.fact.declarationForm==='declaration'||definition.node.isAbstract))return gap('Abstract/interface member has no original callable implementation');
      const nominal=!property&&receiver.kind==='instance'&&!receiver.exact&&!owner.node.isFinal&&!definition.node.isFinal&&visibility!=='private';
      return {kind:'callable',definition,nominal,proof:[...receiver.proof,this.proof(definition.frame,definition.node,property?'Original member declaration':'Original method declaration; virtual runtime dispatch remains unverified')]};
    }
    if(!property) {
      const uses=(this.resolver.facts(owner.unit.file.path)?.traits??[]).filter(use=>use.owner===owner.fact.key);
      if(uses.some(use=>use.adaptations.length))return gap('Original trait adaptations require explicit precedence/alias binding');
      const traits:Value[]=[];for(const use of uses)for(const trait of use.names){const resolved=this.named(owner.frame,{kind:'name',name:trait},'class');if(resolved.kind==='class'){const target=this.member({...resolved,kind:receiver.kind,exact:receiver.exact},member,caller,staticCall,depth+1);if(target.kind!=='gap'||target.status!=='unresolved')traits.push(target);}else traits.push(resolved);}
      const found=traits.filter((value):value is Extract<Value,{kind:'callable'}>=>value.kind==='callable');
      if(found.length>1)return gap('Multiple original trait members compete',[],'ambiguous',found.map(v=>v.definition.id));
      if(traits.some(value=>value.kind==='gap'&&value.status!=='unresolved'))return gap('An original trait member candidate is unavailable or unsupported');
      if(found.length===1)return found[0]!;
    }
    const parent=this.base(owner,depth+1);if(parent.kind==='class')return this.member({...parent,kind:receiver.kind,exact:receiver.exact},member,caller,staticCall,depth+1,property);
    if(ast(owner.node.extends))return parent;
    return gap(`No original ${property?'property/constant':'method'} declaration: ${member}`,receiver.proof,'unresolved');
  }
  private value(frame:Frame,node:Ast|undefined,at:number,depth=0):Value {
    if(!node||depth>32||++frame.unit.work>1_000_000)return gap('Missing or over-budget original PHP binding expression');
    if(frame.dynamic)return gap(frame.dynamic);
    if(node.kind==='variable') {
      if(typeof node.name!=='string')return gap('Dynamic variable names need runtime binding');
      if(node.name==='this')return frame.thisClass?{kind:'instance',definition:frame.thisClass,exact:!!frame.thisClass.node.isFinal,proof:[this.proof(frame,node,'Original non-static lexical $this binding')]}:gap('$this is unavailable in this original callable scope');
      const variable=frame.variables.get(node.name);
      if(!variable)return frame.kind==='arrow'&&frame.parent?this.value(frame.parent,node,frame.definition?.node.loc?.start.offset??at,depth+1):gap(`No original callable-local binding for $${node.name}`,[],'unresolved');
      if(variable.capture){if(variable.capture.byref)return gap('By-reference closure capture has unverified mutations');const capture=variable.capture;return this.value(capture.frame,node,capture.start,depth+1);}
      if(variable.parameter){if(variable.writes.length||variable.parameter.byref)return gap('Reassigned or by-reference original parameter');return this.type(frame,ast(variable.parameter.type),depth+1,!!variable.parameter.nullable);}
      if(variable.writes.length!==1)return gap('Original variable has multiple, aliased or unavailable writes');
      const write=variable.writes[0]!;if(write.unsafe||write.conditional||write.start>=at)return gap('Original variable write is conditional, mutable, deferred or follows this use');
      if(['file','namespace'].includes(frame.kind)&&frame.unit.sites.some(site=>['file','namespace'].includes(site.frame.kind)&&site.frame.variables===frame.variables&&['call','new'].includes(site.node.kind)&&!nodes(site.node.arguments).some(arg=>arg.kind==='variadicplaceholder')&&site.node.loc!.start.offset>=(write.value?.loc?.end.offset??write.start)&&site.node.loc!.start.offset<at))return gap('An intervening original call can mutate global PHP variable state');
      const result=this.value(write.frame,write.value,write.start,depth+1);return {...result,proof:[...result.proof,this.proof(write.frame,write.node,'One prior unconditional original variable assignment')]};
    }
    if(node.kind==='new') {const type=this.classValue(frame,ast(node.what),depth+1);return type.kind==='class'&&type.definition.fact.kind==='class'&&!type.definition.node.isAbstract?{...type,kind:'instance',exact:true}:type.kind==='class'?gap('Original type cannot be certified as instantiable'):type;}
    if(node.kind==='closure'||node.kind==='arrowfunc'){const definition=this.boundClosures.get(this.closureKey(frame.unit.file.path,node));return definition?{kind:'callable',definition,proof:[this.proof(frame,node,'Original named callable source binding')]}:gap('Anonymous callable has no original named source owner');}
    if(node.kind==='string'&&typeof node.value==='string') {
      const parts=node.value.replace(/^\\/,'').split('::');
      if(parts.length===1)return this.qualified(frame,'function',parts[0]!);
      if(parts.length===2){const type=this.qualified(frame,'class',parts[0]!);return type.kind==='class'?this.member(type,parts[1]!,frame,true,depth+1):type;}
      return gap('Dynamic callable string shape is unsupported');
    }
    if(node.kind==='array') {
      const items=nodes(node.items);if(items.length!==2||items.some(item=>item.unpack||item.key))return gap('Callable array requires two original positional entries');
      const receiver=this.value(frame,ast(items[0]!.value),at,depth+1),method=ast(items[1]!.value);
      if(method?.kind!=='string'||typeof method.value!=='string')return gap('Callable array method is not an original literal');
      const first=ast(items[0]!.value);const type=first?.kind==='string'?this.qualified(frame,'class',String(first.value)):receiver;
      return type.kind==='instance'||type.kind==='class'?this.member(type,method.value,frame,type.kind==='class',depth+1):type;
    }
    if(node.kind==='propertylookup'||node.kind==='nullsafepropertylookup') {
      const receiver=this.value(frame,ast(node.what),at,depth+1),offset=ast(node.offset);
      if(receiver.kind!=='instance'||offset?.kind!=='identifier')return receiver.kind==='gap'?receiver:gap('Dynamic original property receiver/name');
      const member=this.member(receiver,`$${name(offset)}`,frame,false,depth+1,true);
      return member.kind==='callable'?this.type(member.definition.frame,member.definition.type,depth+1,!!member.definition.node.nullable):member;
    }
    if(node.kind==='staticlookup'&&fold(name(node.offset)??'')==='class')return this.classValue(frame,ast(node.what),depth+1);
    if(node.kind==='call') {
      const target=this.call(frame,node,depth+1);
      if(nodes(node.arguments).some(arg=>arg.kind==='variadicplaceholder'))return target;
      return target.kind==='callable'?this.type(target.definition.frame,ast(target.definition.node.type),depth+1,!!target.definition.node.nullable):target;
    }
    return gap(`Original ${node.kind} expression needs a separate value profile`);
  }
  private classValue(frame:Frame,node:Ast|undefined,depth:number):Value {
    if(!node)return gap('Missing original class receiver');
    if(['selfreference','parentreference','staticreference'].includes(node.kind)||['self','parent','static'].includes(fold(name(node)??''))) {
      const selected=this.type(frame,node,depth);return selected.kind==='instance'?{...selected,kind:'class',exact:true}:selected;
    }
    return node.kind==='name'?this.named(frame,node,'class'):gap('Dynamic original class receiver');
  }
  private call(frame:Frame,node:Ast,depth=0):Value {
    if(depth>32)return gap('Original PHP call proof depth exceeded');
    const callee=ast(node.what);if(!callee)return gap('Missing original call expression');
    if(callee.kind==='name')return this.named(frame,callee,'function');
    if(['propertylookup','nullsafepropertylookup','staticlookup'].includes(callee.kind)) {
      const offset=ast(callee.offset);if(offset?.kind!=='identifier')return gap('Dynamic original method name');
      const receiver=callee.kind==='staticlookup'?this.classValue(frame,ast(callee.what),depth+1):this.value(frame,ast(callee.what),node.loc!.start.offset,depth+1);
      if(receiver.kind==='instance'&&receiver.nullable&&callee.kind!=='nullsafepropertylookup')return gap('Nullable original receiver needs a source null guard');
      if(receiver.kind!=='instance'&&receiver.kind!=='class')return receiver.kind==='gap'?receiver:gap('Original method receiver is not a class/object binding');
      const lexical=callee.kind==='staticlookup'&&['selfreference','parentreference'].includes(ast(callee.what)?.kind??'')&&!!frame.thisClass;
      return this.member(receiver,name(offset)!,frame,callee.kind==='staticlookup'&&!lexical,depth+1);
    }
    const target=this.value(frame,callee,node.loc!.start.offset,depth+1);
    return target.kind==='instance'?this.member(target,'__invoke',frame,false,depth+1):target;
  }
  async emit():Promise<void> {
    for(const file of this.files.values()){
      // A source may have changed since catalog preparation. Validate it before
      // compiling this file's scopes; never replay a retained raw parser tree.
      const source=await this.source(file);if(!source?.ast||!this.context.syntax?.has(file.path))continue;
      const unit=this.unit(file,source,false);this.active=unit;this.peakUnits=Math.max(this.peakUnits,1);
      this.totalSites+=unit.sites.length;this.totalExpressionBytes+=unit.sites.reduce((bytes,site)=>bytes+2*site.expression.length,0);
      try{this.invalidateArguments(unit);this.emitUnit(unit);}finally{this.active=undefined;}
    }
  }
  private emitUnit(unit:Unit):void {
    const {graph}=this.context;
    {
      const outcomes:unknown[]=[],counts=new Map<string,{resolved:number;external:number;unresolved:number}>();
      const callCounts=new Map<string,{resolved:number;external:number;unresolved:number;unresolvedNames:Record<string,number>}>();
      const record=(site:Site,kind:string,value:Value,edgeType:RelationType)=>{
        const {node,frame,range,expression}=site;
        const proof=[this.proof(frame,node,'Original PHP source use; execution, loader activation and runtime dispatch remain unverified'),...value.proof];
        if(proof.length>128)value=gap('Original PHP source proof-hop budget exceeded');
        if(!frame.owner)value=gap('Original anonymous/type region has no named callable source owner');
        const target=value.kind==='gap'?undefined:value.definition.id;
        const outcome={kind,scope:frame.key,owner:frame.owner,range,expression,status:value.kind==='gap'?value.status:'resolved',...value.kind==='gap'?{reason:value.reason,candidates:value.candidates}:{target,dispatch:value.kind==='callable'&&value.nominal?'nominal':'direct',targetConditions:value.definition.fact.sourceConditions??[]},proof,executionUnverified:true};
        outcomes.push(outcome);
        if(frame.owner){const count=counts.get(frame.owner)??{resolved:0,external:0,unresolved:0};count[value.kind==='gap'?value.status==='external'?'external':'unresolved':'resolved']++;counts.set(frame.owner,count);}
        if(frame.owner&&['call','constructor'].includes(kind)){
          const count=callCounts.get(frame.owner)??{resolved:0,external:0,unresolved:0,unresolvedNames:Object.create(null) as Record<string,number>};
          const status=value.kind==='gap'?value.status==='external'?'external':'unresolved':value.kind==='callable'&&value.nominal?'unresolved':'resolved';count[status]++;
          const callee=ast(node.what),label=name(callee?.offset)??name(callee);
          if(status==='unresolved'&&label&&label.length<=256&&Object.keys(count.unresolvedNames).length<256)count.unresolvedNames[label]=(count.unresolvedNames[label]??0)+1;
          callCounts.set(frame.owner,count);
        }
        if(target&&frame.owner)graph.relate(frame.owner,target,edgeType,proof,{adapter:'php-source-binding',executionUnverified:true,dispatch:value.kind==='callable'&&value.nominal?'nominal':'direct'});
      };
      for(const site of unit.sites) {
        const {node,frame,kind}=site;
        if(unit.gap){record(site,kind,gap(unit.gap),'references');continue;}
        if(node.kind==='name'){record(site,kind,this.named(frame,node,kind==='type-reference'?'class':'const'),'references');}
        else if(node.kind==='call'){const target=this.call(frame,node),reference=nodes(node.arguments).some(arg=>arg.kind==='variadicplaceholder');record(site,reference?'callable-reference':'call',target,reference||target.kind==='callable'&&target.nominal?'references':'calls');}
        else if(node.kind==='new') {
          const receiver=this.value(frame,node,node.loc!.start.offset);
          if(receiver.kind==='instance'){record(site,'construction-type',receiver,'references');const ctor=this.member(receiver,'__construct',frame,false,0);record(site,'constructor',ctor.kind==='gap'&&ctor.status==='unresolved'?receiver:ctor,'calls');}
          else record(site,'constructor',receiver,'calls');
        }else {
          const offset=ast(node.offset);if(offset?.kind!=='identifier')continue;
          if(fold(name(offset)??'')==='class'){record(site,'class-type',this.classValue(frame,ast(node.what),0),'references');continue;}
          const receiver=this.classValue(frame,ast(node.what),0),target=receiver.kind==='class'?this.member(receiver,name(offset)!,frame,true,0,true):receiver;
          record(site,'class-member',target,'references');
        }
      }
      for(const definition of unit.definitions)if(TYPE_KINDS.includes(definition.fact.kind))for(const [field,relation]of [['extends','extends'],['implements','implements']]as const)for(const node of Array.isArray(definition.node[field])?nodes(definition.node[field]):ast(definition.node[field])?[ast(definition.node[field])!]:[]){const target=this.named(definition.frame,node,'class');if(target.kind==='class')graph.relate(definition.id,target.definition.id,relation,[...target.proof,this.proof(definition.frame,node,'Original named inheritance/type contract; runtime activation unverified')]);}
      const entity=graph.entities.get(unit.file.id)!;entity.metadata.phpCallOutcomes=outcomes;entity.metadata.phpBinding={version:PHP_SYMBOL_VERSION,profile:'original-callable-scopes',executionUnverified:true,scopes:unit.frames.map(frame=>({key:frame.key,kind:frame.kind,owner:frame.owner,parent:frame.parent?.key,namespace:frame.namespace,importScope:frame.importScope,variables:[...frame.variables.keys()].sort(),dynamic:frame.dynamic})),...unit.gap?{gap:unit.gap}:{}};
      for(const [id,count]of counts)graph.entities.get(id)!.metadata.phpSourceSites=count;
      for(const [id,count]of callCounts){const owner=graph.entities.get(id)!,stats={...count,unresolvedNames:{...count.unresolvedNames}};owner.metadata.phpCallSites=stats;if(owner.metadata.callSites===undefined)owner.metadata.callSites=stats;}
      const analysis=fileAnalysis(entity.metadata.analysis);if(analysis)analysis.features.references={status:'partial',reason:'Original callable scopes, namespace tables, source functions/constructors/methods and concrete callbacks; nominal dispatch uses references. Dynamic values, by-reference state, trait adaptations and broader flow profiles retain explicit gaps'};
    }
  }
}
export const phpSymbolsAnalyzer:Analyzer={name:'php-symbols',version:PHP_SYMBOL_VERSION,async analyze(context){
  const files=[...context.files.values()].filter(file=>file.language==='php'&&file.analyzable);
  const resolver=new PhpResolver(context),symbols=new PhpSymbols(context,resolver);
  await symbols.prepare();resolver.prepare(files);await symbols.emit();
}};
