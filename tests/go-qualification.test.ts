import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { indexRepository } from '../src/pipeline/index.js';
import { resolveConfig, type ApplicationInput } from '../src/core/config.js';
import { canonicalJson } from '../src/history/fingerprint.js';
import { AnalysisCache } from '../src/pipeline/cache.js';
import { GraphStore } from '../src/storage/sqlite.js';
import { ProjectionService } from '../src/projection/service.js';
import type { SoftwareGraph } from '../src/core/graph.js';
import { normalizeFetchMethod } from '../src/analysis/routes/http-method.js';

const roots: string[] = []; after(async () => { await Promise.all(roots.map(root => rm(root, { recursive:true, force:true }))); });
async function repository(files: Record<string,string>) { const root = await mkdtemp(path.join(tmpdir(), 'codiluce-go-qualification-')); roots.push(root); for (const [file,text] of Object.entries(files)) { await mkdir(path.dirname(path.join(root,file)), {recursive:true}); await writeFile(path.join(root,file),text); } return root; }
const build: NonNullable<ApplicationInput['go']> = { goos:'linux', goarch:'amd64', compiler:'gc', toolchainVersion:'1.26.0', tags:[], cgoEnabled:false };
async function index(root:string, applications:ApplicationInput[] = [{name:'server',path:'.',ecosystems:['go'],apiOrigins:['https://api.example.com'],go:build}], cache?:AnalysisCache, revision?:string) { return indexRepository(root,{config:await resolveConfig(root,{repository:{name:'qualification'},applications}),cache,revision}); }
const endpoints=(g:SoftwareGraph)=>g.entities.filter(e=>e.type==='api_endpoint');
const shape=(g:SoftwareGraph)=>canonicalJson({entities:g.entities,relations:g.relations,diagnostics:g.diagnostics.filter(d=>!['git-metrics','indexer'].includes(d.analyzer)&&d.code!=='git-ignore-unavailable')});
const http='func Handler(w http.ResponseWriter,r *http.Request){}\n';
const manifest='module example.com/server\ngo 1.26.0\nrequire github.com/labstack/echo/v5 v5.4.0\n';

test('Go if/switch initializers run before conditions while branch/short-circuit registrations remain constrained',async()=>{
 const root=await repository({'go.mod':manifest,'main.go':`package main
import("net/http";"github.com/labstack/echo/v5")
${http}
func main(){m:=http.NewServeMux();if m.HandleFunc("GET /initializer",Handler);enabled{m.HandleFunc("GET /branch",Handler)}else{m.HandleFunc("GET /else",Handler)};switch m.HandleFunc("GET /switch",Handler);value{case 1:m.HandleFunc("GET /case",Handler)};http.ListenAndServe(":8080",m)}
`});const g=await index(root);for(const route of ['/initializer','/switch'])assert.ok(!endpoints(g).find(e=>e.metadata.routePath===route)!.metadata.constraintsUnresolved);for(const route of ['/branch','/else','/case'])assert.ok(endpoints(g).find(e=>e.metadata.routePath===route)!.metadata.constraintsUnresolved);
 await writeFile(path.join(root,'main.go'),`package main
import "github.com/labstack/echo/v5"
func Handler(c *echo.Context)error{return nil}
func main(){e:=echo.New();e.GET("/x",Handler);if err:=e.Start(":8080");err!=nil{unknown()}}
`);assert.ok(!endpoints(await index(root))[0]!.metadata.constraintsUnresolved);
 await writeFile(path.join(root,'main.go'),`package main
import "github.com/labstack/echo/v5"
func Handler(c *echo.Context)error{return nil}
func main(){e:=echo.New();e.GET("/x",Handler);if enabled{if err:=e.Start(":8080");err!=nil{unknown()}}}
`);assert.ok(endpoints(await index(root))[0]!.metadata.constraintsUnresolved);
});

test('Comments in keyed Server literals preserve handler construction and Fatal serving arguments retain order',async()=>{
 const root=await repository({'go.mod':manifest,'main.go':`package main
import("net/http";"log";"time")
${http}
func main(){m:=http.NewServeMux();m.HandleFunc("GET /x",Handler);s:=&http.Server{
 // Native keyed construction, not a positional argument.
 Handler:m,
 ReadTimeout:5*time.Second,
};log.Fatal(s.ListenAndServe());http.HandleFunc("/unreachable",Handler)}
`});const g=await index(root);assert.equal(endpoints(g).length,1);assert.ok(!endpoints(g)[0]!.metadata.constraintsUnresolved);assert.ok(g.relations.some(e=>e.type==='handles'));
 await writeFile(path.join(root,'main.go'),`package main
import("net/http";"log")
${http}
func main(){m:=http.NewServeMux();m.HandleFunc("GET /x",Handler);log.Fatal("before serving");http.ListenAndServe(":8080",m)}
`);assert.equal(endpoints(await index(root)).length,0);
});

test('Fetch token normalization keeps extension/PATCH case and rejects forbidden or invalid tokens',()=>{
 for(const method of ['delete','get','head','options','post','put'])assert.equal(normalizeFetchMethod(method),method.toUpperCase());
 for(const method of ['PATCH','patch','custom','CUSTOM','QUERY'])assert.equal(normalizeFetchMethod(method),method);
 for(const method of ['trace','CONNECT','Track','bad method','',null,42])assert.equal(normalizeFetchMethod(method),undefined);
});

test('TS, Vue, Svelte and Astro requests share Fetch casing and original cross-stack Go handler flows',async()=>{
 const files:Record<string,string>={'go/go.mod':manifest,'go/main.go':`package main
import("github.com/labstack/echo/v5";"example.com/server/handlers")
func main(){e:=echo.New();e.Add("custom","/custom",api.Handler);e.PATCH("/patch",api.Handler);e.GET("/standard",api.Handler);e.Any("/invalid",api.Handler);e.Start(":8080")}
`,'go/handlers/handler.go':`// 😀 original callback
package api
import "github.com/labstack/echo/v5"
func Handler(c *echo.Context)error{return nil}
`};
 const methods=[['custom','/custom'],['PATCH','/patch'],['patch','/patch'],['get','/standard'],['TRACE','/invalid'],['bad method','/invalid']];
 const calls=methods.map(([method,url])=>`fetch('https://api.example.com${url}',{method:'${method}'})`);
 files['ts/client.ts']=calls.map((call,i)=>`export function Call${i}(){return ${call};}`).join('\n');
 files['vue/package.json']='{"dependencies":{"vue":"^3.5.0"}}';files['vue/App.vue']='<script setup>const native=fetch;</script><template>'+calls.map(call=>`<button @click="${call.replace('fetch(', 'native(')}"/>`).join('')+'</template>';
 files['svelte/package.json']='{"dependencies":{"svelte":"^5.57.2"}}';files['svelte/App.svelte']='<script>const native=fetch;</script>'+calls.map(call=>`<button onclick={() => ${call.replace('fetch(', 'native(')}}>Save</button>`).join('');
 files['astro/package.json']='{"dependencies":{"astro":"^7.3.8"}}';files['astro/astro.config.mjs']='export default {output:"server"};';files['astro/src/pages/index.astro']=calls.map(call=>`{${call}}`).join('\n');
 const root=await repository(files),apps:ApplicationInput[]=[{name:'server',path:'go',ecosystems:['go'],apiOrigins:['https://api.example.com'],go:build},{name:'ts',path:'ts',ecosystems:['node']},{name:'vue',path:'vue',frameworks:['vue']},{name:'svelte',path:'svelte',frameworks:['svelte']},{name:'astro',path:'astro',frameworks:['astro']}];
 const state=await mkdtemp(path.join(tmpdir(),'codiluce-go-mixed-cache-'));roots.push(state);const cold=await index(root,apps,new AnalysisCache(state)),warm=await index(root,apps,new AnalysisCache(state)),revision=await index(root,apps,undefined,'recorded');assert.equal(shape(cold),shape(warm));assert.equal(shape(cold),shape(revision));
 for(const prefix of ['ts/','vue/','svelte/','astro/']){const requests=cold.relations.filter(edge=>edge.type==='requests'&&cold.entities.find(e=>e.id===edge.from)?.path?.startsWith(prefix));assert.equal(requests.length,3,prefix+JSON.stringify(cold.diagnostics.filter(d=>d.file?.startsWith(prefix))));assert.deepEqual(requests.map(edge=>edge.metadata?.method).sort(),['GET','PATCH','custom']);}
 const store=new GraphStore(':memory:');try{store.save(cold);const projection=new ProjectionService(store,{root});for(const endpoint of endpoints(cold).filter(e=>e.path==='go/main.go')){const flow=await projection.requestFlow(endpoint.id,{maxFileBytes:1<<20});const callback=flow.nodes.find(n=>n.kind==='handler');assert.equal(callback?.node?.path,'go/handlers/handler.go');assert.equal(callback?.node?.sourceRange?.startLine,4);}}finally{store.close();}
});

const routerProfiles = [
 {name:'net-http',requirement:'',imports:'"net/http"',signature:'w http.ResponseWriter,r *http.Request',handlerImports:'"net/http"',setup:'m:=http.NewServeMux();m.HandleFunc("GET /net-http/{id}",api.Handler);log.Fatal(http.ListenAndServe(":8080",m))'},
 {name:'chi',requirement:'github.com/go-chi/chi/v5 v5.2.1',imports:'"net/http";c "github.com/go-chi/chi/v5"',signature:'w http.ResponseWriter,r *http.Request',handlerImports:'"net/http"',setup:'r:=c.NewRouter();r.Route("/chi",func(s c.Router){s.Get("/{id}",api.Handler)});log.Fatal(http.ListenAndServe(":8080",r))'},
 {name:'gin',requirement:'github.com/gin-gonic/gin v1.11.0',imports:'g "github.com/gin-gonic/gin"',signature:'c *g.Context',handlerImports:'g "github.com/gin-gonic/gin"',setup:'r:=g.New();r.Group("/gin").GET("/:id",api.Handler);log.Fatal(r.Run())'},
 {name:'echo4',requirement:'github.com/labstack/echo/v4 v4.13.4',imports:'e "github.com/labstack/echo/v4"',signature:'c e.Context',handlerImports:'e "github.com/labstack/echo/v4"',setup:'r:=e.New();r.Group("/echo4").GET("/:id",api.Handler);log.Fatal(r.Start(":8080"))'},
 {name:'echo5',requirement:'github.com/labstack/echo/v5 v5.4.0',imports:'e "github.com/labstack/echo/v5"',signature:'c *e.Context',handlerImports:'e "github.com/labstack/echo/v5"',setup:'r:=e.New();r.Group("/echo5").GET("/:id",api.Handler);log.Fatal(r.Start(":8080"))'},
 {name:'fiber2',requirement:'github.com/gofiber/fiber/v2 v2.52.9',imports:'f "github.com/gofiber/fiber/v2"',signature:'c *f.Ctx',handlerImports:'f "github.com/gofiber/fiber/v2"',setup:'r:=f.New();child:=f.New();child.Get("/:id",api.Handler);r.Mount("/fiber2",child);log.Fatal(r.Listen(":8080"))'},
 {name:'fiber3',requirement:'github.com/gofiber/fiber/v3 v3.5.0',imports:'f "github.com/gofiber/fiber/v3"',signature:'c f.Ctx',handlerImports:'f "github.com/gofiber/fiber/v3"',setup:'r:=f.New();child:=f.New();child.RouteChain("/:id").Get(api.Handler);r.Use("/fiber3",child);log.Fatal(r.Listen(":8080"))'},
 {name:'gorilla',requirement:'github.com/gorilla/mux v1.8.1',imports:'"net/http";m "github.com/gorilla/mux"',signature:'w http.ResponseWriter,r *http.Request',handlerImports:'"net/http"',setup:'r:=m.NewRouter();r.PathPrefix("/gorilla").Subrouter().HandleFunc("/{id}",api.Handler).Methods("GET");log.Fatal(http.ListenAndServe(":8080",r))'},
];

test('All eight Go router profiles select original platform handlers through declared workspaces and replay caches',async()=>{
 const files:Record<string,string>={'go.work':'go 1.26.0\nuse (\n'+routerProfiles.map(p=>' ./'+p.name).join('\n')+'\n)\n','ui/client.ts':routerProfiles.map(p=>`export function ${p.name.replace('-','')}(){return fetch("https://api.example.com/${p.name}/1");}`).join('\n')};
 for(const p of routerProfiles){files[p.name+'/go.mod']=`module example.com/${p.name}\ngo 1.26.0\n${p.requirement?'require '+p.requirement+'\n':''}`;files[p.name+'/main.go']=`package main\nimport("log";${p.imports};"example.com/${p.name}/handlers")\nfunc main(){${p.setup}}\n`;for(const os of ['linux','windows','darwin'])files[p.name+'/handlers/handler_'+os+'.go']=`// 😀 ${os} original callback\npackage api\nimport ${p.handlerImports}\nfunc Handler(${p.signature})${p.name!=='gin'&&p.signature.startsWith('c ')?'error{return nil}':'{}'}\n`;}
 const root=await repository(files),state=await mkdtemp(path.join(tmpdir(),'codiluce-go-target-cache-'));roots.push(state);
 for(const goos of ['linux','windows','darwin']){const apps:ApplicationInput[]=[{name:'ui',path:'ui',ecosystems:['node']},...routerProfiles.map(p=>({name:p.name,path:p.name,ecosystems:['go'],apiOrigins:['https://api.example.com'],go:{...build,goos}}))];const cold=await index(root,apps,new AnalysisCache(state)),warm=await index(root,apps,new AnalysisCache(state)),recorded=await index(root,apps,undefined,'recorded-'+goos);assert.equal(shape(cold),shape(warm));assert.equal(shape(cold),shape(recorded));assert.equal(endpoints(cold).length,9,JSON.stringify(endpoints(cold).map(e=>e.metadata)));assert.ok(endpoints(cold).every(e=>!e.metadata.constraintsUnresolved),JSON.stringify(endpoints(cold).map(e=>e.metadata.constraints)));const requests=cold.relations.filter(e=>e.type==='requests');assert.equal(requests.length,8,JSON.stringify(cold.diagnostics));for(const request of requests){const edge=cold.relations.find(e=>e.type==='handles'&&e.from===request.to)!;const target=cold.entities.find(e=>e.id===edge.to)!;assert.ok(target.path?.endsWith('/handler_'+goos+'.go'));assert.equal(target.sourceRange?.startLine,4);}}
 const unknown:ApplicationInput[]=[{name:'ui',path:'ui',ecosystems:['node']},...routerProfiles.map(p=>({name:p.name,path:p.name,ecosystems:['go'],apiOrigins:['https://api.example.com'],go:{...build,goos:undefined}}))];const uncertain=await index(root,unknown);assert.equal(uncertain.relations.filter(e=>e.type==='requests').length,0);assert.ok(endpoints(uncertain).every(e=>e.metadata.constraintsUnresolved));
});

test('Go nested else-if scopes remain acyclic and retain conditional source registrations',async()=>{
 const root=await repository({'go.mod':manifest,'main.go':`package main
import "net/http"
${http}
func main(){m:=http.NewServeMux();if first{m.HandleFunc("GET /first",Handler)}else if second{m.HandleFunc("GET /second",Handler)}else{m.HandleFunc("GET /third",Handler)};http.ListenAndServe(":8080",m)}
`});const g=await index(root);assert.equal(endpoints(g).length,3);assert.ok(endpoints(g).every(e=>e.metadata.constraintsUnresolved));
});

test('Registrations reached after a serving call require startup-order proof',async()=>{
 const root=await repository({'go.mod':manifest,'main.go':`package main
import "net/http"
${http}
func main(){m:=http.NewServeMux();m.HandleFunc("GET /early",Handler);http.ListenAndServe(":8080",m);m.HandleFunc("GET /late",Handler)}
`});const g=await index(root);assert.ok(!endpoints(g).find(e=>e.metadata.routePath==='/early')!.metadata.constraintsUnresolved);assert.ok(endpoints(g).find(e=>e.metadata.routePath==='/late')!.metadata.constraintsUnresolved);
 await writeFile(path.join(root,'go.mod'),'module example.com/server\ngo 1.26.0\nrequire github.com/gorilla/mux v1.8.1\n');
 await writeFile(path.join(root,'main.go'),`package main
import("net/http";"github.com/gorilla/mux")
${http}
func main(){r:=mux.NewRouter();r.HandleFunc("/untouched",Handler).Methods("GET");early:=r.HandleFunc("/mutated",Handler).Methods("GET","POST");late:=r.NewRoute().Path("/late-builder");http.ListenAndServe(":8080",r);late.HandlerFunc(Handler).Methods("GET");early.Methods("POST")}
`);const gorilla=await index(root);assert.ok(!endpoints(gorilla).find(e=>e.metadata.routePath==='/untouched')!.metadata.constraintsUnresolved);for(const route of ['/mutated','/late-builder'])assert.ok(endpoints(gorilla).find(e=>e.metadata.routePath===route)!.metadata.constraintsUnresolved);
});
