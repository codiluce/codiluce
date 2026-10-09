import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { indexRepository } from '../src/pipeline/index.js';
import { resolveConfig, type RawConfig } from '../src/core/config.js';
import { AnalysisCache } from '../src/pipeline/cache.js';
import { canonicalJson } from '../src/history/fingerprint.js';
import { GraphStore } from '../src/storage/sqlite.js';
import { ProjectionService } from '../src/projection/service.js';
import type { Entity, SoftwareGraph } from '../src/core/graph.js';
import { aspnetProfiles, frontendNames, jvmDotnetWorkload, jvmProfiles, origin } from '../scripts/fixtures/jvm-dotnet-workload.js';

const roots: string[] = [];
after(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });
async function put(root: string, file: string, text: string) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); }
async function repository(files: Record<string, string>) { const root = await mkdtemp(path.join(tmpdir(), 'codiluce-jvm-dotnet-')); roots.push(root); for (const [file, text] of Object.entries(files)) await put(root, file, text); return root; }
const shape = (g: SoftwareGraph) => canonicalJson({ entities: g.entities, relations: g.relations, diagnostics: g.diagnostics.filter(d => !['git-metrics', 'indexer'].includes(d.analyzer) && d.code !== 'git-ignore-unavailable') });
const endpoints = (g: SoftwareGraph) => g.entities.filter(e => e.type === 'api_endpoint');
const handler = (g: SoftwareGraph, route: Entity) => g.entities.find(e => e.id === g.relations.find(edge => edge.type === 'handles' && edge.from === route.id)?.to);
const requested = (g: SoftwareGraph) => g.relations.filter(e => e.type === 'requests').map(edge => g.entities.find(e => e.id === edge.to)!);
async function index(root: string, config: RawConfig, cache?: AnalysisCache, revision?: string) { return indexRepository(root, { config: await resolveConfig(root, config), cache, revision }); }

test('Java/Kotlin MVC/WebFlux 6.2/7.0 and ASP.NET 8/9/10 retain original frontend, handler and source-leaf flows', async () => {
  const workload = jvmDotnetWorkload(2), root = await repository(workload.files), state = await repository({}), coldCache = new AnalysisCache(state), warmCache = new AnalysisCache(state);
  const cold = await index(root, workload.config, coldCache), warm = await index(root, workload.config, warmCache), revision = await index(root, workload.config, undefined, 'recorded');
  assert.equal(shape(cold), shape(warm)); assert.equal(shape(cold), shape(revision));
  for (const analyzer of ['syntax-facts', 'jvm-imports', 'csharp-imports', 'embedded-source', 'typescript-nextjs']) assert.ok(warmCache.events.some(e => e.analyzer === analyzer && e.hit), `${analyzer}: ${JSON.stringify(warmCache.events)}`);
  assert.equal(endpoints(cold).length, workload.expectedEndpoints); assert.equal(requested(cold).length, workload.expectedRequests);
  for (const name of frontendNames) assert.equal(cold.relations.filter(edge => edge.type === 'requests' && cold.entities.find(e => e.id === edge.from)?.path?.startsWith(name + '/')).length, workload.expectedEndpoints, name);
  const store = new GraphStore(':memory:');
  try {
    store.save(cold); const projection = new ProjectionService(store, { root });
    for (const route of endpoints(cold)) {
      const action = handler(cold, route)!; assert.ok(action?.sourceRange); assert.ok(Object.hasOwn(workload.files, action.path!));
      const application = route.path!.split('/')[0]!; assert.ok(action.path!.startsWith(application + '/'));
      const expectedLine = action.language === 'csharp' ? route.metadata.frameworkPack === 'aspnet-mvc' ? 6 : 3 + Number(action.name.slice(4)) : action.language === 'java' ? route.metadata.framework === 'spring-mvc' ? 7 : 14 : route.metadata.framework === 'spring-mvc' ? 7 : 13;
      assert.equal(action.sourceRange.startLine, expectedLine, action.path);
      const leaf = cold.relations.filter(edge => edge.type === 'calls' && edge.from === action.id).map(edge => cold.entities.find(e => e.id === edge.to)!).find(e => ['leaf', 'Read'].includes(e.name)); assert.ok(leaf?.sourceRange, action.path);
      assert.ok(leaf.path!.startsWith(application + '/')); if (action.language === 'csharp') assert.equal(leaf.path, `${application}/lib/Leaf.cs`);
      const flow = await projection.requestFlow(route.id, { maxFileBytes: 1 << 20 }); assert.equal(flow.nodes.find(n => n.kind === 'handler')?.node?.id, action.id);
      assert.ok(flow.nodes.some(n => n.node?.id === leaf.id), JSON.stringify(flow.nodes));
    }
  } finally { store.close(); }
});

test('Mixed-stack profile changes invalidate cached winners without borrowing another application version', async () => {
  const workload = jvmDotnetWorkload(), root = await repository(workload.files), state = await repository({});
  async function replay(config: RawConfig) { const cache = new AnalysisCache(state), graph = await index(root, config, cache), fresh = await index(root, config, undefined, 'recorded'); assert.equal(shape(graph), shape(fresh)); return { graph, events: cache.events }; }
  await replay(workload.config);
  const config = structuredClone(workload.config); config.applications!.find(a => a.name === 'mvc-java-62')!.jvm!.spring!.version = '7.1.0'; config.applications!.find(a => a.name === 'aspnet8')!.dotnet!.aspnet!.version = '11.0.0';
  const { graph, events } = await replay(config);
  assert.equal(requested(graph).length, workload.expectedRequests - 12);
  for (const name of ['mvc-java-62', 'aspnet8']) assert.ok(!requested(graph).some(e => e.path?.startsWith(name + '/')), name);
  assert.ok(requested(graph).some(e => e.path?.startsWith('mvc-java-70/'))); assert.ok(requested(graph).some(e => e.path?.startsWith('aspnet9/')));
  for (const analyzer of ['jvm-imports', 'csharp-imports']) assert.ok(events.some(e => e.analyzer === analyzer && !e.hit), analyzer);
});

test('CRLF/source shifts and project-reference edits replay exact original locations and dependency visibility', async () => {
  const workload = jvmDotnetWorkload(), root = await repository(workload.files), state = await repository({});
  async function replay() { const g = await index(root, workload.config, new AnalysisCache(state)); assert.equal(shape(g), shape(await index(root, workload.config, undefined, 'recorded'))); return g; }
  await replay();
  const java = 'mvc-java-62/src/main/java/demo/Items0.java', csharp = 'aspnet8/lib/Leaf.cs';
  await put(root, java, '// shifted 😀\r\n\r\n' + workload.files[java]); await put(root, csharp, '// shifted 😀\r\n' + workload.files[csharp]);
  let g = await replay(); assert.equal(handler(g, endpoints(g).find(e => e.path === java)!)?.sourceRange?.startLine, 9); assert.equal(g.entities.find(e => e.path === csharp && e.name === 'Read')?.sourceRange?.startLine, 5);
  await put(root, 'aspnet8/App.csproj', workload.files['aspnet8/App.csproj']!.replace('<ProjectReference Include="lib\\Library.csproj"/>', '<ProjectReference Include="lib\\Library.csproj" ReferenceOutputAssembly="false"/>'));
  g = await replay(); const actions = endpoints(g).filter(e => e.path?.startsWith('aspnet8/')).map(e => handler(g, e)!.id);
  assert.ok(!g.relations.some(e => e.type === 'calls' && actions.includes(e.from) && g.entities.find(x => x.id === e.to)?.name === 'Read'));
  assert.ok(g.relations.some(e => e.type === 'calls' && g.entities.find(x => x.id === e.from)?.path?.startsWith('aspnet9/') && g.entities.find(x => x.id === e.to)?.name === 'Read'));
});

test('Mixed native verb profiles preserve MVC implicit HEAD and require explicit functional/minimal HEAD', async () => {
  const workload = jvmDotnetWorkload();
  for (const file of Object.keys(workload.files).filter(file => frontendNames.some(name => file.startsWith(name + '/')))) workload.files[file] = workload.files[file]!.replace(/\/12'\)/g, "/12',{method:'HEAD'})");
  const root = await repository(workload.files), g = await index(root, workload.config);
  assert.equal(requested(g).length, 4 * frontendNames.length); assert.ok(requested(g).every(e => e.metadata.framework === 'spring-mvc'));
  assert.equal(g.diagnostics.filter(d => d.code === 'unmatched-http-call').length, workload.expectedRequests - 16);
  for (const { name } of aspnetProfiles) await put(root, `${name}/Program.cs`, workload.files[`${name}/Program.cs`]!.replace('app.MapGet("/minimal0/{id:int}",Handlers.Show0);', 'app.MapMethods("/minimal0/{id:int}",new[]{"GET","HEAD"},Handlers.Show0);'));
  const explicit = await index(root, workload.config); assert.equal(requested(explicit).length, (4 + 3) * frontendNames.length);
  assert.equal(requested(explicit).filter(e => e.metadata.framework === 'aspnetcore').length, 12);
});

test('Recorded proxies reach each JVM/.NET application only from original browser contexts', async () => {
  const workload = jvmDotnetWorkload(), names = [...jvmProfiles, ...aspnetProfiles].map(p => p.name);
  for (const file of Object.keys(workload.files).filter(file => frontendNames.some(name => file.startsWith(name + '/')))) for (const name of names) workload.files[file] = workload.files[file]!.replaceAll(origin(name) + '/ctx', '/gateway/' + name);
  workload.files['ts/client0.ts'] = '"use client";\n' + workload.files['ts/client0.ts'];
  const relativeAstro = workload.files['astro/src/pages/page0.astro']!;
  workload.files['astro/src/pages/page0.astro'] = '<script>' + relativeAstro.replace(/\{(fetch\([^\n]+\))\}/g, '$1;') + '</script>\n' + relativeAstro;
  for (const app of workload.config.applications!.filter(a => frontendNames.includes(a.name))) app.apiProxies = names.map(name => ({ target: name, pathPrefix: '/gateway/' + name, targetPrefix: '/ctx' }));
  const root = await repository(workload.files), state = await repository({}), cache = new AnalysisCache(state), g = await index(root, workload.config, cache);
  assert.equal(requested(g).length, workload.expectedRequests);
  assert.ok(g.relations.filter(e => e.type === 'requests').every(e => e.metadata?.resolution === 'configured-proxy'));
  assert.equal(g.diagnostics.filter(d => d.code === 'unverified-relative-api-boundary' && d.file?.endsWith('.astro')).length, workload.expectedEndpoints);
  assert.ok(g.relations.filter(e => e.type === 'requests' && g.entities.find(x => x.id === e.from)?.path?.endsWith('.astro')).every(e => g.entities.find(x => x.id === e.from)?.metadata.executionContext === 'browser'));
  const changed = structuredClone(workload.config); for (const app of changed.applications!.filter(a => frontendNames.includes(a.name))) app.apiProxies = [];
  const replay = await index(root, changed, new AnalysisCache(state)); assert.equal(requested(replay).length, 0); assert.equal(shape(replay), shape(await index(root, changed, undefined, 'recorded')));
});

test('Competing original applications sharing a host retain ambiguity instead of borrowing one native winner', async () => {
  const workload = jvmDotnetWorkload(), names = [...jvmProfiles, ...aspnetProfiles].map(p => p.name);
  for (const file of Object.keys(workload.files).filter(file => frontendNames.some(name => file.startsWith(name + '/')))) for (const name of names) workload.files[file] = workload.files[file]!.replaceAll(origin(name), 'https://shared.test');
  for (const app of workload.config.applications!.filter(a => names.includes(a.name))) app.apiOrigins = ['https://shared.test'];
  const g = await index(await repository(workload.files), workload.config);
  assert.equal(endpoints(g).length, workload.expectedEndpoints); assert.equal(requested(g).length, 0);
  assert.equal(g.diagnostics.filter(d => d.code === 'ambiguous-http-match').length, workload.expectedRequests);
  assert.equal(g.relations.filter(e => e.type === 'handles').length, workload.expectedEndpoints);
});

test('Runtime prefix inputs and source edits invalidate requests while retaining untouched profile winners', async () => {
  const workload = jvmDotnetWorkload(), root = await repository(workload.files), state = await repository({});
  await index(root, workload.config, new AnalysisCache(state));
  const changed = structuredClone(workload.config); changed.applications!.find(a => a.name === 'mvc-java-62')!.jvm!.spring!.contextPath = '/changed'; changed.applications!.find(a => a.name === 'aspnet8')!.dotnet!.aspnet!.pathBase = '/changed';
  await put(root, 'webflux-kotlin-70/src/main/resources/application.properties', 'spring.webflux.base-path=/changed');
  // Remove the recorded value so the original property source can select it.
  delete changed.applications!.find(a => a.name === 'webflux-kotlin-70')!.jvm!.spring!.basePath;
  const g = await index(root, changed, new AnalysisCache(state)); assert.equal(shape(g), shape(await index(root, changed, undefined, 'recorded'))); assert.equal(requested(g).length, workload.expectedRequests - 16);
  assert.equal(endpoints(g).filter(e => String(e.metadata.routePath).startsWith('/changed/')).length, 4);
  await put(root, 'mvc-kotlin-62/src/main/kotlin/demo/Items0.kt', workload.files['mvc-kotlin-62/src/main/kotlin/demo/Items0.kt']!.replace('/items0/{id}', '/edited/{id}'));
  const edited = await index(root, changed, new AnalysisCache(state)); assert.equal(shape(edited), shape(await index(root, changed, undefined, 'recorded'))); assert.equal(requested(edited).length, workload.expectedRequests - 20);
});

test('Denied original MVC handlers remain candidates and never substitute another application source', async () => {
  const workload = jvmDotnetWorkload(), root = await repository(workload.files), state = await repository({});
  await index(root, workload.config, new AnalysisCache(state));
  const changed = { ...workload.config, ignore: ['mvc-java-62/src/main/java/demo/Items0.java', 'aspnet8/Items0Controller.cs'] };
  const g = await index(root, changed, new AnalysisCache(state)); assert.equal(shape(g), shape(await index(root, changed, undefined, 'recorded'))); assert.equal(requested(g).length, workload.expectedRequests - 12);
  // A denied controller could compete with the minimal registration, so the
  // ASP.NET datasource gap also constrains that application's minimal route.
  assert.ok(endpoints(g).filter(e => e.path?.startsWith('aspnet8/')).every(e => e.metadata.registration === 'candidate'));
  assert.ok(!requested(g).some(e => e.path === 'mvc-java-62/src/main/java/demo/Items0.java' || e.path === 'aspnet8/Items0Controller.cs'));
  assert.ok(requested(g).some(e => e.path === 'mvc-java-70/src/main/java/demo/Items0.java')); assert.ok(requested(g).some(e => e.path === 'aspnet9/Items0Controller.cs'));
});

test('Recorded MSBuild target/configuration/platform selections never use host compilation defaults', async () => {
  const workload = jvmDotnetWorkload(), project = workload.files['aspnet8/App.csproj']!;
  workload.files['aspnet8/App.csproj'] = project.replace('<TargetFramework>net8.0</TargetFramework>', '<TargetFrameworks>net8.0;net10.0</TargetFrameworks>').replace('</Project>', '<ItemGroup Condition="\'$(Configuration)\'==\'Debug\' And \'$(Platform)\'==\'AnyCPU\'"><Compile Remove="Items0Controller.cs"/></ItemGroup></Project>');
  const root = await repository(workload.files), state = await repository({});
  const unknown = await index(root, workload.config, new AnalysisCache(state)); assert.ok(!requested(unknown).some(e => e.path?.startsWith('aspnet8/')));
  const release = structuredClone(workload.config), app = release.applications!.find(a => a.name === 'aspnet8')!; Object.assign(app.dotnet!, { targetFramework: 'net8.0', configuration: 'Release', platform: 'AnyCPU' });
  const selected = await index(root, release, new AnalysisCache(state)); assert.equal(shape(selected), shape(await index(root, release, undefined, 'recorded'))); assert.equal(requested(selected).length, workload.expectedRequests);
  const debug = structuredClone(release); debug.applications!.find(a => a.name === 'aspnet8')!.dotnet!.configuration = 'Debug';
  const removed = await index(root, debug, new AnalysisCache(state)); assert.equal(shape(removed), shape(await index(root, debug, undefined, 'recorded'))); assert.ok(!endpoints(removed).some(e => e.path === 'aspnet8/Items0Controller.cs')); assert.equal(requested(removed).filter(e => e.path?.startsWith('aspnet8/')).length, 4);
});
