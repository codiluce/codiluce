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
const roots: string[] = [];
after(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });
async function put(root: string, name: string, text: string) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), text); }
const sdk = (major = 10, extra = '') => `<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net${major}.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings></PropertyGroup>${extra}</Project>`;
const program = (maps = 'app.MapControllers();', services = 'builder.Services.AddControllers();') => `// 😀 original\r\nvar builder=WebApplication.CreateBuilder(args);\r\n${services}\r\nvar app=builder.Build();\r\n${maps}\r\napp.Run();`;
const server: ApplicationInput = { name: 'server', path: '.', apiOrigins: ['http://localhost:5080'] };
async function repo(files: Record<string, string>) {
    const root = await mkdtemp(path.join(tmpdir(), 'codiluce-mvc-'));
    roots.push(root);
    await put(root, 'front/package.json', '{"name":"front"}');
    for (const [name, text] of Object.entries(files))
        await put(root, name, text);
    return root;
}
async function index(root: string, cache?: AnalysisCache, revision?: string) { return indexRepository(root, { config: await resolveConfig(root, { repository: { name: 'mvc' }, applications: [server, { name: 'front', path: 'front' }] }), cache, revision }); }
const endpoints = (g: SoftwareGraph) => g.entities.filter(e => e.type === 'api_endpoint' && e.metadata.frameworkPack === 'aspnet-mvc');
const route = (g: SoftwareGraph, path: string) => endpoints(g).find(e => e.metadata.routePath === path)!;
const handles = (g: SoftwareGraph) => g.relations.filter(e => e.type === 'handles' && e.metadata?.framework === 'aspnetcore');
const requests = (g: SoftwareGraph) => g.relations.filter(e => e.type === 'requests').map(e => { const t = g.entities.find(x => x.id === e.to)!; return { route: t.metadata.routePath, action: (t.metadata.mvc as any)?.actionName }; });
const client = (body: string) => ({ 'front/package.json': '{"name":"front"}', 'front/client.ts': `export async function load(){${body}}` });
const selected = (g: SoftwareGraph) => assert.ok(endpoints(g).length && endpoints(g).every(e => e.metadata.registration === 'selected'), JSON.stringify(g.entities.filter(e => e.type === 'api_endpoint').map(e => ({ route: e.metadata.routePath, routing: e.metadata.routing }))));
const shape = (g: SoftwareGraph) => canonicalJson({ entities: g.entities, relations: g.relations, diagnostics: g.diagnostics.filter(d => !['git-metrics', 'indexer'].includes(d.analyzer) && d.code !== 'git-ignore-unavailable') });
test('Unreviewed Unicode area required values cannot disappear and certify a competing minimal route', async () => {
    for (const [sourceArea, mappedArea] of [['K', 'K'], ['Administración', 'Administración']] as const) {
        const root = await repo({ 'App.csproj': sdk(), 'Program.cs': program(`app.MapAreaControllerRoute("area","${mappedArea}","same",new{controller="Home",action="Index"}).WithOrder(-1);app.MapGet("/same",()=>"minimal");`), 'C.cs': `using Microsoft.AspNetCore.Mvc;[Area("${sourceArea}")]public class HomeController{public string Index()=>"mvc";}`, ...client('await fetch("http://localhost:5080/same");') }), g = await index(root);
        assert.equal(requests(g).length, 0);
        assert.ok(g.diagnostics.some(d => d.reason.includes('Unicode MVC area')));
        assert.ok(g.entities.filter(e => e.type === 'api_endpoint').every(e => e.metadata.registration === 'candidate'));
    }
});
test('MVC attribute constants and out-of-line defaults retain their exact original source evidence', async () => {
    const root = await repo({ 'App.csproj': sdk(), 'Program.cs': program('var defaults=new{controller="Home",action="Index"};app.MapControllers();app.MapControllerRoute("source","start",defaults);'), 'C.cs': 'using Microsoft.AspNetCore.Mvc;public class NativeController{[HttpGet(Paths.PATH)]public string Show()=>"x";}public class HomeController{public string Index()=>"x";}', 'Paths.cs': 'public static class Paths {\n public const string PATH="source-constant";\n}' }), g = await index(root);
    selected(g);
    assert.ok(route(g, '/source-constant').evidence.some(e => e.file === 'Paths.cs' && e.line === 2));
    assert.ok(route(g, '/start').evidence.some(e => e.file === 'Program.cs' && e.explanation?.includes('literal MVC route-value object')));
});
test('MVC original controller filter overrides remain source references and never become HTTP actions', async () => {
    const root = await repo({ 'App.csproj': sdk(), 'Program.cs': program(), 'C.cs': 'using Microsoft.AspNetCore.Mvc;using Microsoft.AspNetCore.Mvc.Filters;[Route("filtered")]public class TestController:Controller{public string Show()=>"x";public override void OnActionExecuting(ActionExecutingContext context){context.Result=null;}}' }), g = await index(root);
    assert.equal(endpoints(g).length, 1);
    assert.equal(route(g, '/filtered').metadata.registration, 'candidate');
    assert.equal(g.entities.find(e => e.id === route(g, '/filtered').metadata.handler)?.name, 'Show');
    const filter = g.entities.find(e => e.name === 'OnActionExecuting')!;
    assert.ok(g.relations.some(e => e.from === route(g, '/filtered').id && e.to === filter.id && e.metadata?.role === 'mvc-filter'));
});
test('Original serving source helpers can map MVC datasources without activating unused helpers', async () => {
    const root = await repo({ 'App.csproj': sdk(), 'Program.cs': program('Register(app);', 'builder.Services.AddControllersWithViews();') + ' static void Register(Microsoft.AspNetCore.Routing.IEndpointRouteBuilder routes){routes.MapControllers();} static void Unused(Microsoft.AspNetCore.Routing.IEndpointRouteBuilder routes){routes.MapControllerRoute("unused","unused/{controller}/{action}");}', 'C.cs': 'using Microsoft.AspNetCore.Mvc;[Route("helper")]public class SourceController{public string Show()=>"x";}' }), g = await index(root);
    selected(g);
    assert.deepEqual(endpoints(g).map(e => e.metadata.routePath), ['/helper']);
    assert.ok(g.relations.some(e => e.metadata?.dispatch === 'direct-registration-helper'));
});
test('Original assembly ApiController applies to every original controller and rejects conventional actions', async () => {
    const root = await repo({ 'App.csproj': sdk(), 'Program.cs': program('app.MapDefaultControllerRoute();'), 'C.cs': 'using Microsoft.AspNetCore.Mvc;[assembly:ApiController]public class HomeController{public string Index()=>"x";}' }), g = await index(root);
    assert.ok(g.diagnostics.some(d => d.reason.includes('without attribute routing')));
    assert.ok(endpoints(g).every(e => e.metadata.registration === 'candidate'));
});
test('MVC route names follow token replacement and allow equivalent shared templates while rejecting incompatible names', async () => {
    for (const incompatible of [false, true]) {
        const root = await repo({ 'App.csproj': sdk(), 'Program.cs': program(), 'C.cs': `using Microsoft.AspNetCore.Mvc;public class TestController{[HttpGet("same",Name="shared")]public string Get()=>"x";[HttpPost("${incompatible ? 'other' : 'same'}",Name="shared")]public string Post()=>"x";[HttpGet("named/[action]",Name="[controller]_[action]")]public string Named()=>"x";}` }), g = await index(root);
        assert.equal(route(g, '/named/Named').metadata.mvc && (route(g, '/named/Named').metadata.mvc as any).routeName, 'Test_Named');
        if (incompatible)
            assert.ok(endpoints(g).every(e => e.metadata.registration === 'candidate'));
        else
            selected(g);
    }
});
test('MVC effective route inheritance uses the original base definition when a derived override has no template attributes', async () => {
    const root = await repo({ 'App.csproj': sdk(), 'Program.cs': program(), 'C.cs': 'using Microsoft.AspNetCore.Mvc;public abstract class Base{[HttpGet("original")]public virtual string Show()=>"x";}public abstract class Middle:Base{[HttpGet("middle")]public override string Show()=>"x";}public class LeafController:Middle{public override string Show()=>"x";}' }), g = await index(root);
    selected(g);
    assert.deepEqual(endpoints(g).map(e => e.metadata.routePath), ['/original']);
    assert.equal(g.entities.find(e => e.id === route(g, '/original').metadata.handler)?.name, 'Show');
});
test('Opaque templates, mixed selectors and source assembly application parts cannot disappear from routing competitors', async () => {
    for (const source of ['using Microsoft.AspNetCore.Mvc;public class TestController{[AcceptVerbs("GET",Route=Dynamic())]public string Show()=>"x";static string Dynamic()=>"x";}', 'using Microsoft.AspNetCore.Mvc;public class TestController{[HttpGet(Dynamic())]public string Show()=>"x";static string Dynamic()=>"x";}', 'using Microsoft.AspNetCore.Mvc;public class TestController{[HttpGet,HttpPost("post")]public string Show()=>"x";}', 'using Microsoft.AspNetCore.Mvc;[assembly:Microsoft.AspNetCore.Mvc.ApplicationParts.ApplicationPart("Other")]public class TestController{[HttpGet("x")]public string Show()=>"x";}']) {
        const root = await repo({ 'App.csproj': sdk(), 'Program.cs': program(), 'C.cs': source }), g = await index(root);
        assert.ok(endpoints(g).length);
        assert.ok(endpoints(g).every(e => e.metadata.registration === 'candidate'));
        assert.ok(g.entities.some(e => e.type === 'api_endpoint' && e.metadata.constraintsUnresolved));
    }
});
test('Original MVC parameter attributes retain source proof and custom binding candidates', async () => {
    const root = await repo({ 'App.csproj': sdk(), 'Program.cs': program(), 'C.cs': 'using Microsoft.AspNetCore.Mvc;[Route("binding")]public class TestController{public string Show([FromBody]int value)=>"x";}' }), g = await index(root);
    assert.equal(route(g, '/binding').metadata.registration, 'candidate');
    assert.ok(route(g, '/binding').evidence.some(e => e.explanation?.includes('parameter binding attribute')));
});
test('Service collection changes after Build and competing source AddControllers extensions constrain original registrations', async () => {
    const cases = [program().replace('builder.Services.AddControllers();', '').replace('var app=builder.Build();', 'var app=builder.Build();builder.Services.AddControllers();'), program() + ' public static class Custom{public static object AddControllers(this Microsoft.Extensions.DependencyInjection.IServiceCollection services)=>null;}'];
    for (const source of cases) {
        const root = await repo({ 'App.csproj': sdk(), 'Program.cs': source, 'C.cs': 'using Microsoft.AspNetCore.Mvc;[Route("x")]public class TestController{public string Show()=>"x";}' }), g = await index(root);
        assert.ok(endpoints(g).length);
        assert.ok(endpoints(g).every(e => e.metadata.registration === 'candidate'));
    }
});
test('MVC literal defaults do not borrow mutated dictionaries and external string constraints remain regex gaps', async () => {
    for (const maps of ['var defaults=new{controller="Home",action="Index"};defaults=Other();app.MapControllerRoute("dynamic","start",defaults);', 'app.MapControllerRoute("regex","{controller}/{action}/{id}",constraints:new{id="int"});']) {
        const root = await repo({ 'App.csproj': sdk(), 'Program.cs': program(maps), 'C.cs': 'public class HomeController{public string Index()=>"x";}' }), g = await index(root);
        assert.ok(endpoints(g).length);
        assert.ok(endpoints(g).every(e => e.metadata.registration === 'candidate'));
    }
});
test('MVC original attributes, aliases, partial controllers and action bodies preserve source IDs and evidence', async () => {
    const root = await repo({ 'App.csproj': sdk(), 'Program.cs': program(), 'Controllers.cs': 'using M=Microsoft.AspNetCore.Mvc; namespace Api; [M.ApiController,M.Route("api/[controller]")] public partial class ItemsController:M.ControllerBase {[M.HttpGet("{id:int}")] public string Show(int id)=>Leaf(id); private string Leaf(int id)=>"item";}', 'ControllerPart.cs': 'using Microsoft.AspNetCore.Mvc; namespace Api; public partial class ItemsController {[HttpPost] public string Create()=>"created";}' }), g = await index(root);
    selected(g);
    assert.deepEqual(endpoints(g).map(e => e.metadata.routePath).sort(), ['/api/Items', '/api/Items/{id:int}']);
    assert.equal(handles(g).length, 2);
    assert.equal(route(g, '/api/Items/{id:int}').path, 'Controllers.cs');
    assert.equal((route(g, '/api/Items').metadata.routing as any).registration.file, 'Program.cs');
    assert.ok(route(g, '/api/Items').evidence.some(e => e.file === 'Controllers.cs'));
    assert.ok(g.relations.some(e => e.type === 'calls' && g.entities.find(t => t.id === e.to)?.name === 'Leaf'));
    assert.ok(!g.entities.some(e => e.metadata.generated));
});
test('Controller annotations require original MVC services, endpoint mapping and a serving root', async () => {
    for (const [maps, services, serving] of [['app.MapControllers();', '', true], ['', 'builder.Services.AddControllers();', true], ['app.MapControllers();', 'builder.Services.AddControllers();', false]] as const) {
        const root = await repo({ 'App.csproj': sdk(), 'Program.cs': program(maps, services).replace('app.Run();', serving ? 'app.Run();' : ''), 'C.cs': 'using Microsoft.AspNetCore.Mvc;[Route("/active")]public class ActiveController{public string Show()=>"ok";}' }), g = await index(root);
        if (!maps)
            assert.equal(endpoints(g).length, 0);
        else
            assert.equal(route(g, '/active').metadata.registration, 'candidate');
    }
});
test('MVC native discovery excludes nested, abstract, generic, private, static and NonController classes and NonAction methods', async () => {
    const root = await repo({ 'App.csproj': sdk(), 'Program.cs': program(), 'C.cs': 'using Microsoft.AspNetCore.Mvc; [Route("x")]public class GoodController {public string Show()=>"x";[NonAction]public string Helper()=>"x";public static string Static()=>"x";public string Generic<T>()=>"x";private string Private()=>"x";}[Route("bad"),NonController]public class BadController{public string Show()=>"x";}[Route("abstract")]public abstract class AbstractController{public string Show()=>"x";}[Route("generic")]public class GenericController<T>{public string Show()=>"x";}public class Outer{[Route("nested")]public class NestedController{public string Show()=>"x";}}[Controller,Route("other")]public class Named{public string Show()=>"x";}' }), g = await index(root);
    selected(g);
    assert.deepEqual(endpoints(g).map(e => e.metadata.routePath).sort(), ['/other', '/x']);
    assert.equal(handles(g).length, 2);
});
test('Native MVC selectors split templated HTTP attributes, combine silent methods with Route, and override absolute prefixes once', async () => {
    const root = await repo({ 'App.csproj': sdk(), 'Program.cs': program(), 'C.cs': 'using Microsoft.AspNetCore.Mvc;[Route("api"),Route("other")]public class ProductsController{[Route("things"),HttpGet,AcceptVerbs("HEAD"),HttpPost("new")]public string Items()=>"x";[HttpGet("~/absolute")]public string Absolute()=>"x";}' }), g = await index(root);
    selected(g);
    assert.equal(endpoints(g).length, 5);
    assert.deepEqual((route(g, '/api/things').metadata.routing as any).methods, ['GET', 'HEAD']);
    assert.deepEqual((route(g, '/api/new').metadata.routing as any).methods, ['POST']);
    assert.equal(endpoints(g).filter(e => e.metadata.routePath === '/absolute').length, 1);
});
test('Conventional routes retain required values, remove mismatched defaults and map native source call order', async () => {
    const root = await repo({ 'App.csproj': sdk(), 'Program.cs': program('app.MapControllerRoute(name:"first",pattern:"{controller=Home}/{action=Index}/{id?}");app.MapControllerRoute("second","{controller}/{action}/{id?}");'), 'C.cs': 'public class HomeController{public string Index()=>"home";public string About()=>"about";}public class ItemsController{public string Index()=>"items";} ', ...client('await fetch("http://localhost:5080/");await fetch("http://localhost:5080/Home/About");await fetch("http://localhost:5080/Items");await fetch("http://localhost:5080/Unknown/Index");') }), g = await index(root);
    selected(g);
    assert.equal(endpoints(g).length, 6);
    assert.deepEqual(requests(g).sort((a, b) => String(a.action).localeCompare(String(b.action))), [{ route: '/{controller=Home}/{action=Index}/{id?}', action: 'About' }, { route: '/{controller=Home}/{action=Index}/{id?}', action: 'Index' }, { route: '/{controller=Home}/{action=Index}/{id?}', action: 'Index' }]);
    assert.deepEqual(endpoints(g).map(e => (e.metadata.routing as any).aspnet.order).sort(), [1, 1, 1, 2, 2, 2]);
});
test('Dedicated defaults and area routes activate only compatible controller/action values', async () => {
    const root = await repo({ 'App.csproj': sdk(), 'Program.cs': program('var defaults=new{controller="Home",action="Index"};app.MapControllerRoute("home","start/{id?}",defaults);app.MapAreaControllerRoute(name:"admin",areaName:"Admin",pattern:"Admin/{controller=Dashboard}/{action=Index}/{id?}");app.MapDefaultControllerRoute();'), 'C.cs': 'using Microsoft.AspNetCore.Mvc;public class HomeController{public string Index()=>"x";public string About()=>"x";}[Area("Admin")]public class DashboardController{public string Index()=>"x";} ', ...client('await fetch("http://localhost:5080/start");await fetch("http://localhost:5080/Admin");await fetch("http://localhost:5080/Dashboard/Index");') }), g = await index(root);
    selected(g);
    assert.equal(endpoints(g).length, 4);
    assert.deepEqual(requests(g).map(x => x.route), ['/Admin/{controller=Dashboard}/{action=Index}/{id?}', '/start/{id?}']);
});
test('Attribute and conventional actions coexist and native attribute order wins over conventional routes', async () => {
    const root = await repo({ 'App.csproj': sdk(), 'Program.cs': program('app.MapDefaultControllerRoute();app.MapControllers();app.MapControllers();'), 'C.cs': 'using Microsoft.AspNetCore.Mvc;public class HomeController{public string Index()=>"home";[HttpGet("Home/Index")]public string Explicit()=>"explicit";} ', ...client('await fetch("http://localhost:5080/Home/Index");await fetch("http://localhost:5080/");await fetch("http://localhost:5080/Home/Explicit");') }), g = await index(root);
    selected(g);
    assert.equal(endpoints(g).length, 2);
    assert.deepEqual(requests(g).map(x => x.action).sort(), ['Explicit', 'Index']);
});
test('MapControllers shared conventions and per-conventional-route conventions compose with late groups', async () => {
    const root = await repo({ 'App.csproj': sdk(), 'Program.cs': program('var group=app.MapGroup("/v1");group.MapControllers().WithOrder(-3);group.MapDefaultControllerRoute().RequireHost("mvc.example.com");group.WithOrder(-4);'), 'C.cs': 'using Microsoft.AspNetCore.Mvc;public class HomeController{public string Index()=>"home";[HttpGet("explicit")]public string Explicit()=>"x";}' }), g = await index(root);
    selected(g);
    assert.equal((route(g, '/v1/explicit').metadata.routing as any).aspnet.order, -3);
    assert.equal((route(g, '/v1/{controller=Home}/{action=Index}/{id?}').metadata.routing as any).aspnet.order, -3);
    assert.deepEqual((route(g, '/v1/{controller=Home}/{action=Index}/{id?}').metadata.routing as any).aspnet.hosts, ['mvc.example.com']);
});
test('Native action names strip Async by default and honor reviewed literal MVC options and ActionName tokens', async () => {
    for (const suppress of [true, false]) {
        const root = await repo({ 'App.csproj': sdk(), 'Program.cs': program('app.MapControllers();', `builder.Services.AddControllers(options=>options.SuppressAsyncSuffixInActionNames=${suppress});`), 'C.cs': 'using Microsoft.AspNetCore.Mvc;[Route("[controller]/[action]")]public class ValuesController{[HttpGet]public string ReadAsync()=>"x";[ActionName("renamed"),HttpGet]public string OtherAsync()=>"x";}' }), g = await index(root);
        selected(g);
        assert.ok(route(g, '/Values/' + (suppress ? 'Read' : 'ReadAsync')));
        assert.ok(route(g, '/Values/renamed'));
    }
});
test('Source inherited actions and override route attributes retain original bodies and derived controller names', async () => {
    const root = await repo({ 'App.csproj': sdk(), 'Program.cs': program(), 'C.cs': 'using Microsoft.AspNetCore.Mvc;[Route("base/[controller]")]public abstract class Base{[HttpGet("inherited")]public string Inherited()=>"x";[HttpGet("old")]public virtual string Show()=>"base";[NonAction]public virtual string Hidden()=>"x";}[Route("derived/[controller]")]public class ChildController:Base{[HttpGet("new")]public override string Show()=>"child";public override string Hidden()=>"x";}' }), g = await index(root);
    selected(g);
    assert.deepEqual(endpoints(g).map(e => e.metadata.routePath).sort(), ['/derived/Child/inherited', '/derived/Child/new']);
    assert.equal(g.entities.find(e => e.id === route(g, '/derived/Child/inherited').metadata.handler)?.name, 'Inherited');
});
test('Explicit MVC HEAD remains separate and method ties/duplicate actions stay ambiguous', async () => {
    const root = await repo({ 'App.csproj': sdk(), 'Program.cs': program(), 'C.cs': 'using Microsoft.AspNetCore.Mvc;[Route("api")]public class TestController{[HttpGet("get")]public string Get()=>"x";[AcceptVerbs("GET","HEAD",Route="head")]public string Head()=>"x";[Route("same")]public string Any()=>"x";[HttpPost("same")]public string Post()=>"x";[HttpGet("tie")]public string A()=>"x";[HttpGet("tie")]public string B()=>"x";} ', ...client('await fetch("http://localhost:5080/api/get",{method:"HEAD"});await fetch("http://localhost:5080/api/head",{method:"HEAD"});await fetch("http://localhost:5080/api/same",{method:"POST"});await fetch("http://localhost:5080/api/tie");') }), g = await index(root);
    selected(g);
    assert.deepEqual(requests(g).map(x => x.action), ['Head', 'Post']);
    assert.ok(g.diagnostics.some(d => d.code === 'ambiguous-http-match'));
});
test('MVC custom metadata, ApiController conventional actions, missing services and binary/assembly parts stay candidates', async () => {
    const cases = [['[ApiController]public class TestController{public string Index()=>"x";}', 'app.MapDefaultControllerRoute();', 'builder.Services.AddControllers();'], ['[Route("x"),Consumes("application/json")]public class TestController{public string Index()=>"x";}', 'app.MapControllers();', 'builder.Services.AddControllers();'], ['[Route("x")]public class TestController{public string Index()=>"x";}', 'app.MapControllers();', 'builder.Services.AddControllers().AddApplicationPart(typeof(TestController).Assembly);'], ['[Route("x")]public class TestController{public string Index()=>"x";}', 'app.MapControllers();', 'builder.Services.AddControllers(options=>options.EnableEndpointRouting=false);']] as const;
    for (const [source, maps, services] of cases) {
        const root = await repo({ 'App.csproj': sdk(), 'Program.cs': program(maps, services), 'C.cs': 'using Microsoft.AspNetCore.Mvc;' + source }), g = await index(root);
        assert.ok(endpoints(g).length);
        assert.ok(endpoints(g).every(e => e.metadata.registration === 'candidate'));
    }
});
test('MVC source shadows cannot borrow native service extensions, base classes or route attributes', async () => {
    const root = await repo({ 'App.csproj': sdk(), 'Program.cs': program(), 'C.cs': 'using Microsoft.AspNetCore.Mvc;public class RouteAttribute:System.Attribute{public RouteAttribute(string path){}}[Route("fake")]public class FakeController{public string Index()=>"x";} ' }), g = await index(root);
    assert.ok(g.entities.filter(e => e.type === 'api_endpoint').every(e => e.metadata.registration === 'candidate'));
    assert.ok(g.diagnostics.some(d => d.reason.includes('shadowed')));
});
test('MVC route and handler contracts survive actual warm cache hits, revision replay, CRLF/Unicode shifts and dependency edits', async () => {
    const root = await repo({ 'App.csproj': sdk(), 'Program.cs': program(), 'C.cs': 'using Microsoft.AspNetCore.Mvc;\r\n[Route("api")]public class TestController{[HttpGet("first")]public string Show()=>"x";} ', ...client('await fetch("http://localhost:5080/api/first");') }), cacheRoot = await mkdtemp(path.join(tmpdir(), 'codiluce-mvc-cache-'));
    roots.push(cacheRoot);
    const cache = new AnalysisCache(cacheRoot), cold = await index(root, cache), warm = await index(root, cache), revised = await index(root, undefined, 'revision');
    selected(cold);
    assert.equal(shape(cold), shape(warm));
    assert.equal(shape(cold), shape(revised));
    assert.ok(cache.events.some(e => e.analyzer === 'csharp-imports' && e.hit));
    const id = route(cold, '/api/first').metadata.handler;
    await put(root, 'C.cs', '// 😀 shifted\r\nusing Microsoft.AspNetCore.Mvc;\r\n[Route("api")]public class TestController{[HttpGet("second")]public string Show()=>"x";} ');
    const changed = await index(root, cache);
    assert.equal(route(changed, '/api/first'), undefined);
    assert.equal(route(changed, '/api/second').metadata.handler, id);
    assert.equal(route(changed, '/api/second').sourceRange?.startLine, 3);
});
test('MVC reviewed ASP.NET 8/9/10 profiles never implicitly import the MVC namespace', async () => {
    for (const major of [8, 9, 10]) {
        const root = await repo({ 'App.csproj': sdk(major), 'Program.cs': program(), 'C.cs': '[Microsoft.AspNetCore.Mvc.Route("native")]public class TestController{public string Index()=>"x";}' }), g = await index(root);
        selected(g);
        assert.equal((route(g, '/native').metadata.routing as any).pattern.dialect, `aspnet-${major}`);
    }
    const root = await repo({ 'App.csproj': sdk(), 'Program.cs': program(), 'C.cs': '[Route("missing-import")]public class TestController{public string Index()=>"x";}' }), g = await index(root);
    assert.ok(g.entities.filter(e => e.type === 'api_endpoint').every(e => e.metadata.registration === 'candidate'));
});
