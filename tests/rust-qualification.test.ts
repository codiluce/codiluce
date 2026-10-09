import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
import { rustFrontendNames, rustOrigin, rustProfiles, rustWorkload } from '../scripts/fixtures/rust-workload.js';

const roots: string[] = [];
after(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });
async function put(root: string, file: string, text: string) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); }
async function repository(files: Record<string, string> = {}) { const root = await mkdtemp(path.join(tmpdir(), 'codiluce-rust-qualification-')); roots.push(root); for (const [file, text] of Object.entries(files)) await put(root, file, text); return root; }
const shape = (g: SoftwareGraph) => createHash('sha256').update(canonicalJson({ entities: g.entities, relations: g.relations, diagnostics: g.diagnostics.filter(d => !['git-metrics', 'indexer'].includes(d.analyzer) && d.code !== 'git-ignore-unavailable') })).digest('hex');
const endpoints = (g: SoftwareGraph) => g.entities.filter(e => e.type === 'api_endpoint' && e.metadata.registration === 'explicit');
const handler = (g: SoftwareGraph, route: Entity) => g.entities.find(e => e.id === g.relations.find(edge => edge.type === 'handles' && edge.from === route.id)?.to);
const requested = (g: SoftwareGraph) => g.relations.filter(e => e.type === 'requests').map(edge => g.entities.find(e => e.id === edge.to)!);
async function index(root: string, config: RawConfig, cache?: AnalysisCache, revision?: string) { return indexRepository(root, { config: await resolveConfig(root, config), cache, revision }); }

test('All six Rust native profiles retain TS/Vue/Svelte/Astro requests, original handlers and shared source leaves', async () => {
  const workload = rustWorkload(2), root = await repository(workload.files), state = await repository();
  const cold = await index(root, workload.config, new AnalysisCache(state)), warmCache = new AnalysisCache(state), warm = await index(root, workload.config, warmCache), revision = await index(root, workload.config, undefined, 'recorded');
  assert.equal(shape(cold), shape(warm)); assert.equal(shape(cold), shape(revision));
  for (const analyzer of ['syntax-facts', 'rust-imports', 'rust-symbols', 'rust-routers', 'embedded-source', 'typescript-nextjs']) assert.ok(warmCache.events.some(e => e.analyzer === analyzer && e.hit), analyzer);
  assert.equal(endpoints(cold).length, workload.expectedEndpoints); assert.equal(requested(cold).length, workload.expectedRequests);
  for (const name of rustFrontendNames) assert.equal(cold.relations.filter(edge => edge.type === 'requests' && cold.entities.find(e => e.id === edge.from)?.path?.startsWith(name + '/')).length, workload.expectedEndpoints, name);
  const store = new GraphStore(':memory:');
  try {
    store.save(cold); const projection = new ProjectionService(store, { root });
    for (const route of endpoints(cold)) {
      const action = handler(cold, route)!; assert.ok(action?.sourceRange, route.name); assert.ok(Object.hasOwn(workload.files, action.path!));
      const profile = rustProfiles.find(p => route.path!.startsWith(p.name + '/'))!; assert.ok(profile);
      assert.equal((route.metadata.routing as any).pattern.dialect, profile.dialect); assert.ok(!route.metadata.constraintsUnresolved, JSON.stringify(route.metadata.routing));
      assert.equal(action.path, `${profile.name}/src/routes.rs`); assert.equal(action.sourceRange.startLine, profile.framework === 'rocket' ? 3 + Number(action.name.slice(4)) * 2 : 2 + Number(action.name.slice(4)));
      assert.ok(route.evidence.some(e => e.file === `${profile.name}/Cargo.toml`));
      const leaf = cold.relations.filter(edge => edge.type === 'calls' && edge.from === action.id).map(edge => cold.entities.find(e => e.id === edge.to)!).find(e => e.name === 'leaf'); assert.ok(leaf, action.path); assert.equal(leaf.path, 'common/src/lib.rs'); assert.equal(leaf.sourceRange!.startLine, 3);
      const flow = await projection.requestFlow(route.id, { maxFileBytes: 1 << 20 }); assert.equal(flow.nodes.find(n => n.kind === 'handler')?.node?.id, action.id); assert.ok(flow.nodes.some(n => n.node?.id === leaf.id), JSON.stringify(flow.nodes));
    }
  } finally { store.close(); }
});

test('Six version profiles keep native HEAD and trailing slash dispatch independent', async () => {
  const workload = rustWorkload();
  for (const file of Object.keys(workload.files).filter(file => rustFrontendNames.some(name => file.startsWith(name + '/')))) workload.files[file] = workload.files[file]!.replace(/\/12'\)/g, "/12',{method:'HEAD'})");
  const root = await repository(workload.files), headGraph = await index(root, workload.config), heads = requested(headGraph);
  const headHandlers = heads.filter(e => e.metadata.registration === 'explicit');
  assert.equal(headHandlers.length, 3 * rustFrontendNames.length); assert.ok(headHandlers.every(e => ['axum', 'rocket'].includes(String(e.metadata.framework))));
  const headDefaults = heads.filter(e => e.metadata.registration !== 'explicit'); assert.equal(headDefaults.length, rustFrontendNames.length); assert.ok(headDefaults.every(e => e.metadata.framework === 'actix-web' && e.metadata.status === 404 && !handler(headGraph, e)));
  for (const file of Object.keys(workload.files).filter(file => rustFrontendNames.some(name => file.startsWith(name + '/')))) await put(root, file, workload.files[file]!.replaceAll("/12',{method:'HEAD'}", "/12/'"));
  const slashGraph = await index(root, workload.config), slashes = requested(slashGraph), slashHandlers = slashes.filter(e => e.metadata.registration === 'explicit');
  assert.equal(slashHandlers.length, 3 * rustFrontendNames.length); assert.ok(slashHandlers.every(e => ['rocket', 'warp'].includes(String(e.metadata.framework))));
  const slashDefaults = slashes.filter(e => e.metadata.registration !== 'explicit'); assert.equal(slashDefaults.length, 3 * rustFrontendNames.length); assert.ok(slashDefaults.every(e => ['axum', 'actix-web'].includes(String(e.metadata.framework)) && e.metadata.status === 404 && !handler(slashGraph, e)));
});

test('Changing Cargo versions invalidates affected winners without borrowing a different Rust profile', async () => {
  const workload = rustWorkload(), root = await repository(workload.files), state = await repository();
  await index(root, workload.config, new AnalysisCache(state));
  for (const { name, version } of rustProfiles) await put(root, `${name}/Cargo.toml`, workload.files[`${name}/Cargo.toml`]!.replace(`version="${version}"`, 'version="*"'));
  const changed = await index(root, workload.config, new AnalysisCache(state)); assert.equal(shape(changed), shape(await index(root, workload.config, undefined, 'recorded'))); assert.equal(requested(changed).length, 0);
  assert.ok(changed.diagnostics.some(d => d.analyzer === 'rust-routers'));
});

test('Recorded feature selections suppress inactive source modules in every router pack', async () => {
  const workload = rustWorkload(), root = await repository(workload.files), state = await repository();
  await index(root, workload.config, new AnalysisCache(state));
  const changed = structuredClone(workload.config); for (const app of changed.applications!.filter(a => a.rust)) app.rust!.features = [];
  const graph = await index(root, changed, new AnalysisCache(state)); assert.equal(shape(graph), shape(await index(root, changed, undefined, 'recorded'))); assert.equal(requested(graph).length, 0);
  assert.ok(!graph.relations.some(edge => edge.type === 'handles' && graph.entities.find(e => e.id === edge.to)?.path?.endsWith('/routes.rs')));
});

test('Recorded Unix/Windows shared compilation contexts never infer leaf winners from the host', async () => {
  const workload = rustWorkload(), root = await repository(workload.files), state = await repository();
  await index(root, workload.config, new AnalysisCache(state));
  const changed = structuredClone(workload.config); for (const app of changed.applications!.filter(a => a.rust)) { app.rust!.targetTriple = 'x86_64-pc-windows-msvc'; app.rust!.cfg = { flags: ['windows'], values: { target_os: ['windows'], target_arch: ['x86_64'], target_pointer_width: ['64'] } }; }
  const graph = await index(root, changed, new AnalysisCache(state)); assert.equal(shape(graph), shape(await index(root, changed, undefined, 'recorded'))); assert.equal(requested(graph).length, workload.expectedRequests);
  const leaves = graph.relations.filter(edge => edge.type === 'calls' && graph.entities.find(e => e.id === edge.to)?.path === 'common/src/lib.rs').map(edge => graph.entities.find(e => e.id === edge.to)!); assert.ok(leaves.length >= rustProfiles.length); assert.ok(leaves.every(e => e.sourceRange!.startLine === 5));
  for (const app of changed.applications!.filter(a => a.rust)) delete app.rust!.cfg;
  const unknown = await index(root, changed, new AnalysisCache(state)); assert.equal(shape(unknown), shape(await index(root, changed, undefined, 'recorded')));
  assert.ok(!unknown.relations.some(edge => edge.type === 'calls' && unknown.entities.find(e => e.id === edge.to)?.path === 'common/src/lib.rs'));
});

test('Concurrent Unix and Windows invocations of one shared crate retain application-specific leaf calls', async () => {
  const workload = rustWorkload();
  const windows = new Set(['axum8', 'rocket5', 'warp4']);
  for (const app of workload.config.applications!.filter(a => windows.has(a.name))) { app.rust!.targetTriple = 'x86_64-pc-windows-msvc'; app.rust!.cfg = { flags: ['windows'], values: { target_os: ['windows'], target_arch: ['x86_64'], target_pointer_width: ['64'] } }; }
  const root = await repository(workload.files), state = await repository(), graph = await index(root, workload.config, new AnalysisCache(state)), warm = await index(root, workload.config, new AnalysisCache(state));
  assert.equal(shape(graph), shape(warm)); assert.equal(shape(graph), shape(await index(root, workload.config, undefined, 'recorded'))); assert.equal(requested(graph).length, workload.expectedRequests);
  for (const route of endpoints(graph)) {
    const action = handler(graph, route)!, name = action.path!.split('/')[0]!;
    const calls = graph.relations.filter(edge => edge.type === 'calls' && edge.from === action.id && graph.entities.find(e => e.id === edge.to)?.path === 'common/src/lib.rs');
    assert.ok(calls.length, name); for (const edge of calls) { assert.equal(graph.entities.find(e => e.id === edge.to)!.sourceRange!.startLine, windows.has(name) ? 5 : 3); assert.equal(edge.metadata!.compilation, route.metadata.compilation); }
  }
});

test('Changed dependency features and a missing selected bin constrain only their original applications', async () => {
  const workload = rustWorkload(), root = await repository(workload.files), state = await repository(); await index(root, workload.config, new AnalysisCache(state));
  await put(root, 'warp4/Cargo.toml', workload.files['warp4/Cargo.toml']!.replace(',features=["server"]', ''));
  const changed = structuredClone(workload.config); changed.applications!.find(a => a.name === 'axum7')!.rust!.target = { kind: 'bin', name: 'missing' };
  const graph = await index(root, changed, new AnalysisCache(state)); assert.equal(shape(graph), shape(await index(root, changed, undefined, 'recorded'))); assert.equal(requested(graph).length, workload.expectedRequests - 2 * rustFrontendNames.length);
  assert.ok(!requested(graph).some(e => ['axum7', 'warp4'].some(name => e.path?.startsWith(name + '/'))));
  for (const { name } of rustProfiles.filter(p => !['axum7', 'warp4'].includes(p.name))) assert.equal(requested(graph).filter(e => e.path?.startsWith(name + '/')).length, rustFrontendNames.length, name);
});

test('Replacing a shared path dependency with a registry dependency removes original source calls only', async () => {
  const workload = rustWorkload(), root = await repository(workload.files), state = await repository(); await index(root, workload.config, new AnalysisCache(state));
  await put(root, 'warp4/Cargo.toml', workload.files['warp4/Cargo.toml']!.replace('common={path="../common"}', 'common="1.0.0"'));
  const graph = await index(root, workload.config, new AnalysisCache(state)); assert.equal(shape(graph), shape(await index(root, workload.config, undefined, 'recorded'))); assert.equal(requested(graph).length, workload.expectedRequests);
  const action = handler(graph, endpoints(graph).find(e => e.path?.startsWith('warp4/'))!)!;
  assert.ok(!graph.relations.some(edge => edge.type === 'calls' && edge.from === action.id && graph.entities.find(e => e.id === edge.to)?.path === 'common/src/lib.rs'));
  assert.ok(graph.relations.some(edge => edge.type === 'calls' && graph.entities.find(e => e.id === edge.from)?.path === 'warp3/src/routes.rs' && graph.entities.find(e => e.id === edge.to)?.path === 'common/src/lib.rs'));
});

test('CRLF/source shifts preserve identities while shared source edits invalidate every original leaf', async () => {
  const workload = rustWorkload(), root = await repository(workload.files), state = await repository(), initial = await index(root, workload.config, new AnalysisCache(state));
  for (const profile of rustProfiles) await put(root, `${profile.name}/src/routes.rs`, '// shifted 😀\r\n\r\n' + workload.files[`${profile.name}/src/routes.rs`]);
  await put(root, 'common/src/lib.rs', '// shifted 😀\r\n' + workload.files['common/src/lib.rs']);
  const shifted = await index(root, workload.config, new AnalysisCache(state)); assert.equal(shape(shifted), shape(await index(root, workload.config, undefined, 'recorded'))); assert.deepEqual(endpoints(shifted).map(e => e.id).sort(), endpoints(initial).map(e => e.id).sort());
  for (const route of endpoints(shifted)) assert.equal(handler(shifted, route)!.sourceRange!.startLine, handler(initial, endpoints(initial).find(e => e.id === route.id)!)!.sourceRange!.startLine + 2);
  await put(root, 'common/src/lib.rs', workload.files['common/src/lib.rs']!.replaceAll('leaf', 'renamed'));
  const edited = await index(root, workload.config, new AnalysisCache(state)); assert.equal(shape(edited), shape(await index(root, workload.config, undefined, 'recorded'))); assert.equal(requested(edited).length, workload.expectedRequests);
  assert.ok(!edited.relations.some(edge => edge.type === 'calls' && edited.entities.find(e => e.id === edge.to)?.name === 'renamed'));
});

test('Denial of shared source and original handlers cannot reuse cached source winners', async () => {
  const workload = rustWorkload(), root = await repository(workload.files), state = await repository(); await index(root, workload.config, new AnalysisCache(state));
  const changed = { ...workload.config, ignore: ['common/src/lib.rs', ...rustProfiles.map(p => `${p.name}/src/routes.rs`)] };
  const graph = await index(root, changed, new AnalysisCache(state)); assert.equal(shape(graph), shape(await index(root, changed, undefined, 'recorded'))); assert.equal(requested(graph).length, 0); assert.equal(graph.relations.filter(e => e.type === 'handles').length, 0);
});

test('Explicit browser proxies retain each Rust application boundary and original callback context', async () => {
  const workload = rustWorkload();
  for (const file of Object.keys(workload.files).filter(file => rustFrontendNames.some(name => file.startsWith(name + '/')))) for (const { name } of rustProfiles) workload.files[file] = workload.files[file]!.replaceAll(rustOrigin(name) + '/api', '/gateway/' + name);
  workload.files['ts/client0.ts'] = '"use client";\n' + workload.files['ts/client0.ts'];
  const astro = workload.files['astro/src/pages/page0.astro']!; workload.files['astro/src/pages/page0.astro'] = '<script>' + astro.replace(/\{(fetch\([^\n]+\))\}/g, '$1;') + '</script>\n' + astro;
  for (const app of workload.config.applications!.filter(a => rustFrontendNames.includes(a.name))) app.apiProxies = rustProfiles.map(p => ({ target: p.name, pathPrefix: '/gateway/' + p.name, targetPrefix: '/api' }));
  const root = await repository(workload.files), state = await repository(), graph = await index(root, workload.config, new AnalysisCache(state)); assert.equal(requested(graph).length, workload.expectedRequests); assert.ok(graph.relations.filter(e => e.type === 'requests').every(e => e.metadata?.resolution === 'configured-proxy'));
  assert.equal(graph.diagnostics.filter(d => d.code === 'unverified-relative-api-boundary' && d.file?.endsWith('.astro')).length, workload.expectedEndpoints);
  const changed = structuredClone(workload.config); for (const app of changed.applications!.filter(a => rustFrontendNames.includes(a.name))) app.apiProxies = [];
  const replay = await index(root, changed, new AnalysisCache(state)); assert.equal(requested(replay).length, 0); assert.equal(shape(replay), shape(await index(root, changed, undefined, 'recorded')));
});

test('Competing native Rust applications sharing an origin retain cross-pack ambiguity', async () => {
  const workload = rustWorkload();
  for (const file of Object.keys(workload.files).filter(file => rustFrontendNames.some(name => file.startsWith(name + '/')))) for (const { name } of rustProfiles) workload.files[file] = workload.files[file]!.replaceAll(rustOrigin(name), 'https://shared.test');
  for (const app of workload.config.applications!.filter(a => a.rust)) app.apiOrigins = ['https://shared.test'];
  const graph = await index(await repository(workload.files), workload.config); assert.equal(endpoints(graph).length, workload.expectedEndpoints); assert.equal(requested(graph).length, 0); assert.equal(graph.diagnostics.filter(d => d.code === 'ambiguous-http-match').length, workload.expectedRequests);
});

test('Larger native filter portfolios serialize with distinct original proof and replay within a fixed graph budget', async () => {
  const workload = rustWorkload(32), root = await repository(workload.files), state = await repository(), cold = await index(root, workload.config, new AnalysisCache(state));
  assert.equal(endpoints(cold).length, 192); assert.equal(requested(cold).length, 768);
  for (const route of endpoints(cold)) {
    assert.ok(route.evidence.length < 256, `${route.name}: ${route.evidence.length} proof facts`);
    assert.equal(new Set(route.evidence.map(fact => JSON.stringify(fact))).size, route.evidence.length);
    assert.ok(route.evidence.some(fact => fact.file === route.path)); assert.ok(route.evidence.some(fact => fact.file?.endsWith('/Cargo.toml')));
    assert.ok((route.metadata.routing as any).mounts.length, route.name); assert.ok(handler(cold, route)?.sourceRange);
  }
  assert.ok(Buffer.byteLength(JSON.stringify(cold)) < 16 << 20, '192 source routes and 768 original requests serialize under 16 MiB');
  const cache = new AnalysisCache(state), warm = await index(root, workload.config, cache); assert.equal(shape(cold), shape(warm)); assert.ok(cache.events.some(e => e.analyzer === 'rust-routers' && e.hit)); assert.equal(shape(cold), shape(await index(root, workload.config, undefined, 'recorded')));
});
