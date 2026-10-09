import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { indexRepository } from '../src/pipeline/index.js';
import { resolveConfig, type ApplicationInput } from '../src/core/config.js';
import { AnalysisCache } from '../src/pipeline/cache.js';
import { canonicalJson } from '../src/history/fingerprint.js';
import type { SoftwareGraph } from '../src/core/graph.js';
const roots:string[]=[];
after(async()=>{await Promise.all(roots.map(root=>rm(root,{recursive:true,force:true})));});
async function put(root:string,name:string,text:string){await mkdir(path.dirname(path.join(root,name)),{recursive:true});await writeFile(path.join(root,name),text);}
async function repository(files:Record<string,string>){const root=await mkdtemp(path.join(tmpdir(),'codiluce-webflux-'));roots.push(root);for(const[name,text]of Object.entries(files))await put(root,name,text);return root;}
const app:ApplicationInput={name:'server',path:'.',apiOrigins:['http://localhost:8080'],sourceRoots:{java:['java'],kotlin:['kotlin']},jvm:{dependencies:[],spring:{stack:'webflux',version:'6.2.19',componentScan:['demo']}}};
async function index(root:string,applications:ApplicationInput[]=[app],cache?:AnalysisCache,revision?:string){return indexRepository(root,{config:await resolveConfig(root,{repository:{name:'webflux-fixture'},applications}),cache,revision});}
const endpoints=(graph:SoftwareGraph)=>graph.entities.filter(entity=>entity.type==='api_endpoint'&&entity.metadata.framework==='spring-webflux');
const shape=(graph:SoftwareGraph)=>canonicalJson({entities:graph.entities,relations:graph.relations,diagnostics:graph.diagnostics.filter(item=>!['git-metrics','indexer'].includes(item.analyzer)&&item.code!=='git-ignore-unavailable')});
const imports='import org.springframework.context.annotation.Configuration; import org.springframework.context.annotation.Bean; import org.springframework.web.reactive.function.server.RouterFunctions; import org.springframework.web.reactive.function.server.RequestPredicates; import org.springframework.web.reactive.function.server.RouterFunction; import org.springframework.web.reactive.function.server.ServerRequest; import org.springframework.web.reactive.function.server.ServerResponse; import reactor.core.publisher.Mono;';
const java=(body:string,extra='')=>`// 😀 original\r\npackage demo;\r\n${imports}\r\n@Configuration(proxyBeanMethods=false) public final class Routes { @Bean public RouterFunction<ServerResponse> routes(){${body}} private Mono<ServerResponse> show(ServerRequest request){return leaf();} private Mono<ServerResponse> other(ServerRequest request){return leaf();} private Mono<ServerResponse> leaf(){return null;} ${extra} }`;
const requests=(paths:string[])=>`export async function load(){${paths.map(url=>`await fetch('http://localhost:8080${url}');`).join('')}}`;
const requested=(graph:SoftwareGraph)=>graph.relations.filter(edge=>edge.type==='requests').map(edge=>graph.entities.find(entity=>entity.id===edge.to)!.metadata.handler).map(id=>graph.entities.find(entity=>entity.id===id)?.name);

test('Java WebFlux builders bind original method references/lambdas and direct handler leaves without registration-time calls',async()=>{
 const root=await repository({'java/demo/Routes.java':java('return RouterFunctions.route().GET("/items/{id}",this::show).POST("/new",request -> leaf()).build();'),'front/package.json':'{"name":"frontend"}','front/client.ts':requests(['/items/12'])}),graph=await index(root,[app,{name:'frontend',path:'front'}]),routes=endpoints(graph);
 assert.equal(routes.length,2,JSON.stringify(graph.diagnostics));assert.ok(routes.every(route=>!route.metadata.constraintsUnresolved),JSON.stringify(routes.map(route=>route.metadata.routing)));
 assert.equal(requested(graph)[0],'show');const handler=graph.entities.find(entity=>entity.id===routes[0]?.metadata.handler)!;assert.ok(graph.relations.some(edge=>edge.type==='calls'&&edge.from===handler.id&&graph.entities.find(entity=>entity.id===edge.to)?.name==='leaf'));
 const inline=graph.entities.find(entity=>entity.id===routes[1]?.metadata.handler)!;assert.equal(inline.metadata.declarationKind,'lambda');assert.ok(inline.sourceRange);assert.ok(graph.relations.some(edge=>edge.type==='handles'&&edge.from===routes[1]?.id&&edge.to===inline.id));
 const factory=graph.entities.find(entity=>entity.id===routes[0]?.metadata.factory)!;assert.equal(graph.relations.some(edge=>edge.type==='calls'&&edge.from===factory.id&&edge.to===handler.id),false);assert.equal(graph.run.analyzerVersions['spring-webflux'],'1');
});

test('WebFlux first matching route defeats MVC path specificity; GET does not borrow HEAD or OPTIONS',async()=>{
 const root=await repository({'java/demo/Routes.java':java('return RouterFunctions.route().GET("/items/{id}",this::show).GET("/items/new",this::other).HEAD("/head",this::other).build();'),'front/package.json':'{"name":"frontend"}','front/client.ts':requests(['/items/new'])+`export async function heads(){await fetch('http://localhost:8080/items/new',{method:'HEAD'});await fetch('http://localhost:8080/items/new',{method:'OPTIONS'});await fetch('http://localhost:8080/head',{method:'HEAD'});}`}),graph=await index(root,[app,{name:'frontend',path:'front'}]);
 assert.deepEqual(requested(graph).sort(),['other','show']);assert.deepEqual((endpoints(graph)[0]!.metadata.routing as any).methods,['GET']);assert.equal(graph.diagnostics.filter(item=>item.code==='unmatched-http-call').length,2);
});

test('Java route/static predicates, OR/AND, query equality and RouterFunction composition retain original order',async()=>{
 const root=await repository({'java/demo/Routes.java':java('final RouterFunction<ServerResponse> a=RouterFunctions.route(RequestPredicates.GET("/a").or(RequestPredicates.GET("/b")),this::show); return a.andRoute(RequestPredicates.path("/q").and(RequestPredicates.queryParam("q","x")),this::other);'),'front/package.json':'{"name":"frontend"}','front/client.ts':requests(['/a','/b','/q?q=x','/q?q=y'])}),graph=await index(root,[app,{name:'frontend',path:'front'}]);
 assert.equal(endpoints(graph).length,3);assert.ok(endpoints(graph).every(route=>!route.metadata.constraintsUnresolved),JSON.stringify(endpoints(graph).map(route=>route.metadata.routing)));assert.deepEqual(requested(graph).sort(),['other','show','show']);
});

test('Java nested Consumer/Supplier routes compose original path prefixes and callbacks',async()=>{
 const root=await repository({'java/demo/Routes.java':java('return RouterFunctions.route().path("/api",b -> b.GET("/items/{id}",this::show).POST(this::other)).path("/v2",() -> RouterFunctions.route().GET("/items",this::show).build()).build();')}),graph=await index(root),routes=endpoints(graph);
 assert.equal(routes.length,3);assert.ok(routes.every(route=>!route.metadata.constraintsUnresolved),JSON.stringify(routes.map(route=>route.metadata.routing)));assert.deepEqual(routes.map(route=>route.metadata.routePath),['/api/items/{id}','/api/{*rest}','/v2/items']);
});

test('Kotlin aliased router/coRouter DSL, nesting and original callable references preserve original handlers',async()=>{
 const root=await repository({'kotlin/demo/Routes.kt':`package demo
import org.springframework.context.annotation.Configuration
import org.springframework.context.annotation.Bean
import org.springframework.core.annotation.Order
import org.springframework.web.reactive.function.server.router as routesDsl
import org.springframework.web.reactive.function.server.coRouter
import org.springframework.web.reactive.function.server.ServerRequest
import org.springframework.web.reactive.function.server.ServerResponse
import reactor.core.publisher.Mono
@Configuration(proxyBeanMethods=false)
class Routes {
 @Bean @Order(1)
 fun reactive() = routesDsl {
  "/api".nest {
   GET("/items", ::show)
   POST("/new") { request -> leaf() }
  }
 }
 @Bean @Order(2)
 fun coroutine() = coRouter {
  GET("/coroutine", ::suspending)
 }
 private fun show(request: ServerRequest): Mono<ServerResponse> = leaf()
 private fun leaf(): Mono<ServerResponse> = response()
 private suspend fun suspending(request: ServerRequest): ServerResponse = reply()
}`,'front/package.json':'{"name":"frontend"}','front/client.ts':requests(['/api/items','/coroutine'])}),graph=await index(root,[app,{name:'frontend',path:'front'}]),routes=endpoints(graph);
 assert.equal(routes.length,3,JSON.stringify(graph.diagnostics));assert.ok(routes.every(route=>!route.metadata.constraintsUnresolved),JSON.stringify(routes.map(route=>route.metadata.routing)));assert.deepEqual(requested(graph).sort(),['show','suspending']);assert.ok(routes.some(route=>graph.entities.find(entity=>entity.id===route.metadata.handler)?.metadata.declarationKind==='lambda'));
});

test('Opaque earlier predicates block later matches; a known earlier match can shadow a later opaque candidate',async()=>{
 const root=await repository({'java/demo/Routes.java':java('return RouterFunctions.route().GET("/guarded",RequestPredicates.headers(headers -> true),this::show).GET("/guarded",this::other).GET("/plain",this::show).GET("/plain",RequestPredicates.accept(media),this::other).build();'),'front/package.json':'{"name":"frontend"}','front/client.ts':requests(['/guarded','/plain'])}),graph=await index(root,[app,{name:'frontend',path:'front'}]);
 assert.deepEqual(requested(graph),['show']);assert.ok(graph.diagnostics.some(item=>item.code==='ambiguous-http-match'));
});

test('Filter callbacks retain original handlers as constrained candidates and nested filters keep their original scope',async()=>{
 const root=await repository({'java/demo/Routes.java':java('return RouterFunctions.route().path("/filtered", b -> b.GET("/x",this::show).filter((request,next) -> next.handle(request))).GET("/plain",this::other).build();'),'front/package.json':'{"name":"frontend"}','front/client.ts':requests(['/filtered/x','/plain'])}),graph=await index(root,[app,{name:'frontend',path:'front'}]);
 assert.equal(endpoints(graph).find(route=>route.metadata.routePath==='/filtered/x')?.metadata.constraintsUnresolved,true);assert.equal(endpoints(graph).find(route=>route.metadata.routePath==='/plain')?.metadata.constraintsUnresolved,false);assert.deepEqual(requested(graph),['other']);assert.ok(endpoints(graph).every(route=>graph.relations.some(edge=>edge.from===route.id&&edge.type==='handles')));
});

test('Bean registration requires selected configuration; unused ordinary router factories are not server endpoints',async()=>{
 const root=await repository({'java/demo/Routes.java':java('return RouterFunctions.route().GET("/selected",this::show).build();','public RouterFunction<ServerResponse> unused(){return RouterFunctions.route().GET("/unused",this::other).build();}')});
 const absent=await index(root,[{...app,jvm:{...app.jvm,spring:{stack:'webflux',version:'6.2.19'}}}]);assert.equal(endpoints(absent).length,1);assert.equal(endpoints(absent)[0]?.metadata.constraintsUnresolved,true);
 const selected=await index(root,[{...app,jvm:{...app.jvm,spring:{stack:'webflux',version:'6.2.19',routers:['demo.Routes.routes']}}}]);assert.equal(endpoints(selected).length,1);assert.equal(endpoints(selected)[0]?.metadata.constraintsUnresolved,false);
});

test('Plain Configuration/EnableWebFlux and Boot roots select original router beans with independent framework versions',async()=>{
 const root=await repository({'java/demo/Routes.java':java('return RouterFunctions.route().GET("/items",this::show).build();').replace('@Configuration(proxyBeanMethods=false)','@Configuration(proxyBeanMethods=false) @org.springframework.web.reactive.config.EnableWebFlux')});
 const plain=await index(root,[{...app,entrypoints:{spring:['demo.Routes']},jvm:{...app.jvm,spring:{version:'7.0.9'}}}]);assert.equal(endpoints(plain)[0]?.metadata.constraintsUnresolved,false,JSON.stringify(endpoints(plain)[0]?.metadata.routing));
 await put(root,'java/demo/Routes.java',java('return RouterFunctions.route().GET("/items",this::show).build();').replace('@Configuration(proxyBeanMethods=false)','@Configuration(proxyBeanMethods=false) @org.springframework.boot.autoconfigure.SpringBootApplication'));
 const boot=await index(root,[{...app,entrypoints:{spring:['demo.Routes']},jvm:{...app.jvm,spring:{version:'7.0.9',bootVersion:'4.0.0'}}}]);assert.equal(endpoints(boot)[0]?.metadata.constraintsUnresolved,false);
 const missing=await index(root,[{...app,entrypoints:{spring:['demo.Routes']},jvm:{...app.jvm,spring:{version:'7.0.9'}}}]);assert.equal(endpoints(missing)[0]?.metadata.constraintsUnresolved,true);
});

test('Unknown/equal bean order remains ambiguous; unique original Order values select a first matching bean',async()=>{
 const second='@Bean public RouterFunction<ServerResponse> second(){return RouterFunctions.route().GET("/same",this::other).build();}',text=java('return RouterFunctions.route().GET("/same",this::show).build();',second),root=await repository({'java/demo/Routes.java':text,'front/package.json':'{"name":"frontend"}','front/client.ts':requests(['/same'])});
 const unknown=await index(root,[app,{name:'frontend',path:'front'}]);assert.deepEqual(requested(unknown),[]);assert.ok(endpoints(unknown).every(route=>route.metadata.beanOrdering==='unresolved'));
 await put(root,'java/demo/Routes.java',text.replace('@Bean public RouterFunction<ServerResponse> routes','@Bean @org.springframework.core.annotation.Order(2) public RouterFunction<ServerResponse> routes').replace('@Bean public RouterFunction<ServerResponse> second','@Bean @org.springframework.core.annotation.Order(1) public RouterFunction<ServerResponse> second'));
 const ordered=await index(root,[app,{name:'frontend',path:'front'}]);assert.deepEqual(requested(ordered),['other']);
 await put(root,'java/demo/Routes.java',text.replaceAll('@Bean','@Bean @org.springframework.core.annotation.Order(1)'));
 const equal=await index(root,[app,{name:'frontend',path:'front'}]);assert.deepEqual(requested(equal),[]);
});

test('Changed locals, conditional factories, injected/virtual receivers and incompatible SAM signatures cannot borrow handler identity',async()=>{
 const cases=[
 'RouterFunction<ServerResponse> a=RouterFunctions.route().GET("/bad",this::show).build(); a=RouterFunctions.route().GET("/other",this::other).build(); return a;',
 'if(enabled){return RouterFunctions.route().GET("/bad",this::show).build();} return RouterFunctions.route().GET("/other",this::other).build();',
 'return RouterFunctions.route().GET("/bad",injected::show).build();',
 'return RouterFunctions.route().GET("/bad",this::wrong).build();'
 ];
 for(const body of cases){const root=await repository({'java/demo/Routes.java':java(body,'private Mono<ServerResponse> wrong(String request){return null;} private Service injected;')}),graph=await index(root);assert.ok(endpoints(graph).length>0);assert.ok(endpoints(graph).every(route=>route.metadata.constraintsUnresolved));assert.equal(graph.relations.some(edge=>edge.type==='handles'&&graph.entities.find(entity=>entity.id===edge.from)?.metadata.framework==='spring-webflux'),false);}
});

test('Source lookalike router factories and shadowed Kotlin DSL names cannot acquire WebFlux identity',async()=>{
 const root=await repository({'java/demo/Routes.java':java('return Fake.route().GET("/fake",this::show).build();','static class Fake { static Fake route(){return new Fake();} Fake GET(String path,Object callback){return this;} RouterFunction<ServerResponse> build(){return null;} }'),'kotlin/demo/Other.kt':`package demo
import org.springframework.context.annotation.Configuration
import org.springframework.context.annotation.Bean
import org.springframework.web.reactive.function.server.router
@Configuration(proxyBeanMethods=false)
class Other {
 @Bean fun routes() = router {
  val GET = { path: String, handler: String -> Unit }
  GET("/fake", "x")
 }
}`}),graph=await index(root);
 assert.ok(endpoints(graph).every(route=>route.metadata.constraintsUnresolved));assert.equal(graph.relations.some(edge=>edge.type==='handles'&&graph.entities.find(entity=>entity.id===edge.from)?.metadata.framework==='spring-webflux'),false);
});

test('Unchanged initialized functional values and expected request/result signatures select original overloads across local source modules',async()=>{
 const root=await repository({'java/demo/Routes.java':java('final org.springframework.web.reactive.function.server.HandlerFunction<ServerResponse> handler=this::show; return RouterFunctions.route().GET("/a",handler).GET("/b",new Other()::run).build();','private Mono<ServerResponse> show(String request){return null;}'),'java/demo/Other.java':`package demo; ${imports} public final class Other { public Mono<ServerResponse> run(ServerRequest request){return null;} }`}),graph=await index(root),routes=endpoints(graph);
 assert.equal(routes.length,2);assert.ok(routes.every(route=>!route.metadata.constraintsUnresolved),JSON.stringify(routes.map(route=>route.metadata.routing)));assert.deepEqual(routes.map(route=>graph.entities.find(entity=>entity.id===route.metadata.handler)?.name).sort(),['run','show']);
});

test('WebFlux properties/YAML, version and source changes invalidate cold/warm/revision replay while whitespace preserves original IDs',async()=>{
 const text=java('return RouterFunctions.route().GET("/a",this::show).build();'),root=await repository({'java/demo/Routes.java':text,'src/main/resources/application.properties':'spring.webflux.base-path=/v1\n'}),cache=new AnalysisCache(path.join(root,'.codiluce','cache')),cold=await index(root,[app],cache),warm=await index(root,[app],cache),revision=await index(root,[app],undefined,'fixture-revision');
 assert.equal(shape(warm),shape(cold));assert.equal(shape(revision),shape(cold));assert.equal(endpoints(cold)[0]?.metadata.routePath,'/v1/a');
 await put(root,'java/demo/Routes.java','\r\n\r\n'+text);const shifted=await index(root,[app],cache);assert.equal(endpoints(shifted)[0]?.id,endpoints(cold)[0]?.id);assert.equal(endpoints(shifted)[0]?.sourceRange?.startLine,(endpoints(cold)[0]?.sourceRange?.startLine??0)+2);
 await rm(path.join(root,'src/main/resources/application.properties'));await put(root,'src/main/resources/application.yml','spring:\n  webflux:\n    base-path: /yaml\n');const yaml=await index(root,[app],cache);assert.equal(endpoints(yaml)[0]?.metadata.routePath,'/yaml/a');assert.equal(endpoints(yaml)[0]?.metadata.constraintsUnresolved,false);
 const version=await index(root,[{...app,jvm:{...app.jvm,spring:{stack:'webflux',version:'7.1.0',componentScan:['demo']}}}],cache);assert.ok(endpoints(version).every(route=>route.metadata.constraintsUnresolved));
 await put(root,'src/main/resources/application-prod.properties','spring.webflux.base-path=/prod\n');const profile=await index(root,[app],cache);assert.ok(endpoints(profile).every(route=>route.metadata.constraintsUnresolved));
});

test('Kotlin DSL predicate invocation and nested query predicates stay ordered and preserve implicit original handler closures',async()=>{
 const root=await repository({'kotlin/demo/Routes.kt':`package demo
import org.springframework.context.annotation.Configuration
import org.springframework.context.annotation.Bean
import org.springframework.web.reactive.function.server.router
@Configuration(proxyBeanMethods=false)
class Routes {
 @Bean fun routes() = router {
  (GET("/a") or GET("/b")) { response() }
  queryParam("q", "x").nest {
   GET("/q") { response() }
  }
 }
}`,'front/package.json':'{"name":"frontend"}','front/client.ts':requests(['/a','/b','/q?q=x','/q?q=y'])}),graph=await index(root,[app,{name:'frontend',path:'front'}]);
 assert.equal(endpoints(graph).length,3);assert.ok(endpoints(graph).every(route=>!route.metadata.constraintsUnresolved),JSON.stringify(endpoints(graph).map(route=>route.metadata.routing)));assert.equal(requested(graph).length,3);assert.ok(requested(graph).every(name=>name==='<lambda>'));
});

test('Original Vue/Svelte/Astro requests reach original WebFlux handlers through explicit origins',async()=>{
 const root=await repository({'java/demo/Routes.java':java('return RouterFunctions.route().GET("/a",this::show).build();'),'front/package.json':'{"name":"frontend","dependencies":{"vue":"3.5.0","svelte":"5.57.2","astro":"5.0.0"}}','front/A.vue':'<script setup lang="ts">async function loadVue(){await fetch("http://localhost:8080/a")}</script><template><div/></template>','front/A.svelte':'<script lang="ts">async function loadSvelte(){await fetch("http://localhost:8080/a")}</script><div/>','front/A.astro':'---\nasync function loadAstro(){await fetch("http://localhost:8080/a")}\n---\n<div/>\n'}),graph=await index(root,[app,{name:'frontend',path:'front'}]);
 assert.equal(requested(graph).length,3);assert.ok(requested(graph).every(name=>name==='show'));
});

test('Proxy, security/filter beans, runtime servlet settings and programmatic path customization retain context gaps',async()=>{
 const variants=[java('return RouterFunctions.route().GET("/a",this::show).build();').replace('@Configuration(proxyBeanMethods=false)','@Configuration'),java('return RouterFunctions.route().GET("/a",this::show).build();','@Bean public org.springframework.web.server.WebFilter filter(){return null;}'),java('mapper.setUseCaseSensitiveMatch(false);return RouterFunctions.route().GET("/a",this::show).build();')];
 for(const text of variants){const root=await repository({'java/demo/Routes.java':text}),graph=await index(root);assert.ok(endpoints(graph).length);assert.ok(endpoints(graph).every(route=>route.metadata.constraintsUnresolved));}
 const root=await repository({'java/demo/Routes.java':java('return RouterFunctions.route().GET("/a",this::show).build();')}),servlet=await index(root,[{...app,jvm:{...app.jvm,spring:{...app.jvm?.spring,contextPath:'/servlet'}}}]);assert.ok(endpoints(servlet).every(route=>route.metadata.constraintsUnresolved));assert.ok(endpoints(servlet).every(route=>route.metadata.routePath==='/a'));
});

test('Standalone DSL builder mutations, nested captured builders and changed functional aliases remain constrained',async()=>{
 const root=await repository({'kotlin/demo/Routes.kt':`package demo
import org.springframework.context.annotation.Configuration
import org.springframework.context.annotation.Bean
import org.springframework.web.reactive.function.server.RouterFunctions
import org.springframework.web.reactive.function.server.router
@Configuration(proxyBeanMethods=false)
class Routes {
 @Bean fun routes() = router {
  val b = RouterFunctions.route()
  b.GET("/x") { response() }
  GET("/x") { other() }
  add(b.build())
 }
}`,'front/package.json':'{"name":"frontend"}','front/client.ts':requests(['/x'])}),graph=await index(root,[app,{name:'frontend',path:'front'}]);assert.deepEqual(requested(graph),[]);assert.ok(endpoints(graph).every(route=>route.metadata.constraintsUnresolved));
 const nested=await repository({'java/demo/Routes.java':java('return RouterFunctions.route().path("/api", b -> b.path("/v2", b2 -> b2.GET("/x",this::show))).build();')}),correct=await index(nested);assert.equal(endpoints(correct).length,1);assert.equal(endpoints(correct)[0]?.metadata.routePath,'/api/v2/x');assert.equal(endpoints(correct)[0]?.metadata.constraintsUnresolved,false);
 const changed=await repository({'java/demo/Routes.java':java('org.springframework.web.reactive.function.server.HandlerFunction<ServerResponse> h=this::show; h=this::other; return RouterFunctions.route().GET("/x",h).build();')}),unknown=await index(changed);assert.ok(endpoints(unknown).every(route=>route.metadata.constraintsUnresolved));assert.ok(endpoints(unknown).every(route=>!route.metadata.handler));
});

test('Spring config validates reactive stack/paths/router names and refuses malformed fields',async()=>{
 const root=await repository({});for(const spring of [{stack:'guess'},{basePath:'relative'},{basePath:'/api/'},{routers:['demo::routes']},{routers:['demo.Routes.routes','demo.Routes.routes']},{stack:'webflux',unknown:true}])await assert.rejects(resolveConfig(root,{applications:[{...app,jvm:{spring} as any}]}),/Invalid Spring configuration/);
 const valid=await resolveConfig(root,{applications:[{...app,jvm:{spring:{stack:'webflux',basePath:'/api',routers:['demo.Routes.routes']}}}]});assert.equal(valid.applications[0]?.jvm?.spring?.stack,'webflux');
});

test('Reviewed reactive dependency versions are separate from servlet starters and unknown runtime selections',async()=>{
 const pom=(dependency:string)=>`<project><modelVersion>4.0.0</modelVersion><groupId>demo</groupId><artifactId>server</artifactId><version>1</version><dependencies>${dependency}</dependencies></project>`,dep=(artifact:string,version:string,group='org.springframework')=>`<dependency><groupId>${group}</groupId><artifactId>${artifact}</artifactId><version>${version}</version></dependency>`,text=java('return RouterFunctions.route().GET("/x",this::show).build();');
 const root=await repository({'pom.xml':pom(dep('spring-webflux','7.0.9')),'src/main/java/demo/Routes.java':text}),declared:ApplicationInput={name:'server',path:'.',jvm:{spring:{stack:'webflux',componentScan:['demo']}}};const graph=await index(root,[declared]);assert.equal(endpoints(graph)[0]?.metadata.frameworkVersion,'7.0.9');assert.equal(endpoints(graph)[0]?.metadata.constraintsUnresolved,false);
 await put(root,'pom.xml',pom(dep('spring-webflux','7.0.9')+dep('spring-webmvc','7.0.9')));const mixed=await index(root,[declared]);assert.ok(endpoints(mixed).every(route=>route.metadata.constraintsUnresolved));
 await put(root,'pom.xml',pom(dep('spring-boot-starter-webflux','4.0.0','org.springframework.boot')));const bom=await index(root,[declared]);assert.ok(endpoints(bom).every(route=>route.metadata.constraintsUnresolved));
 await put(root,'pom.xml',pom(dep('spring-webflux','7.0.9')));await put(root,'src/main/resources/application.properties','spring.main.web-application-type=servlet\n');const override=await index(root,[declared]);assert.ok(endpoints(override).every(route=>route.metadata.constraintsUnresolved));
});

test('Plain WebFlux configuration does not invent a package scan; original static path constants retain source proof',async()=>{
 const root=await repository({'java/demo/Routes.java':java('return RouterFunctions.route().GET(Paths.ROOT,this::show).build();').replace('@Configuration(proxyBeanMethods=false)','@Configuration(proxyBeanMethods=false) @org.springframework.web.reactive.config.EnableWebFlux'),'java/demo/Paths.java':'package demo; public class Paths { public static final String ROOT="/original"; }','java/demo/Extra.java':`package demo; ${imports} @Configuration(proxyBeanMethods=false) public final class Extra { @Bean public RouterFunction<ServerResponse> extra(){return RouterFunctions.route().GET("/extra",request -> null).build();} }`}),graph=await index(root,[{...app,entrypoints:{spring:['demo.Routes']},jvm:{spring:{version:'6.2.19'}}}]);
 const selected=endpoints(graph).find(route=>route.metadata.routePath==='/original')!,unselected=endpoints(graph).find(route=>route.metadata.routePath==='/extra')!;
 assert.equal(selected.metadata.constraintsUnresolved,false);assert.equal(unselected.metadata.constraintsUnresolved,true);assert.ok(selected.evidence.some(item=>item.file==='java/demo/Paths.java'&&item.line===1));
});

test('Warm WebFlux caches cannot replay endpoints or handlers after the required grammar is unavailable',async()=>{
 const {grammarCatalog}=await import('../src/analysis/tree-sitter/grammars.js'),root=await repository({'java/demo/Routes.java':java('return RouterFunctions.route().GET("/x",this::show).build();')}),state=await repository({});assert.equal(endpoints(await index(root,[app],new AnalysisCache(state))).length,1);
 const grammar=grammarCatalog.get('java')!;
 try{grammarCatalog.delete('java');const missing=await index(root,[app],new AnalysisCache(state));assert.equal(endpoints(missing).length,0);assert.equal(missing.relations.filter(edge=>edge.type==='handles').length,0);assert.equal((missing.entities.find(entity=>entity.type==='file'&&entity.path==='java/demo/Routes.java')!.metadata.analysis as any).features.imports.status,'failed');}
 finally{grammarCatalog.set('java',grammar);}
 assert.equal(endpoints(await index(root,[app],new AnalysisCache(state))).length,1);
});

test('Local initializer mutations and unavailable Consumer callback control flow cannot certify builder registration',async()=>{
 const root=await repository({'java/demo/Routes.java':java('final RouterFunctions.Builder b=RouterFunctions.route(); final Object ignored=b.GET("/earlier",this::other); return b.GET("/later",this::show).build();')}),graph=await index(root);assert.ok(endpoints(graph).length);assert.ok(endpoints(graph).every(route=>route.metadata.constraintsUnresolved));
 const conditional=await repository({'java/demo/Routes.java':java('return RouterFunctions.route().path("/api", b -> { if(enabled){b.GET("/x",this::show);} b.POST("/y",this::other); }).build();')}),unknown=await index(conditional);assert.ok(endpoints(unknown).length);assert.ok(endpoints(unknown).every(route=>route.metadata.constraintsUnresolved));
});

test('Visible dependency bean sources remain competitors without inventing the consumer runtime bean context',async()=>{
 const pom=(name:string,body='')=>`<project><modelVersion>4.0.0</modelVersion><groupId>demo</groupId><artifactId>${name}</artifactId><version>1</version>${body}</project>`,root=await repository({'pom.xml':pom('root','<packaging>pom</packaging><modules><module>app</module><module>lib</module></modules>'),'app/pom.xml':pom('app','<dependencies><dependency><groupId>demo</groupId><artifactId>lib</artifactId><version>1</version></dependency><dependency><groupId>org.springframework</groupId><artifactId>spring-webflux</artifactId><version>6.2.19</version></dependency></dependencies>'),'lib/pom.xml':pom('lib'),'app/src/main/java/demo/Routes.java':java('return RouterFunctions.route().GET("/x",this::show).build();'),'lib/src/main/java/demo/Library.java':'package demo; import org.springframework.context.annotation.Configuration; @Configuration public class Library {}'}),graph=await index(root,[{name:'server',path:'app',jvm:{spring:{stack:'webflux',componentScan:['demo']}}},{name:'library',path:'lib'}]);assert.ok(endpoints(graph).length);assert.ok(endpoints(graph).every(route=>route.metadata.constraintsUnresolved));assert.ok(graph.diagnostics.some(item=>item.reason.includes('Visible dependency source')));
});

test('Nested OR chooses a prefix before child matching; overlapping prefixes cannot become invented fallback routes',async()=>{
 const root=await repository({'java/demo/Routes.java':java('return RouterFunctions.nest(RequestPredicates.path("/a").or(RequestPredicates.path("/a/b")),RouterFunctions.route().GET("/x",this::show).build());'),'front/package.json':'{"name":"frontend"}','front/client.ts':requests(['/a/b/x'])}),graph=await index(root,[app,{name:'frontend',path:'front'}]);assert.deepEqual(requested(graph),[]);assert.ok(endpoints(graph).every(route=>route.metadata.constraintsUnresolved));
 const disjoint=await repository({'java/demo/Routes.java':java('return RouterFunctions.nest(RequestPredicates.path("/a").or(RequestPredicates.path("/b")),RouterFunctions.route().GET("/x",this::show).build());'),'front/package.json':'{"name":"frontend"}','front/client.ts':requests(['/a/x','/b/x'])}),selected=await index(disjoint,[app,{name:'frontend',path:'front'}]);assert.deepEqual(requested(selected),['show','show']);
});

test('Final builder fields remain mutable shared registration state; immutable built router fields retain original route snapshots',async()=>{
 const mutable=await repository({'java/demo/Routes.java':java('return builder.GET("/x",this::show).build();','private final RouterFunctions.Builder builder=RouterFunctions.route();')}),unknown=await index(mutable);assert.ok(endpoints(unknown).length);assert.ok(endpoints(unknown).every(route=>route.metadata.constraintsUnresolved));
 const immutable=await repository({'java/demo/Routes.java':java('return snapshot;','private final RouterFunction<ServerResponse> snapshot=RouterFunctions.route().GET("/x",this::show).build();')}),known=await index(immutable);assert.equal(endpoints(known).length,1);assert.equal(endpoints(known)[0]?.metadata.constraintsUnresolved,false);
});
