import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { indexRepository } from '../src/pipeline/index.js';
import { resolveConfig, type GoBuildConfig } from '../src/core/config.js';
import type { Entity, SoftwareGraph } from '../src/core/graph.js';
import { compileChiPath, compileGinPath, compileGoMux } from '../src/analysis/routes/go-patterns.js';
import { matchRoutePattern } from '../src/analysis/routes/contracts.js';
import { AnalysisCache } from '../src/pipeline/cache.js';
import { canonicalJson } from '../src/history/fingerprint.js';
import { GraphStore } from '../src/storage/sqlite.js';
import { ProjectionService } from '../src/projection/service.js';

const temporary: string[] = []; after(async () => { await Promise.all(temporary.map(root => rm(root, { recursive: true, force: true }))); });
const manifest = 'module example.com/server\ngo 1.25\nrequire (\n github.com/go-chi/chi/v5 v5.2.1\n github.com/gin-gonic/gin v1.11.0\n)\n';
const httpHandler = 'func Handler(w http.ResponseWriter,r *http.Request){}\n';
const ginHandler = 'func Handler(c *gin.Context){}\n';
async function repository(files: Record<string, string>) { const root = await mkdtemp(path.join(tmpdir(), 'codiluce-go-routes-')); temporary.push(root); for (const [file, text] of Object.entries({ 'go.mod': manifest, ...files })) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); } return root; }
async function index(root: string, go: GoBuildConfig = {}, cache?: AnalysisCache, revision?: string) { const config = await resolveConfig(root, { repository: { name: 'go-routers' }, applications: [{ name: 'server', path: '.', ecosystems: ['go'], apiOrigins: ['https://api.example.com'], go }] }); return indexRepository(root, { config, cache, revision }); }
const endpoints = (g: SoftwareGraph, path?: string) => g.entities.filter(item => item.type === 'api_endpoint' && (!path || item.metadata.routePath === path));
const callback = (g: SoftwareGraph, endpoint: Entity) => g.entities.find(item => g.relations.some(edge => edge.from === endpoint.id && edge.to === item.id && edge.type === 'handles'));
const requestTarget = (g: SoftwareGraph, name: string) => g.entities.find(item => g.relations.some(edge => edge.type === 'requests' && edge.from === g.entities.find(owner => owner.name === name)?.id && edge.to === item.id));
const stored = (g: SoftwareGraph) => canonicalJson({ entities: g.entities, relations: g.relations, diagnostics: g.diagnostics.filter(item => !['indexer', 'git-metrics'].includes(item.analyzer) && item.code !== 'git-ignore-unavailable') });

test('Go path dialects preserve subtree, terminal slash, wildcard and escaped-segment semantics', () => {
  const modern = compileGoMux('GET api.example.com/files/{name}', true); assert.deepEqual(modern.methods, ['GET', 'HEAD']); assert.equal(modern.host, 'api.example.com'); assert.equal(matchRoutePattern(modern.pattern, '/files/a%2Fb'), true); assert.equal(matchRoutePattern(modern.pattern, '/files/a/b'), false);
  assert.equal(matchRoutePattern(compileGoMux('/files/{rest...}', true).pattern, '/files/'), true); assert.equal(matchRoutePattern(compileGoMux('/files/{rest...}', true).pattern, '/files'), false);
  assert.equal(matchRoutePattern(compileGoMux('/{$}', true).pattern, '/'), true); assert.equal(matchRoutePattern(compileGoMux('/{$}', true).pattern, '/child'), false);
  assert.equal(matchRoutePattern(compileGoMux('/tree/', true).pattern, '/tree/a/b'), true); assert.equal(matchRoutePattern(compileGoMux('/tree/', true).pattern, '/tree'), false);
  assert.equal(matchRoutePattern(compileGoMux('/{name}', false).pattern, '/value'), false); assert.equal(matchRoutePattern(compileGoMux('/{name}', false).pattern, '/%7Bname%7D'), true);
  assert.equal(matchRoutePattern(compileChiPath('/files/*'), '/files/x/'), true); assert.equal(matchRoutePattern(compileChiPath('/files/*'), '/files'), false); assert.equal(matchRoutePattern(compileChiPath('/item/{id:[0-9]+}'), '/item/x'), false);
  assert.equal(matchRoutePattern(compileGinPath('/item/:name.json'), '/item/anything'), true); assert.equal(matchRoutePattern(compileGinPath('/files/*file'), '/files/'), true); assert.equal(matchRoutePattern(compileGinPath('/item/:name'), '/item/a%2Fb'), false);
  for (const value of ['/x/{a}/{a}', '/x/{a...}/y', '/x/a{id}', '/x//y']) assert.equal(compileGoMux(value, true).invalid, true);
});

test('net/http activates from canonical stdlib imports and exposes direct, inline and concrete ServeHTTP handlers', async () => {
  const root = await repository({ 'main.go': 'package main\nimport "net/http"\n' + httpHandler + 'type Service struct{}\nfunc(s *Service)ServeHTTP(w http.ResponseWriter,r *http.Request){}\nfunc main(){mux:=http.NewServeMux();mux.HandleFunc("GET /items/{id}",Handler);mux.Handle("/service",&Service{});mux.HandleFunc("/inline",func(w http.ResponseWriter,r *http.Request){Handler(w,r)});http.ListenAndServe(":8080",mux)}\n' });
  const g = await index(root); assert.equal(endpoints(g).length, 3); for (const endpoint of endpoints(g)) assert.equal(endpoint.metadata.constraintsUnresolved, undefined, endpoint.name); assert.equal(callback(g, endpoints(g, '/items/{id}')[0]!)?.name, 'Handler'); assert.equal(callback(g, endpoints(g, '/service')[0]!)?.name, 'ServeHTTP'); assert.equal(callback(g, endpoints(g, '/inline')[0]!)?.metadata.declarationKind, 'closure');
});

test('net/http default mux, package init and invoked cross-file helper registrations keep original callbacks', async () => {
  const root = await repository({ 'main.go': 'package main\nimport "net/http"\nfunc main(){Register(http.DefaultServeMux);http.ListenAndServe(":8080",nil)}\n', 'setup.go': 'package main\nimport "net/http"\n' + httpHandler + 'const Base="/api"\nfunc init(){http.HandleFunc("/init",Handler)}\nfunc Register(m *http.ServeMux){alias:=Handler;m.HandleFunc(Base+"/helper",alias)}\nfunc Unused(){http.HandleFunc("/unused",Handler)}\n' });
  const g = await index(root); assert.deepEqual(endpoints(g).map(item => item.metadata.routePath).sort(), ['/api/helper', '/init']); assert.ok(endpoints(g).every(item => item.path === 'setup.go' && callback(g, item)?.path === 'setup.go' && !item.metadata.constraintsUnresolved)); assert.ok(endpoints(g).every(item => item.evidence.some(fact => fact.file === 'setup.go')));
});

test('net/http factory returns, HandlerFunc adapters and Server literals are summarized without executing Go', async () => {
  const root = await repository({ 'main.go': 'package main\nimport "net/http"\n' + httpHandler + 'func Router()http.Handler{m:=new(http.ServeMux);m.Handle("/factory",http.HandlerFunc(Handler));return m}\nfunc main(){server:=&http.Server{Addr:":8080",Handler:Router()};server.ListenAndServe()}\n' });
  const g = await index(root); assert.equal(endpoints(g).length, 1); assert.equal(endpoints(g)[0]?.metadata.routePath, '/factory'); assert.equal(callback(g, endpoints(g)[0]!)?.name, 'Handler'); assert.equal(endpoints(g)[0]?.metadata.constraintsUnresolved, undefined);
});

test('net/http manifest, workspace, main debug and recorded startup overrides select the actual routing dialect', async () => {
  const root = await repository({ 'go.mod': manifest.replace('1.25', '1.21'), 'main.go': 'package main\nimport "net/http"\n' + httpHandler + 'func main(){http.HandleFunc("/{id}",Handler);http.ListenAndServe(":8080",nil)}\n' });
  assert.equal((endpoints(await index(root))[0]!.metadata.routing as any).pattern.dialect, 'go-servemux-121'); assert.equal((endpoints(await index(root, { httpMuxGo121: false }))[0]!.metadata.routing as any).pattern.dialect, 'go-servemux-122');
  await writeFile(path.join(root, 'go.mod'), manifest + 'godebug httpmuxgo121=1\n'); assert.equal((endpoints(await index(root))[0]!.metadata.routing as any).pattern.dialect, 'go-servemux-121');
  await writeFile(path.join(root, 'main.go'), '//go:debug httpmuxgo121=0\npackage main\nimport "net/http"\n' + httpHandler + 'func main(){http.HandleFunc("/{id}",Handler);http.ListenAndServe(":8080",nil)}\n'); assert.equal((endpoints(await index(root))[0]!.metadata.routing as any).pattern.dialect, 'go-servemux-122');
  await writeFile(path.join(root, 'go.work'), 'go 1.25\nuse .\ngodebug httpmuxgo121=1\n'); await writeFile(path.join(root, 'main.go'), 'package main\nimport "net/http"\n' + httpHandler + 'func main(){http.HandleFunc("/{id}",Handler);http.ListenAndServe(":8080",nil)}\n'); assert.equal((endpoints(await index(root))[0]!.metadata.routing as any).pattern.dialect, 'go-servemux-121');
});

test('net/http specificity, HEAD and host guards select the original handler; redirects never claim handler execution', async () => {
  const root = await repository({ 'main.go': 'package main\nimport "net/http"\n' + httpHandler + 'func Item(w http.ResponseWriter,r *http.Request){}\nfunc Head(w http.ResponseWriter,r *http.Request){}\nfunc Host(w http.ResponseWriter,r *http.Request){}\nfunc main(){m:=http.NewServeMux();m.HandleFunc("/",Handler);m.HandleFunc("GET /items/{id}",Item);m.HandleFunc("HEAD /items/{id}",Head);m.HandleFunc("api.example.com/host",Host);m.HandleFunc("/tree/",Item);http.ListenAndServe(":8080",m)}\n', 'client.ts': 'export async function Read(){await fetch("https://api.example.com/items/1")}\nexport async function Heading(){await fetch("https://api.example.com/items/1",{method:"HEAD"})}\nexport async function Hosting(){await fetch("https://api.example.com/host")}\nexport async function Redirect(){await fetch("https://api.example.com/tree")}\n' });
  const g = await index(root); assert.equal(callback(g, requestTarget(g, 'Read')!)?.name, 'Item'); assert.equal(callback(g, requestTarget(g, 'Heading')!)?.name, 'Head'); assert.equal(callback(g, requestTarget(g, 'Hosting')!)?.name, 'Host'); assert.equal(callback(g, requestTarget(g, 'Redirect')!), undefined); assert.equal(requestTarget(g, 'Redirect')?.metadata.role, 'redirect');
});

test('net/http duplicate/conflicting patterns and callback mutation retain constrained candidates', async () => {
  for (const statements of ['m.HandleFunc("/x",Handler);m.HandleFunc("/x",Handler)', 'm.HandleFunc("GET /",Handler);m.HandleFunc("/x",Handler)', 'var h=Handler;h=Other;m.HandleFunc("/x",h)']) {
    const root = await repository({ 'main.go': 'package main\nimport "net/http"\n' + httpHandler + 'func Other(w http.ResponseWriter,r *http.Request){}\nfunc main(){m:=http.NewServeMux();' + statements + ';http.ListenAndServe(":8080",m)}\n' }); const g = await index(root); assert.ok(endpoints(g).every(item => item.metadata.constraintsUnresolved)); if (statements.startsWith('var')) assert.equal(g.relations.some(edge => edge.type === 'handles'), false);
  }
});

test('Chi core Route, Mount, Group, With and invoked imported helpers compose actual prefixes and callbacks', async () => {
  const root = await repository({ 'main.go': 'package main\nimport("net/http";"github.com/go-chi/chi/v5";h "example.com/server/helpers")\n' + httpHandler + 'func Auth(next http.Handler)http.Handler{return next}\nfunc main(){r:=chi.NewRouter();r.Use(Auth);r.Route("/api",func(x chi.Router){x.Get("/items/{id:[0-9]+}",Handler)});r.Group(func(x chi.Router){x.With(Auth).Get("/group",Handler)});child:=chi.NewRouter();h.Install(child);r.Mount("/mounted",child);http.ListenAndServe(":8080",r)}\n', 'helpers/helper.go': 'package helpers\nimport("net/http";"github.com/go-chi/chi/v5")\nfunc Imported(w http.ResponseWriter,r *http.Request){}\nfunc Install(r chi.Router){r.Get("/child",Imported)}\n' });
  const g = await index(root); assert.deepEqual(endpoints(g).map(item => item.metadata.routePath).sort(), ['/api/items/{id:[0-9]+}', '/group', '/mounted/child']); assert.ok(endpoints(g).every(item => !item.metadata.constraintsUnresolved), JSON.stringify(endpoints(g).map(e => e.metadata.constraints))); assert.equal(callback(g, endpoints(g, '/mounted/child')[0]!)?.name, 'Imported'); assert.ok((endpoints(g, '/group')[0]!.metadata.routing as any).middleware.length > 0); assert.ok((endpoints(g, '/mounted/child')[0]!.metadata.routing as any).mounts.length > 0);
});

test('Chi GET has no automatic HEAD, duplicate methods overwrite and unmounted routers stay unexposed', async () => {
  const root = await repository({ 'main.go': 'package main\nimport("net/http";"github.com/go-chi/chi/v5")\n' + httpHandler + 'func Last(w http.ResponseWriter,r *http.Request){}\nfunc main(){r:=chi.NewRouter();r.Get("/x",Handler);r.Get("/x",Last);unused:=chi.NewRouter();unused.Get("/unused",Handler);http.ListenAndServe(":8080",r)}\n', 'client.ts': 'export async function Heading(){await fetch("https://api.example.com/x",{method:"HEAD"})}\n' });
  const g = await index(root); assert.equal(endpoints(g).length, 1); assert.equal(callback(g, endpoints(g)[0]!)?.name, 'Last'); assert.equal(requestTarget(g, 'Heading'), undefined);
});

test('Chi middleware GetHead qualifies a HEAD fallback, while late Use and duplicate/self mounts retain panic gaps', async () => {
  const root = await repository({ 'main.go': 'package main\nimport("net/http";"github.com/go-chi/chi/v5";"github.com/go-chi/chi/v5/middleware")\n' + httpHandler + 'func main(){r:=chi.NewRouter();r.Use(middleware.GetHead);r.Get("/x",Handler);http.ListenAndServe(":8080",r)}\n', 'client.ts': 'export async function Heading(){await fetch("https://api.example.com/x",{method:"HEAD"})}\n' }); const g = await index(root); assert.ok(requestTarget(g, 'Heading'));
  await writeFile(path.join(root, 'main.go'), 'package main\nimport("net/http";"github.com/go-chi/chi/v5")\n' + httpHandler + 'func Auth(next http.Handler)http.Handler{return next}\nfunc main(){r:=chi.NewRouter();r.Get("/x",Handler);r.Use(Auth);r.Mount("/self",r);http.ListenAndServe(":8080",r)}\n'); const gap = await index(root); assert.ok(endpoints(gap).every(item => item.metadata.constraintsUnresolved));
});

test('Gin groups, static joined prefixes, snapshots and handler/middleware lists retain original callbacks', async () => {
  const root = await repository({ 'main.go': 'package main\nimport "github.com/gin-gonic/gin"\n' + ginHandler + 'func Auth(c *gin.Context){}\nfunc Later(c *gin.Context){}\nfunc main(){r:=gin.New();r.Use(gin.Logger(),Auth);g:=r.Group("/api");r.Use(Later);g.Group("/v1/").GET("items/:id",Auth,Handler);g.POST("/items",Handler);r.Run(":8080")}\n' });
  const g = await index(root); assert.deepEqual(endpoints(g).map(item => item.metadata.routePath).sort(), ['/api/items', '/api/v1/items/:id']); assert.ok(endpoints(g).every(item => !item.metadata.constraintsUnresolved)); const middleware = (endpoints(g)[0]!.metadata.routing as any).middleware as string[]; assert.ok(middleware.includes(g.entities.find(item => item.name === 'Auth')!.id)); assert.ok(!middleware.includes(g.entities.find(item => item.name === 'Later')!.id));
});

test('Gin helper/factory parameters, Match/Any and method-specific registration preserve actual method sets', async () => {
  const root = await repository({ 'main.go': 'package main\nimport "github.com/gin-gonic/gin"\n' + ginHandler + 'func Install(g *gin.RouterGroup){g.Match([]string{"GET","POST"},"/match",Handler);g.Any("/any",Handler);g.Handle("PURGE","/cache",Handler)}\nfunc Build()*gin.Engine{r:=gin.Default();Install(r.Group("/v1"));return r}\nfunc main(){Build().Run()}\n' });
  const g = await index(root); assert.equal(endpoints(g).length, 3); assert.ok(endpoints(g).every(item => !item.metadata.constraintsUnresolved)); assert.deepEqual((endpoints(g, '/v1/match')[0]!.metadata.routing as any).methods, ['GET', 'POST']); assert.equal((endpoints(g, '/v1/any')[0]!.metadata.routing as any).methods.length, 9);
});

test('Gin explicit HEAD, literal precedence and duplicate method/path panics are reflected in matching', async () => {
  const root = await repository({ 'main.go': 'package main\nimport "github.com/gin-gonic/gin"\n' + ginHandler + 'func Literal(c *gin.Context){}\nfunc main(){r:=gin.New();r.GET("/items/:id",Handler);r.GET("/items/new",Literal);r.Run()}\n', 'client.ts': 'export async function Read(){await fetch("https://api.example.com/items/new")}\nexport async function Heading(){await fetch("https://api.example.com/items/new",{method:"HEAD"})}\n' });
  const g = await index(root); assert.equal(callback(g, requestTarget(g, 'Read')!)?.name, 'Literal'); assert.equal(requestTarget(g, 'Heading'), undefined);
  await writeFile(path.join(root, 'main.go'), 'package main\nimport "github.com/gin-gonic/gin"\n' + ginHandler + 'func main(){r:=gin.New();r.GET("/x",Handler);r.GET("/x",Handler);r.Run()}\n'); assert.ok(endpoints(await index(root)).every(item => item.metadata.constraintsUnresolved));
});

test('Go lookalikes, uninvoked factories, version gaps, dynamic branches and router escapes never become confirmed APIs', async () => {
  const root = await repository({ 'main.go': 'package main\nimport "net/http"\n' + httpHandler + 'type Fake struct{}\nfunc(f Fake)GET(path string,h any){}\nfunc Unused(){m:=http.NewServeMux();m.HandleFunc("/unused",Handler);http.ListenAndServe(":8080",m)}\nfunc main(){f:=Fake{};f.GET("/fake",Handler)}\n' }); assert.equal(endpoints(await index(root)).length, 0);
  await writeFile(path.join(root, 'main.go'), 'package main\nimport "github.com/gin-gonic/gin"\n' + ginHandler + 'func Unknown(r *gin.Engine){}\nfunc main(){r:=gin.New();if enabled{r.GET("/conditional",Handler)};r.GET(dynamic,Handler);Unknown(r);r.Run()}\n'); const gap = await index(root); assert.ok(endpoints(gap).every(item => item.metadata.constraintsUnresolved));
  await writeFile(path.join(root, 'go.mod'), manifest.replace('v1.11.0', 'v1.9.0')); const older = await index(root); assert.ok(endpoints(older).length === 0 || endpoints(older).every(item => item.metadata.constraintsUnresolved)); assert.ok(older.diagnostics.some(item => item.code === 'go-router-version-profile'));
});

test('Go route registrations, original handler flow and source ranges replay across cold/warm/revision runs', async () => {
  const root = await repository({ 'main.go': '// 😀 source\r\npackage main\r\nimport("net/http";"github.com/go-chi/chi/v5")\r\n' + httpHandler + 'func main(){r:=chi.NewRouter();r.Route("/api",func(x chi.Router){x.Get("/inline",func(w http.ResponseWriter,r *http.Request){Handler(w,r)})});http.ListenAndServe(":8080",r)}\n' }), state = await mkdtemp(path.join(tmpdir(), 'codiluce-go-routes-cache-')); temporary.push(state);
  const cold = await index(root, {}, new AnalysisCache(state)), warm = await index(root, {}, new AnalysisCache(state)), revision = await index(root, {}, undefined, 'recorded'); assert.equal(stored(cold), stored(warm)); assert.equal(stored(cold), stored(revision)); assert.equal(endpoints(cold)[0]!.sourceRange?.startLine, 5); assert.equal(callback(cold, endpoints(cold)[0]!)?.metadata.declarationKind, 'closure');
  await writeFile(path.join(root, 'main.go'), '\n' + await (await import('node:fs/promises')).readFile(path.join(root, 'main.go'), 'utf8')); const moved = await index(root, {}, new AnalysisCache(state)); assert.equal(endpoints(moved)[0]!.id, endpoints(cold)[0]!.id); assert.equal(endpoints(moved)[0]!.sourceRange?.startLine, 6);
});

test('ServeMux mounts intersect parent method/host/path guards, preserve URL paths and respect parent precedence', async () => {
  const root = await repository({ 'main.go': 'package main\nimport "net/http"\n' + httpHandler + 'func Exact(w http.ResponseWriter,r *http.Request){}\nfunc main(){child:=http.NewServeMux();child.HandleFunc("GET /items/{id}",Handler);child.HandleFunc("POST /items/{id}",Handler);child.HandleFunc("/elsewhere",Handler);parent:=http.NewServeMux();parent.Handle("GET api.example.com/api/",http.StripPrefix("/api",child));parent.HandleFunc("GET /api/items/special",Exact);http.ListenAndServe(":8080",parent)}\n', 'client.ts': 'export async function Good(){await fetch("https://api.example.com/api/items/1")}\nexport async function WrongMethod(){await fetch("https://api.example.com/api/items/1",{method:"POST"})}\nexport async function ExactRead(){await fetch("https://api.example.com/api/items/special")}\nexport async function Outside(){await fetch("https://api.example.com/elsewhere")}\n' });
  const g = await index(root); assert.equal(callback(g, requestTarget(g, 'Good')!)?.name, 'Handler'); assert.equal(requestTarget(g, 'WrongMethod'), undefined); assert.equal(requestTarget(g, 'Outside'), undefined);
  // ServeMux's host-qualified mount wins over the hostless exact route.
  assert.equal(callback(g, requestTarget(g, 'ExactRead')!)?.name, 'Handler');
  await writeFile(path.join(root, 'main.go'), 'package main\nimport "net/http"\n' + httpHandler + 'func main(){child:=http.NewServeMux();child.HandleFunc("GET /api/items/{id}",Handler);child.HandleFunc("/elsewhere",Handler);parent:=http.NewServeMux();parent.Handle("GET /api/",child);http.ListenAndServe(":8080",parent)}\n');
  const preserved = await index(root); assert.equal(callback(preserved, requestTarget(preserved, 'Good')!)?.name, 'Handler'); assert.equal(requestTarget(preserved, 'Outside'), undefined); assert.ok(endpoints(preserved).every(item => !item.metadata.constraintsUnresolved));
});

test('Chi mounts retain root aliases, concrete handlers and URL.Path for non-Chi children', async () => {
  const root = await repository({ 'main.go': 'package main\nimport("net/http";"github.com/go-chi/chi/v5")\n' + httpHandler + 'func main(){r:=chi.NewRouter();child:=chi.NewRouter();child.Get("/",Handler);r.Mount("/nested",child);r.Mount("/concrete",http.HandlerFunc(Handler));mux:=http.NewServeMux();mux.HandleFunc("/native/x",Handler);r.Mount("/native",mux);http.ListenAndServe(":8080",r)}\n', 'client.ts': 'export async function Root(){await fetch("https://api.example.com/nested")}\nexport async function Slash(){await fetch("https://api.example.com/nested/")}\nexport async function Concrete(){await fetch("https://api.example.com/concrete")}\nexport async function Native(){await fetch("https://api.example.com/native/x")}\n' }); const g = await index(root);
  for (const name of ['Root', 'Slash', 'Concrete', 'Native']) assert.equal(callback(g, requestTarget(g, name)!)?.name, 'Handler', name);
});

test('Chi GetHead favors an explicit HEAD match across paths and follows mounted GET handlers otherwise', async () => {
  const root = await repository({ 'main.go': 'package main\nimport("net/http";"github.com/go-chi/chi/v5";"github.com/go-chi/chi/v5/middleware")\n' + httpHandler + 'func Heading(w http.ResponseWriter,r *http.Request){}\nfunc main(){r:=chi.NewRouter();r.Use(middleware.GetHead);r.Get("/items/new",Handler);r.Head("/items/{id}",Heading);r.Route("/api",func(x chi.Router){x.Get("/x",Handler)});http.ListenAndServe(":8080",r)}\n', 'client.ts': 'export async function Explicit(){await fetch("https://api.example.com/items/new",{method:"HEAD"})}\nexport async function Fallback(){await fetch("https://api.example.com/api/x",{method:"HEAD"})}\n' }); const g = await index(root); assert.equal(callback(g, requestTarget(g, 'Explicit')!)?.name, 'Heading'); assert.equal(callback(g, requestTarget(g, 'Fallback')!)?.name, 'Handler');
});

test('Gin wildcard-name and catch-all insertion conflicts constrain the entire serving tree', async () => {
  for (const routes of [['/items/:id/a', '/items/:name/b'], ['/files/*rest', '/files/static']]) {
    const root = await repository({ 'main.go': 'package main\nimport "github.com/gin-gonic/gin"\n' + ginHandler + `func main(){r:=gin.New();r.GET("${routes[0]}",Handler);r.GET("${routes[1]}",Handler);r.Run()}\n` }); assert.ok(endpoints(await index(root)).every(item => item.metadata.constraintsUnresolved), routes.join(', '));
  }
});

test('Go external router escapes, replacement namespaces and mutable routing options retain gaps', async () => {
  const root = await repository({ 'go.mod': manifest + 'require example.com/unknown v1.0.0\n', 'main.go': 'package main\nimport("github.com/gin-gonic/gin";"example.com/unknown")\n' + ginHandler + 'func main(){r:=gin.New();r.GET("/x",Handler);unknown.Configure(r);r.Run()}\n' }); assert.ok(endpoints(await index(root)).every(item => item.metadata.constraintsUnresolved));
  await writeFile(path.join(root, 'main.go'), 'package main\nimport "github.com/gin-gonic/gin"\n' + ginHandler + 'func main(){r:=gin.New();r.GET("/x",Handler);r.UseRawPath=true;r.Run()}\n'); assert.ok(endpoints(await index(root)).every(item => item.metadata.constraintsUnresolved));
  await writeFile(path.join(root, 'go.mod'), manifest + 'replace github.com/gin-gonic/gin => ./fake\n'); await mkdir(path.join(root, 'fake')); await writeFile(path.join(root, 'fake/go.mod'), 'module example.com/fake\ngo 1.25\n'); await writeFile(path.join(root, 'fake/gin.go'), 'package gin\ntype Context struct{}\ntype Engine struct{}\nfunc New()*Engine{return &Engine{}}\nfunc(e *Engine)GET(p string,h any){}\nfunc(e *Engine)Run(){}\n'); assert.equal(endpoints(await index(root)).length, 0);
});

test('Stored Go request flows show the original imported callback and its source range', async () => {
  const root = await repository({ 'main.go': 'package main\nimport("net/http";"example.com/server/handlers")\nfunc main(){m:=http.NewServeMux();m.HandleFunc("GET /flow",handlers.Handle);http.ListenAndServe(":8080",m)}\n', 'handlers/handler.go': 'package handlers\nimport "net/http"\nfunc Handle(w http.ResponseWriter,r *http.Request){}\n', 'client.ts': 'export async function Read(){await fetch("https://api.example.com/flow")}\n' }); const graph = await index(root), store = new GraphStore(':memory:');
  try { store.save(graph); const projection = new ProjectionService(store, { root }), endpoint = requestTarget(graph, 'Read')!, handler = callback(graph, endpoint)!; const flow = await projection.requestFlow(endpoint.id, { maxFileBytes: 1 << 20 }); assert.equal(flow.stages.handler, true); const original = flow.nodes.find(item => item.kind === 'handler')!; assert.equal(original.node?.id, handler.id); assert.equal(original.node?.path, 'handlers/handler.go'); assert.deepEqual(original.node?.sourceRange, handler.sourceRange); assert.ok(flow.edges.some(edge => edge.kind === 'handles' && edge.hops.some(hop => hop.to === handler.id))); } finally { store.close(); }
});

test('Gin trailing slashes remain singular and opaque group middleware does not constrain sibling routes', async () => {
  const root = await repository({ 'main.go': 'package main\nimport "github.com/gin-gonic/gin"\n' + ginHandler + 'func main(){r:=gin.Default();r.GET("/plain",Handler);g:=r.Group("/v1/");g.GET("/ping/",Handler);guarded:=r.Group("/auth",unindexedMiddleware());guarded.GET("/",Handler);r.GET("/later",Handler);r.Run()}\n', 'client.ts': 'export async function Ping(){await fetch("https://api.example.com/v1/ping/")}\n' }); const g = await index(root); assert.equal(callback(g, requestTarget(g, 'Ping')!)?.name, 'Handler'); assert.ok(!endpoints(g, '/plain')[0]!.metadata.constraintsUnresolved); assert.ok(!endpoints(g, '/later')[0]!.metadata.constraintsUnresolved); assert.ok(endpoints(g, '/auth/')[0]!.metadata.constraintsUnresolved);
});

test('ServeMux StripPrefix rejects alternate raw-prefix escapes, and short-circuit helper setup retains conditions', async () => {
  const root = await repository({ 'main.go': 'package main\nimport "net/http"\n' + httpHandler + 'func main(){child:=http.NewServeMux();child.HandleFunc("/x",Handler);parent:=http.NewServeMux();parent.Handle("/api/",http.StripPrefix("/api",child));http.ListenAndServe(":8080",parent)}\n', 'client.ts': 'export async function Encoded(){await fetch("https://api.example.com/%61pi/x")}\n' }); assert.equal(requestTarget(await index(root), 'Encoded'), undefined);
  await writeFile(path.join(root, 'main.go'), 'package main\nimport "net/http"\n' + httpHandler + 'func Install(r *http.ServeMux)bool{r.HandleFunc("/x",Handler);return true}\nfunc main(){m:=http.NewServeMux();_ = enabled && Install(m);http.ListenAndServe(":8080",m)}\n'); assert.ok(endpoints(await index(root)).every(item => item.metadata.constraintsUnresolved));
});

test('ServeMux exact slash patterns redirect missing slashes while existing wildcard handlers suppress redirects per method', async () => {
  const root = await repository({ 'main.go': 'package main\nimport "net/http"\n' + httpHandler + 'func Wild(w http.ResponseWriter,r *http.Request){}\nfunc main(){m:=http.NewServeMux();m.HandleFunc("/",Handler);m.HandleFunc("GET /exact/{$}",Handler);m.HandleFunc("/tree/",Handler);m.HandleFunc("POST /{id}",Wild);http.ListenAndServe(":8080",m)}\n', 'client.ts': 'export async function SlashRedirect(){await fetch("https://api.example.com/exact")}\nexport async function Wildcard(){await fetch("https://api.example.com/tree",{method:"POST"})}\n' }); const g = await index(root); assert.equal(requestTarget(g, 'SlashRedirect')?.metadata.role, 'redirect'); assert.equal(callback(g, requestTarget(g, 'Wildcard')!)?.name, 'Wild');
});

test('Go routing facts retain canonical dependency proof and path-mutating Chi middleware constrains matches', async () => {
  const root = await repository({ 'main.go': 'package main\nimport("net/http";"github.com/go-chi/chi/v5")\n' + httpHandler + 'func Rewrite(next http.Handler)http.Handler{return http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){r.URL.Path="/changed";next.ServeHTTP(w,r)})}\nfunc main(){r:=chi.NewRouter();r.Use(Rewrite);r.Get("/x",Handler);http.ListenAndServe(":8080",r)}\n' }); const g = await index(root); assert.ok(endpoints(g)[0]!.metadata.constraintsUnresolved); assert.ok(endpoints(g)[0]!.evidence.some(item => item.file === 'go.mod' && item.explanation?.includes('github.com/go-chi/chi/v5')));
});

test('Dynamic Go paths and group prefixes remain competing candidates for literal request matches', async () => {
  for (const source of ['r.GET("/known",Handler);r.GET(dynamic,Handler)', 'r.GET("/known",Handler);r.Group(dynamic).GET("/x",Handler)']) {
    const root = await repository({ 'main.go': 'package main\nimport "github.com/gin-gonic/gin"\n' + ginHandler + `func main(){r:=gin.New();${source};r.Run()}\n`, 'client.ts': 'export async function Read(){await fetch("https://api.example.com/known")}\n' }); const g = await index(root); assert.equal(requestTarget(g, 'Read'), undefined); assert.ok(g.diagnostics.some(item => item.code === 'ambiguous-http-match'));
  }
});

test('Go program termination before serving blocks exposure and conditional termination remains a gap', async () => {
  const root = await repository({ 'main.go': 'package main\nimport("net/http";"github.com/go-chi/chi/v5")\n' + httpHandler + 'func Fail(){panic("stop")}\nfunc main(){r:=chi.NewRouter();r.Get("/x",Handler);Fail();http.ListenAndServe(":8080",r)}\n' }); assert.equal(endpoints(await index(root)).length, 0);
  await writeFile(path.join(root, 'main.go'), 'package main\nimport("net/http";"github.com/go-chi/chi/v5")\n' + httpHandler + 'func main(){r:=chi.NewRouter();r.Get("/x",Handler);if enabled{panic("stop")};http.ListenAndServe(":8080",r)}\n'); assert.ok(endpoints(await index(root)).every(item => item.metadata.constraintsUnresolved));
});

test('Opaque Go path escapes retain a possible competitor prefix instead of an impossible raw spelling', () => {
  assert.equal(matchRoutePattern(compileGinPath('/colon\\:literal'), '/colon:literal'), true);
  assert.equal(matchRoutePattern(compileGoMux('/item?opaque', true).pattern, '/item%3Fopaque'), true);
  assert.equal(matchRoutePattern(compileChiPath('/item/{id:\\p{L}+}'), '/item/name'), true);
});

test('DefaultServeMux replacement uses the actual receiver and conditional Server.Handler writes retain gaps', async () => {
  const root = await repository({ 'main.go': 'package main\nimport "net/http"\n' + httpHandler + 'func main(){http.HandleFunc("/old",Handler);http.DefaultServeMux=http.NewServeMux();http.HandleFunc("/new",Handler);http.ListenAndServe(":8080",nil)}\n' }); assert.deepEqual(endpoints(await index(root)).map(item => item.metadata.routePath), ['/new']);
  await writeFile(path.join(root, 'main.go'), 'package main\nimport "net/http"\n' + httpHandler + 'func main(){m:=http.NewServeMux();m.HandleFunc("/x",Handler);s:=&http.Server{};if enabled{s.Handler=m};s.ListenAndServe()}\n'); const constrained = endpoints(await index(root)); assert.equal(constrained.length, 1); assert.ok(constrained[0]!.metadata.constraintsUnresolved);
});
