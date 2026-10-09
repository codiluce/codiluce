import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { indexRepository } from '../src/pipeline/index.js';
import { resolveConfig } from '../src/core/config.js';
import type { Entity, SoftwareGraph } from '../src/core/graph.js';
import { compileEchoPath, compileFiberPath, compileGorillaPath } from '../src/analysis/routes/go-patterns.js';
import { matchRoutePattern } from '../src/analysis/routes/contracts.js';
import { AnalysisCache } from '../src/pipeline/cache.js';
import { canonicalJson } from '../src/history/fingerprint.js';
import { GraphStore } from '../src/storage/sqlite.js';
import { ProjectionService } from '../src/projection/service.js';

const roots: string[] = []; after(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });
const manifest = 'module example.com/server\ngo 1.26\nrequire (\n github.com/labstack/echo/v4 v4.13.4\n github.com/labstack/echo/v5 v5.4.0\n github.com/gofiber/fiber/v2 v2.52.9\n github.com/gofiber/fiber/v3 v3.5.0\n github.com/gorilla/mux v1.8.1\n)\n';
async function repository(files: Record<string, string>) { const root = await mkdtemp(path.join(tmpdir(), 'codiluce-go-packs-')); roots.push(root); for (const [file, text] of Object.entries({ 'go.mod': manifest, ...files })) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); } return root; }
async function index(root: string, cache?: AnalysisCache, revision?: string) { const config = await resolveConfig(root, { repository: { name: 'go-packs' }, applications: [{ name: 'server', path: '.', ecosystems: ['go'], apiOrigins: ['https://api.example.com'], go: { goos: 'linux', goarch: 'amd64', compiler: 'gc', toolchainVersion: '1.26', cgoEnabled: false, tags: [] } }] }); return indexRepository(root, { config, cache, revision }); }
const endpoints = (graph: SoftwareGraph, route?: string) => graph.entities.filter(item => item.type === 'api_endpoint' && item.metadata.registration !== 'implicit' && (!route || item.metadata.routePath === route));
const handler = (graph: SoftwareGraph, endpoint?: Entity) => graph.entities.find(item => endpoint && graph.relations.some(edge => edge.from === endpoint.id && edge.to === item.id && edge.type === 'handles'));
const target = (graph: SoftwareGraph, name: string) => graph.entities.find(item => graph.relations.some(edge => edge.type === 'requests' && edge.from === graph.entities.find(owner => owner.name === name)?.id && edge.to === item.id));
const shape = (graph: SoftwareGraph) => canonicalJson({ entities: graph.entities, relations: graph.relations, diagnostics: graph.diagnostics.filter(item => !['indexer', 'git-metrics'].includes(item.analyzer) && item.code !== 'git-ignore-unavailable') });
const http = 'func Handler(w http.ResponseWriter,r *http.Request){}\n';

test('Echo, Fiber and Gorilla path dialects retain slash, prefix, constraint and escaped-path behavior', () => {
  assert.equal(matchRoutePattern(compileEchoPath('/items/:id', 4), '/items/a%2Fb'), true); assert.equal(matchRoutePattern(compileEchoPath('/items/:id', 5), '/items/a/b'), false);
  assert.equal(matchRoutePattern(compileFiberPath('/Items/:id?', 2), '/items/'), true); assert.equal(matchRoutePattern(compileFiberPath('/Items/:id?', 2), '/ITEMS/1'), true); assert.equal(matchRoutePattern(compileFiberPath('/Items/:id?', 3, { caseSensitive: true }), '/items/1'), false);
  assert.equal(matchRoutePattern(compileFiberPath('/files/*', 2), '/files'), true); assert.equal(matchRoutePattern(compileFiberPath('/files/+', 3), '/files'), false); assert.equal(matchRoutePattern(compileFiberPath('/items/:id<int>', 3), '/items/abc'), false);
  assert.equal(matchRoutePattern(compileGorillaPath('/api', { prefix: true }), '/apix'), true); assert.equal(matchRoutePattern(compileGorillaPath('/files/{id}'), '/files/a%2Fb'), false); assert.equal(matchRoutePattern(compileGorillaPath('/files/{id}', { encoded: true }), '/files/a%2Fb'), true);
});

test('Echo 4 concatenates nested group prefixes, keeps registration middleware snapshots and original imported handlers', async () => {
  const root = await repository({ 'main.go': 'package main\nimport(e "github.com/labstack/echo/v4";"example.com/server/handlers")\nfunc Auth(next e.HandlerFunc)e.HandlerFunc{return next}\nfunc Late(next e.HandlerFunc)e.HandlerFunc{return next}\nfunc main(){x:=e.New();g:=x.Group("/v1",Auth);g.GET("/early",handlers.Handle);g.Use(Late);g.Group("/nested").POST("child",handlers.Handle,Auth);x.Start(":8080")}\n', 'handlers/handler.go': 'package handlers\nimport "github.com/labstack/echo/v4"\nfunc Handle(c echo.Context)error{return nil}\n' }); const g = await index(root);
  assert.deepEqual(endpoints(g).map(item => item.metadata.routePath).sort(), ['/v1/early', '/v1/nestedchild']); assert.ok(endpoints(g).every(item => !item.metadata.constraintsUnresolved), JSON.stringify(endpoints(g).map(item => item.metadata.constraints))); assert.ok(endpoints(g).every(item => handler(g, item)?.path === 'handlers/handler.go')); const early = endpoints(g, '/v1/early')[0]!.metadata.routing as any; assert.ok(!early.middleware.includes(g.entities.find(item => item.name === 'Late')!.id));
});

test('Echo 4 and 5 select distinct callback and Any method profiles; GET has no implicit HEAD', async () => {
  for (const [version, signature, expected] of [['4', 'echo.Context', false], ['5', '*echo.Context', true]] as const) {
    const root = await repository({ 'main.go': `package main\nimport "github.com/labstack/echo/v${version}"\nfunc Handler(c ${signature})error{return nil}\nfunc main(){e:=echo.New();e.Any("/any",Handler);e.GET("/get",Handler);e.Match([]string{"GET","POST"},"/match",Handler);e.Start(":8080")}\n`, 'client.ts': 'export async function Custom(){await fetch("https://api.example.com/any",{method:"CUSTOM"})}\nexport async function Heading(){await fetch("https://api.example.com/get",{method:"HEAD"})}\n' }); const g = await index(root); assert.equal(endpoints(g).length, 3); assert.equal(!!target(g, 'Custom'), expected); assert.equal(target(g, 'Heading'), undefined); assert.ok(endpoints(g).every(item => !item.metadata.constraintsUnresolved));
  }
});

test('Echo overwrites equivalent parameter registrations, prefers static paths and applies global Use added later', async () => {
  const root = await repository({ 'main.go': 'package main\nimport "github.com/labstack/echo/v4"\nfunc First(c echo.Context)error{return nil}\nfunc Last(c echo.Context)error{return nil}\nfunc Static(c echo.Context)error{return nil}\nfunc Auth(next echo.HandlerFunc)echo.HandlerFunc{return next}\nfunc main(){e:=echo.New();e.GET("/items/:id",First);e.GET("/items/:name",Last);e.GET("/items/new",Static);e.Use(Auth);e.Start(":8080")}\n', 'client.ts': 'export async function Read(){await fetch("https://api.example.com/items/1")}\nexport async function New(){await fetch("https://api.example.com/items/new")}\n' }); const g = await index(root); assert.equal(handler(g, target(g, 'Read'))?.name, 'Last'); assert.equal(handler(g, target(g, 'New'))?.name, 'Static'); assert.ok(endpoints(g).every(item => (item.metadata.routing as any).middleware.includes(g.entities.find(item => item.name === 'Auth')!.id)));
});

test('Echo host routers replace the default router for that authority and Pre/custom configuration retain gaps', async () => {
  const root = await repository({ 'main.go': 'package main\nimport "github.com/labstack/echo/v4"\nfunc Handler(c echo.Context)error{return nil}\nfunc main(){e:=echo.New();e.GET("/default",Handler);e.Host("api.example.com").GET("/host",Handler);e.Start(":8080")}\n', 'client.ts': 'export async function Default(){await fetch("https://api.example.com/default")}\nexport async function Host(){await fetch("https://api.example.com/host")}\n' }); const g = await index(root); assert.equal(target(g, 'Default'), undefined); assert.ok(target(g, 'Host'));
  await writeFile(path.join(root, 'main.go'), 'package main\nimport "github.com/labstack/echo/v5"\nfunc Handler(c *echo.Context)error{return nil}\nfunc main(){e:=echo.New();e.Pre(unknown);e.GET("/x",Handler);e.Start(":8080")}\n'); const gap = endpoints(await index(root)); assert.equal(gap.length, 1); assert.ok(gap[0]!.metadata.constraintsUnresolved);
});

test('Fiber 2 groups, Route summaries, GET/HEAD and first-match order retain original handlers', async () => {
  const root = await repository({ 'main.go': 'package main\nimport "github.com/gofiber/fiber/v2"\nfunc Handler(c *fiber.Ctx)error{return nil}\nfunc Static(c *fiber.Ctx)error{return nil}\nfunc Auth(c *fiber.Ctx)error{return c.Next()}\nfunc Install(r fiber.Router){r.Get("/:id",Handler)}\nfunc main(){a:=fiber.New();a.Group("/v1",Auth).Route("/items",Install);a.Get("/v1/items/new",Static);a.Listen(":8080")}\n', 'client.ts': 'export async function Read(){await fetch("https://api.example.com/V1/items/new/")}\nexport async function Heading(){await fetch("https://api.example.com/v1/items/1",{method:"HEAD"})}\n' }); const g = await index(root); assert.equal(handler(g, target(g, 'Read'))?.name, 'Handler'); assert.equal(handler(g, target(g, 'Heading'))?.name, 'Handler'); assert.ok(endpoints(g).every(item => !item.metadata.constraintsUnresolved), JSON.stringify(endpoints(g).map(item => item.metadata.constraints)));
});

test('Fiber 3 automatic HEAD defers to explicit same-path HEAD and supports literal Add method sets and RouteChain', async () => {
  const root = await repository({ 'main.go': 'package main\nimport "github.com/gofiber/fiber/v3"\nfunc Handler(c fiber.Ctx)error{return nil}\nfunc Heading(c fiber.Ctx)error{return nil}\nfunc main(){a:=fiber.New();a.Get("/x",Handler);a.Head("/x",Heading);a.Add([]string{"GET","POST"},"/match",Handler);a.RouteChain("/chain").Get(Handler).Post(Handler);a.Listen(":8080")}\n', 'client.ts': 'export async function Head(){await fetch("https://api.example.com/x",{method:"HEAD"})}\nexport async function Chain(){await fetch("https://api.example.com/chain",{method:"POST"})}\n' }); const g = await index(root); assert.equal(handler(g, target(g, 'Head'))?.name, 'Heading'); assert.ok(target(g, 'Chain')); assert.ok(endpoints(g).every(item => !item.metadata.constraintsUnresolved)); assert.deepEqual((endpoints(g, '/match').find(item => item.metadata.method !== 'HEAD')!.metadata.routing as any).methods, ['GET', 'POST']);
});

test('Fiber configuration controls case, strict slashes, escaping, method sets and automatic HEAD', async () => {
  const root = await repository({ 'main.go': 'package main\nimport "github.com/gofiber/fiber/v3"\nfunc Handler(c fiber.Ctx)error{return nil}\nfunc main(){a:=fiber.New(fiber.Config{CaseSensitive:true,StrictRouting:true,DisableHeadAutoRegister:true,RequestMethods:[]string{"GET","HEAD","PURGE"}});a.Get("/Items/",Handler);a.All("/all",Handler);a.Listen(":8080")}\n', 'client.ts': 'export async function WrongCase(){await fetch("https://api.example.com/items/")}\nexport async function WrongSlash(){await fetch("https://api.example.com/Items")}\nexport async function Head(){await fetch("https://api.example.com/Items/",{method:"HEAD"})}\nexport async function Purge(){await fetch("https://api.example.com/all",{method:"PURGE"})}\n' }); const g = await index(root); assert.equal(target(g, 'WrongCase'), undefined); assert.equal(target(g, 'WrongSlash'), undefined); assert.equal(target(g, 'Head'), undefined); assert.ok(target(g, 'Purge'));
});

test('Fiber 2 Mount and Fiber 3 Use(app) preserve nested mount paths and callbacks', async () => {
  for (const version of [2, 3]) {
    const root = await repository({ 'main.go': `package main\nimport "github.com/gofiber/fiber/v${version}"\nfunc Handler(c ${version === 2 ? '*' : ''}fiber.Ctx)error{return nil}\nfunc main(){a:=fiber.New();child:=fiber.New();child.Group("/v1").Get("/x",Handler);a.${version === 2 ? 'Mount' : 'Use'}("/api",child);a.Listen(":8080")}\n`, 'client.ts': 'export async function Read(){await fetch("https://api.example.com/api/v1/x")}\n' }); const g = await index(root); assert.equal(handler(g, target(g, 'Read'))?.name, 'Handler', `${version}: ${JSON.stringify(g.diagnostics.filter(item => item.analyzer === 'go-routers' || item.analyzer === 'api-matcher'))}`); assert.ok((target(g, 'Read')!.metadata.routing as any).mounts.length);
  }
});

test('Fiber middleware order and unresolved continuation affect only eligible later routes', async () => {
  const root = await repository({ 'main.go': 'package main\nimport "github.com/gofiber/fiber/v2"\nfunc Handler(c *fiber.Ctx)error{return nil}\nfunc Stop(c *fiber.Ctx)error{return nil}\nfunc main(){a:=fiber.New();a.Get("/before",Handler);a.Use("/private/",Stop);a.Get("/private",Handler);a.Get("/private/x",Handler);a.Get("/public",Handler);a.Listen(":8080")}\n' }); const g = await index(root); assert.ok(!endpoints(g, '/before')[0]!.metadata.constraintsUnresolved); assert.ok(!endpoints(g, '/public')[0]!.metadata.constraintsUnresolved); assert.ok(endpoints(g, '/private/x')[0]!.metadata.constraintsUnresolved); assert.ok(endpoints(g, '/private')[0]!.metadata.constraintsUnresolved);
});

test('Gorilla mutable route builders, method guards, host/query matchers and subrouters use original handlers', async () => {
  const root = await repository({ 'main.go': 'package main\nimport("net/http";"github.com/gorilla/mux")\n' + http + 'func main(){r:=mux.NewRouter();s:=r.Host("api.example.com").PathPrefix("/api").Subrouter();route:=s.HandleFunc("/items/{id:[0-9]+}",Handler);route.Methods("get");route.Queries("view","full","token","{token}");http.ListenAndServe(":8080",r)}\n', 'client.ts': 'export async function Good(){await fetch("https://api.example.com/api/items/1?view=full&token=abc")}\nexport async function Missing(){await fetch("https://api.example.com/api/items/1?view=full")}\nexport async function Bad(){await fetch("https://api.example.com/api/items/1?view=small&token=abc")}\nexport async function Post(){await fetch("https://api.example.com/api/items/1?view=full&token=abc",{method:"POST"})}\n' }); const g = await index(root); assert.equal(handler(g, target(g, 'Good'))?.name, 'Handler', JSON.stringify(endpoints(g).map(item => item.metadata))); for (const name of ['Missing', 'Bad', 'Post']) assert.equal(target(g, name), undefined);
});

test('Gorilla first-match precedence, explicit HEAD and encoded paths differ from ServeMux semantics', async () => {
  const root = await repository({ 'main.go': 'package main\nimport("net/http";"github.com/gorilla/mux")\n' + http + 'func Literal(w http.ResponseWriter,r *http.Request){}\nfunc main(){r:=mux.NewRouter();r.UseEncodedPath();r.HandleFunc("/items/{id}",Handler).Methods("GET");r.HandleFunc("/items/new",Literal).Methods("GET");http.ListenAndServe(":8080",r)}\n', 'client.ts': 'export async function Read(){await fetch("https://api.example.com/items/new")}\nexport async function Encoded(){await fetch("https://api.example.com/items/a%2Fb")}\nexport async function Heading(){await fetch("https://api.example.com/items/new",{method:"HEAD"})}\n' }); const g = await index(root); assert.equal(handler(g, target(g, 'Read'))?.name, 'Handler'); assert.ok(target(g, 'Encoded')); assert.equal(target(g, 'Heading'), undefined);
});

test('Gorilla strict-slash redirects have no handler, while header/custom/templated-host matchers retain gaps', async () => {
  const root = await repository({ 'main.go': 'package main\nimport("net/http";"github.com/gorilla/mux")\n' + http + 'func main(){r:=mux.NewRouter();r.StrictSlash(true);r.HandleFunc("/slash/",Handler).Methods("GET");r.HandleFunc("/header",Handler).Headers("X-Mode","test");r.HandleFunc("/host",Handler).Host("{tenant}.example.com");http.ListenAndServe(":8080",r)}\n', 'client.ts': 'export async function Redirect(){await fetch("https://api.example.com/slash")}\nexport async function Header(){await fetch("https://api.example.com/header")}\n' }); const g = await index(root); assert.equal(target(g, 'Redirect')?.metadata.role, 'redirect'); assert.equal(handler(g, target(g, 'Redirect')), undefined); assert.equal(target(g, 'Header'), undefined); assert.ok(endpoints(g, '/host')[0]!.metadata.constraintsUnresolved);
});

test('Additional Go router namespace profiles reject replacements, old majors, lookalikes and uninvoked factories', async () => {
  const root = await repository({ 'main.go': 'package main\nimport "github.com/labstack/echo/v5"\nfunc Handler(c *echo.Context)error{return nil}\nfunc Unused(){e:=echo.New();e.GET("/unused",Handler);e.Start(":8080")}\nfunc main(){}\n' }); assert.equal(endpoints(await index(root)).length, 0);
  await writeFile(path.join(root, 'main.go'), 'package main\nimport "github.com/labstack/echo/v5"\nfunc Handler(c *echo.Context)error{return nil}\nfunc main(){e:=echo.New();e.GET("/x",Handler);e.Start(":8080")}\n'); await writeFile(path.join(root, 'go.mod'), manifest.replace('v5.4.0', 'v5.3.1')); const g = await index(root); assert.ok(endpoints(g).length === 0 || endpoints(g).every(item => item.metadata.constraintsUnresolved)); assert.ok(g.diagnostics.some(item => item.code === 'go-router-version-profile'));
});

test('Additional Go packs replay original callbacks through caches, revisions and stored request flows', async () => {
  const root = await repository({ 'main.go': '// 😀 original\r\npackage main\r\nimport "github.com/labstack/echo/v5"\r\nfunc Build()*echo.Echo{e:=echo.New();e.GET("/flow",func(c *echo.Context)error{return nil});return e}\r\nfunc main(){Build().Start(":8080")}\r\n' }), state = await mkdtemp(path.join(tmpdir(), 'codiluce-go-packs-cache-')); roots.push(state); const cold = await index(root, new AnalysisCache(state)), warm = await index(root, new AnalysisCache(state)), revision = await index(root, undefined, 'recorded'); assert.equal(shape(cold), shape(warm)); assert.equal(shape(cold), shape(revision)); const endpoint = endpoints(cold)[0]!; assert.equal(endpoint.sourceRange?.startLine, 4);
  const store = new GraphStore(':memory:'); try { store.save(cold); const projection = new ProjectionService(store, { root }), flow = await projection.requestFlow(endpoint.id, { maxFileBytes: 1 << 20 }); assert.equal(flow.stages.handler, true); assert.equal(flow.nodes.find(item => item.kind === 'handler')?.node?.sourceRange?.startLine, 4); } finally { store.close(); }
  await writeFile(path.join(root, 'go.mod'), manifest.replace('v5.4.0', 'v5.3.1')); assert.equal(shape(await index(root, new AnalysisCache(state))), shape(await index(root)));
});


test('Echo group fallback responses keep middleware and never invent an indexed 404 handler', async () => {
  const root = await repository({ 'main.go': `package main
import "github.com/labstack/echo/v5"
func Auth(next echo.HandlerFunc)echo.HandlerFunc{return next}
func Handler(c *echo.Context)error{return nil}
func main(){e:=echo.New();e.Group("/private",Auth).GET("/found",Handler);e.Start(":8080")}
`, 'client.ts': `export async function Found(){await fetch("https://api.example.com/private/found")}
export async function Missing(){await fetch("https://api.example.com/private/missing")}
export async function Root(){await fetch("https://api.example.com/private")}
` }); const g = await index(root); assert.equal(handler(g, target(g, 'Found'))?.name, 'Handler');
  for (const name of ['Missing', 'Root']) { const endpoint = target(g, name); assert.equal(endpoint?.metadata.role, 'not-found'); assert.equal(endpoint?.metadata.status, 404); assert.equal(handler(g, endpoint), undefined); assert.ok((endpoint?.metadata.routing as any).middleware.includes(g.entities.find(item => item.name === 'Auth')!.id)); }
  const main = `package main
import "github.com/labstack/echo/v5"
func Auth(next echo.HandlerFunc)echo.HandlerFunc{return next}
func Handler(c *echo.Context)error{return nil}
func main(){e:=echo.NewWithConfig(echo.Config{NoGroupAutoRegister404Routes:true});e.Group("/private",Auth).GET("/found",Handler);e.Start(":8080")}
`; await writeFile(path.join(root, 'main.go'), main); const disabled = await index(root); assert.equal(target(disabled, 'Missing'), undefined); assert.ok(target(disabled, 'Found'));
});

test('Gorilla repeated method matchers intersect and unresolved matcher mutations stay constrained', async () => {
  const root = await repository({ 'main.go': `package main
import("net/http";"github.com/gorilla/mux")
${http}
func main(){r:=mux.NewRouter();r.HandleFunc("/both",Handler).Methods("GET","POST").Methods("POST");r.HandleFunc("/none",Handler).Methods("GET").Methods("POST");r.HandleFunc("/repeat",Handler).Path("/other");r.HandleFunc("/scheme",Handler).Schemes("https");http.ListenAndServe(":8080",r)}
`, 'client.ts': `export async function Get(){await fetch("https://api.example.com/both")}
export async function Post(){await fetch("https://api.example.com/both",{method:"POST"})}
export async function None(){await fetch("https://api.example.com/none",{method:"POST"})}
export async function Repeated(){await fetch("https://api.example.com/other")}
export async function Scheme(){await fetch("https://api.example.com/scheme")}
` }); const g = await index(root); assert.equal(target(g, 'Get'), undefined); assert.equal(handler(g, target(g, 'Post'))?.name, 'Handler'); assert.equal(target(g, 'None'), undefined); assert.equal(target(g, 'Repeated'), undefined); assert.equal(target(g, 'Scheme'), undefined); assert.ok(endpoints(g, '/other')[0]!.metadata.constraintsUnresolved); assert.ok(endpoints(g, '/scheme')[0]!.metadata.constraintsUnresolved);
});

test('Fiber 3 HEAD synthesis respects case, strict paths and configured method availability', async () => {
  const root = await repository({ 'main.go': `package main
import "github.com/gofiber/fiber/v3"
func Get(c fiber.Ctx)error{return nil}
func Head(c fiber.Ctx)error{return nil}
func main(){a:=fiber.New(fiber.Config{CaseSensitive:true,StrictRouting:true});a.Get("/Case",Get);a.Head("/case",Head);a.Get("/slash/",Get);a.Head("/slash",Head);a.Listen(":8080")}
`, 'client.ts': `export async function Upper(){await fetch("https://api.example.com/Case",{method:"HEAD"})}
export async function Lower(){await fetch("https://api.example.com/case",{method:"HEAD"})}
export async function Slash(){await fetch("https://api.example.com/slash/",{method:"HEAD"})}
` }); const g = await index(root); assert.equal(handler(g, target(g, 'Upper'))?.name, 'Get'); assert.equal(handler(g, target(g, 'Lower'))?.name, 'Head'); assert.equal(handler(g, target(g, 'Slash'))?.name, 'Get');
  await writeFile(path.join(root, 'main.go'), `package main
import "github.com/gofiber/fiber/v3"
func Get(c fiber.Ctx)error{return nil}
func main(){a:=fiber.New(fiber.Config{RequestMethods:[]string{fiber.MethodGet}});a.Get("/Case",Get);a.Listen(":8080")}
`); assert.equal(target(await index(root), 'Upper'), undefined);
});

test('Fiber mounted apps inherit ordered middleware while conditional Next remains uncertain', async () => {
  const root = await repository({ 'main.go': `package main
import "github.com/gofiber/fiber/v3"
func Handler(c fiber.Ctx)error{return nil}
func Auth(c fiber.Ctx)error{return c.Next()}
func Maybe(c fiber.Ctx)error{if unknown{return c.Next()};return nil}
func main(){a:=fiber.New();child:=fiber.New();child.RouteChain("/items").Add([]string{fiber.MethodGet},Handler);a.Use("/API",Auth);a.Use("/api",child);a.Use("/api",Maybe);a.Get("/api/late",Handler);a.Listen(":8080")}
`, 'client.ts': `export async function Mounted(){await fetch("https://api.example.com/api/items")}
export async function Late(){await fetch("https://api.example.com/api/late")}
` }); const g = await index(root), mounted = target(g, 'Mounted'); assert.equal(handler(g, mounted)?.name, 'Handler'); assert.ok((mounted!.metadata.routing as any).middleware.includes(g.entities.find(item => item.name === 'Auth')!.id)); assert.equal(target(g, 'Late'), undefined); assert.ok(endpoints(g, '/api/late')[0]!.metadata.constraintsUnresolved);
});

test('Fiber integer constraints use signed native Go widths and preserve unreviewed delimiters', () => {
  for (const value of ['-1', '+1', '9223372036854775807', '-9223372036854775808']) assert.ok(matchRoutePattern(compileFiberPath('/:id<int>', 3), `/${value}`));
  for (const value of ['9223372036854775808', '-9223372036854775809', '1.0', '']) assert.equal(matchRoutePattern(compileFiberPath('/:id<int>', 3), `/${value}`), false);
  assert.equal(matchRoutePattern(compileFiberPath('/:id<int>', 2, {integerBits:32}), '/2147483648'), false); assert.ok(matchRoutePattern(compileFiberPath('/:id<int>', 2, {integerBits:32}), '/-2147483648'));
  assert.equal(compileFiberPath('/:a:b', 3).status, 'partial'); assert.equal(compileFiberPath('/:id<int>-suffix', 3).status, 'partial');
});

test('Fetch custom methods preserve case while standard normalization and forbidden methods follow the API', async () => {
  const root = await repository({ 'main.go': `package main
import "github.com/labstack/echo/v5"
func Handler(c *echo.Context)error{return nil}
func main(){e:=echo.New();e.Add("custom","/case",Handler);e.Add("GET","/standard",Handler);e.PATCH("/patch",Handler);e.Any("/invalid",Handler);e.Start(":8080")}
`, 'client.ts': `export async function Custom(){await fetch("https://api.example.com/case",{method:"custom"})}
export async function WrongCase(){await fetch("https://api.example.com/case",{method:"CUSTOM"})}
export async function Standard(){await fetch("https://api.example.com/standard",{method:"get"})}
export async function LowerPatch(){await fetch("https://api.example.com/patch",{method:"patch"})}
export async function UpperPatch(){await fetch("https://api.example.com/patch",{method:"PATCH"})}
export async function Invalid(){await fetch("https://api.example.com/invalid",{method:"bad method"})}
export async function Forbidden(){await fetch("https://api.example.com/invalid",{method:"TRACE"})}
` }); const g = await index(root); assert.equal(handler(g, target(g, 'Custom'))?.name, 'Handler'); assert.equal(target(g, 'WrongCase'), undefined); assert.ok(target(g, 'Standard')); assert.equal(target(g, 'LowerPatch'), undefined); assert.ok(target(g, 'UpperPatch')); assert.equal(target(g, 'Invalid'), undefined); assert.equal(target(g, 'Forbidden'), undefined);
});

test('Canonical-looking local module replacements and unrelated router methods cannot acquire Go pack identities', async () => {
  const root = await repository({ 'go.mod': manifest + 'replace github.com/labstack/echo/v5 => ./local-echo\n', 'local-echo/go.mod': 'module github.com/labstack/echo/v5\ngo 1.26\n', 'local-echo/echo.go': `package echo
 type Context struct{}
 type Echo struct{}
 func New()*Echo{return &Echo{}}
 func(e *Echo)GET(path string,h func(*Context)error){}
 func(e *Echo)Start(addr string){}
`, 'main.go': `package main
import "github.com/labstack/echo/v5"
func Handler(c *echo.Context)error{return nil}
func main(){e:=echo.New();e.GET("/impostor",Handler);e.Start(":8080")}
` }); assert.equal(endpoints(await index(root)).length, 0);
  await writeFile(path.join(root, 'main.go'), `package main
 type Service struct{}
 func(s *Service)Get(path string,h func()){}
 func(s *Service)Listen(addr string){}
 func Handler(){}
 func main(){s:=&Service{};s.Get("/lookalike",Handler);s.Listen(":8080")}
`); assert.equal(endpoints(await index(root)).length, 0);
});


test('Gorilla same-path query alternatives retain distinct endpoint identities and first-value query semantics', async () => {
  const root = await repository({ 'main.go': `package main
import("net/http";"github.com/gorilla/mux")
func One(w http.ResponseWriter,r *http.Request){}
func Two(w http.ResponseWriter,r *http.Request){}
func main(){r:=mux.NewRouter();r.HandleFunc("/query",One).Methods("GET").Queries("view","one");r.HandleFunc("/query",Two).Methods("GET").Queries("view","two");http.ListenAndServe(":8080",r)}
`, 'client.ts': `export async function First(){await fetch("https://api.example.com/query?view=one&view=two")}
export async function Second(){await fetch("https://api.example.com/query?view=two")}
export async function Missing(){await fetch("https://api.example.com/query")}
` }); const g = await index(root); assert.equal(endpoints(g, '/query').length, 2); assert.equal(handler(g, target(g, 'First'))?.name, 'One'); assert.equal(handler(g, target(g, 'Second'))?.name, 'Two'); assert.equal(target(g, 'Missing'), undefined);
});

test('Echo and Fiber middleware factories require a canonical major and reviewed continuation/configuration', async () => {
  const root = await repository({ 'main.go': `package main
import("github.com/labstack/echo/v5";"github.com/labstack/echo/v5/middleware")
func Handler(c *echo.Context)error{return nil}
func main(){e:=echo.New();e.Use(middleware.RequestLogger());e.Use(middleware.Recover());e.GET("/stock",Handler);e.Start(":8080")}
` }); assert.ok(!endpoints(await index(root))[0]!.metadata.constraintsUnresolved);
  await writeFile(path.join(root, 'main.go'), `package main
import("github.com/gofiber/fiber/v3";"github.com/gofiber/fiber/v3/middleware/logger")
func Handler(c fiber.Ctx)error{return nil}
func main(){a:=fiber.New();a.Use(logger.New(logger.Config{Next:unknown}));a.Get("/custom",Handler);a.Listen(":8080")}
`); assert.ok(endpoints(await index(root))[0]!.metadata.constraintsUnresolved);
});


test('Echo host groups preserve exact authority and isolate native fallbacks from global middleware', async () => {
  const root = await repository({ 'main.go': `package main
import "github.com/labstack/echo/v4"
func Auth(next echo.HandlerFunc)echo.HandlerFunc{return next}
func Handler(c echo.Context)error{return nil}
func main(){e:=echo.New();e.Use(Auth);e.GET("/default",Handler);e.Host("api.example.com:8080").Group("/api").GET("/x",Handler);e.Start(":8080")}
`, 'client.ts': `export async function Default(){await fetch("https://api.example.com/default")}
export async function WrongPort(){await fetch("https://api.example.com/api/x")}
` }); const g = await index(root); assert.ok(target(g, 'Default')); assert.equal(target(g, 'WrongPort'), undefined); assert.equal(g.entities.filter(item => item.metadata.role === 'not-found').length, 0);
  await writeFile(path.join(root, 'main.go'), `package main
import "github.com/labstack/echo/v4"
func Auth(next echo.HandlerFunc)echo.HandlerFunc{return next}
func Handler(c echo.Context)error{return nil}
func main(){e:=echo.New();e.Host("api.example.com",Auth).Group("/api").GET("/x",Handler);e.Start(":8080")}
`); const constrained = await index(root); assert.ok(endpoints(constrained, '/api/x')[0]!.metadata.constraintsUnresolved); assert.ok(constrained.diagnostics.some(item => item.reason.includes('host-group fallback')));
});
