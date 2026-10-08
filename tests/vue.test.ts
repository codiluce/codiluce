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
import { SourceText } from '../src/analysis/source-map.js';
import { vueTemplateSites } from '../src/analysis/frameworks/vue-template.js';
import { GraphStore } from '../src/storage/sqlite.js';
import { ProjectionService } from '../src/projection/service.js';

const temporary: string[] = [];
after(async () => { await Promise.all(temporary.map(root => rm(root, { recursive: true, force: true }))); });
const manifest = JSON.stringify({ dependencies: { vue: '^3.5.0', 'vue-router': '^4.5.0' } });
async function repository(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'codiluce-vue-')); temporary.push(root);
  for (const [file, text] of Object.entries({ 'package.json': manifest, ...files })) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); } return root;
}
async function index(root: string, cache?: AnalysisCache, revision?: string, applications: ApplicationInput[] = [{ name: 'ui', path: '.', frameworks: ['vue'] }]) { return indexRepository(root, { config: await resolveConfig(root, { repository: { name: 'vue' }, applications }), cache, revision }); }
const stored = (graph: SoftwareGraph) => canonicalJson({ entities: graph.entities, relations: graph.relations, diagnostics: graph.diagnostics.filter(item => !['git-metrics', 'indexer'].includes(item.analyzer) && item.code !== 'git-ignore-unavailable') });
const components = (graph: SoftwareGraph) => graph.entities.filter(item => item.type === 'component' && item.language === 'vue');
const routes = (graph: SoftwareGraph) => graph.entities.filter(item => item.type === 'route' && item.metadata.framework === 'vue-router');
const named = (graph: SoftwareGraph, name: string) => graph.entities.find(item => item.name === name)!;
const sfc = '<template><span/></template>';
const install = 'import { createApp } from "vue"; import App from "./App.vue"; import router from "./router"; createApp(App).use(router).mount("#app");';
const router = (records: string, imports = '') => `import { createRouter, createWebHistory } from "vue-router"; ${imports} export default createRouter({ history: createWebHistory(), routes: ${records} });`;

test('Vue lexer ignores comment/raw/v-pre content, preserves UTF-16 ranges and tracks loop/slot locals', () => {
  const text = '<!-- <False @click="fake()"/> --><div>😀<Real @click.stop="save"/><template v-for="(save, i) in rows"><Real @click="save()"/></template><Slot v-slot="{save}"><Real @click="save()"/></Slot><div v-pre><False @click="fake()"/></div><textarea><False/></textarea>{{ "<False/>" }}</div>';
  const sites = vueTemplateSites(text, 0, text.length); assert.equal(sites.filter(site => site.kind === 'event').length, 3);
  assert.deepEqual(sites.filter(site => site.kind === 'event').map(site => site.locals), [[], ['save', 'i'], ['save']]);
  assert.equal(sites.some(site => site.name === 'False'), false); const real = sites.find(site => site.name === 'Real')!;
  assert.equal(new SourceText(text).range(real.start, real.end).startColumn, text.indexOf('<Real') + 1);
});

test('Vue script setup resolves aliases, kebab-case, namespace barrels, self recursion and callback helpers', async () => {
  const root = await repository({ 'tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}', 'src/App.vue': '<script setup lang="ts">import ChildCard from "@/Child.vue"; import * as Forms from "./barrel"; import { save as handler } from "./helpers";</script>\r\n<template><ChildCard/><child-card/><Forms.Child/><App/><button @click.stop="handler"/><button @click="() => handler()"/></template>', 'src/Child.vue': sfc, 'src/barrel.ts': 'export { default as Child } from "./Child.vue";', 'src/helpers.ts': 'export function save() { return 1; }' });
  const graph = await index(root), app = components(graph).find(item => item.path === 'src/App.vue')!, child = components(graph).find(item => item.path === 'src/Child.vue')!, save = named(graph, 'save');
  const renders = graph.relations.find(item => item.from === app.id && item.to === child.id && item.type === 'renders')!; assert.equal(renders.evidence.length, 3);
  assert.ok(graph.relations.some(item => item.from === app.id && item.to === app.id && item.type === 'renders'));
  const events = graph.entities.filter(item => item.metadata.vueTemplateEvent); assert.equal(events.length, 2); assert.ok(events.every(event => event.sourceRange?.startLine === 2 && event.metadata.executionContext === 'browser'));
  assert.equal(graph.relations.filter(item => item.type === 'calls' && events.some(event => event.id === item.from) && item.to === save.id).length, 2);
  assert.equal(graph.entities.some(item => item.path?.includes('.__codiluce_')), false);
  const childFile = graph.entities.find(item => item.type === 'file' && item.path === 'src/Child.vue')!; assert.equal((childFile.metadata.analysis as any).features.references.status, 'partial');
});

test('Vue Options API components/methods and Composition setup returns use exact original declarations', async () => {
  const root = await repository({ 'App.vue': '<script lang="ts">import { defineComponent as define } from "vue"; import Child from "./Child.vue"; import { leaf } from "./helpers"; export default define({ components: { Registered: Child }, methods: { save() { return leaf(); }, click: () => leaf() }, setup() { function compose() { return leaf(); } return { compose, Child }; } });</script><template><Registered/><Child/><button @click="save"/><button @click="click()"/><button @click="compose()"/></template>', 'Child.vue': sfc, 'helpers.ts': 'export function leaf() { return 1; }' });
  const graph = await index(root), app = components(graph).find(item => item.path === 'App.vue')!, child = components(graph).find(item => item.path === 'Child.vue')!, leaf = named(graph, 'leaf');
  assert.equal(graph.relations.find(item => item.type === 'renders' && item.from === app.id && item.to === child.id)!.evidence.length, 2);
  for (const name of ['save', 'click', 'compose']) { const method = named(graph, name); assert.ok(method, name); assert.ok(graph.relations.some(item => item.type === 'calls' && item.to === method.id && graph.entities.some(event => event.id === item.from && event.metadata.vueTemplateEvent)), name); assert.ok(graph.relations.some(item => item.type === 'calls' && item.from === method.id && item.to === leaf.id), name); }
});

test('Module imports are private unless Options registers them; type-only and local fake defineComponent do not qualify', async () => {
  const root = await repository({ 'App.vue': '<script lang="ts">import Hidden from "./Child.vue"; export default { methods: { save() {} } };</script><template><Hidden/></template>', 'Fake.vue': '<script>function defineComponent(x) { return x; } export default defineComponent({components:{Hidden:null},methods:{save(){}}});</script><template><Hidden/><button @click="save"/></template>', 'Typed.vue': '<script setup lang="ts">import type Child from "./Child.vue"; import type { save } from "./helper";</script><template><Child/><button @click="save()"/></template>', 'Child.vue': sfc, 'helper.ts': 'export function save() {}' });
  const graph = await index(root); assert.equal(graph.relations.some(item => item.type === 'renders'), false); assert.equal(graph.relations.some(item => item.type === 'calls' && graph.entities.some(event => event.id === item.from && event.metadata.vueTemplateEvent)), false);
  assert.ok(graph.diagnostics.some(item => item.code === 'vue-template-gap' && item.file === 'Fake.vue'));
});

test('Template loop/slot/arrow/block shadowing suppresses unrelated helpers and v-pre disables binding', async () => {
  const root = await repository({ 'App.vue': '<script setup>import { save } from "./helper";</script><template><div v-for="save in rows"><button @click="save()"/></div><div v-slot="{ save }"><button @click="save()"/></div><button @click="save => save()"/><button @click="() => { const save = () => 1; save(); }"/><div v-pre><button @click="save()"/></div></template>', 'helper.ts': 'export function save() {}' });
  const graph = await index(root), save = named(graph, 'save'); assert.equal(graph.relations.some(item => item.type === 'calls' && item.to === save.id), false); assert.equal(graph.entities.filter(item => item.metadata.vueTemplateEvent).length, 4);
});

test('Malformed/preprocessed/exporting setup/unsupported version components do not invent template edges', async () => {
  const root = await repository({ 'Child.vue': sfc, 'Pug.vue': '<script setup>import Child from "./Child.vue";</script><template lang="pug"><Child/></template>', 'Invalid.vue': '<script setup>import Child from "./Child.vue"; export function save() {}</script><template><Child/></template>', 'Broken.vue': '<script setup>import Child from "./Child.vue";</script><template><Child>', 'Encoded.vue': '<script setup>import { save } from "./helper";</script><template><button @click="save(&quot;value&quot;)"/></template>', 'helper.ts': 'export function save() {}', 'legacy/package.json': '{"dependencies":{"vue":"^2.7.0"}}', 'legacy/Legacy.vue': '<script>export default { methods: { save() {} } };</script><template><button @click="save"/></template>' });
  const graph = await index(root, undefined, undefined, [{ name: 'ui', path: '.', frameworks: ['vue'] }, { name: 'legacy', path: 'legacy', frameworks: ['vue'] }]); assert.equal(graph.relations.some(item => item.type === 'renders'), false); assert.equal(graph.entities.some(item => item.metadata.vueTemplateEvent), false); assert.ok(graph.diagnostics.some(item => item.code === 'vue-version-profile' && item.file === 'legacy/Legacy.vue'));
});

test('Vue Router imported records, nested/reset/empty paths, named views, literal lazy imports and aliases reach components', async () => {
  const root = await repository({ 'main.ts': install, 'App.vue': '<template><RouterView/></template>', 'Child.vue': sfc, 'Layout.vue': sfc, 'Other.vue': sfc, 'router.ts': router('records', 'import records from "./records";'), 'records.ts': 'import Layout from "./Layout.vue"; import Other from "./Other.vue"; const records = [{path:"/users/:id",component:Layout,children:[{path:"",name:"user",component:()=>import("./Child.vue")},{path:"edit",components:{default:()=>import("./Child.vue"),sidebar:Other}},{path:"/absolute",component:Other}]},{path:"/alias",alias:["/also"],component:Other}]; export default records;' });
  const graph = await index(root); assert.deepEqual(routes(graph).map(item => item.name).sort(), ['/absolute', '/alias', '/also', '/users/:id', '/users/:id', '/users/:id/edit']);
  const edit = routes(graph).find(item => item.name.endsWith('/edit'))!, targets = graph.relations.filter(item => item.from === edit.id && item.type === 'routes_to').map(item => graph.entities.find(entity => entity.id === item.to)!.path);
  assert.deepEqual(targets.sort(), ['App.vue', 'Child.vue', 'Layout.vue', 'Other.vue']); assert.equal(edit.path, 'records.ts'); assert.equal(graph.entities.some(item => item.type === 'api_endpoint'), false);
  assert.ok(graph.relations.some(item => item.from === edit.id && item.metadata?.view === 'sidebar'));
});

test('Static redirects bind unique names/paths and do not render the redirect source component', async () => {
  const root = await repository({ 'main.ts': install, 'App.vue': sfc, 'Child.vue': sfc, 'router.ts': router('[{path:"/target",name:"target",component:Child},{path:"/old",redirect:{name:"target"},component:Child},{path:"/older",redirect:"/target"},{path:"/dynamic",redirect:to=>to.path}]', 'import Child from "./Child.vue";') });
  const graph = await index(root), target = routes(graph).find(item => item.name === '/target')!;
  for (const name of ['/old', '/older']) { const route = routes(graph).find(item => item.name === name)!; const links = graph.relations.filter(item => item.from === route.id && item.type === 'routes_to'); assert.equal(links.length, 1); assert.equal(links[0]!.to, target.id); assert.equal(links[0]!.metadata?.role, 'redirect'); }
  assert.ok(graph.diagnostics.some(item => item.code === 'vue-router-redirect-gap'));
  await writeFile(path.join(root, 'router.ts'), router('[{path:"/one",name:"same",component:Child},{path:"/two",name:"same",component:Child},{path:"/old",redirect:{name:"same"}}]', 'import Child from "./Child.vue";'));
  const conflicting = await index(root); assert.equal(routes(conflicting).length, 0); assert.ok(conflicting.diagnostics.some(item => item.code === 'vue-router-name-collision'));
});

test('Uninstalled, type-only, conditional and spelling-only router instances produce no flow roots', async () => {
  const root = await repository({ 'App.vue': sfc, 'Child.vue': sfc, 'router.ts': router('[{path:"/hidden",component:Child}]', 'import Child from "./Child.vue";'), 'fake.ts': 'import { createApp } from "vue"; import App from "./App.vue"; function createRouter(config) { return config; } const router=createRouter({routes:[{path:"/fake",component:App}]}); createApp(App).use(router);', 'typed.ts': 'import type { createRouter, createWebHistory } from "vue-router"; import { createApp } from "vue"; import App from "./App.vue"; const router=createRouter({history:createWebHistory(),routes:[{path:"/typed",component:App}]}); createApp(App).use(router);', 'conditional.ts': 'import { createApp } from "vue"; import App from "./App.vue"; import router from "./router"; if (enabled) createApp(App).use(router);' });
  const graph = await index(root); assert.equal(routes(graph).length, 0); assert.ok(graph.diagnostics.some(item => item.code === 'vue-router-uninstalled'));
});

test('Mutated routes, excluded components, dynamic arrays/loaders and unsupported router versions stay visible', async () => {
  const root = await repository({ 'main.ts': install, 'App.vue': sfc, 'Child.vue': sfc, 'router.ts': router('records', 'import Child from "./Child.vue"; const records=[{path:"/stale",component:Child}]; records.push(extra);') });
  let graph = await index(root); assert.equal(routes(graph).length, 0); assert.ok(graph.diagnostics.some(item => item.code === 'vue-router-record-gap'));
  await writeFile(path.join(root, 'router.ts'), router('[{path:"/computed",component:()=>import(target)},{path:"/excluded",component:()=>import("./Excluded.vue")}]')); await writeFile(path.join(root, 'Excluded.vue'), 'x'.repeat(1_600_000));
  graph = await index(root); assert.equal(routes(graph).length, 2); assert.equal(graph.relations.some(item => item.type === 'routes_to' && item.metadata?.role === 'view'), false); assert.ok(graph.diagnostics.some(item => item.code === 'vue-router-component-gap'));
  await writeFile(path.join(root, 'package.json'), '{"dependencies":{"vue":"^3.5.0","vue-router":"^6.0.0"}}'); graph = await index(root); assert.equal(routes(graph).length, 0); assert.ok(graph.diagnostics.some(item => item.code === 'vue-router-version-profile'));
});

test('Dynamic history bases retain logical paths with a constraint, while static history bases preserve public paths', async () => {
  const root = await repository({ 'main.ts': install, 'App.vue': sfc, 'Child.vue': sfc, 'router.ts': router('[{path:"/page",component:Child}]', 'import Child from "./Child.vue";').replace('createWebHistory()', 'createWebHistory(import.meta.env.BASE_URL)') });
  let graph = await index(root), page = routes(graph)[0]!; assert.equal(page.name, '/page'); assert.equal(page.metadata.historyBaseUnresolved, true); assert.equal(page.metadata.publicPath, undefined);
  await writeFile(path.join(root, 'router.ts'), router('[{path:"/page",component:Child}]', 'import Child from "./Child.vue";').replace('createWebHistory()', 'createWebHistory("/base/")'));
  graph = await index(root); page = routes(graph)[0]!; assert.equal(page.metadata.publicPath, '/base/page');
});

test('Vue event callbacks reach backend origins and browser proxies without converting shared SSR functions to browser declarations', async () => {
  const root = await repository({ 'main.ts': install, 'App.vue': '<script setup>import { save } from "./helper"; const request = fetch;</script><template><button @click="save"/><button @click="request(\'/direct\')"/><button @click="fetch(\'/invalid\')"/></template>', 'router.ts': router('[{path:"/",component:App}]', 'import App from "./App.vue";'), 'helper.ts': 'export function save() { return fetch("/items"); }', 'api/package.json': '{"dependencies":{"express":"^5.1.0"}}', 'api/main.ts': 'import express from "express"; const app=express(); app.get("/items",()=>1); app.get("/direct",()=>2); app.get("/invalid",()=>3);' });
  const graph = await index(root, undefined, undefined, [{ name: 'ui', path: '.', frameworks: ['vue'], apiProxies: [{ pathPrefix: '/', target: 'api' }] }, { name: 'api', path: 'api', apiOrigins: ['https://api.example'] }]);
  const events = graph.entities.filter(item => item.metadata.vueTemplateEvent), requests = graph.relations.filter(item => item.type === 'requests' && events.some(event => item.from === event.id));
  assert.equal(requests.length, 2); assert.deepEqual(requests.map(item => graph.entities.find(entity => entity.id === item.to)!.metadata.routePath).sort(), ['/direct', '/items']); assert.notEqual(named(graph, 'save').metadata.executionContext, 'browser');
  assert.ok(graph.relations.some(item => item.type === 'routes_to' && item.to === components(graph).find(item => item.path === 'App.vue')!.id));
});

test('Original event ranges, duplicate callbacks, warm/revision replay and helper edits preserve ownership and line identities', async () => {
  const text = '<script setup>import { save } from "./helper";</script>\r\n<template>😀<button @click="save()"/><button @click="save()"/></template>';
  const root = await repository({ 'main.ts': install, 'App.vue': text, 'router.ts': router('[{path:"/",component:App}]', 'import App from "./App.vue";'), 'helper.ts': 'export function save() { return 1; }' }), cacheRoot = await mkdtemp(path.join(tmpdir(), 'codiluce-vue-cache-')); temporary.push(cacheRoot); const cache = new AnalysisCache(cacheRoot);
  const cold = await index(root, cache), eventIds = cold.entities.filter(item => item.metadata.vueTemplateEvent).map(item => item.id).sort(), routeIds = routes(cold).map(item => item.id).sort(); assert.equal(eventIds.length, 2); assert.notEqual(eventIds[0], eventIds[1]); assert.equal(stored(await index(root, cache)), stored(cold)); assert.equal(stored(await index(root, cache, 'fixture-revision')), stored(cold));
  await writeFile(path.join(root, 'App.vue'), '\n' + text); await writeFile(path.join(root, 'main.ts'), '\n' + install); let graph = await index(root, cache); assert.deepEqual(graph.entities.filter(item => item.metadata.vueTemplateEvent).map(item => item.id).sort(), eventIds); assert.deepEqual(routes(graph).map(item => item.id).sort(), routeIds); assert.ok(graph.entities.filter(item => item.metadata.vueTemplateEvent).every(item => item.sourceRange!.startLine === 3));
  await writeFile(path.join(root, 'helper.ts'), 'export function changed() {}'); graph = await index(root, cache); assert.equal(graph.relations.some(item => item.type === 'calls' && eventIds.includes(item.from)), false); assert.equal(stored(graph), stored(await index(root)));
});

test('Two app instances installing one router retain independent route identities', async () => {
  const root = await repository({ 'main.ts': 'import { createApp } from "vue"; import App from "./App.vue"; import router from "./router"; createApp(App).use(router); createApp(App).use(router);', 'App.vue': sfc, 'router.ts': router('[{path:"/",component:App}]', 'import App from "./App.vue";') });
  const graph = await index(root); assert.equal(routes(graph).length, 2); assert.notEqual(routes(graph)[0]!.id, routes(graph)[1]!.id);
});

test('Imported barrel APIs and const spreads work while mutations through aliases and unknown helpers suppress stale records', async () => {
  const root = await repository({ 'main.ts': install, 'App.vue': sfc, 'Child.vue': sfc, 'api.ts': 'export { createRouter as makeRouter, createWebHistory as history } from "vue-router";', 'router.ts': 'import {makeRouter,history} from "./api"; import Child from "./Child.vue"; const base={component:Child}; const first=[{...base,path:"/ok"}]; const records=[...first]; export default makeRouter({history:history(),routes:records});' });
  assert.deepEqual(routes(await index(root)).map(item => item.name), ['/ok']);
  await writeFile(path.join(root, 'router.ts'), router('records', 'import Child from "./Child.vue"; const records=[{path:"/stale",component:Child}]; const alias=records; alias[0].path="/changed";')); assert.equal(routes(await index(root)).length, 0);
  await writeFile(path.join(root, 'router.ts'), router('records', 'import Child from "./Child.vue"; const records=[{path:"/stale",component:Child}]; unknown(records);')); assert.equal(routes(await index(root)).length, 0);
  await writeFile(path.join(root, 'records.ts'), 'import Child from "./Child.vue"; export const records=[{path:"/stale",component:Child}]; export default records;');
  await writeFile(path.join(root, 'router.ts'), router('records', 'import alias, {records} from "./records"; unknown(alias);')); assert.equal(routes(await index(root)).length, 0);
});

test('Runtime route mutation, loop installation and factory installations remain explicit gaps', async () => {
  const root = await repository({ 'main.ts': install + ' router.removeRoute("page");', 'App.vue': sfc, 'router.ts': router('[{path:"/",name:"page",component:App}]', 'import App from "./App.vue";') });
  let graph = await index(root); assert.equal(routes(graph).length, 0); assert.ok(graph.diagnostics.some(item => item.code === 'vue-router-dynamic-registration'));
  await writeFile(path.join(root, 'main.ts'), 'import {createApp} from "vue"; import App from "./App.vue"; import router from "./router"; for(const target of targets) createApp(App).use(router);'); graph = await index(root); assert.equal(routes(graph).length, 0);
});

test('Native HTML tags, computed getters, side-effect tags and deferred lambdas do not become component or handler calls', async () => {
  const root = await repository({ 'App.vue': '<script setup>import input from "./Child.vue"; import slot from "./Child.vue"; import component from "./Child.vue"; const request=fetch;</script><template><input/><slot/><component/><script @click="request(\'/side-effect\')"/><button @click="() => { const later=()=>request(\'/deferred\'); }"/></template>', 'Computed.vue': '<script>export default {computed:{save(){return 1}}};</script><template><button @click="save()"/></template>', 'Child.vue': sfc });
  const graph = await index(root); assert.equal(graph.relations.some(item => item.type === 'renders'), false); assert.equal(graph.entities.some(item => Array.isArray(item.metadata.effects) && item.metadata.effects.length), false); const computed = named(graph, 'save'); assert.equal(graph.relations.some(item => item.type === 'calls' && item.to === computed.id), false);
});

test('Literal fetch aliases and proven axios imports in templates retain methods while locals/lookalikes cannot fabricate requests', async () => {
  const root = await repository({ 'App.vue': '<script setup>import axios from "axios"; import {get as send} from "axios"; const request=fetch;</script><template><button @click="request(\'https://api.example/items\', {method:\'POST\'})"/><button @click="axios.get(\'https://api.example/items\')"/><button @click="send(\'https://api.example/items\')"/><button @click="request => request(\'https://api.example/items\')"/></template>', 'api/package.json': '{"dependencies":{"express":"^5.1.0"}}', 'api/main.ts': 'import express from "express"; const app=express(); app.get("/items",()=>1); app.post("/items",()=>2);' });
  const graph = await index(root, undefined, undefined, [{ name: 'ui', path: '.', frameworks: ['vue'] }, { name: 'api', path: 'api', apiOrigins: ['https://api.example'] }]); const requests = graph.relations.filter(item => item.type === 'requests'); assert.equal(requests.length, 3); assert.deepEqual(requests.map(item => item.metadata?.method).sort(), ['GET', 'GET', 'POST']);
});

test('Shared dependency requests use the invoking Vue application proxy and retain original helper evidence', async () => {
  const root = await repository({ 'package.json': '{"private":true,"workspaces":["ui","shared","api"]}', 'ui/package.json': manifest.replace('"vue-router"', '"@shared/http":"workspace:*","vue-router"'), 'ui/App.vue': '<script setup>import {save} from "@shared/http";</script><template><button @click="save"/></template>', 'shared/package.json': '{"name":"@shared/http","version":"1.0.0","exports":"./index.ts"}', 'shared/index.ts': 'export function save(){return fetch("/items");}', 'api/package.json': '{"dependencies":{"express":"^5.1.0"}}', 'api/main.ts': 'import express from "express"; const app=express(); app.get("/items",()=>1);' });
  const state = await mkdtemp(path.join(tmpdir(), 'codiluce-vue-browser-cache-')); temporary.push(state); const cache = new AnalysisCache(state);
  const apps: ApplicationInput[] = [{ name: 'ui', path: 'ui', frameworks: ['vue'], apiProxies: [{ pathPrefix: '/', target: 'api' }] }, { name: 'api', path: 'api' }];
  const graph = await index(root, cache, undefined, apps), event = graph.entities.find(item => item.metadata.vueTemplateEvent)!;
  const request = graph.relations.find(item => item.type === 'requests' && item.from === event.id); assert.ok(request); assert.ok(request.evidence.some(item => item.file === 'shared/index.ts'));
  assert.equal(stored(await index(root, cache, undefined, apps)), stored(graph)); assert.equal(stored(await index(root, cache, 'browser-revision', apps)), stored(graph));
});

test('Nested Vue page → child component → event → Express handler appears in the existing flow catalog and request inspector', async () => {
  const root = await repository({ 'main.ts': install, 'App.vue': '<template><RouterView/></template>', 'Page.vue': '<script setup>import Child from "./Child.vue";</script><template><Child/></template>', 'Child.vue': '<script setup>function save(){return fetch("https://api.example/items");}</script><template><button @click="save"/></template>', 'router.ts': router('[{path:"/nested",children:[{path:"page",component:Page}]}]', 'import Page from "./Page.vue";'), 'api/package.json': '{"dependencies":{"express":"^5.1.0"}}', 'api/main.ts': 'import express from "express"; const app=express(); app.get("/items",function list(){return 1;});' });
  const graph = await index(root, undefined, undefined, [{ name: 'ui', path: '.', frameworks: ['vue'] }, { name: 'api', path: 'api', apiOrigins: ['https://api.example'] }]), store = new GraphStore(':memory:');
  try {
    store.save(graph); const projection = new ProjectionService(store, { root }), page = routes(graph).find(item => item.name === '/nested/page')!, list = graph.entities.find(item => item.metadata.role === 'handler' && item.metadata.framework === 'express')!;
    const flow = projection.flows({ entity: list.id }).items.find(item => item.entry.id === page.id); assert.ok(flow); assert.equal(flow.kind, 'page');
    const requests = projection.requestFlows({ entity: named(graph, 'save').id }); assert.ok(requests.items.length);
    const detail = await projection.requestFlow(requests.items[0]!.id, { maxFileBytes: 1 << 20 }); assert.ok(JSON.stringify(detail).includes('click'));
  } finally { store.close(); }
});

test('Vue Router 5 manual records preserve nested/views/lazy/redirect semantics; generated routes remain a separate gap', async () => {
  const root = await repository({ 'package.json': manifest.replace('^4.5.0', '^5.3.1'), 'main.ts': install, 'App.vue': sfc, 'Child.vue': sfc, 'router.ts': router('[{path:"/parent",component:Child,children:[{path:"child",name:"child",components:{default:()=>import("./Child.vue"),sidebar:Child}}]},{path:"/old",redirect:{name:"child"}}]', 'import Child from "./Child.vue";') }), cacheRoot = await mkdtemp(path.join(tmpdir(), 'codiluce-vue5-cache-')); temporary.push(cacheRoot); const cache = new AnalysisCache(cacheRoot);
  const cold = await index(root, cache); assert.deepEqual(routes(cold).map(item => item.name).sort(), ['/old', '/parent', '/parent/child']); assert.ok(routes(cold).every(item => item.metadata.profile === 'vue-router-5')); assert.ok(cold.relations.some(item => item.metadata?.role === 'redirect')); assert.ok(cold.relations.some(item => item.metadata?.view === 'sidebar')); assert.equal(stored(await index(root, cache)), stored(cold));
  await writeFile(path.join(root, 'router.ts'), 'import {createRouter,createWebHistory} from "vue-router/auto"; import {routes} from "vue-router/auto-routes"; export default createRouter({history:createWebHistory(),routes});'); const graph = await index(root); assert.equal(routes(graph).length, 0); assert.ok(graph.diagnostics.some(item => item.code === 'vue-router-generated-route-gap'));
});

test('Namespace type-only barrels and shorthand type-only Options imports cannot become runtime components', async () => {
  const root = await repository({ 'App.vue': '<script setup lang="ts">import * as UI from "./barrel";</script><template><UI.Child/></template>', 'Options.vue': '<script lang="ts">import type Child from "./Child.vue"; export default {components:{Child}};</script><template><Child/></template>', 'Child.vue': sfc, 'barrel.ts': 'export type {default as Child} from "./Child.vue";' });
  let graph = await index(root); assert.equal(graph.relations.some(item => item.type === 'renders'), false);
  await writeFile(path.join(root, 'barrel.ts'), 'export type * from "./all";'); await writeFile(path.join(root, 'all.ts'), 'export {default as Child} from "./Child.vue";'); graph = await index(root); assert.equal(graph.relations.some(item => item.type === 'renders'), false);
  await writeFile(path.join(root, 'App.vue'), '<script setup lang="ts">export type Shape={value:string}; export interface Props {label:string}</script><template><span/></template>'); graph = await index(root);
  const appFile = graph.entities.find(item => item.type === 'file' && item.path === 'App.vue')!; assert.equal((appFile.metadata.analysis as any).features.framework.status, 'partial');
});
