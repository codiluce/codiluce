import type { AnalysisContext, ScannedFile } from '../../core/analyzer.js';
import type { ApplicationConfig } from '../../core/config.js';
import { evidence, type Evidence } from '../../core/graph.js';
import { fileAnalysis, type JvmAnnotationFact, type JvmExpression } from '../facts.js';
import type { JvmDefinition, JvmSymbols } from '../languages/jvm-symbols.js';
import { springMvcProfile, SPRING_VERSION, type SpringMvcProfile } from './spring-profile.js';
import { combineSpringPath, compileSpringPath, springNameCondition } from '../routes/spring-patterns.js';
import type { RoutingContract } from '../routes/contracts.js';
const WEB = 'org.springframework.web.bind.annotation.';
const SHORTCUTS: Record<string,string> = { GetMapping:'GET', PostMapping:'POST', PutMapping:'PUT', PatchMapping:'PATCH', DeleteMapping:'DELETE' };
const HTTP_METHODS = new Set(['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS','TRACE']);
interface Mapping { paths: string[]; methods: string[]; params: string[]; headers: string[]; consumes: string[]; produces: string[]; gaps: string[]; proof: Evidence[] }
interface Registration { packages: string[]; controllers: string[]; gaps: string[]; proof: Evidence[] }
const emptyMapping = (): Mapping => ({paths:[''],methods:[],params:[],headers:[],consumes:[],produces:[],gaps:[],proof:[]});
/** Original servlet MVC annotations and original handler identities. Runtime
 * bean creation, proxies, filters, SpEL, compiler plugins and target builds are
 * never executed; incomplete registration remains a constrained competitor. */
export class SpringMvc {
  constructor(readonly context: AnalysisContext, readonly symbols: JvmSymbols) {}
  private proof(file: string, annotation: JvmAnnotationFact, explanation: string): Evidence[] {
    return [{ ...evidence('framework','spring-mvc',file,annotation.range.startLine,explanation), analyzerVersion:SPRING_VERSION,endLine:annotation.range.endLine }];
  }
  private identity(definition: JvmDefinition, annotation: JvmAnnotationFact): { name?:string; proof:Evidence[]; reason?:string } {
    if (annotation.target) return {proof:[],reason:'Kotlin annotation use-site target requires a reviewed controller profile'};
    const bound = this.symbols.bound(definition.unit.file.path,definition.fact.scope,annotation.type,true);
    if (bound.kind === 'external') return {name:bound.name,proof:[...bound.proof,...this.proof(definition.unit.file.path,annotation,`Selected external annotation spelling ${bound.name}`)]};
    if (bound.kind === 'type') return {proof:bound.proof,reason:'Annotation binds an original source declaration; framework identity is not assumed from its spelling'};
    return {proof:bound.proof,reason:bound.kind==='unknown'?bound.reason:'Annotation identity is outside the reviewed source type profile'};
  }
  private strings(definition: JvmDefinition, value: JvmExpression): { values?:string[]; proof:Evidence[]; reason?:string } {
    const result = this.symbols.constant(definition.unit.file.path,definition.fact.scope,value);
    if(result.status==='unresolved')return {proof:result.proof,reason:result.reason};
    const values=Array.isArray(result.value)?result.value:[result.value];
    return values.length<=128&&values.every(item=>typeof item==='string'&&item.length<=4096)?{values:values as string[],proof:result.proof}:{proof:result.proof,reason:'Expected bounded original annotation string/string-array value'};
  }
  private methodValues(definition:JvmDefinition,value:JvmExpression):{values?:string[];proof:Evidence[];reason?:string}{
    const expressions=value.kind==='array'?value.items:[value], methods:string[]=[],proof:Evidence[]=[];
    if(expressions.length>16)return{proof,reason:'Spring method array exceeds the annotation budget'};
    for(const expression of expressions){
      const bound=this.symbols.bound(definition.unit.file.path,definition.fact.scope,expression);
      if(bound.kind!=='external'||!bound.name.startsWith(WEB+'RequestMethod.')||!HTTP_METHODS.has(bound.name.slice((WEB+'RequestMethod.').length)))return{proof:bound.proof,reason:'Spring request method does not bind the selected external RequestMethod enum'};
      methods.push(bound.name.slice((WEB+'RequestMethod.').length));proof.push(...bound.proof);
    }
    return{values:[...new Set(methods)],proof};
  }
  private mapping(definition:JvmDefinition):Mapping|undefined{
    const selected=definition.fact.annotations.map(annotation=>({annotation,identity:this.identity(definition,annotation)})).filter(item=>item.identity.name===WEB+'RequestMapping'||item.identity.name?.startsWith(WEB)&&SHORTCUTS[item.identity.name.slice(WEB.length)]);
    if(!selected.length)return undefined;
    const mapping=emptyMapping(), first=selected[0]!,name=first.identity.name!.slice(WEB.length),values=new Map<string,JvmExpression>();
    mapping.proof.push(...first.identity.proof);
    if(selected.length>1)mapping.gaps.push('Multiple mapping annotations on one element require the framework first-mapping selection; alternatives are not unioned');
    if(SHORTCUTS[name])mapping.methods=[SHORTCUTS[name]!];
    for(const argument of first.annotation.args){const key=argument.name??'value';if(argument.spread||values.has(key)){mapping.gaps.push('Duplicate/spread Spring annotation argument');continue;}values.set(key,argument.value);}
    if(values.has('path')&&values.has('value'))mapping.gaps.push('Competing Spring path/value aliases require merged-annotation validation');
    for(const [key,value]of values){
      if(!['path','value','method','params','headers','consumes','produces','name'].includes(key)){mapping.gaps.push(`Unreviewed Spring mapping attribute ${key}`);continue;}
      if(key==='name')continue;
      const result=key==='method'?this.methodValues(definition,value):this.strings(definition,value);mapping.proof.push(...result.proof);
      if(!result.values){mapping.gaps.push(result.reason??'Opaque Spring annotation value');continue;}
      if(key==='path'||key==='value')mapping.paths=result.values.length?[...new Set(result.values)]:[''];
      else if(key==='method'){if(name!=='RequestMapping')mapping.gaps.push('Composed HTTP annotation method override is outside its declared API');else mapping.methods=result.values;}
      else mapping[key as 'params'|'headers'|'consumes'|'produces']=result.values;
    }
    if(mapping.paths.some(path=>path.includes('${')||path.includes('#{')))mapping.gaps.push('Spring property/SpEL path placeholders require selected runtime property sources');
    return mapping;
  }
  private registration(app:ApplicationConfig,profile:SpringMvcProfile,definitions:JvmDefinition[]):Registration{
    const registration:Registration={packages:[...profile.config.componentScan??[]],controllers:[...profile.config.controllers??[]],gaps:[],proof:[]};
    if(profile.config.componentScan||profile.config.controllers)registration.proof.push({...evidence('framework','spring-mvc',undefined,undefined,`Recorded Spring scan/controller-bean selection for ${app.name}`),analyzerVersion:SPRING_VERSION});
    const entries=app.entrypoints?.spring??[];
    for(const entry of entries){
      const roots=definitions.filter(definition=>definition.symbol?.syntax.qualifiedName===entry&&definition.fact.kind==='class');
      if(roots.length!==1){registration.gaps.push(`Spring entry configuration is unavailable or ambiguous: ${entry}`);continue;}
      const root=roots[0]!,annotations=root.fact.annotations.map(annotation=>({annotation,identity:this.identity(root,annotation)}));
      const boot=annotations.find(item=>item.identity.name==='org.springframework.boot.autoconfigure.SpringBootApplication'), scan=annotations.find(item=>item.identity.name==='org.springframework.context.annotation.ComponentScan');
      const plain=annotations.some(item=>item.identity.name==='org.springframework.context.annotation.Configuration')&&annotations.some(item=>item.identity.name==='org.springframework.web.servlet.config.annotation.EnableWebMvc');
      if(root.fact.parent||root.fact.bases.length)registration.gaps.push('Nested/inherited Spring root configuration requires a reviewed activation profile');
      for(const item of annotations.filter(item=>['org.springframework.context.annotation.Configuration','org.springframework.web.servlet.config.annotation.EnableWebMvc'].includes(item.identity.name??'')))if(item.annotation.args.length)registration.gaps.push('Custom Spring MVC/configuration annotation options require a reviewed activation profile');
      if(boot&&!profile.bootVersion)registration.gaps.push('SpringBootApplication requires a selected reviewed Boot MVC profile');
      if(!boot&&!plain){registration.gaps.push('Selected Spring root is not a reviewed Boot application or explicit MVC configuration');continue;}
      for(const item of annotations)if(!['org.springframework.boot.autoconfigure.SpringBootApplication','org.springframework.context.annotation.Configuration','org.springframework.context.annotation.ComponentScan','org.springframework.web.servlet.config.annotation.EnableWebMvc'].includes(item.identity.name??''))registration.gaps.push('Selected Spring root has conditional/custom/unreviewed configuration annotations');
      const source=scan??boot;
      if(source){
        registration.proof.push(...source.identity.proof);
        let explicit=false;
        for(const argument of source.annotation.args){
          const key=argument.name??'value';
          if(['value','basePackages','scanBasePackages'].includes(key)){
            const result=this.strings(root,argument.value);registration.proof.push(...result.proof);
            if(result.values){explicit=true;registration.packages.push(...result.values);}else registration.gaps.push(result.reason??'Opaque component scan packages');
          }else registration.gaps.push(`Unreviewed Spring component/Boot configuration option ${key}`);
        }
        if(!explicit)registration.packages.push(root.symbol?.package??'');
      }else if(!registration.packages.length&&!registration.controllers.length)registration.gaps.push('Plain Spring MVC requires selected component scans or controller bean registrations');
    }
    if(!entries.length&&!registration.packages.length&&!registration.controllers.length)registration.gaps.push('No selected Spring entry configuration, scan packages or explicit controller beans');
    return registration;
  }
  run(files:ScannedFile[]):void{
    const repository=this.context.graph.entities.get(this.context.repositoryId)!,profiles:unknown[]=[];
    for(const app of this.context.config.applications){
      if(app.jvm?.spring?.stack==='webflux')continue;
      const selected=files.filter(file=>file.application?.name===app.name),definitions=selected.flatMap(file=>this.symbols.definitions(file.path)),controllers=definitions.filter(definition=>definition.fact.kind==='class'&&definition.fact.annotations.some(annotation=>['org.springframework.stereotype.Controller',WEB+'RestController'].includes(this.identity(definition,annotation).name??'')));
      if(!controllers.length&&!app.frameworks.some(name=>['spring','spring-boot'].includes(name))&&!app.jvm?.spring)continue;
      const projects=[...new Set(selected.map(file=>this.symbols.resolver.projects.selection(file.path).project).filter(Boolean))];
      for(const project of projects){
        if(!project)continue;
        const profile=springMvcProfile(this.context,this.symbols.resolver.projects,project,app),visible=this.symbols.resolver.projects.classpath(project).projects,visibleIds=new Set(visible.map(item=>item.id)),available=definitions.filter(definition=>definition.symbol&&visibleIds.has(definition.symbol.project.id)),registration=this.registration(app,profile,available),rootId=this.context.graph.id('spring-context',app.name,project.id),rootGaps=[...profile.gaps,...registration.gaps];
        for(const definition of available){
          const annotationNames=definition.fact.annotations.map(annotation=>this.identity(definition,annotation).name);
          if(definition.fact.bases.some(base=>base.kind==='name'&&/WebMvcConfigurer|WebMvcConfigurationSupport|RequestMappingHandlerMapping/.test(base.name))||annotationNames.some(name=>name&&['org.springframework.context.annotation.Import','org.springframework.context.annotation.ImportResource'].includes(name)))rootGaps.push('Custom/imported Spring MVC configuration can alter handler registration/path matching');
        }
        for(const unit of new Set(available.map(definition=>definition.unit)))if(unit.facts.calls.some(call=>call.expression.kind==='call'&&call.expression.callee.kind==='member'&&['registerMapping','unregisterMapping','setPatternParser','setPathMatcher','addPathPrefix','setUseTrailingSlashMatch','configureApiVersioning'].includes(call.expression.callee.name)))rootGaps.push('Programmatic/custom Spring mapping configuration requires a reviewed registration summary');
        for(const reason of new Set(rootGaps))this.context.graph.diagnose({analyzer:'spring-mvc',severity:'warning',code:'spring-mvc-context-gap',file:project.manifest,entityId:this.context.applicationIds.get(app.name),reason});
        profiles.push({application:app.name,project:project.id,version:profile.version,bootVersion:profile.bootVersion,dialect:profile.dialect,packages:registration.packages,controllers:registration.controllers,gaps:rootGaps,proof:[...profile.proof,...registration.proof]});
        let order=0,exhausted=false;
        controllersLoop: for(const controller of controllers.filter(definition=>definition.symbol?.project.id===project.id)){
          const file=controller.unit.file,environment=this.symbols.resolver.environment(file.path),gaps=[...rootGaps,...environment.status==='resolved'?[]:[environment.reason]],name=controller.symbol!.syntax.qualifiedName,pkg=controller.symbol!.package;
          const registered=registration.controllers.includes(name)||registration.packages.some(root=>root===''||pkg===root||pkg.startsWith(root+'.'));
          if(!registered)gaps.push('Original controller is outside the selected component-scan/controller-bean registration');
          if(controller.fact.parent||controller.fact.bases.length||controller.fact.typeParameters.length||controller.fact.modifiers.some(modifier=>['abstract','expect','actual'].includes(modifier)))gaps.push('Nested/inherited/generic/abstract controller requires a reviewed original registration/handler profile');
          const controllerIdentities=controller.fact.annotations.map(annotation=>this.identity(controller,annotation));
          if(controllerIdentities.some(identity=>!identity.name||!['org.springframework.stereotype.Controller',WEB+'RestController',WEB+'RequestMapping'].includes(identity.name)))gaps.push('Controller has custom/conditional/security annotations requiring a reviewed bean/guard profile');
          const parent=this.mapping(controller)??emptyMapping();
          this.context.graph.entities.get(controller.id)!.metadata.springController={version:SPRING_VERSION,context:rootId,registration:registered?'selected':'unresolved',gaps};
          for(const handler of available.filter(definition=>definition.unit===controller.unit&&definition.fact.parent===controller.fact.key&&['method','function'].includes(definition.fact.kind))){
            const mapping=this.mapping(handler);if(!mapping)continue;
            const conditions=[...gaps,...parent.gaps,...mapping.gaps];
            if(handler.fact.modifiers.some(modifier=>['abstract','static','native','external','expect','actual'].includes(modifier))||handler.fact.typeParameters.length||handler.fact.receiverType)conditions.push('Handler shape requires a reviewed original JVM MVC method profile');
            const params=[...parent.params,...mapping.params].map(springNameCondition),headers=[...parent.headers,...mapping.headers].map(springNameCondition),consumes=mapping.consumes.length?mapping.consumes:parent.consumes,produces=mapping.produces.length?mapping.produces:parent.produces;
            if(params.some(item=>!item)||headers.some(item=>!item))conditions.push('Opaque Spring request parameter/header expression');
            if(headers.length||consumes.length||produces.length)conditions.push('HTTP observation does not prove Spring header/content negotiation restrictions');
            const declaredMethods=[...new Set([...parent.methods,...mapping.methods])],methods=declaredMethods.length?[...new Set([...declaredMethods,...declaredMethods.includes('GET')?['HEAD']:[]])]: '*';
            if(parent.paths.length*mapping.paths.length>256){conditions.push('Spring class/method path cross-product exceeds the route budget');continue;}
            for(const base of parent.paths)for(const local of mapping.paths){
              if(order>=20_000){exhausted=true;break controllersLoop;}
              const combined=combineSpringPath(base,local),prefix=(profile.config.contextPath??'')+(profile.config.servletPath??''),routePath=combined?prefix+combined:prefix+'/{*unresolved}',pattern=compileSpringPath(routePath,profile.dialect??'spring-path-6.2');
              const routeConditions=[...conditions,...!combined?['Spring path combination requires a reviewed native pattern profile']:[],...pattern.status==='partial'?[pattern.reason!]:[]];
              if(!combined||mapping.gaps.length||parent.gaps.length||!profile.dialect){pattern.status='partial';pattern.prefix=prefix+'/';pattern.reason=routeConditions.join('; ');}
              const id=this.context.graph.id('endpoint','spring-mvc',rootId,controller.id,handler.id,base,local),proof=[...profile.proof,...registration.proof,...controllerIdentities.flatMap(identity=>identity.proof),...parent.proof,...mapping.proof,...handler.symbol?.proof??[]];
              const contract:RoutingContract={version:1,pattern,methods,excludedMethods:declaredMethods.length?undefined:['OPTIONS'],executionContext:'server',registration:{file:file.path,line:handler.fact.range.startLine,receiver:name},mounts:[],middleware:[],conditions:routeConditions,dispatch:{dialect:'spring',root:rootId,order:order++},spring:{params:params.filter(Boolean)as NonNullable<typeof params[number]>[],headers:headers.filter(Boolean)as NonNullable<typeof headers[number]>[],consumes,produces,declaredMethods}};
              this.context.graph.contain({id,type:'api_endpoint',name:`${methods==='*'?'ANY':methods.join('|')} ${routePath}`,path:file.path,language:file.language,parentId:this.context.applicationIds.get(app.name),sourceRange:handler.fact.range,metadata:{framework:'spring-mvc',frameworkVersion:profile.version,packVersion:SPRING_VERSION,routePath,method:methods==='*'?'ANY':methods.length===1?methods[0]:'ANY',routing:contract,executionContext:'server',registration:routeConditions.length?'candidate':'selected',constraintsUnresolved:routeConditions.length>0,controller:controller.id,handler:handler.id},evidence:proof.length?proof:this.proof(file.path,handler.fact.annotations[0]!, 'Original Spring handler annotation')});
              this.context.graph.relate(id,handler.id,'handles',proof,{framework:'spring-mvc',version:SPRING_VERSION,conditions:routeConditions});
              this.context.graph.entities.get(handler.id)!.metadata.springHandler={context:rootId,controller:controller.id,conditions:routeConditions};
            }
          }
          const analysis=fileAnalysis(this.context.graph.entities.get(file.id)!.metadata.analysis);if(analysis)analysis.features.framework={status:'partial',reason:'Selected original Spring MVC controller/mapping annotations, direct handlers and bounded servlet PathPattern routes; conditional/inherited/custom registration, runtime proxies, negotiation and wider versions retain gaps'};
          for(const reason of new Set(gaps))this.context.graph.diagnose({analyzer:'spring-mvc',severity:'warning',code:'spring-mvc-registration-gap',file:file.path,entityId:controller.id,reason});
        }
        if(exhausted){
          const reason='Spring MVC endpoint expansion exceeded the bounded registration budget';rootGaps.push(reason);
          for(const entity of this.context.graph.entities.values()){const routing=entity.metadata.routing as RoutingContract|undefined;if(routing?.dispatch?.root===rootId){entity.metadata.constraintsUnresolved=true;routing.conditions.push(reason);}}
          this.context.graph.diagnose({analyzer:'spring-mvc',severity:'warning',code:'spring-mvc-registration-budget',reason});
        }
      }
    }
    if(profiles.length)repository.metadata.springMvcProfiles=profiles;
  }
}
