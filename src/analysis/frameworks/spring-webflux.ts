import type { AnalysisContext, ScannedFile } from '../../core/analyzer.js';
import { evidence, type Evidence } from '../../core/graph.js';
import { fileAnalysis, type JvmExpression, type JvmScopeFact } from '../facts.js';
import { JvmSymbols, type JvmDefinition } from '../languages/jvm-symbols.js';
import { compileSpringPath, combineSpringPath } from '../routes/spring-patterns.js';
import type { RoutingContract } from '../routes/contracts.js';
import { springWebFluxProfile } from './spring-profile.js';

export const WEBFLUX_VERSION = '1';
const SERVER='org.springframework.web.reactive.function.server.', REQUEST=SERVER+'RequestPredicates.', ROUTERS=SERVER+'RouterFunctions.';
const CONFIG='org.springframework.context.annotation.', METHODS=new Set(['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS']);
interface Origin { file:string; scope:string; expression:JvmExpression; proof?:Evidence[] }
interface Predicate { paths:string[]; methods:string[]|'*'; queries:{name:string;value:string}[]; gaps:string[]; proof:Evidence[]; uncertainPath?:boolean }
interface Route { origin:Origin; predicate:Predicate; handler?:JvmDefinition; gaps:string[]; proof:Evidence[] }
interface Router { kind:'builder'|'router'; routes:Route[]; gaps:string[] }
interface State { selectedScopes:string[]; builders:Map<string,Router>; dsl?:'router'|'coRouter'; depth:number; seen:Set<string> }
const any=():Predicate=>({paths:[],methods:'*',queries:[],gaps:[],proof:[]});
const opaque=(reason:string):Predicate=>({...any(),gaps:[reason]});
const initial=():State=>({selectedScopes:[],builders:new Map(),depth:0,seen:new Set()});

/** Ordered, bounded original-source WebFlux.fn registration. The interpreter
 * reads facts only: it never loads classes, creates beans, invokes factories,
 * runs a DSL, dependency resolver, compiler, coroutine or target application. */
export class SpringWebFlux {
  private operations=0;
  constructor(readonly context:AnalysisContext,readonly symbols:JvmSymbols){}
  private proof(origin:Origin,reason:string):Evidence[]{
    const constant=['literal','name','member'].includes(origin.expression.kind)?this.symbols.constant(origin.file,origin.scope,origin.expression):undefined;
    return[...origin.proof??[],...constant?.proof??[],{...evidence('framework','spring-webflux',origin.file,origin.expression.range.startLine,reason),analyzerVersion:WEBFLUX_VERSION,endLine:origin.expression.range.endLine}];
  }
  private identity(origin:Origin,state:State,type=false):string|undefined{
    const value=this.symbols.bound(origin.file,origin.scope,origin.expression,type,state.selectedScopes);
    return value.kind==='external'?value.name:undefined;
  }
  private annotation(definition:JvmDefinition,index:number):string|undefined{
    const annotation=definition.fact.annotations[index];return annotation&&!annotation.target?this.identity({file:definition.unit.file.path,scope:definition.fact.scope,expression:annotation.type},initial(),true):undefined;
  }
  private annotationNames(definition:JvmDefinition):string[]{return definition.fact.annotations.map((_item,index)=>this.annotation(definition,index)??'unresolved');}
  private configurationGaps(definition:JvmDefinition):string[]{
    const index=definition.fact.annotations.findIndex((_item,index)=>this.annotation(definition,index)===CONFIG+'Configuration'),annotation=definition.fact.annotations[index],gaps:string[]=[];let proxy=true;
    if(annotation)for(const argument of annotation.args){const value=this.symbols.constant(definition.unit.file.path,definition.fact.scope,argument.value);if(argument.name!=='proxyBeanMethods'||value.status!=='resolved'||typeof value.value!=='boolean')gaps.push('Custom/opaque Configuration options require a reviewed bean activation profile');else proxy=value.value;}
    if(proxy&&(definition.fact.modifiers.includes('final')||definition.unit.file.language==='kotlin'&&!definition.fact.modifiers.includes('open')))gaps.push('Final configuration requires explicit proxyBeanMethods=false; compiler all-open/proxy transformation is not inferred');
    return gaps;
  }
  private string(origin:Origin):string|undefined{
    const value=this.symbols.constant(origin.file,origin.scope,origin.expression);
    return value.status==='resolved'&&typeof value.value==='string'&&value.value.length<=4096?value.value:undefined;
  }
  private conjunction(a:Predicate,b:Predicate):Predicate{
    const methods=a.methods==='*'?b.methods:b.methods==='*'?a.methods:a.methods.filter(method=>b.methods.includes(method));
    return{paths:[...a.paths,...b.paths],methods,queries:[...a.queries,...b.queries],gaps:[...a.gaps,...b.gaps],proof:[...a.proof,...b.proof],...a.uncertainPath||b.uncertainPath?{uncertainPath:true}:{}};
  }
  private combine(left:Predicate[],right:Predicate[]):Predicate[]{
    if(left.length*right.length>128)return[opaque('WebFlux predicate cross-product exceeds the bounded expansion budget')];
    return left.flatMap(a=>right.map(b=>this.conjunction(a,b))).filter(predicate=>predicate.methods==='*'||predicate.methods.length);
  }
  private trace(origin:Origin,state:State,accept:string[]):(Origin&{storage:'local'|'property'})|undefined{
    const value=this.symbols.initialized(origin.file,origin.scope,origin.expression,state.selectedScopes);
    if(!value)return;
    if(value.type){const type=value.type.kind==='generic-type'?value.type.name:value.type,name=this.identity({...value,expression:type},state,true);if(!name||!accept.includes(name))return;
      if(value.type.kind==='generic-type'&&(value.type.arguments.length!==1||this.identity({...value,expression:value.type.arguments[0]!},state,true)!==SERVER+'ServerResponse'))return;
    }
    return value;
  }
  private predicate(origin:Origin,state:State):Predicate[]{
    const {expression}=origin;if(++this.operations>100_000||state.depth>48)return[opaque('WebFlux interpretation budget exceeded')];
    state={...state,depth:state.depth+1};
    const trace=this.trace(origin,state,[SERVER+'RequestPredicate']);
    if(trace){const key=`predicate:${trace.file}:${trace.expression.start}`;if(state.seen.has(key))return[opaque('Cyclic WebFlux predicate initializer')];return this.predicate(trace,{...state,seen:new Set([...state.seen,key])});}
    if(state.dsl&&expression.kind==='literal'&&typeof expression.value==='string')return[{...any(),paths:[expression.value],proof:this.proof(origin,'Original Kotlin DSL path predicate')}];
    if(expression.kind==='binary'&&state.dsl&&['and','or'].includes(expression.operator)){
      const a=this.predicate({...origin,expression:expression.left},state),b=this.predicate({...origin,expression:expression.right},state);
      return expression.operator==='and'?this.combine(a,b):a.length+b.length<=128?[...a,...b]:[opaque('WebFlux predicate alternatives exceed the budget')];
    }
    if(expression.kind!=='call'||expression.args.some(argument=>argument.spread||argument.name)||expression.typeArguments)return[opaque('Opaque/unreviewed WebFlux request predicate')];
    const callee=expression.callee,args=expression.args.map(argument=>({...origin,expression:argument.value}));
    if(callee.kind==='member'&&['and','or'].includes(callee.name)&&args.length===1){
      const a=this.predicate({...origin,expression:callee.object},state),b=this.predicate(args[0]!,state);
      return callee.name==='and'?this.combine(a,b):a.length+b.length<=128?[...a,...b]:[opaque('WebFlux predicate alternatives exceed the budget')];
    }
    const external=this.identity({...origin,expression:callee},state),dslName=state.dsl&&callee.kind==='name'&&!this.masked(origin,callee.name)?callee.name:undefined;
    const name=external?.startsWith(REQUEST)?external.slice(REQUEST.length):dslName;
    const proof=this.proof(origin,'Original selected WebFlux request predicate');
    if(name==='all'&&!args.length)return[{...any(),proof}];
    if(name==='path'||name&&METHODS.has(name)){
      if(args.length!==1)return[opaque('WebFlux path predicate requires one original string')];
      const path=this.string(args[0]!);return path===undefined?[opaque('Opaque WebFlux path constant')]:[{...any(),paths:[path],methods:name==='path'?'*':[name],proof}];
    }
    if(name==='method'&&args.length&&args.length<=16){
      const methods=args.map(argument=>this.identity(argument,state)).map(value=>value?.startsWith('org.springframework.http.HttpMethod.')?value.slice('org.springframework.http.HttpMethod.'.length):undefined);
      return methods.every(method=>method&&METHODS.has(method))?[{...any(),methods:[...new Set(methods as string[])],proof}]:[opaque('Unreviewed WebFlux HTTP method identity')];
    }
    if(name==='queryParam'&&args.length===2){const key=this.string(args[0]!),value=this.string(args[1]!);if(key!==undefined&&value!==undefined)return[{...any(),queries:[{name:key,value}],proof}];}
    return[{...opaque(`Unobserved/custom WebFlux predicate ${name??'identity'} requires a reviewed restriction summary`),proof}];
  }
  private owned(definition:JvmDefinition,scope:string):boolean{
    const seen=new Set<string>();let current=definition.unit.scopes.get(scope);
    while(current&&!seen.has(current.key)){seen.add(current.key);if(current.owner)return current.owner===definition.fact.key;current=current.parent?definition.unit.scopes.get(current.parent):undefined;}
    return false;
  }
  private conditional(definition:JvmDefinition,scope:string):boolean{
    const seen=new Set<string>();let current=definition.unit.scopes.get(scope);
    while(current&&!seen.has(current.key)){seen.add(current.key);if(current.conditional||current.kind==='opaque'||current.gaps.some(gap=>gap!=='Implicit Kotlin lambda parameter/receiver requires a selected callable type'))return true;if(current.owner)return current.owner!==definition.fact.key;current=current.parent?definition.unit.scopes.get(current.parent):undefined;}
    return true;
  }
  private masked(origin:Origin,name:string):boolean{
    // DSL names must not borrow framework identity from a shadowing original
    // local/member/import. Exact external aliases are handled separately.
    const definitions=this.symbols.definitions(origin.file),unit=definitions[0]?.unit;if(!unit)return true;
    let scope:JvmScopeFact|undefined=unit.scopes.get(origin.scope);const seen=new Set<string>();
    while(scope&&!seen.has(scope.key)){seen.add(scope.key);if(unit.facts.bindings.some(binding=>binding.scope===scope!.key&&binding.name===name)||definitions.some(definition=>definition.fact.scope===scope!.key&&definition.fact.name===name))return true;scope=scope.parent?unit.scopes.get(scope.parent):undefined;}
    return !!this.symbols.resolver.facts(origin.file)?.imports.some(item=>!item.kind.endsWith('star')&&(item.alias??item.specifier.split('.').at(-1))===name);
  }
  private expressions(definition:JvmDefinition):Origin[]{
    const calls=definition.unit.facts.calls.filter(call=>this.owned(definition,call.scope)).sort((a,b)=>a.start-b.start||b.end-a.end),result:Origin[]=[];let end=-1;
    for(const call of calls){if(call.end<=end)continue;end=call.end;result.push({file:definition.unit.file.path,scope:call.scope,expression:call.expression});}
    return result;
  }
  private handler(origin:Origin,state:State):{definition?:JvmDefinition;reason?:string;proof:Evidence[]}{
    const trace=this.trace(origin,state,[SERVER+'HandlerFunction']);
    if(trace){const key=`handler:${trace.file}:${trace.expression.start}`;if(state.seen.has(key))return{reason:'Cyclic WebFlux handler initializer',proof:[]};return this.handler(trace,{...state,seen:new Set([...state.seen,key])});}
    return this.symbols.functionalHandler(origin.file,origin.scope,origin.expression,SERVER+'ServerRequest',state.dsl==='coRouter'?SERVER+'ServerResponse':'reactor.core.publisher.Mono',state.dsl==='coRouter'?undefined:SERVER+'ServerResponse',state.dsl==='coRouter',state.selectedScopes);
  }
  private route(origin:Origin,predicates:Predicate[],handler:Origin,state:State):Route[]{
    const bound=this.handler(handler,state);
    return predicates.map(predicate=>({origin,predicate,handler:bound.definition,gaps:bound.reason?[bound.reason]:[],proof:[...this.proof(origin,'Original WebFlux functional route registration'),...bound.proof]}));
  }
  private nesting(origin:Origin,predicates:Predicate[],child:Router):Router{
    const routes:Route[]=[];
    if(predicates.length*child.routes.length>2000)return this.unknown(origin,'WebFlux nesting exceeds the route expansion budget');
    const competing=predicates.some((a,index)=>predicates.slice(index+1).some(b=>{
      if(a.methods!=='*'&&b.methods!=='*'&&!a.methods.some(method=>b.methods.includes(method)))return false;
      if(a.queries.some(query=>b.queries.some(other=>other.name===query.name&&other.value!==query.value)))return false;
      const left=a.paths.join(''),right=b.paths.join('');
      if(!left||!right||/[{}*?]/.test(left+right))return true;
      return left===right||left.startsWith(right.replace(/\/$/,'')+'/')||right.startsWith(left.replace(/\/$/,'')+'/');
    }));
    for(const predicate of predicates)for(const route of child.routes){
      const prefix=predicate.paths.join(''), paths=route.predicate.paths.length?route.predicate.paths:['/{*rest}'];
      const combined=paths.map(path=>combineSpringPath(prefix,path)),gaps=[...predicate.gaps,...route.predicate.gaps];
      const uncertainPath=predicate.gaps.length>0||predicate.paths.some(path=>/[?*]/.test(path))||combined.some(path=>!path);
      if(uncertainPath)gaps.push('WebFlux nested wildcard/custom path consumption requires a reviewed native nesting profile');
      if(competing)gaps.push('Overlapping nested OR predicates select their first prefix before the child route; alternatives cannot be flattened as fallback routes');
      routes.push({...route,gaps:[...route.gaps,...child.gaps],predicate:{...this.conjunction(predicate,route.predicate),paths:combined.map(path=>path??'/{*unresolved}'),gaps,...uncertainPath?{uncertainPath:true}:{}},proof:[...this.proof(origin,'Original WebFlux nested registration'),...route.proof]});
    }
    return{...child,routes,gaps:[]};
  }
  private unknown(origin:Origin,reason:string):Router{return{kind:'router',gaps:[],routes:[{origin,predicate:opaque(reason),gaps:[reason],proof:this.proof(origin,reason)}]};}
  private callback(origin:Origin,state:State,consumer:boolean):Router{
    if(origin.expression.kind!=='lambda')return this.unknown(origin,'WebFlux builder callback is not an original inline lambda');
    const definition=this.symbols.definition(origin.file,origin.expression.key);if(!definition?.fact.bodyScope)return this.unknown(origin,'Original WebFlux builder lambda is unavailable');
    const parameters=definition.fact.parameters,body=definition.fact.bodyScope,next:State={...state,selectedScopes:[...state.selectedScopes,body],builders:new Map(state.builders),depth:state.depth+1};
    if(consumer){if(parameters.length!==1||!parameters[0]?.name)return this.unknown(origin,'WebFlux Consumer<Builder> requires one original builder parameter');next.builders.set(`${origin.file}:${body}:${parameters[0].name}`,{kind:'builder',routes:[],gaps:[]});}
    else if(parameters.length)return this.unknown(origin,'WebFlux router supplier requires no original parameters');
    const expressions=this.expressions(definition);if(expressions.length!==1||this.conditional(definition,expressions[0]!.scope))return this.unknown(origin,'WebFlux callback has conditional/multiple/opaque builder statements');
    return this.router(expressions[0]!,next);
  }
  private dsl(origin:Origin,mode:'router'|'coRouter',state:State):Router{
    if(origin.expression.kind!=='lambda')return this.unknown(origin,'WebFlux Kotlin DSL requires an original inline block');
    const definition=this.symbols.definition(origin.file,origin.expression.key);if(!definition?.fact.bodyScope||definition.fact.parameters.length)return this.unknown(origin,'WebFlux Kotlin DSL receiver block has an unreviewed parameter shape');
    const next:State={...state,dsl:mode,selectedScopes:[...state.selectedScopes,definition.fact.bodyScope],depth:state.depth+1},result:Router={kind:'router',routes:[],gaps:[]};
    const calls=this.expressions(definition);
    for(const call of calls){
      if(this.conditional(definition,call.scope)){result.routes.push(...this.unknown(call,'Conditional/deferred WebFlux DSL registration').routes);continue;}
      // A local immutable initializer is read only when its original value is
      // subsequently added. It is not registered merely by being constructed.
      if(definition.unit.facts.bindings.some(binding=>binding.value&&binding.value.start<=call.expression.start&&binding.value.end>=call.expression.end))continue;
      const callee=call.expression.kind==='call'?call.expression.callee:undefined;
      const registration=callee&&(callee.kind==='name'&&!this.masked(call,callee.name)||callee.kind==='member'&&callee.name==='nest'||['literal','binary','call'].includes(callee.kind));
      if(!registration){result.gaps.push('Standalone/custom builder mutation in a Kotlin DSL block requires a reviewed activation/order summary');continue;}
      const value=this.router(call,next);result.routes.push(...value.routes);result.gaps.push(...value.gaps);
    }
    if(definition.unit.facts.writes.some(write=>this.owned(definition,write.scope)))result.gaps.push('Mutable WebFlux DSL registration state is outside the reviewed interpretation');
    return result;
  }
  private router(origin:Origin,state:State):Router{
    const expression=origin.expression;if(++this.operations>100_000||state.depth>48)return this.unknown(origin,'WebFlux interpretation budget exceeded');state={...state,depth:state.depth+1};
    if(expression.kind==='name'){
      const unit=this.symbols.definitions(origin.file)[0]?.unit,seen=new Set<string>();let scope=unit?.scopes.get(origin.scope);
      while(scope&&!seen.has(scope.key)){
        seen.add(scope.key);const bindings=unit!.facts.bindings.filter(binding=>binding.scope===scope!.key&&binding.name===expression.name);
        if(bindings.length){const value=bindings.length===1&&bindings[0]!.kind==='parameter'?state.builders.get(`${origin.file}:${scope.key}:${expression.name}`):undefined;if(value)return value;break;}
        scope=scope.parent?unit?.scopes.get(scope.parent):undefined;
      }
    }
    const trace=this.trace(origin,state,[SERVER+'RouterFunction',SERVER+'RouterFunctions.Builder']);
    if(trace){
      const key=`router:${trace.file}:${trace.expression.start}`;if(state.seen.has(key))return this.unknown(origin,'Cyclic original WebFlux router initializer');
      const router=this.router(trace,{...state,seen:new Set([...state.seen,key])});
      if(trace.storage==='property'&&router.kind==='builder')router.gaps.push('A shared mutable builder field can be changed by other bean/lifecycle calls; construction order is unavailable');
      return router;
    }
    if(expression.kind!=='call'||expression.typeArguments||expression.args.some(argument=>argument.name||argument.spread))return this.unknown(origin,'Opaque/custom WebFlux router value');
    const callee=expression.callee,args=expression.args.map(argument=>({...origin,expression:argument.value})),external=this.identity({...origin,expression:callee},state);
    if(external===SERVER+'router'||external===SERVER+'coRouter')return args.length===1?this.dsl(args[0]!,external.endsWith('coRouter')?'coRouter':'router',state):this.unknown(origin,'Invalid Kotlin router DSL argument shape');
    if(external===ROUTERS+'route'){
      if(!args.length)return{kind:'builder',routes:[],gaps:[]};
      if(args.length===2)return{kind:'router',routes:this.route(origin,this.predicate(args[0]!,state),args[1]!,state),gaps:[]};
      return this.unknown(origin,'Invalid WebFlux route factory arguments');
    }
    if(external===ROUTERS+'nest'&&args.length===2)return this.nesting(origin,this.predicate(args[0]!,state),this.router(args[1]!,state));
    if(state.dsl&&args.length===1&&args[0]!.expression.kind==='lambda'&&['literal','binary','call'].includes(callee.kind))return{kind:'router',routes:this.route(origin,this.predicate({...origin,expression:callee},state),args[0]!,state),gaps:[]};
    let name:string|undefined,receiver:Router|undefined;
    if(callee.kind==='member'){
      name=callee.name;
      if(state.dsl&&name==='nest'&&args.length===1){const predicates=this.predicate({...origin,expression:callee.object},state);return this.nesting(origin,predicates,this.dsl(args[0]!,state.dsl,state));}
      receiver=this.router({...origin,expression:callee.object},state);
    }else if(state.dsl&&callee.kind==='name'&&!this.masked(origin,callee.name)){name=callee.name;receiver={kind:'builder',routes:[],gaps:[]};}
    if(!name||!receiver)return this.unknown(origin,'Router call is not a selected WebFlux builder/DSL identity');
    if(name==='build'&&!args.length&&receiver.kind==='builder')return{...receiver,kind:'router'};
    if(['withAttribute','withAttributes'].includes(name))return{...receiver,gaps:[...receiver.gaps,'WebFlux attributes can affect custom predicates/filters and require a reviewed summary']};
    if(['filter','before','after','onError','context'].includes(name))return{...receiver,gaps:[...receiver.gaps,`Unreviewed WebFlux ${name} callback can alter handler execution`]};
    if(['add','and','andOther'].includes(name)&&args.length===1){const child=this.router(args[0]!,state);return{...receiver,routes:[...receiver.routes,...child.routes.map(route=>({...route,gaps:[...route.gaps,...child.gaps]}))]};}
    if(name==='andRoute'&&args.length===2)return{...receiver,routes:[...receiver.routes,...this.route(origin,this.predicate(args[0]!,state),args[1]!,state)]};
    if((name==='path'||name==='nest')&&args.length===2&&receiver.kind==='builder'){
      const predicates=name==='path'?(()=>{const value=this.string(args[0]!);return[value===undefined?opaque('Opaque nested WebFlux path'):{...any(),paths:[value]}];})():this.predicate(args[0]!,state);
      const lambda=args[1]!.expression,definition=lambda.kind==='lambda'?this.symbols.definition(origin.file,lambda.key):undefined,child=this.callback(args[1]!,state,!!definition?.fact.parameters.length),nested=this.nesting(origin,predicates,child);
      return{...receiver,routes:[...receiver.routes,...nested.routes],gaps:[...receiver.gaps,...nested.gaps]};
    }
    if(name==='route'&&args.length===2&&receiver.kind==='builder')return{...receiver,routes:[...receiver.routes,...this.route(origin,this.predicate(args[0]!,state),args[1]!,state)]};
    if(METHODS.has(name)&&receiver.kind==='builder'&&args.length>=1&&args.length<=3){
      const handler=args.at(-1)!,conditions=args.slice(0,-1);let predicates=[{...any(),methods:[name]} as Predicate];
      for(const argument of conditions){const value=this.string(argument);predicates=this.combine(predicates,value===undefined?this.predicate(argument,state):[{...any(),paths:[value],proof:this.proof(argument,'Original WebFlux path literal/constant')}]);}
      return{...receiver,routes:[...receiver.routes,...this.route(origin,predicates,handler,state)]};
    }
    return{...receiver,routes:[...receiver.routes,...this.unknown(origin,`Unreviewed WebFlux builder operation ${name}`).routes]};
  }
  private factory(definition:JvmDefinition):Router{
    const returns=definition.unit.facts.returns.filter(item=>this.owned(definition,item.scope)),origin:Origin={file:definition.unit.file.path,scope:definition.fact.scope,expression:{...definition.fact,kind:'name',name:definition.fact.name}};
    if(returns.length!==1||this.conditional(definition,returns[0]?.scope??''))return this.unknown(origin,'Router bean requires one unconditional original return value');
    const returned=returns[0]!,result=this.router({file:origin.file,scope:returned.scope,expression:returned.value},initial());
    if(result.kind!=='router')result.gaps.push('WebFlux builder was not built into a RouterFunction');
    const calls=this.expressions(definition).filter(call=>!(call.expression.start>=returned.value.start&&call.expression.end<=returned.value.end)&&!definition.unit.facts.bindings.some(binding=>binding.value&&binding.value.start<=call.expression.start&&binding.value.end>=call.expression.end));
    if(calls.length||definition.unit.facts.writes.some(write=>this.owned(definition,write.scope)))result.gaps.push('Additional/mutable router factory statements can alter registration');
    const initializerMutation=definition.unit.facts.calls.some(call=>{
      if(!this.owned(definition,call.scope)||call.expression.kind!=='call')return false;
      const callee=call.expression.callee;
      if(callee.kind!=='member'||callee.object.kind!=='name'||!['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS','add','path','nest','route','filter','before','after'].includes(callee.name))return false;
      const external=this.identity({file:origin.file,scope:call.scope,expression:callee},initial());
      if(external&&(external.startsWith(REQUEST)||external.startsWith(ROUTERS)))return false;
      return definition.unit.facts.bindings.some(binding=>binding.value&&binding.value.start<=call.start&&binding.value.end>=call.end);
    });
    if(initializerMutation)result.gaps.push('A local initializer mutates a separate captured builder; activation/order requires a reviewed summary');
    return result;
  }
  run(files:ScannedFile[]):void{
    const profiles:unknown[]=[];
    for(const app of this.context.config.applications){
      if(app.jvm?.spring?.stack==='mvc')continue;
      const definitions=files.filter(file=>file.application?.name===app.name).flatMap(file=>this.symbols.definitions(file.path));
      const beans=definitions.filter(definition=>['method','function'].includes(definition.fact.kind)&&this.annotationNames(definition).includes(CONFIG+'Bean'));
      const projects=[...new Set(beans.map(bean=>bean.symbol?.project).filter(Boolean))];
      for(const project of projects){
        if(!project)continue;
        this.operations=0;const profile=springWebFluxProfile(this.context,this.symbols.resolver.projects,project,app),rootGaps=[...profile.gaps],packages=[...profile.config.componentScan??[]],selected=[...profile.config.routers??[]],entries=app.entrypoints?.spring??[];
        const available=definitions.filter(definition=>definition.symbol?.project.id===project.id);
        let activated=app.jvm?.spring?.stack==='webflux'&&(packages.length>0||selected.length>0);
        for(const entry of entries){
          const roots=available.filter(definition=>definition.symbol?.syntax.qualifiedName===entry&&definition.fact.kind==='class');
          if(roots.length!==1){rootGaps.push(`Unavailable/ambiguous WebFlux entry configuration ${entry}`);continue;}
          const root=roots[0]!,names=this.annotationNames(root),boot=names.includes('org.springframework.boot.autoconfigure.SpringBootApplication');
          if(!boot&&!(names.includes(CONFIG+'Configuration')&&names.includes('org.springframework.web.reactive.config.EnableWebFlux'))){rootGaps.push('Selected root does not activate a reviewed WebFlux configuration');continue;}
          activated=true;if(boot)packages.push(root.symbol!.package);selected.push(...beans.filter(bean=>bean.fact.parent===root.fact.key&&bean.unit===root.unit).map(bean=>bean.symbol!.syntax.qualifiedName));
          if(boot&&!profile.bootVersion)rootGaps.push('SpringBootApplication requires a selected reviewed Boot WebFlux profile');
          rootGaps.push(...this.configurationGaps(root));
          if(root.fact.bases.length||root.fact.parent||names.some(name=>![CONFIG+'Configuration','org.springframework.web.reactive.config.EnableWebFlux','org.springframework.boot.autoconfigure.SpringBootApplication'].includes(name))||root.fact.annotations.some((annotation,index)=>this.annotation(root,index)!==CONFIG+'Configuration'&&annotation.args.length))rootGaps.push('Custom/conditional/inherited WebFlux root configuration requires a reviewed activation profile');
        }
        if(!activated)rootGaps.push('No selected WebFlux entry configuration or recorded reactive scan/router beans');
        // Annotated controllers, custom mappings/security and imported bean
        // definitions can introduce other runtime dispatch/guard competitors.
        for(const definition of available){const names=this.annotationNames(definition);if(definition.fact.bases.some(base=>base.kind==='name'&&/WebFluxConfigurer|WebFluxConfigurationSupport|RouterFunctionMapping/.test(base.name))||names.some(name=>[CONFIG+'Import',CONFIG+'ImportResource','org.springframework.web.bind.annotation.RestController','org.springframework.stereotype.Controller','org.springframework.security.config.annotation.web.reactive.EnableWebFluxSecurity'].includes(name)))rootGaps.push('Custom/imported/annotated/security WebFlux configuration requires a reviewed competing registration summary');}
        const visible=new Set(this.symbols.resolver.projects.classpath(project).projects.filter(item=>item.id!==project.id).map(item=>item.id));
        for(const file of this.context.files.values())for(const definition of this.symbols.definitions(file.path))if(definition.symbol&&visible.has(definition.symbol.project.id)&&this.annotationNames(definition).some(name=>[CONFIG+'Configuration',CONFIG+'Bean','org.springframework.stereotype.Component','org.springframework.web.bind.annotation.RestController','org.springframework.stereotype.Controller'].includes(name)))rootGaps.push('Visible dependency source contributes bean/controller configuration outside this selected router context');
        for(const bean of beans){const type=bean.fact.returnType,base=type?.kind==='generic-type'?type.name:type;if(base&&['org.springframework.security.web.server.SecurityWebFilterChain','org.springframework.web.server.WebFilter'].includes(this.identity({file:bean.unit.file.path,scope:bean.fact.scope,expression:base},initial(),true)??''))rootGaps.push('Original WebFlux security/filter bean can guard or alter request dispatch');}
        for(const unit of new Set(available.map(definition=>definition.unit)))if(unit.facts.calls.some(call=>call.expression.kind==='call'&&call.expression.callee.kind==='member'&&['setRouterFunction','setPathPatternParser','configurePathMatching','registerBean','registerSingleton','setUseCaseSensitiveMatch','setUseTrailingSlashMatch'].includes(call.expression.callee.name)))rootGaps.push('Programmatic/custom WebFlux registration requires a reviewed configuration summary');
        const factories=beans.filter(bean=>bean.symbol?.project.id===project.id&&(()=>{const type=bean.fact.returnType,base=type?.kind==='generic-type'?type.name:type;return base&&this.identity({file:bean.unit.file.path,scope:bean.fact.scope,expression:base},initial(),true)===SERVER+'RouterFunction'||!type&&bean.unit.file.language==='kotlin';})());
        if(new Set(factories.map(bean=>bean.fact.name)).size!==factories.length)rootGaps.push('Competing original router bean names require selected overriding/bean-registration inputs');
        const orders=factories.map(bean=>{const index=bean.fact.annotations.findIndex((_annotation,index)=>this.annotation(bean,index)==='org.springframework.core.annotation.Order'),annotation=bean.fact.annotations[index];if(!annotation||annotation.args.length!==1)return undefined;const value=this.symbols.constant(bean.unit.file.path,bean.fact.scope,annotation.args[0]!.value);return value.status==='resolved'&&typeof value.value==='number'&&Number.isInteger(value.value)&&value.value>=-2147483648&&value.value<=2147483647?value.value:undefined;});
        const ordered=factories.length<=1||orders.every(order=>order!==undefined)&&new Set(orders).size===factories.length;
        const sorted=factories.map((bean,index)=>({bean,order:orders[index]})).sort((a,b)=>ordered?(a.order??0)-(b.order??0):a.bean.id.localeCompare(b.bean.id));let ordinal=0;
        const contextId=this.context.graph.id('spring-webflux-context',app.name,project.id);
        for(const {bean}of sorted){
          const owner=bean.fact.parent?bean.unit.definitions.get(bean.fact.parent):undefined,pkg=owner?.symbol?.package??bean.symbol!.package,names=owner?this.annotationNames(owner):[],registered=selected.includes(bean.symbol!.syntax.qualifiedName)||packages.some(root=>pkg===root||pkg.startsWith(root+'.'))&&names.includes(CONFIG+'Configuration');
          const gaps=[...rootGaps,...!registered?['Original router bean is outside the selected WebFlux configuration/scan']:[]];
          if(owner)gaps.push(...this.configurationGaps(owner));
          if(owner?.fact.typeParameters.length||owner?.fact.modifiers.includes('abstract'))gaps.push('Generic/abstract configuration requires a reviewed activation profile');
          const type=bean.fact.returnType;
          if(type&&(type.kind!=='generic-type'||type.arguments.length!==1||this.identity({file:bean.unit.file.path,scope:bean.fact.scope,expression:type.arguments[0]!},initial(),true)!==SERVER+'ServerResponse'&&!(type.arguments[0]?.kind==='unknown'&&['?','*'].includes(type.arguments[0].text))))gaps.push('Router bean has an unreviewed declared generic result type');
          if(!owner||owner.fact.bases.length||owner.fact.parent||names.some(name=>![CONFIG+'Configuration','org.springframework.web.reactive.config.EnableWebFlux','org.springframework.boot.autoconfigure.SpringBootApplication'].includes(name))||bean.fact.parameters.length||bean.fact.typeParameters.length||bean.fact.receiverType||bean.fact.modifiers.some(modifier=>['abstract','native','external','expect','actual'].includes(modifier))||this.annotationNames(bean).some(name=>![CONFIG+'Bean','org.springframework.core.annotation.Order'].includes(name))||bean.fact.annotations.some(annotation=>this.identity({file:bean.unit.file.path,scope:bean.fact.scope,expression:annotation.type},initial(),true)===CONFIG+'Bean'&&annotation.args.length))gaps.push('Conditional/injected/custom WebFlux bean factory requires a reviewed registration profile');
          const router=this.factory(bean),root=ordered?contextId:contextId+':'+bean.id;
          if(!router.routes.length&&router.gaps.length)router.routes.push(...this.unknown({file:bean.unit.file.path,scope:bean.fact.scope,expression:{...bean.fact,kind:'name',name:bean.fact.name}},'Incomplete empty WebFlux router registration').routes);
          let beanOrdinal=0;
          for(const route of router.routes.slice(0,20_000)){
            const paths=route.predicate.paths.length?route.predicate.paths:['/{*rest}'],base=profile.config.basePath??'',patterns=paths.map(value=>compileSpringPath(base+(value.startsWith('/')?value:'/'+value),profile.dialect??'spring-path-6.2')),conditions=[...new Set([...gaps,...router.gaps,...route.gaps,...route.predicate.gaps,...patterns.filter(pattern=>pattern.status==='partial').map(pattern=>pattern.reason!)])];
            const pattern=patterns[0]!,routePath=pattern.original,order=ordinal++,id=this.context.graph.id('endpoint','spring-webflux',contextId,bean.id,route.origin.file,String(beanOrdinal++));
            if(!profile.dialect||route.predicate.uncertainPath){pattern.status='partial';pattern.prefix=base+'/';pattern.reason=conditions.join('; ');patterns.splice(1);}
            const contract:RoutingContract={version:1,pattern,methods:route.predicate.methods,executionContext:'server',registration:{file:route.origin.file,line:route.origin.expression.range.startLine,receiver:bean.symbol!.syntax.qualifiedName},mounts:[],middleware:[],conditions,dispatch:{dialect:'spring-webflux',root,order},queries:route.predicate.queries,guards:patterns.slice(1).map(guard=>({version:1,pattern:guard,methods:'*',executionContext:'server',registration:{file:route.origin.file,line:route.origin.expression.range.startLine,receiver:bean.symbol!.syntax.qualifiedName},mounts:[],middleware:[],conditions:[]}))};
            const proof=[...profile.proof,...this.proof(route.origin,'Selected original WebFlux bean/factory route contract'),...route.predicate.proof,...route.proof,...bean.symbol?.proof??[]];
            this.context.graph.contain({id,type:'api_endpoint',name:`${contract.methods==='*'?'ANY':contract.methods.join('|')} ${routePath}`,path:route.origin.file,language:bean.unit.file.language,parentId:this.context.applicationIds.get(app.name),sourceRange:route.origin.expression.range,metadata:{framework:'spring-webflux',packVersion:WEBFLUX_VERSION,frameworkVersion:profile.version,routePath,method:contract.methods==='*'?'ANY':contract.methods.length===1?contract.methods[0]:'ANY',routing:contract,executionContext:'server',registration:conditions.length?'candidate':'selected',constraintsUnresolved:conditions.length>0,handler:route.handler?.id,factory:bean.id,beanOrdering:ordered?'selected':'unresolved'},evidence:proof});
            if(route.handler)this.context.graph.relate(id,route.handler.id,'handles',proof,{framework:'spring-webflux',version:WEBFLUX_VERSION,conditions});
          }
          if(router.routes.length>20_000)for(const entity of this.context.graph.entities.values()){const routing=entity.metadata.routing as RoutingContract|undefined;if(entity.metadata.factory===bean.id&&routing){entity.metadata.constraintsUnresolved=true;routing.conditions.push('WebFlux endpoint expansion exceeds the route budget');}}
          this.context.graph.entities.get(bean.id)!.metadata.springWebFluxFactory={context:contextId,registration:registered?'selected':'unresolved',gaps:[...gaps,...router.gaps],beanOrdering:ordered?'selected':'unresolved'};
          const analysis=fileAnalysis(this.context.graph.entities.get(bean.unit.file.id)!.metadata.analysis);if(analysis)analysis.features.framework={status:'partial',reason:'Selected original WebFlux.fn bean routes, Java builders/Kotlin DSL, direct functional handlers, bounded predicates and ordered dispatch; runtime bean/proxy/filter/custom registration remains unresolved'};
        }
        profiles.push({application:app.name,project:project.id,version:profile.version,bootVersion:profile.bootVersion,basePath:profile.config.basePath,packages,routers:selected,beanOrdering:ordered?'selected':'unresolved',gaps:[...new Set(rootGaps)],proof:profile.proof});
        for(const reason of new Set(rootGaps))this.context.graph.diagnose({analyzer:'spring-webflux',severity:'warning',code:'spring-webflux-context-gap',file:project.manifest,reason});
      }
    }
    if(profiles.length)this.context.graph.entities.get(this.context.repositoryId)!.metadata.springWebFluxProfiles=profiles;
  }
}
