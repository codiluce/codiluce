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
async function freshCache() { const directory = await mkdtemp(path.join(tmpdir(), 'codiluce-aspnet-cache-')); roots.push(directory); return new AnalysisCache(directory); }
after(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });
async function put(root: string, name: string, text: string) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), text); }
async function repository(files: Record<string, string>) {
    const root = await mkdtemp(path.join(tmpdir(), 'codiluce-aspnet-'));
    roots.push(root);
    for (const [name, text] of Object.entries(files))
        await put(root, name, text);
    return root;
}
const sdk = (major = 10, extra = '') => `<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net${major}.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings></PropertyGroup>${extra}</Project>`;
const app: ApplicationInput = { name: 'server', path: '.', apiOrigins: ['http://localhost:5080'] };
async function index(root: string, applications: ApplicationInput[] = [app], cache?: AnalysisCache, revision?: string) { return indexRepository(root, { config: await resolveConfig(root, { repository: { name: 'aspnet-fixture' }, applications }), cache, revision }); }
const endpoints = (graph: SoftwareGraph) => graph.entities.filter(entity => entity.type === 'api_endpoint' && entity.metadata.framework === 'aspnetcore');
const route = (graph: SoftwareGraph, path: string) => endpoints(graph).find(entity => entity.metadata.routePath === path)!;
const handles = (graph: SoftwareGraph) => graph.relations.filter(edge => edge.type === 'handles' && edge.metadata?.framework === 'aspnetcore');
const requested = (graph: SoftwareGraph) => graph.relations.filter(edge => edge.type === 'requests').map(edge => graph.entities.find(entity => entity.id === edge.to)!.metadata.routePath).sort();
const shape = (graph: SoftwareGraph) => canonicalJson({ entities: graph.entities, relations: graph.relations, diagnostics: graph.diagnostics.filter(item => !['git-metrics', 'indexer'].includes(item.analyzer) && item.code !== 'git-ignore-unavailable') });
const program = (body: string, extra = '') => `// 😀 original\r\nvar builder=WebApplication.CreateBuilder(args);\r\nvar app=builder.Build();\r\n${body}\r\napp.Run();\r\n${extra}`;
test('ASP.NET minimal hosting preserves original method groups, typed lambdas, local functions and source calls', async () => {
    const root = await repository({ 'App.csproj': sdk(), 'Program.cs': program('app.MapGet("/hello",()=>Handlers.Leaf()); app.MapPost("/items/{id:int}",Handlers.Show); app.MapGet("/local",Local);', 'static string Local()=>Handlers.Leaf(); public static class Handlers {public static string Show(int id)=>Leaf();public static string Leaf()=>"hello";}') }), graph = await index(root);
    assert.equal(endpoints(graph).length, 3);
    assert.ok(endpoints(graph).every(entity => entity.metadata.registration === 'selected'), JSON.stringify(endpoints(graph).map(entity => entity.metadata.routing)));
    assert.equal(handles(graph).length, 3);
    assert.ok(handles(graph).every(edge => graph.entities.some(entity => entity.id === edge.to && entity.path === 'Program.cs')));
    assert.ok(graph.relations.some(edge => edge.type === 'calls' && graph.entities.find(entity => entity.id === edge.from)?.name === 'Show' && graph.entities.find(entity => entity.id === edge.to)?.name === 'Leaf'));
    assert.equal(route(graph, '/hello').sourceRange?.startLine, 4);
    assert.ok(route(graph, '/hello').evidence.some(item => item.file === 'App.csproj'));
    assert.ok(!graph.entities.some(entity => entity.metadata.generated));
});
test('ASP.NET 8/9/10 families, literal method arrays and nested late group conventions compose', async () => {
    for (const major of [8, 9, 10]) {
        const root = await repository({ 'App.csproj': sdk(major), 'Program.cs': program('const string prefix="/api"; var outer=app.MapGroup(prefix); var inner=outer.MapGroup("/v1"); var verbs=new[]{"GET","HEAD"}; inner.MapMethods("/items/{id:long}",verbs,(long id)=>id); outer.RequireHost("*.example.com:443"); inner.WithOrder(-2); inner.WithTags("items");') }), graph = await index(root), endpoint = route(graph, '/api/v1/items/{id:long}');
        assert.ok(endpoint, JSON.stringify(endpoints(graph)));
        assert.equal(endpoint.metadata.registration, 'selected', JSON.stringify(endpoint.metadata.routing));
        const contract = endpoint.metadata.routing as any;
        assert.equal(contract.pattern.dialect, `aspnet-${major}`);
        assert.deepEqual(contract.methods, ['GET', 'HEAD']);
        assert.equal(contract.aspnet.order, -2);
        assert.deepEqual(contract.aspnet.hosts, ['*.example.com:443']);
        assert.equal(contract.mounts.length, 2);
    }
});
test('Source registration helpers and extension groups are interpreted only when invoked from the serving root', async () => {
    const root = await repository({ 'App.csproj': sdk(), 'Program.cs': program('app.Register("/direct"); Register(app,"/other");', 'static void Register(Microsoft.AspNetCore.Routing.IEndpointRouteBuilder endpoints,string path){endpoints.MapGet(path,()=>"other");}'), 'Routes.cs': 'using Microsoft.AspNetCore.Routing; public static class Routes{public static IEndpointRouteBuilder Register(this IEndpointRouteBuilder endpoints,string path){var group=endpoints.MapGroup(path);group.MapGet("/item",Handlers.Show);return endpoints;} public static void Unused(IEndpointRouteBuilder endpoints){endpoints.MapGet("/unused",Handlers.Show);}} public static class Handlers{public static string Show()=>"ok";}' }), graph = await index(root);
    assert.deepEqual(endpoints(graph).map(entity => entity.metadata.routePath).sort(), ['/direct/item', '/other']);
    assert.ok(endpoints(graph).every(entity => entity.metadata.registration === 'selected'), JSON.stringify(endpoints(graph).map(entity => entity.metadata.routing)));
    assert.equal(graph.relations.filter(edge => edge.metadata?.dispatch === 'direct-registration-helper').length, 2);
    assert.ok(route(graph, '/direct/item').evidence.some(item => item.file === 'Program.cs'));
    assert.ok(route(graph, '/direct/item').evidence.some(item => item.file === 'Routes.cs'));
});
test('Original source startup controls and serving calls gate endpoint selection', async () => {
    const cases: [
        string,
        string,
        boolean
    ][] = [
        ['var app=WebApplication.Create();app.MapGet("/unused",()=>"ok");', '/unused', false],
        ['var app=WebApplication.Create();if(enabled){app.MapGet("/conditional",()=>"ok");}app.Run();', '/conditional', false],
        ['var app=WebApplication.Create();if(false){app.MapGet("/never",()=>"ok");}app.MapGet("/yes",()=>"ok");app.Run();', '/yes', true],
        ['var app=WebApplication.Create();app.MapGet("/terminal",()=>"ok");app.Run(context=>Handlers.Handle(context));', '/terminal', false],
        ['var app=WebApplication.Create();app.Run();app.MapGet("/after",()=>"ok");', '/after', false], ['var app=WebApplication.Create();app.MapGet("/start",()=>"ok");app.Start();', '/start', true], ['var app=WebApplication.Create();app.MapGet("/start-url",()=>"ok");app.StartAsync("http://localhost:5080");', '/start-url', false]
    ];
    for (const [text, path, selected] of cases) {
        const root = await repository({ 'App.csproj': sdk(), 'Program.cs': text + ' public static class Handlers{public static System.Threading.Tasks.Task Handle(Microsoft.AspNetCore.Http.HttpContext context)=>null;}' }), graph = await index(root);
        assert.equal(route(graph, path)?.metadata.registration === 'selected', selected, JSON.stringify(endpoints(graph).map(entity => entity.metadata.routing)));
        if (path === '/yes')
            assert.equal(endpoints(graph).length, 1);
        if (path === '/after')
            assert.equal(endpoints(graph).length, 0);
    }
});
test('HTTP requests obey ASP.NET route precedence, method metadata, explicit HEAD and equal-score ambiguity', async () => {
    const root = await repository({ 'App.csproj': sdk(), 'Program.cs': program('app.MapGet("/items/{id}",(string id)=>id);app.MapGet("/items/special",()=>"literal");app.MapGet("/get-only",()=>"get");app.MapMethods("/head",new[]{"GET","HEAD"},()=>"head");app.MapGet("/same",()=>"a");app.MapGet("/same",()=>"b");app.Map("/method",()=>"any");app.MapPost("/method",()=>"post");'), 'front/package.json': '{"name":"front"}', 'front/client.ts': 'export async function load(){await fetch("http://localhost:5080/items/special");await fetch("http://localhost:5080/items/12");await fetch("http://localhost:5080/get-only",{method:"HEAD"});await fetch("http://localhost:5080/head",{method:"HEAD"});await fetch("http://localhost:5080/same");await fetch("http://localhost:5080/method",{method:"POST"});}' }), graph = await index(root, [app, { name: 'front', path: 'front' }]);
    assert.deepEqual(requested(graph), ['/head', '/items/special', '/items/{id}', '/method']);
    assert.ok(graph.diagnostics.some(item => item.code === 'ambiguous-http-match'));
    const post = graph.relations.find(edge => edge.type === 'requests' && graph.entities.find(entity => entity.id === edge.to)?.metadata.routePath === '/method')!;
    assert.equal((graph.entities.find(entity => entity.id === post.to)?.metadata.routing as any).methods[0], 'POST');
});
test('ASP.NET minimal route facts and prepared lambda contracts are identical on cold, warm and revised caches', async () => {
    const root = await repository({ 'App.csproj': sdk(), 'Program.cs': program('var group=app.MapGroup("/v1");group.MapGet("/{id:int}",(int id)=>Handlers.Leaf(id));', 'public static class Handlers{public static int Leaf(int id)=>id;}'), 'front/package.json': '{"name":"front"}', 'front/client.ts': 'export const load=()=>fetch("http://localhost:5080/v1/12");' }), cache = await freshCache(), apps = [app, { name: 'front', path: 'front' }];
    const cold = await index(root, apps, cache), warm = await index(root, apps, cache), revised = await index(root, apps, undefined, 'fixture-revision');
    assert.equal(shape(cold), shape(warm));
    assert.ok(cache.events.some(event => event.analyzer === 'csharp-imports' && event.hit), 'warm C# framework cache is reused');
    assert.equal(shape(cold), shape(revised));
    assert.deepEqual(requested(cold), ['/v1/{id:int}']);
    await put(root, 'Program.cs', program('app.MapGet("/new",()=>"ok");'));
    const changed = await index(root, apps, cache);
    assert.equal(route(changed, '/v1/{id:int}'), undefined);
    assert.ok(route(changed, '/new'));
});
test('ASP.NET original aliases, global XML usings and static Main retain exact source roots', async () => {
    const root = await repository({ 'App.csproj': sdk(9, '<ItemGroup><Using Include="Microsoft.AspNetCore.Builder" Alias="Host"/></ItemGroup>'), 'Program.cs': 'class Entry{public static void Main(string[] args){var app=Host.WebApplication.Create(args);app.MapGet("/main",Show);app.Run();}static string Show()=>"main";}' }), graph = await index(root, [{ ...app, entrypoints: { aspnet: ['Entry'] } }]);
    assert.equal(route(graph, '/main').metadata.registration, 'selected', JSON.stringify(route(graph, '/main').metadata.routing));
    assert.ok(route(graph, '/main').evidence.some(item => item.file === 'App.csproj' && item.line === 1));
});
test('Deferred handler aliases retain their declaration scope and implicit async HttpContext contracts', async () => {
    const root = await repository({ 'App.csproj': sdk(), 'Program.cs': program('var handler=(int id)=>Handlers.Show(id); { app.MapGet("/alias/{id:int}",handler); } app.MapGet("/context",async context=>{await Handlers.Write(context);});', 'public static class Handlers{public static int Show(int id)=>id;public static System.Threading.Tasks.Task Write(Microsoft.AspNetCore.Http.HttpContext context)=>null;}') }), graph = await index(root);
    assert.ok(endpoints(graph).every(entity => entity.metadata.registration === 'selected'), JSON.stringify(endpoints(graph).map(entity => entity.metadata.routing)));
    assert.equal(handles(graph).length, 2);
    assert.ok(graph.relations.some(edge => edge.type === 'calls' && graph.entities.find(entity => entity.id === edge.to)?.name === 'Write'), JSON.stringify(graph.entities.find(entity => entity.type === 'file' && entity.path === 'Program.cs')!.metadata.csharpCallOutcomes));
});
test('Authorization/filter continuation stays constrained while late AllowAnonymous overrides inherited policies', async () => {
    const root = await repository({ 'App.csproj': sdk(), 'Program.cs': program('var secured=app.MapGroup("/secure").RequireAuthorization("users");secured.MapGet("/hidden",()=>"hidden");secured.MapGet("/public",()=>"public").AllowAnonymous();app.MapGet("/filtered",()=>"ok").AddEndpointFilter((Microsoft.AspNetCore.Http.EndpointFilterInvocationContext context,Microsoft.AspNetCore.Http.EndpointFilterDelegate next)=>next(context));') }), graph = await index(root);
    assert.equal(route(graph, '/secure/hidden').metadata.registration, 'candidate');
    assert.equal(route(graph, '/secure/public').metadata.registration, 'selected');
    assert.equal(route(graph, '/filtered').metadata.registration, 'candidate');
    assert.ok(graph.relations.some(edge => edge.from === route(graph, '/filtered').id && edge.metadata?.role === 'endpoint-filter'));
});
test('Order and host metadata precede method/host presence tie-breaks; equal hosts do not rank by specificity', async () => {
    const root = await repository({ 'App.csproj': sdk(), 'Program.cs': program('app.MapGet("/items/{id}",(string id)=>id).WithOrder(-1);app.MapGet("/items/special",()=>"literal");app.MapGet("/host",()=>"any");app.MapGet("/host",()=>"host").RequireHost("localhost:5080");app.MapGet("/equal",()=>"exact").RequireHost("localhost");app.MapGet("/equal",()=>"wildcard").RequireHost("*");'), 'front/package.json': '{"name":"front"}', 'front/client.ts': 'export async function load(){await fetch("http://localhost:5080/items/special");await fetch("http://localhost:5080/host");await fetch("http://localhost:5080/equal");}' }), graph = await index(root, [app, { name: 'front', path: 'front' }]);
    assert.deepEqual(requested(graph), ['/host', '/items/{id}']);
    const host = graph.relations.find(edge => edge.type === 'requests' && graph.entities.find(entity => entity.id === edge.to)?.metadata.routePath === '/host')!;
    assert.deepEqual((graph.entities.find(entity => entity.id === host.to)?.metadata.routing as any).aspnet.hosts, ['localhost:5080']);
});
test('Opaque router conventions, regex constraints and middleware remain routing competitors', async () => {
    for (const body of ['app.MapGet("/items",()=>"ok").WithMetadata(custom);', 'app.MapGet("/items/{id:regex(^a$)}",(string id)=>id);', 'app.UsePathBase("/base");app.MapGet("/items",()=>"ok");', 'app.Services.CustomMatcher();app.MapGet("/items",()=>"ok");']) {
        const root = await repository({ 'App.csproj': sdk(), 'Program.cs': program(body) }), graph = await index(root);
        assert.ok(endpoints(graph).length > 0);
        assert.ok(endpoints(graph).every(entity => entity.metadata.registration === 'candidate'), JSON.stringify(endpoints(graph).map(entity => entity.metadata.routing)));
    }
});
test('Writes, method-array mutation, opaque escapes and declared type mismatch cannot borrow hosting values', async () => {
    const cases = ['var app=WebApplication.Create();app=WebApplication.Create();app.MapGet("/bad",()=>"ok");app.Run();', 'var app=WebApplication.Create();var methods=new[]{"GET"};methods[0]="POST";app.MapMethods("/bad",methods,()=>"ok");app.Run();', 'var app=WebApplication.Create();Escape(app);app.MapGet("/bad",()=>"ok");app.Run();', 'var app=WebApplication.Create();var methods=new[]{"GET"};Escape(methods);app.MapMethods("/bad",methods,()=>"ok");app.Run();', 'object app=WebApplication.Create();app.MapGet("/bad",()=>"ok");app.Run();'];
    for (const text of cases) {
        const root = await repository({ 'App.csproj': sdk(), 'Program.cs': text }), graph = await index(root);
        assert.ok(endpoints(graph).every(entity => entity.metadata.registration === 'candidate'), JSON.stringify(endpoints(graph).map(entity => entity.metadata.routing)));
    }
});
test('Source names, disabled implicit usings and competing source extensions block framework lookalikes', async () => {
    const fixtures: Record<string, string>[] = [{ 'App.csproj': sdk(), 'Program.cs': 'var app=WebApplication.Create();app.MapGet("/fake",()=>"ok");app.Run();class WebApplication{public static WebApplication Create()=>new WebApplication();public void MapGet(string path,System.Func<string> callback){}public void Run(){}}' }, { 'App.csproj': sdk().replace('<ImplicitUsings>enable</ImplicitUsings>', '<ImplicitUsings>disable</ImplicitUsings>'), 'Program.cs': program('app.MapGet("/fake",()=>"ok");') }, { 'App.csproj': sdk(), 'Program.cs': program('app.MapGet("/fake",()=>"ok");'), 'Extensions.cs': 'public static class Extensions{public static void MapGet(this Microsoft.AspNetCore.Routing.IEndpointRouteBuilder app,string path,System.Func<string> callback){}}' }];
    for (const files of fixtures) {
        const graph = await index(await repository(files));
        assert.ok(endpoints(graph).every(entity => entity.metadata.registration === 'candidate'));
        assert.equal(route(graph, '/fake')?.metadata.registration === 'selected', false);
    }
});
test('Unreviewed targets/runtime versions, disabled framework references and competing entrypoints stay explicit', async () => {
    for (const [project, config] of [[sdk(7), app], [sdk(10, '<ItemGroup><PackageReference Include="Unknown.Extensions" Version="1.0.0"/></ItemGroup>'), app], [sdk(10), { ...app, dotnet: { aspnet: { version: '9.0.0' } } }], [sdk(10, '<PropertyGroup><DisableImplicitFrameworkReferences>true</DisableImplicitFrameworkReferences></PropertyGroup>'), { ...app, dotnet: { aspnet: { version: '10.0.0' } } }]] as [
        string,
        ApplicationInput
    ][]) {
        const graph = await index(await repository({ 'App.csproj': project, 'Program.cs': program('app.MapGet("/gap",()=>"ok");') }), [config]);
        assert.equal(route(graph, '/gap').metadata.registration, 'candidate');
        assert.ok(graph.diagnostics.some(item => item.code === 'aspnet-profile-gap'));
    }
    const graph = await index(await repository({ 'App.csproj': sdk(), 'One.cs': 'class One{public static void Main(){var app=WebApplication.Create();app.MapGet("/one",()=>"ok");app.Run();}}', 'Two.cs': 'class Two{public static void Main(){var app=WebApplication.Create();app.MapGet("/two",()=>"ok");app.Run();}}' }));
    assert.equal(endpoints(graph).length, 2);
    assert.ok(endpoints(graph).every(entity => entity.metadata.registration === 'candidate'));
});
test('Conditional builder customization and deferred captured routers constrain later registrations', async () => {
    for (const text of ['var builder=WebApplication.CreateBuilder();if(enabled){builder.Services.CustomMatcher();}var app=builder.Build();app.MapGet("/bad",()=>"ok");app.Run();', 'var app=WebApplication.Create();System.Threading.Tasks.Task.Run(()=>{app.MapGet("/later",()=>"later");});app.MapGet("/bad",()=>"ok");app.Run();', 'var app=WebApplication.Create();app.MapGet("/bad",()=>{app.MapGet("/later",()=>"later");return "ok";});app.Run();', 'var app=WebApplication.Create();Later(app);app.MapGet("/bad",()=>"ok");app.Run();static async System.Threading.Tasks.Task Later(Microsoft.AspNetCore.Routing.IEndpointRouteBuilder app){await System.Threading.Tasks.Task.Delay(1);app.MapGet("/later",()=>"later");}']) {
        const graph = await index(await repository({ 'App.csproj': sdk(), 'Program.cs': text }));
        assert.equal(route(graph, '/bad').metadata.registration, 'candidate', JSON.stringify(endpoints(graph).map(entity => entity.metadata.routing)));
        assert.equal(route(graph, '/later'), undefined);
    }
});
test('Vue/Svelte/Astro request callers bind original ASP.NET helpers and handler leaves through configured proxy prefixes', async () => {
    const root = await repository({ 'App.csproj': sdk(), 'Program.cs': program('app.MapGet("/items/{id:int}",(int id)=>Handlers.Show(id));', 'public static class Handlers{public static int Show(int id)=>Leaf(id);private static int Leaf(int id)=>id;}'), 'front/package.json': '{"name":"front","dependencies":{"vue":"^3.5.0","svelte":"^5.0.0","astro":"^7.0.0"}}', 'front/Page.vue': '<script setup lang="ts">async function load(){await fetch("/proxy/items/12");}</script><template><button @click="load">Load</button></template>', 'front/Page.svelte': '<script lang="ts">async function load(){await fetch("/proxy/items/13");}</script><button onclick={load}>Load</button>', 'front/Page.astro': '---\nasync function load(){await fetch("http://localhost:5080/items/14");}\nawait load();\n---\n<div>Items</div>' }), graph = await index(root, [app, { name: 'front', path: 'front', frameworks: ['vue', 'svelte', 'astro'], apiProxies: [{ pathPrefix: '/proxy', target: 'server', targetPrefix: '/' }] }]);
    assert.deepEqual(requested(graph), ['/items/{id:int}', '/items/{id:int}', '/items/{id:int}']);
    assert.ok(graph.relations.some(edge => edge.type === 'calls' && graph.entities.find(entity => entity.id === edge.to)?.name === 'Leaf'));
});
test('Recorded external path bases are config dependencies and invalid ASP.NET fields are rejected', async () => {
    const root = await repository({ 'App.csproj': sdk(), 'Program.cs': program('app.MapGet("/items",()=>"ok");') }), cache = await freshCache();
    const bare = await index(root, [app], cache);
    assert.ok(route(bare, '/items'));
    const prefixed = await index(root, [{ ...app, dotnet: { aspnet: { pathBase: '/external' } } }], cache);
    assert.ok(route(prefixed, '/external/items'));
    assert.equal(route(prefixed, '/items'), undefined);
    for (const aspnet of [{ pathBase: '/bad/' }, { pathBase: '/a/../b' }, { pathBase: '/a//b' }, { pathBase: 'bad' }, { version: '10.x' }, { unknown: true }])
        await assert.rejects(() => resolveConfig(root, { applications: [{ ...app, dotnet: { aspnet } }] as ApplicationInput[] }), /ASP.NET routing configuration/);
});
test('Invoked original hosting factories share roots and declarations survive harmless source shifts', async () => {
    const text = 'var app=Create();app.MapGet("/factory",Handlers.Show);app.Run();static Microsoft.AspNetCore.Builder.WebApplication Create()=>WebApplication.Create();public static class Handlers{public static string Show()=>"ok";}', root = await repository({ 'App.csproj': sdk(), 'Program.cs': text }), first = await index(root);
    assert.equal(route(first, '/factory').metadata.registration, 'selected', JSON.stringify(route(first, '/factory').metadata.routing));
    await put(root, 'Program.cs', '// 😀 shift\r\n' + text);
    const moved = await index(root);
    assert.equal(route(moved, '/factory').id, route(first, '/factory').id);
    assert.deepEqual(handles(first).map(edge => edge.to), handles(moved).map(edge => edge.to));
    assert.equal(route(moved, '/factory').sourceRange?.startLine, 2);
});
test('Declared constant/delegate/factory types and custom model binding cannot invent registration certainty', async () => {
    for (const text of ['var app=WebApplication.Create();object path="/bad";app.MapGet(path,()=>"ok");app.Run();', 'var app=WebApplication.Create();System.Action<int> handler=(int id)=>id;app.MapGet("/bad",handler);app.Run();', 'var app=Create();app.MapGet("/bad",()=>"ok");app.Run();static object Create()=>WebApplication.Create();', 'var app=WebApplication.Create();app.MapPost("/bad",(Model model)=>"ok");app.Run();public class Model{}', 'var app=WebApplication.Create();app.MapGet("/bad",()=>new CustomResult());app.Run();public class CustomResult{}']) {
        const graph = await index(await repository({ 'App.csproj': sdk(), 'Program.cs': text }));
        assert.ok(endpoints(graph).every(entity => entity.metadata.registration === 'candidate'), JSON.stringify(endpoints(graph).map(entity => entity.metadata.routing)));
    }
});
test('Request holes, unknown native policies and Unicode casing never choose a competing literal route', async () => {
    const root = await repository({ 'App.csproj': sdk(), 'Program.cs': program('app.MapGet("/items/{id}",(string id)=>id);app.MapGet("/items/literal",()=>"literal");app.MapGet("/custom/{id:unknown}",(string id)=>id);app.MapGet("/unicode/{id}",(string id)=>id);app.MapGet("/unicode/K",()=>"k");'), 'front/package.json': '{"name":"front"}', 'front/client.ts': 'export async function load(id:string){await fetch(`http://localhost:5080/items/${id}`);await fetch("http://localhost:5080/custom/a");await fetch("http://localhost:5080/unicode/%E2%84%AA");}' }), graph = await index(root, [app, { name: 'front', path: 'front' }]);
    assert.deepEqual(requested(graph), []);
    assert.ok(graph.diagnostics.some(item => item.code === 'ambiguous-http-match'));
});
test('Empty MapMethods lists mean native ANY; scalar strings remain an invalid registration overload', async () => {
    const graph = await index(await repository({ 'App.csproj': sdk(), 'Program.cs': program('app.MapMethods("/any",new string[]{},()=>"ok");app.MapMethods("/bad","GET",()=>"bad");') }));
    assert.equal(route(graph, '/any').metadata.registration, 'selected');
    assert.equal((route(graph, '/any').metadata.routing as any).methods, '*');
    assert.equal(route(graph, '/bad').metadata.registration, 'candidate');
});
