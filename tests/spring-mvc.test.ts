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
import { combineSpringPath, compileSpringPath, springNameCondition } from '../src/analysis/routes/spring-patterns.js';
import { matchRoutePattern } from '../src/analysis/routes/contracts.js';
const roots:string[]=[];
after(async()=>{await Promise.all(roots.map(root=>rm(root,{recursive:true,force:true})));});
async function put(root:string,name:string,text:string){await mkdir(path.dirname(path.join(root,name)),{recursive:true});await writeFile(path.join(root,name),text);}
async function repository(files:Record<string,string>){const root=await mkdtemp(path.join(tmpdir(),'codiluce-spring-'));roots.push(root);for(const[name,text]of Object.entries(files))await put(root,name,text);return root;}
const app:ApplicationInput={name:'server',path:'.',apiOrigins:['http://localhost:8080'],sourceRoots:{java:['java'],kotlin:['kotlin']},jvm:{dependencies:[],spring:{version:'6.2.19',componentScan:['demo']}}};
async function index(root:string,applications:ApplicationInput[]=[app],cache?:AnalysisCache,revision?:string){return indexRepository(root,{config:await resolveConfig(root,{repository:{name:'spring-fixture'},applications}),cache,revision});}
const endpoints=(graph:SoftwareGraph)=>graph.entities.filter(entity=>entity.type==='api_endpoint'&&entity.metadata.framework==='spring-mvc');
const shape=(graph:SoftwareGraph)=>canonicalJson({entities:graph.entities,relations:graph.relations,diagnostics:graph.diagnostics.filter(item=>!['git-metrics','indexer'].includes(item.analyzer)&&item.code!=='git-ignore-unavailable')});
const imports='import org.springframework.web.bind.annotation.RestController; import org.springframework.web.bind.annotation.RequestMapping; import org.springframework.web.bind.annotation.GetMapping; import org.springframework.web.bind.annotation.PostMapping; import org.springframework.web.bind.annotation.RequestMethod;';

test('Spring PathPattern literals, captures, fixed constraints, terminal catch-all, escaping and matrix parameters preserve native boundaries',()=>{
 const compile=(text:string)=>compileSpringPath(text,'spring-path-6.2');
 for(const[pathname,pattern]of [['/api/42','/api/{id}'],['/api/42;x=1','/api/{id:[0-9]+}'],['/api/a%2Fb','/api/{id}'],['/api','/api/**'],['/api/a/b','/api/{*rest}'],['/file/report.png','/file/*.png'],['/file/test.txt','/file/t?st.txt'],['/','/']]as const)assert.ok(matchRoutePattern(compile(pattern),pathname),`${pattern} ${pathname}`);
 for(const[pathname,pattern]of [['/API/42','/api/{id}'],['/api/42/','/api/{id}'],['/api//42','/api/{id}'],['/api/no','/api/{id:[0-9]+}'],['/api/','/api/{id}'],['/api/%ZZ','/api/{id}'],['/file/reportXpng','/file/*.png']]as const)assert.equal(matchRoutePattern(compile(pattern),pathname),false,`${pattern} ${pathname}`);
 assert.equal(compile('/api/**/tail').status,'partial');assert.equal(compile('/api/{id:(a+)+}').status,'partial');assert.equal(compile('/api/${root}').status,'partial');assert.equal(compile('/{id}/{id}').status,'partial');
 assert.equal(compile('/api/a*a*a*a*a*a*b').status,'partial');assert.equal(compile('/api/{left}-{right}').status,'partial');
 assert.equal(combineSpringPath('/api/*','/pets'),'/api/pets');assert.equal(combineSpringPath('/api/**','/pets'),undefined);
 assert.deepEqual(springNameCondition('q!=x'),{name:'q',value:'x',negated:true});
});

test('Java MVC class/method path arrays and original constants produce original handler registrations and direct calls',async()=>{
 const root=await repository({'java/demo/Paths.java':'package demo; public class Paths { public static final String ROOT="/v"+"2"; }','java/demo/Api.java':`// 😀 original\r\npackage demo;\r\n${imports}\r\n@RestController\r\n@RequestMapping(path={"/api",Paths.ROOT}, method=RequestMethod.GET)\r\npublic class Api {\r\n @PostMapping(path={"/pets","/animals"})\r\n public String create(){ return helper(); }\r\n private String helper(){return "ok";}\r\n}`}),graph=await index(root),routes=endpoints(graph);
 assert.equal(routes.length,4,JSON.stringify(graph.diagnostics));assert.deepEqual(routes.map(route=>route.metadata.routePath).sort(),['/api/animals','/api/pets','/v2/animals','/v2/pets']);assert.ok(routes.every(route=>!route.metadata.constraintsUnresolved));
 assert.ok(routes.every(route=>(route.metadata.routing as any).methods.join(',')==='GET,POST,HEAD'));
 const handler=graph.entities.find(entity=>entity.name==='create')!;assert.ok(routes.every(route=>graph.relations.some(edge=>edge.from===route.id&&edge.to===handler.id&&edge.type==='handles')));
 assert.ok(graph.relations.some(edge=>edge.type==='calls'&&edge.from===handler.id&&graph.entities.find(entity=>entity.id===edge.to)?.name==='helper'));
 assert.equal(routes[0]?.sourceRange?.startLine,7);assert.ok(routes.some(route=>route.evidence.some(item=>item.file==='java/demo/Paths.java')));assert.equal(graph.run.analyzerVersions['spring-mvc'],'2');
});

test('Kotlin annotation aliases and declared Spring Boot entry scan retain original endpoints without injected calls',async()=>{
 const root=await repository({'kotlin/demo/App.kt':'package demo\nimport org.springframework.boot.autoconfigure.SpringBootApplication\n@SpringBootApplication\nclass App\n','kotlin/demo/Api.kt':'package demo.api\nimport org.springframework.web.bind.annotation.RestController as Rest\nimport org.springframework.web.bind.annotation.GetMapping as Get\n@Rest\nclass Api(private val service: Service){\n @Get("/items/{id}")\n fun show(id: String): String = service.find(id)\n}\nclass Service {\n fun find(id: String): String=id\n}\n'}),graph=await index(root,[{...app,entrypoints:{spring:['demo.App']},jvm:{...app.jvm,spring:{version:'7.0.9',bootVersion:'4.0.0',contextPath:'/ctx'}}}]);
 const routes=endpoints(graph);assert.equal(routes.length,1);assert.equal(routes[0]?.metadata.routePath,'/ctx/items/{id}');assert.equal(routes[0]?.metadata.constraintsUnresolved,false,JSON.stringify(graph.diagnostics));
 assert.equal(graph.relations.some(edge=>edge.type==='calls'&&graph.entities.find(entity=>entity.id===edge.to)?.name==='find'),false);
});

test('Plain MVC configuration entry scans use resolved annotations; unselected controllers remain constrained',async()=>{
 const root=await repository({'java/demo/App.java':'package demo; import org.springframework.context.annotation.Configuration; import org.springframework.context.annotation.ComponentScan; import org.springframework.web.servlet.config.annotation.EnableWebMvc; @Configuration @EnableWebMvc @ComponentScan("demo.selected") public class App {}','java/demo/selected/Api.java':`package demo.selected; ${imports} @RestController public class Api { @GetMapping("/ok") public void ok(){} }`,'java/other/Other.java':`package other; ${imports} @RestController public class Other { @GetMapping("/other") public void other(){} }`}),graph=await index(root,[{...app,entrypoints:{spring:['demo.App']},jvm:{...app.jvm,spring:{version:'6.2.19'}}}]);
 assert.equal(endpoints(graph).find(route=>route.metadata.routePath==='/ok')?.metadata.constraintsUnresolved,false);assert.equal(endpoints(graph).find(route=>route.metadata.routePath==='/other')?.metadata.constraintsUnresolved,true);
});

test('Source lookalike mapping/controller annotations cannot acquire framework identity',async()=>{
 const root=await repository({'java/demo/Api.java':'package demo; import org.springframework.web.bind.annotation.RestController; @interface GetMapping { String value(); } @RestController public class Api { @GetMapping("/fake") public void fake(){} }','java/demo/Fake.java':'package demo; @interface Controller {} @Controller public class Fake { @org.springframework.web.bind.annotation.GetMapping("/fake-controller") public void action(){} }'}),graph=await index(root);
 assert.equal(endpoints(graph).length,0);
});

test('Versions, profile annotations, inherited mapping and placeholders keep routes constrained',async()=>{
 const root=await repository({'java/demo/Api.java':`package demo; ${imports} import org.springframework.context.annotation.Profile; @RestController @Profile("prod") public class Api extends Base { @GetMapping("/known") public void known(){} @GetMapping("/${'${root}'}/dynamic") public void dynamic(){} } class Base {}`}),graph=await index(root,[{...app,jvm:{...app.jvm,spring:{version:'7.1.0',componentScan:['demo']}}}]);
 assert.equal(endpoints(graph).length,2);assert.ok(endpoints(graph).every(route=>route.metadata.constraintsUnresolved));assert.ok((graph.entities.find(entity=>entity.type==='repository')!.metadata.springMvcProfiles as any[])[0].gaps.some((gap:string)=>gap.includes('version')));
});

test('Literal client observations respect Spring specificity, parameter conditions, HEAD and content restrictions',async()=>{
 const root=await repository({'java/demo/Api.java':`package demo; ${imports} @RestController public class Api {
 @GetMapping("/items/{id}") public void dynamic(){}
 @GetMapping("/items/new") public void literal(){}
 @GetMapping(path="/search",params="q=x") public void query(){}
 @GetMapping(path="/search",params="q!=x") public void other(){}
 @GetMapping(path="/json",produces="application/json") public void json(){}
 @RequestMapping(path="/head",method=RequestMethod.HEAD) public void head(){}
 @GetMapping("/head") public void get(){}
 @RequestMapping("/any") public void any(){}
}`,'front/package.json':'{"name":"frontend"}','front/client.ts':`export async function load(){await fetch('http://localhost:8080/items/new');await fetch('http://localhost:8080/search?q=x');await fetch('http://localhost:8080/json');await fetch('http://localhost:8080/head',{method:'HEAD'});await fetch('http://localhost:8080/any',{method:'OPTIONS'});}`}),graph=await index(root,[app,{name:'frontend',path:'front'}]);
 const requested=graph.relations.filter(edge=>edge.type==='requests').map(edge=>graph.entities.find(entity=>entity.id===edge.to)!.metadata.handler).map(id=>graph.entities.find(entity=>entity.id===id)?.name);
 assert.deepEqual(requested.sort(),['head','literal','query']);assert.ok(graph.diagnostics.some(item=>item.code==='constrained-http-match'));
});

test('Spring cache/revision replay and changed registration/prefix inputs preserve and invalidate graph evidence',async()=>{
 const root=await repository({'java/demo/Api.java':`package demo; ${imports} @RestController public class Api { @GetMapping("/items") public void items(){} }`}),cache=new AnalysisCache(path.join(root,'.codiluce','cache')),cold=await index(root,[app],cache),warm=await index(root,[app],cache),revision=await index(root,[app],undefined,'fixture-revision');
 assert.equal(shape(warm),shape(cold));assert.equal(shape(revision),shape(cold));
 const shifted=await index(root,[{...app,jvm:{...app.jvm,spring:{version:'6.2.19',componentScan:['demo'],contextPath:'/ctx'}}}],cache);assert.equal(endpoints(shifted)[0]?.metadata.routePath,'/ctx/items');
 const excluded=await index(root,[{...app,jvm:{...app.jvm,spring:{version:'6.2.19',componentScan:['other']}}}],cache);assert.equal(endpoints(excluded)[0]?.metadata.constraintsUnresolved,true);
});

test('Indexed properties/YAML prefixes invalidate cached routes; profiles and custom MVC configuration retain gaps',async()=>{
 const root=await repository({'java/demo/Api.java':`package demo; ${imports} @RestController public class Api { @GetMapping("/items") public void items(){} }`,'src/main/resources/application.properties':'server.servlet.context-path=/original\n'}),cache=new AnalysisCache(path.join(root,'.codiluce','cache'));
 const original=await index(root,[app],cache);assert.equal(endpoints(original)[0]?.metadata.routePath,'/original/items');assert.equal(endpoints(original)[0]?.metadata.constraintsUnresolved,false);
 await put(root,'src/main/resources/application.properties','spring.mvc.pathmatch.matching-strategy=ant_path_matcher\n');
 const ant=await index(root,[app],cache);assert.equal(endpoints(ant)[0]?.metadata.constraintsUnresolved,true);
 await rm(path.join(root,'src/main/resources/application.properties'));await put(root,'src/main/resources/application.yml','server:\n  servlet:\n    context-path: /yaml\n');
 const yaml=await index(root,[app],cache);assert.equal(endpoints(yaml)[0]?.metadata.routePath,'/yaml/items');assert.equal(endpoints(yaml)[0]?.metadata.constraintsUnresolved,false);
 await put(root,'src/main/resources/application-prod.properties','server.servlet.context-path=/prod\n');
 const profile=await index(root,[app],cache);assert.equal(endpoints(profile)[0]?.metadata.constraintsUnresolved,true);
 await rm(path.join(root,'src/main/resources/application-prod.properties'));await put(root,'java/demo/Custom.java','package demo; import org.springframework.web.servlet.config.annotation.WebMvcConfigurer; public class Custom implements WebMvcConfigurer {}');
 const custom=await index(root,[app],cache);assert.equal(endpoints(custom)[0]?.metadata.constraintsUnresolved,true);
});

test('Declared Maven MVC identities exclude runtime/test dependencies and reject competing recorded versions',async()=>{
 const pom=(scope='compile')=>`<project><modelVersion>4.0.0</modelVersion><groupId>demo</groupId><artifactId>api</artifactId><version>1</version><dependencies><dependency><groupId>org.springframework</groupId><artifactId>spring-webmvc</artifactId><version>6.2.19</version><scope>${scope}</scope></dependency></dependencies></project>`;
 const root=await repository({'pom.xml':pom(),'java/demo/Api.java':`package demo; ${imports} @RestController public class Api { @GetMapping("/items") public void items(){} }`}),selected:ApplicationInput={...app,jvm:{spring:{componentScan:['demo']}}};
 const declared=await index(root,[selected]);assert.equal(endpoints(declared)[0]?.metadata.frameworkVersion,'6.2.19');assert.equal(endpoints(declared)[0]?.metadata.constraintsUnresolved,false);
 const mismatch=await index(root,[{...selected,jvm:{spring:{version:'7.0.9',componentScan:['demo']}}}]);assert.equal(endpoints(mismatch)[0]?.metadata.constraintsUnresolved,true);
 await put(root,'pom.xml',pom('runtime'));const runtime=await index(root,[selected]);assert.equal(endpoints(runtime)[0]?.metadata.constraintsUnresolved,true);
 await put(root,'pom.xml',pom('test'));const testOnly=await index(root,[selected]);assert.equal(endpoints(testOnly)[0]?.metadata.constraintsUnresolved,true);
});

test('Multiple/duplicate path annotations and equivalent patterns never fabricate a union or ambiguous handler',async()=>{
 const root=await repository({'java/demo/Api.java':`package demo; ${imports} @RestController public class Api { @GetMapping({"/items/{id}","/items/{other}","/items/{id}"}) public void same(){} @GetMapping("/first") @PostMapping("/second") public void competing(){} }`}),graph=await index(root);
 assert.equal(endpoints(graph).filter(route=>route.metadata.handler===graph.entities.find(entity=>entity.name==='same')?.id).length,2);
 assert.equal(endpoints(graph).some(route=>route.metadata.routePath==='/second'),false);assert.equal(endpoints(graph).find(route=>route.metadata.routePath==='/first')?.metadata.constraintsUnresolved,true);
});

test('Vue, Svelte and Astro original script requests reach original Spring handlers through explicit origins',async()=>{
 const root=await repository({'java/demo/Api.java':`package demo; ${imports} @RestController public class Api { @GetMapping("/items/{id}") public String show(String id){return helper(id);} private String helper(String id){return id;} }`,'front/package.json':'{"name":"components","dependencies":{"vue":"3.5.17","svelte":"5.57.2","astro":"7.0.0"}}','front/Page.vue':'<script setup lang="ts">function vueRequest(){return fetch("http://localhost:8080/items/1");}</script><template><button @click="vueRequest"/></template>','front/Page.svelte':'<script>function svelteRequest(){return fetch("http://localhost:8080/items/2");}</script><button onclick={svelteRequest}/>','front/Page.astro':'---\n---\n<script>function astroRequest(){return fetch("http://localhost:8080/items/3");}</script>'}),graph=await index(root,[app,{name:'components',path:'front'}]),endpoint=endpoints(graph)[0]!;
 const requests=graph.relations.filter(edge=>edge.type==='requests'&&edge.to===endpoint.id);assert.equal(requests.length,3,JSON.stringify(graph.diagnostics));
 assert.deepEqual(requests.map(edge=>graph.entities.find(entity=>entity.id===edge.from)?.path).sort(),['front/Page.astro','front/Page.svelte','front/Page.vue']);
 const handler=graph.entities.find(entity=>entity.name==='show')!;assert.ok(graph.relations.some(edge=>edge.type==='handles'&&edge.from===endpoint.id&&edge.to===handler.id));assert.ok(graph.relations.some(edge=>edge.type==='calls'&&edge.from===handler.id&&graph.entities.find(entity=>entity.id===edge.to)?.name==='helper'));
});
