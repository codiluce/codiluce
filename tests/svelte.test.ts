import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { indexRepository } from '../src/pipeline/index.js';
import { resolveConfig, type ApplicationInput } from '../src/core/config.js';
import { AnalysisCache } from '../src/pipeline/cache.js';
import { canonicalJson } from '../src/history/fingerprint.js';
import type { SoftwareGraph } from '../src/core/graph.js';
import { kitPath } from '../src/analysis/frameworks/sveltekit-path.js';
import { matchRoutePattern } from '../src/analysis/routes/contracts.js';
import { GraphStore } from '../src/storage/sqlite.js';
import { ProjectionService } from '../src/projection/service.js';

const temporary: string[] = [];
after(async () => { await Promise.all(temporary.map(root => rm(root, { recursive: true, force: true }))); });
const manifest = JSON.stringify({ workspaces: ['old', 'legacy', 'future'], dependencies: { svelte: '^5.57.2', '@sveltejs/kit': '^2.62.0', vite: '^8.0.12' } });
async function repository(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'codiluce-svelte-')); temporary.push(root);
  for (const [file, text] of Object.entries({ 'package.json': manifest, ...files })) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); } return root;
}
async function index(root: string, cache?: AnalysisCache, revision?: string, applications: ApplicationInput[] = [{ name: 'app', path: '.', frameworks: ['svelte', 'sveltekit'] }]) { return indexRepository(root, { config: await resolveConfig(root, { repository: { name: 'svelte' }, applications }), cache, revision }); }
const stored = (graph: SoftwareGraph) => canonicalJson({ entities: graph.entities, relations: graph.relations, diagnostics: graph.diagnostics.filter(item => !['git-metrics', 'indexer'].includes(item.analyzer) && item.code !== 'git-ignore-unavailable') });
const components = (graph: SoftwareGraph) => graph.entities.filter(item => item.type === 'component' && item.language === 'svelte');
const pages = (graph: SoftwareGraph) => graph.entities.filter(item => item.type === 'route' && item.metadata.framework === 'sveltekit');
const endpoints = (graph: SoftwareGraph) => graph.entities.filter(item => item.type === 'api_endpoint' && item.metadata.framework === 'sveltekit');
const named = (graph: SoftwareGraph, name: string) => graph.entities.find(item => item.name === name)!;
const sfc = '<span>Content</span>';

test('Svelte legacy/runes templates bind original imports, aliases, namespaces and browser callbacks with UTF-16 ranges', async () => {
  const root = await repository({ 'src/App.svelte': '<script module lang="ts">import {save as moduleSave} from "./helpers";</script>\r\n<script lang="ts">import Child from "./Child.svelte"; import * as UI from "./barrel"; import {save} from "./helpers"; const Alias=Child; let count=$state(0);</script>\r\n<p>😀</p><Child/><Alias/><UI.Child/><svelte:component this={Child}/><button onclick={moduleSave}/><button onclick={() => save()}/>', 'src/Child.svelte': sfc, 'src/helpers.ts': 'export function save(){return 1;}', 'src/barrel.ts': 'export {default as Child} from "./Child.svelte";' });
  const graph = await index(root), app = components(graph).find(item => item.path === 'src/App.svelte')!, child = components(graph).find(item => item.path === 'src/Child.svelte')!, save = named(graph, 'save');
  assert.equal(graph.relations.find(item => item.type === 'renders' && item.from === app.id && item.to === child.id)!.evidence.length, 4);
  const callbacks = graph.entities.filter(item => item.metadata.svelteBrowserCallback); assert.equal(callbacks.length, 2); assert.ok(callbacks.every(item => item.sourceRange?.startLine === 3));
  assert.equal(graph.relations.filter(item => item.type === 'calls' && item.to === save.id && callbacks.some(callback => callback.id === item.from)).length, 2);
  assert.equal(graph.entities.some(item => item.path?.includes('.__codiluce_')), false);
});

test('Each, await, let, const, snippet and inline JS scopes suppress shadowed script helpers', async () => {
  const root = await repository({ 'App.svelte': '<script>import {save} from "./helpers"; import Child from "./Child.svelte";</script>{#each rows as {save}, index}<button onclick={() => save()}/>{:else}<button onclick={save}/>{/each}{#await promise then save}<button onclick={save}/>{:catch save}<button onclick={() => save()}/>{/await}<Child let:save><button onclick={save}/></Child>{#if ok}{@const save = local}<button onclick={save}/>{/if}{#snippet row(save)}<button onclick={save}/>{/snippet}{@render row(value)}<button onclick={(save) => save()}/><button onclick={() => {const save=()=>1;save();}}/>', 'Child.svelte': '<slot/>', 'helpers.ts': 'export function save(){}' });
  const graph = await index(root), save = named(graph, 'save');
  assert.equal(graph.relations.filter(item => item.type === 'calls' && item.to === save.id).length, 1);
  assert.ok(graph.entities.some(item => item.metadata.role === 'snippet'));
  assert.ok(graph.relations.some(item => item.type === 'calls' && graph.entities.some(entity => entity.id === item.to && entity.metadata.role === 'snippet')));
});

test('Svelte comments/raw text, type-only imports and mutated bindings do not invent components or handlers', async () => {
  const root = await repository({ 'App.svelte': '<script lang="ts">import type Child from "./Child.svelte"; import type {save} from "./helper"; import * as UI from "./types";</script><!-- <Child on:click={save}/> --><textarea>&lt;Child/&gt;</textarea><Child/><UI.Child/><button onclick={save}/>', 'Child.svelte': sfc, 'helper.ts': 'export function save(){}', 'types.ts': 'export type {default as Child} from "./Child.svelte";' });
  const graph = await index(root); assert.equal(graph.relations.some(item => item.type === 'renders'), false); assert.equal(graph.relations.some(item => item.type === 'calls' && item.to === named(graph, 'save').id), false);
});

test('Svelte parse failures, unsupported preprocessors and version profiles preserve explicit outcomes', async () => {
  const root = await repository({ 'Broken.svelte': '<script>import Child from "./Child.svelte";</script><Child>', 'Coffee.svelte': '<script lang="coffee">x = 1</script><Child/>', 'old/package.json': '{"dependencies":{"svelte":"^3.0.0"}}', 'old/Old.svelte': sfc, 'Child.svelte': sfc });
  const graph = await index(root); assert.ok(graph.diagnostics.some(item => item.code === 'svelte-parse-error')); assert.ok(graph.diagnostics.some(item => item.code === 'svelte-version-profile' && item.file === 'old/Old.svelte'));
  assert.equal(graph.relations.some(item => item.type === 'renders'), false);
  const broken = graph.entities.find(item => item.type === 'file' && item.path === 'Broken.svelte')!; assert.equal((broken.metadata.analysis as any).features.framework.status, 'failed');
});

test('Svelte 4 legacy callbacks and Svelte 5 lifecycle/effect callbacks preserve server/browser execution', async () => {
  const root = await repository({ 'App.svelte': '<script>import {onMount as mount,onDestroy} from "svelte"; import {save} from "./helper"; mount(save); onDestroy(() => save()); $effect(() => save()); $derived.by(() => save());</script><button onclick={save}/>', 'helper.ts': 'export function save(){return fetch("/items");}', 'src/routes/items/+server.ts': 'export function GET(){return new Response("ok");}', 'legacy/package.json': '{"dependencies":{"svelte":"^4.2.0"}}', 'legacy/App.svelte': '<script>function old(){return 1;}</script><button on:click={old}/>' });
  const graph = await index(root), callbacks = graph.entities.filter(item => item.metadata.svelteBrowserCallback);
  assert.ok(callbacks.some(item => item.name === 'onMount')); assert.ok(callbacks.some(item => item.name === '$effect')); assert.ok(callbacks.some(item => item.name === 'click event' && item.path === 'legacy/App.svelte'));
  assert.equal(named(graph, 'save').metadata.executionContext === 'browser', false);
  const requests = graph.relations.filter(item => item.type === 'requests'); assert.equal(requests.length, 3); assert.ok(requests.every(item => callbacks.some(callback => callback.id === item.from)));
});

test('Svelte direct template fetch/axios and contextual shared helper requests keep original evidence', async () => {
  const root = await repository({ 'package.json': manifest.replace('"vite"', '"axios":"^1.0.0","vite"'), 'src/routes/+page.svelte': '<script>import axios from "axios"; import {save} from "../../helper";</script><button onclick={() => fetch("/items")}/><button onclick={save}/><button onclick={() => axios.post("/items")}/><button onclick={(fetch) => fetch("/items")}/>', 'helper.ts': 'export function save(){return fetch("/items");}', 'src/routes/items/+server.ts': 'export function GET(){return new Response("ok");} export const POST=()=>new Response("ok");' });
  const graph = await index(root); assert.equal(graph.relations.filter(item => item.type === 'requests').length, 3); assert.ok(graph.relations.some(item => item.type === 'requests' && item.evidence.some(fact => fact.file === 'helper.ts')));
});

test('Kit paths expand optional params, route groups, zero-length rest/suffix and escapes with bounded constraints', () => {
  const route = kitPath('(app)/[[lang]]/files/[...rest]/end'); assert.equal(route.path, '/[[lang]]/files/[...rest]/end'); assert.deepEqual(route.groups, ['(app)']);
  for (const value of ['/files/end', '/en/files/a/b/end', '/files/a/end']) assert.equal(matchRoutePattern(route.pattern, value), true, value);
  assert.equal(matchRoutePattern(route.pattern, '/files/a/no'), false);
  assert.equal(kitPath('[...rest]/[[lang]]').pattern.status, 'partial'); assert.equal(kitPath('[id]/[id]').pattern.status, 'partial');
  const escaped = kitPath('smile-[u+d83d-de00]/[x+23]'); assert.equal(matchRoutePattern(escaped.pattern, '/smile-%F0%9F%98%80/%23'), true);
  assert.deepEqual(kitPath('[id=integer]').matchers, ['integer']);
});

test('Kit pages reach group layouts, layout loads and server loads; only HTTP exports become endpoints', async () => {
  const root = await repository({ 'src/routes/+layout.svelte': sfc, 'src/routes/+layout.ts': 'export const load=()=>({root:true});', 'src/routes/(app)/+layout.svelte': sfc, 'src/routes/(app)/[[lang]]/users/[id]/+page.svelte': sfc, 'src/routes/(app)/[[lang]]/users/[id]/+page.ts': 'export const load=()=>({value:true}); export const _helper=()=>1;', 'src/routes/(app)/[[lang]]/users/[id]/+page.server.ts': 'export async function load(){return {secret:true};} export function _privateHelper(){return 1;}', 'src/routes/api/[...path]/+server.ts': 'export function GET(){return new Response("ok");} export function _privateHelper(){return 2;}' });
  const graph = await index(root), page = pages(graph)[0]!; assert.equal(page.name, '/[[lang]]/users/[id]'); assert.deepEqual(page.metadata.groups, ['(app)']);
  const links = graph.relations.filter(item => item.type === 'routes_to' && item.from === page.id); assert.equal(links.filter(item => item.metadata?.role === 'layout').length, 2); assert.equal(links.filter(item => item.metadata?.role === 'universal-load').length, 2); assert.equal(links.filter(item => item.metadata?.role === 'server-load').length, 1);
  assert.equal(endpoints(graph).length, 1); assert.deepEqual((endpoints(graph)[0]!.metadata.routing as any).methods, ['GET', 'HEAD']);
});

test('Kit RequestEvent fetch aliases bind to registered load ownership; global server fetch stays unverified', async () => {
  const root = await repository({ 'src/routes/+page.svelte': sfc, 'src/routes/+page.server.ts': 'export const load=async ({fetch:request}) => {await request("/items"); return {};}; export function _helper(){return fetch("/items");}', 'src/routes/other/+page.svelte': sfc, 'src/routes/other/+page.ts': 'export async function load(event){const e=event; const {fetch:request}=e; await request("/items"); return {};}', 'src/routes/items/+server.ts': 'export function GET(){return new Response("ok");}' });
  const graph = await index(root), requests = graph.relations.filter(item => item.type === 'requests'); assert.equal(requests.length, 2); assert.ok(requests.every(item => item.metadata?.resolution === 'sveltekit-fetch'));
  assert.ok(requests.every(item => graph.entities.find(entity => entity.id === item.from)?.name === 'load')); assert.ok(graph.diagnostics.some(item => item.code === 'unverified-relative-api-boundary'));
});

test('Kit named/default POST actions are registered operations on page URLs, with query-sensitive HTTP matching', async () => {
  const root = await repository({ 'src/routes/login/+page.svelte': '<button onclick={() => fetch("/login?/login", {method:"POST"})}/><button onclick={() => fetch("/login?/logout", {method:"POST"})}/><button onclick={() => fetch("/login", {method:"POST"})}/>', 'src/routes/login/+page.server.ts': 'import {login} from "../../helper"; const logout=async()=>({ok:true}); export const actions={login,logout}; export const _privateExport=()=>1;', 'src/helper.ts': 'export async function login(){return {ok:true};}', 'src/routes/default/+page.svelte': '<button onclick={() => fetch("/default",{method:"POST"})}/>', 'src/routes/default/+page.server.ts': 'export const actions={default:async ({request})=>({ok:true})}; export const load=()=>({});' });
  const graph = await index(root); assert.deepEqual(endpoints(graph).map(item => item.name).sort(), ['POST /default', 'POST /login?/login', 'POST /login?/logout']);
  assert.ok(endpoints(graph).every(item => item.metadata.operationKind === 'form-action' && item.metadata.method === 'POST'));
  assert.equal(graph.relations.filter(item => item.type === 'requests').length, 3); assert.ok(graph.diagnostics.some(item => item.code === 'unmatched-http-call'));
  const login = endpoints(graph).find(item => item.metadata.actionName === 'login')!; assert.equal(graph.entities.find(item => item.id === graph.relations.find(relation => relation.from === login.id && relation.type === 'routes_to')!.to)!.path, 'src/helper.ts');
});

test('Invalid, mutable, dynamic and type-only Kit registrations stay unbound with action/version gaps', async () => {
  const root = await repository({ 'src/routes/+page.svelte': sfc, 'src/routes/+page.server.ts': 'export const actions={default:()=>1,named:()=>2};', 'src/routes/mutated/+page.svelte': sfc, 'src/routes/mutated/+page.server.ts': 'export const actions={save:()=>1}; actions.save=()=>2;', 'src/routes/typed/+server.ts': 'export type {handler as GET} from "../../handler";', 'src/handler.ts': 'export function handler(){}', 'src/routes/dynamic/+server.ts': 'export const GET=makeHandler();', 'future/package.json': '{"dependencies":{"svelte":"^5.0.0","@sveltejs/kit":"^4.0.0"}}', 'future/src/routes/+page.svelte': sfc });
  const graph = await index(root); assert.equal(endpoints(graph).length, 0); assert.ok(graph.diagnostics.some(item => item.code === 'sveltekit-action-gap')); assert.ok(graph.diagnostics.some(item => item.code === 'sveltekit-version-profile'));
});

test('Kit v2 static custom route/lib/params/base/alias configuration resolves indexed components without executing config', async () => {
  const root = await repository({ 'svelte.config.js': 'throw new Error("never execute"); const dirs={routes:"pages",lib:"lib",params:"matchers"}; export default {kit:{files:dirs,paths:{base:"/base"},alias:{"@ui":"lib"}}};', 'pages/+page.svelte': '<script lang="ts">import Child from "$lib/Child.svelte"; import {save} from "@ui/helper"; import type {PageData} from "./$types";</script><Child/><button onclick={save}/>', 'lib/Child.svelte': sfc, 'lib/helper.ts': 'export function save(){return 1;}', 'pages/api/+server.ts': 'export function GET(){return new Response("ok");}', 'src/routes/ignored/+page.svelte': sfc });
  const graph = await index(root); assert.deepEqual(pages(graph).map(item => item.name), ['/base/']); assert.equal(endpoints(graph)[0]!.name, 'GET /base/api'); assert.equal(graph.relations.filter(item => item.type === 'renders').length, 1); assert.equal(graph.diagnostics.some(item => item.code === 'unresolved-local-import'), false);
});

test('Kit v3 static Vite plugin options and package #lib imports resolve the migrated profile', async () => {
  const root = await repository({ 'package.json': '{"dependencies":{"svelte":"^5.57.2","@sveltejs/kit":"^3.0.1","vite":"^8.0.12"},"imports":{"#lib/*":"./src/lib/*"}}', 'vite.config.ts': 'import {sveltekit as kit} from "@sveltejs/kit/vite"; import {defineConfig} from "vite"; export default defineConfig({plugins:[kit({files:{routes:"pages"},paths:{base:"/v3"}})]});', 'pages/+page.svelte': '<script>import Child from "#lib/Child.svelte"; import {browser} from "$app/env";</script><Child/>', 'pages/+page.ts': 'export const ssr=false;', 'pages/+page.server.ts': 'export const ssr=true;', 'src/lib/Child.svelte': sfc, 'pages/api/+server.ts': 'export function GET(){return new Response("ok");}' });
  const graph = await index(root); assert.equal(pages(graph)[0]!.metadata.profile, 'sveltekit-3'); assert.equal(pages(graph)[0]!.name, '/v3/'); assert.equal(pages(graph)[0]!.metadata.executionContext, 'browser'); assert.equal(graph.relations.filter(item => item.type === 'renders').length, 1);
});

test('Dynamic config, unregistered Vite plugins and legacy v3 config never fall back to invented default routes', async () => {
  const cases: Record<string, string>[] = [{ 'svelte.config.js': 'export default {kit:{files:{routes:process.env.ROUTES}}};' }, { 'package.json': manifest.replace('^2.62.0', '^3.0.1'), 'vite.config.ts': 'function sveltekit(x){return x;} export default {plugins:[sveltekit({})]};' }, { 'package.json': manifest.replace('^2.62.0', '^3.0.1'), 'svelte.config.js': 'export default {kit:{}};' }];
  for (const files of cases) {
    const graph = await index(await repository({ 'src/routes/+page.svelte': sfc, ...files })); assert.equal(pages(graph).length, 0); assert.ok(graph.diagnostics.some(item => item.code === 'sveltekit-config-gap'));
  }
});

test('Matcher, hooks, route collisions and page/server negotiation remain constrained HTTP candidates', async () => {
  const root = await repository({ 'src/routes/item/[id=integer]/+server.ts': 'export function GET(){return new Response("ok");}', 'src/params/integer.ts': 'export const match=(value)=>/^\\d+$/.test(value);', 'src/hooks.server.ts': 'export const handle=async ({event,resolve})=>resolve(event);', 'src/routes/both/+page.svelte': sfc, 'src/routes/both/+server.ts': 'export function GET(){return new Response("ok");}', 'src/routes/(one)/same/+page.svelte': sfc, 'src/routes/(two)/same/+page.svelte': sfc, 'App.svelte': '<button onclick={() => fetch("/item/1")}/><button onclick={() => fetch("/both")}/>' });
  const graph = await index(root); assert.equal(graph.relations.some(item => item.type === 'requests'), false); assert.ok(endpoints(graph).every(item => item.metadata.constraintsUnresolved)); assert.ok(pages(graph).filter(item => item.name === '/same').every(item => item.metadata.constraintsUnresolved)); assert.ok(graph.diagnostics.some(item => item.code === 'sveltekit-matcher-gap')); assert.ok(graph.diagnostics.some(item => item.code === 'sveltekit-hook-gap'));
});

test('Kit root layout resets and browser-only load options have bounded source-backed links', async () => {
  const root = await repository({ 'src/routes/+layout.svelte': sfc, 'src/routes/(app)/+layout.svelte': sfc, 'src/routes/(app)/deep/+page@.svelte': sfc, 'src/routes/(app)/deep/+page.ts': 'export const ssr=false; export const load=({fetch})=>fetch("/items");', 'src/routes/items/+server.ts': 'export function GET(){return new Response("ok");}' });
  const graph = await index(root), page = pages(graph)[0]!; const layouts = graph.relations.filter(item => item.from === page.id && item.type === 'routes_to' && item.metadata?.role === 'layout'); assert.equal(layouts.length, 1); assert.equal(graph.entities.find(item => item.id === layouts[0]!.to)!.path, 'src/routes/+layout.svelte'); assert.equal(named(graph, 'load').metadata.executionContext, 'browser');
});

test('Kit cold/warm/revision replay, line-stable identities and config/consumer invalidation are equivalent', async () => {
  const root = await repository({ 'src/routes/+page.svelte': '<script>import {save} from "$lib/helper";</script><button onclick={save}/>', 'src/lib/helper.ts': 'export function save(){return fetch("/items");}', 'src/routes/items/+server.ts': 'export function GET(){return new Response("ok");}' }), state = await mkdtemp(path.join(tmpdir(), 'codiluce-svelte-cache-')); temporary.push(state); const cache = new AnalysisCache(state);
  const cold = await index(root, cache); assert.equal(stored(await index(root, cache)), stored(cold)); assert.equal(stored(await index(root, cache, 'revision')), stored(cold));
  const before = cold.entities.filter(item => item.metadata.svelteBrowserCallback).map(item => item.id);
  await writeFile(path.join(root, 'src/routes/+page.svelte'), '\n\n<script>import {save} from "$lib/helper";</script><button onclick={save}/>'); const moved = await index(root, cache); assert.deepEqual(moved.entities.filter(item => item.metadata.svelteBrowserCallback).map(item => item.id), before); assert.equal(stored(moved), stored(await index(root)));
  await writeFile(path.join(root, 'svelte.config.js'), 'export default {kit:{paths:{base:"/base"}}};'); assert.equal(stored(await index(root, cache)), stored(await index(root)));
});

test('Kit page → child → browser event → HTTP endpoint → handler appears in the existing flow catalog', async () => {
  const root = await repository({ 'src/routes/(app)/nested/+page.svelte': '<script>import Child from "$lib/Child.svelte";</script><Child/>', 'src/lib/Child.svelte': '<script>function save(){return fetch("/items");}</script><button onclick={save}/>', 'src/routes/items/+server.ts': 'export function GET(){return new Response("ok");}' });
  const graph = await index(root), store = new GraphStore(':memory:');
  try { store.save(graph); const projection = new ProjectionService(store, { root }), page = pages(graph)[0]!, handler = named(graph, 'GET'); const flow = projection.flows({ entity: handler.id }).items.find(item => item.entry.id === page.id); assert.ok(flow); assert.equal(flow.kind, 'page'); const requests = projection.requestFlows({ entity: named(graph, 'save').id }); assert.ok(requests.items.length); const detail = await projection.requestFlow(requests.items[0]!.id, { maxFileBytes: 1 << 20 }); assert.ok(JSON.stringify(detail).includes('click')); } finally { store.close(); }
});

test('Deferred snippets, factories, nested lifecycle registrations and mutable component/callback aliases retain invocation boundaries', async () => {
  const root = await repository({ 'App.svelte': '<script>import Child from "./Child.svelte"; import {save} from "./helper"; import {onMount} from "svelte"; let Selected=Child; const factory=()=>{onMount(save);}; function make(){return save;}</script><Selected/>{#snippet unused()}<button onclick={save}/>{/snippet}<button onclick={make()}/>', 'Child.svelte': sfc, 'helper.ts': 'export function save(){return fetch("/items");}', 'src/routes/items/+server.ts': 'export function GET(){return new Response("ok");}' });
  const graph = await index(root), app = components(graph).find(item => item.path === 'App.svelte')!;
  assert.equal(graph.relations.some(item => item.type === 'renders' && item.from === app.id), false);
  const snippet = graph.entities.find(item => item.metadata.role === 'snippet')!; assert.equal(graph.relations.some(item => item.from === app.id && item.to === snippet.id && item.type !== 'contains'), false);
  const mount = named(graph, 'onMount'), factory = named(graph, 'factory'); assert.equal(mount.parentId, factory.id);
  assert.equal(graph.entities.filter(item => item.metadata.svelteBrowserCallback).length, 2);
  assert.ok(graph.diagnostics.some(item => item.code === 'svelte-template-gap' && item.reason.includes('evaluated during rendering')));
});

test('Mixed event syntaxes fail qualification, and scriptless literal events advertise partial effects', async () => {
  const root = await repository({ 'Mixed.svelte': '<button on:click={()=>1}/><button onclick={()=>2}/>', 'Valid.svelte': '<button onclick={()=>fetch("/items")}/>', 'src/routes/items/+server.ts': 'export function GET(){return new Response("ok");}' });
  const graph = await index(root); assert.ok(graph.diagnostics.some(item => item.code === 'svelte-event-syntax')); assert.equal(graph.entities.some(item => item.metadata.svelteBrowserCallback && item.path === 'Mixed.svelte'), false);
  const valid = graph.entities.find(item => item.type === 'file' && item.path === 'Valid.svelte')!; assert.equal((valid.metadata.analysis as any).features.effects.status, 'partial');
});

test('Kit plain fetch parameters, event aliases, shadowed and overwritten receivers require exact framework evidence', async () => {
  const root = await repository({ 'src/routes/+page.svelte': sfc, 'src/routes/+page.ts': 'export const load=({fetch})=>fetch("/items");', 'src/routes/mutated/+page.svelte': sfc, 'src/routes/mutated/+page.ts': 'export function load(event){event.fetch=custom; return event.fetch("/items");}', 'src/routes/escaped/+page.svelte': sfc, 'src/routes/escaped/+page.ts': 'export function load(event){configure(event); return event.fetch("/items");}', 'src/routes/shadowed/+page.svelte': sfc, 'src/routes/shadowed/+page.ts': 'export function load({fetch:request}){function other(request){return request("/items");}return {};}', 'src/routes/items/+server.ts': 'export function GET(){return new Response("ok");}' });
  const graph = await index(root); const requests = graph.relations.filter(item => item.type === 'requests'); assert.equal(requests.length, 1); assert.equal(graph.entities.find(item => item.id === requests[0]!.from)!.path, 'src/routes/+page.ts'); assert.equal(requests[0]!.metadata?.resolution, 'sveltekit-fetch');
});

test('Kit GET handles implicit HEAD while explicit HEAD and fallback including OPTIONS keep distinct handler ownership', async () => {
  const root = await repository({ 'src/routes/items/+server.ts': 'export const GET=()=>new Response("get");export const HEAD=()=>new Response(null);export const fallback=()=>new Response("fallback");', 'App.svelte': '<button onclick={()=>fetch("/items",{method:"GET"})}/><button onclick={()=>fetch("/items",{method:"HEAD"})}/><button onclick={()=>fetch("/items",{method:"OPTIONS"})}/>' });
  const graph = await index(root); assert.equal(endpoints(graph).length, 3); const requests = graph.relations.filter(item => item.type === 'requests'); assert.equal(requests.length, 3); assert.deepEqual(requests.map(item => graph.entities.find(entity => entity.id === item.to)!.metadata.method).sort(), ['*', 'GET', 'HEAD']);
});

test('Kit nested layout resets skip excluded layout loads/options without applying layout flags to standalone endpoints', async () => {
  const root = await repository({ 'src/routes/+layout.svelte': sfc, 'src/routes/+layout.ts': 'export const load=()=>({root:true});', 'src/routes/(app)/+layout.svelte': sfc, 'src/routes/(app)/+layout.ts': 'export const load=()=>({skipped:true});export const csr=false;export const prerender=true;', 'src/routes/(app)/item/+layout@.svelte': sfc, 'src/routes/(app)/item/deep/+page.svelte': sfc, 'src/routes/(app)/api/+server.ts': 'export const POST=()=>new Response("ok");' });
  const graph = await index(root), page = pages(graph)[0]!;
  const loads = graph.relations.filter(item => item.from === page.id && item.metadata?.role === 'universal-load').map(item => graph.entities.find(entity => entity.id === item.to)!.path); assert.deepEqual(loads, ['src/routes/+layout.ts']); assert.equal((page.metadata.options as any).csr, undefined); assert.equal(endpoints(graph)[0]!.metadata.constraintsUnresolved, false);
});

test('Kit v3 package image imports resolve actual indexed assets and missing assets remain unresolved', async () => {
  const root = await repository({ 'package.json': '{"dependencies":{"svelte":"^5.57.2","@sveltejs/kit":"^3.0.1"},"imports":{"#lib/*":"./src/lib/*"}}', 'vite.config.js': 'import {sveltekit} from "@sveltejs/kit/vite"; export default {plugins:[sveltekit()]};', 'src/routes/+page.svelte': '<script>import logo from "#lib/logo.svg";import missing from "#lib/missing.svg";</script><img src={logo}/>', 'src/lib/logo.svg': '<svg/>' });
  const graph = await index(root); assert.ok(graph.relations.some(item => item.type === 'imports' && graph.entities.find(entity => entity.id === item.to)!.path === 'src/lib/logo.svg')); assert.equal(graph.diagnostics.filter(item => item.code === 'unresolved-local-import').length, 1);
});

test('Two Kit applications registering a shared load retain separate RequestEvent and cache ownership', async () => {
  const files: Record<string, string> = { 'package.json': '{"workspaces":["ui-one","ui-two","shared"]}', 'shared/package.json': '{"name":"@shared/load","version":"1.0.0","exports":"./load.ts"}', 'shared/load.ts': 'export const sharedLoad=({fetch})=>fetch("/items");' };
  for (const app of ['ui-one', 'ui-two']) Object.assign(files, { [`${app}/package.json`]: '{"dependencies":{"svelte":"^5.57.2","@sveltejs/kit":"^2.62.0","@shared/load":"workspace:*"}}', [`${app}/src/routes/+page.svelte`]: sfc, [`${app}/src/routes/+page.ts`]: 'export {sharedLoad as load} from "@shared/load";', [`${app}/src/routes/items/+server.ts`]: 'export function GET(){return new Response("ok");}' });
  const root = await repository(files), state = await mkdtemp(path.join(tmpdir(), 'codiluce-kit-shared-cache-')); temporary.push(state); const cache = new AnalysisCache(state), apps: ApplicationInput[] = [{ name: 'one', path: 'ui-one' }, { name: 'two', path: 'ui-two' }];
  const graph = await index(root, cache, undefined, apps), invocations = graph.entities.filter(item => item.metadata.svelteKitInvocation); assert.equal(invocations.length, 2); assert.notEqual(named(graph, 'sharedLoad').metadata.executionContext, 'server');
  for (const invocation of invocations) { const request = graph.relations.find(item => item.type === 'requests' && item.from === invocation.id)!; assert.ok(request); const endpoint = graph.entities.find(item => item.id === request.to)!; assert.equal(endpoint.path?.startsWith(invocation.metadata.executionApplication === 'one' ? 'ui-one/' : 'ui-two/'), true); assert.ok(request.evidence.some(fact => fact.file === 'shared/load.ts')); }
  assert.equal(stored(await index(root, cache, undefined, apps)), stored(graph)); assert.equal(stored(await index(root, cache, 'revision', apps)), stored(graph));
});

test('Type-only star exports cannot expose Kit HTTP handlers through compiler-flattened barrels', async () => {
  const root = await repository({ 'src/routes/type/+server.ts': 'export type * from "../../handler";', 'src/handler.ts': 'export function GET(){return new Response("ok");}' });
  const graph = await index(root); assert.equal(endpoints(graph).length, 0);
});
