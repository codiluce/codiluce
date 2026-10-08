import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import ts from 'typescript';
import { extractEmbedded, embeddedText, expressionEnd, mappedRange } from '../src/analysis/embedded/source.js';
import { SourceText } from '../src/analysis/source-map.js';
import { resolveConfig, type ApplicationInput } from '../src/core/config.js';
import { indexRepository } from '../src/pipeline/index.js';
import { AnalysisCache } from '../src/pipeline/cache.js';
import { canonicalJson } from '../src/history/fingerprint.js';
import type { SoftwareGraph } from '../src/core/graph.js';
const temporary: string[] = [];
after(async () => { await Promise.all(temporary.map(root => rm(root, { recursive: true, force: true }))); });
async function repository(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'codiluce-embedded-')); temporary.push(root);
  for (const [file, content] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), content); } return root;
}
async function index(root: string, cache?: AnalysisCache, revision?: string, applications: ApplicationInput[] = [{ name: 'ui', path: '.', frameworks: ['vue'] }]) { return indexRepository(root, { config: await resolveConfig(root, { repository: { name: 'embedded' }, applications }), cache, revision }); }
const stored = (graph: SoftwareGraph) => canonicalJson({ entities: graph.entities, relations: graph.relations, diagnostics: graph.diagnostics.filter(item => !['git-metrics', 'indexer'].includes(item.analyzer) && item.code !== 'git-ignore-unavailable') });
const named = (graph: SoftwareGraph, name: string) => graph.entities.filter(item => item.name === name);

test('Vue extraction retains module/setup UTF-16 ranges and excludes comments, styles, custom blocks and template scripts', () => {
  const source = '<!-- <script>function fake() {}</script> -->\r\n<template><div>😀<script>fake()</script><template><span/></template></div></template>\r\n<style>.x { content: "<script>fake()</script>"; }</style>\r\n<docs><script>fake()</script></docs>\r\n<script lang="ts">\r\nexport function normal(x: number) { return x; }\r\n</script>\r\n<script setup lang="ts">const save = () => normal(1);</script>';
  const facts = extractEmbedded(source, 'vue'); assert.deepEqual(facts.regions.map(item => item.role), ['module', 'setup']); assert.deepEqual(facts.issues, []); assert.equal(facts.regions[0]!.range.startLine, 5);
  for (const region of facts.regions) {
    const virtual = embeddedText(source, region); assert.equal(virtual.slice(region.start, region.end), source.slice(region.start, region.end)); assert.equal(virtual.indexOf('fake()'), -1);
    assert.deepEqual(mappedRange(region, region.start, region.end), { start: region.start, end: region.end }); assert.equal(mappedRange(region, source.length, virtual.length), undefined);
    const a = new SourceText(source).position(region.start), b = new SourceText(virtual).position(region.start); assert.deepEqual(a, b);
  }
  assert.equal(source.slice(facts.templates[0]!.start, facts.templates[0]!.end).endsWith('</div>'), true);
});

test('Svelte extraction distinguishes module/instance contexts and ignores script-like expression strings and block comments', () => {
  const source = '<script module lang="ts">export function shared() { return 1; }</script>\n<script lang="ts">function local() { return shared(); }</script>\n<div>{`<script>${"}"}</script>`}{/<script>}/.test("x")}</div><!-- <script>fake()</script> -->';
  const facts = extractEmbedded(source, 'svelte'); assert.deepEqual(facts.regions.map(item => item.role), ['module', 'instance']); assert.deepEqual(facts.issues, []);
  const nested = '{`a${{ x: `b${1}` }}c`}'; assert.equal(expressionEnd(nested, 0), nested.length);
  const legacy = extractEmbedded('<script context="module">export const x=1;</script><script>let y=1;</script>', 'svelte'); assert.deepEqual(legacy.regions.map(item => item.role), ['module', 'instance']);
  assert.deepEqual(extractEmbedded('<script>let ready = true;</script>{#if ready}<div>{`value ${1}`}</div>{:else}<span/>{/if}', 'svelte').issues, []);
});

test('Astro separates server frontmatter from processed client scripts and leaves inline/data/external scripts out of module binding', () => {
  const source = '---\nimport Item from "./Item.vue";\nconst data = await load();\n---\n<div>{"<script>fake()</script>"}<script>const x: number = 1;</script></div><script is:inline>window.start()</script><script type="application/ld+json">{ "x": 1 }</script><script src="./external.ts"></script>';
  const facts = extractEmbedded(source, 'astro'); assert.deepEqual(facts.regions.map(item => item.role), ['frontmatter', 'client', 'client', 'client']); assert.deepEqual(facts.regions.map(item => item.supported), [true, true, false, false]); assert.equal(facts.regions[0]!.executionContext, 'server'); assert.equal(facts.regions[1]!.executionContext, 'browser'); assert.ok(facts.issues.some(item => item.code === 'unprocessed-script')); assert.ok(facts.issues.some(item => item.code === 'external-script'));
});

test('Malformed/duplicate/dynamic/preprocessed embedded blocks produce explicit bounded outcomes', () => {
  for (const [source, language] of [['<script>let x = 1', 'vue'], ['<script/><script/>', 'vue'], ['---\nconst x=1', 'astro'], ['{#if yes}<script>let x=1;</script>{/if}', 'svelte'], ['<template><div>', 'vue']] as const) assert.ok(extractEmbedded(source, language).issues.some(item => item.fatal), source);
  const dynamic = extractEmbedded('<script lang={language}>const x=1;</script>', 'svelte'); assert.equal(dynamic.regions[0]!.supported, false);
  const preprocessed = extractEmbedded('<script lang="coffee">x = -> 1</script>', 'vue'); assert.ok(preprocessed.issues.some(item => item.code === 'unsupported-script'));
  const closed = extractEmbedded('<script setup src="./source.ts"/>', 'vue'); assert.ok(closed.issues.some(item => item.code === 'invalid-setup-src'));
});

test('Canonical offsets match TypeScript for CRLF, CR, Unicode separators and surrogate pairs', () => {
  const text = '😀x\r\ny\rz\u2028a\u2029b\n', source = new SourceText(text), tsSource = ts.createSourceFile('source.ts', text, ts.ScriptTarget.Latest);
  for (let i = 0; i <= text.length; i++) { const expected = tsSource.getLineAndCharacterOfPosition(i); assert.deepEqual(source.position(i), { line: expected.line + 1, column: expected.character + 1 }); }
});

test('Embedded Vue scripts bind imported TS helpers and component imports with original declarations/evidence and no virtual graph files', async () => {
  const root = await repository({ 'package.json': '{"dependencies":{"vue":"^3.5.0"}}', 'tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}', 'src/App.vue': '<template><Card/></template>\n<script setup lang="ts">\nimport Card from "@/Card.vue";\nimport { leaf } from "./helper";\nexport function save() { return leaf(); }\n</script>', 'src/Card.vue': '<template><span/></template>', 'src/helper.ts': 'export function leaf() { return 1; }' });
  const graph = await index(root), save = named(graph, 'save')[0]!, leaf = named(graph, 'leaf')[0]!; assert.ok(save && leaf); assert.equal(save.sourceRange!.startLine, 5); assert.equal(save.evidence[0]!.file, 'src/App.vue'); assert.equal(save.path, 'src/App.vue');
  assert.ok(graph.relations.some(item => item.type === 'calls' && item.from === save.id && item.to === leaf.id));
  const app = graph.entities.find(item => item.type === 'file' && item.path === 'src/App.vue')!, card = graph.entities.find(item => item.type === 'file' && item.path === 'src/Card.vue')!;
  assert.ok(graph.relations.some(item => item.type === 'imports' && item.from === app.id && item.to === card.id)); assert.equal((app.metadata.analysis as any).features.references.status, 'partial');
  assert.equal(graph.entities.some(item => item.path?.includes('.__codiluce_')), false); assert.equal(graph.relations.some(item => item.evidence.some(proof => proof.file?.includes('.__codiluce_'))), false);
});

test('Svelte module exports cross component imports, instance scopes read module bindings, and unrelated globals stay isolated', async () => {
  const root = await repository({ 'Counter.svelte': '<script module lang="ts">export function shared() { return 1; }\nfunction duplicate() { return 1; }</script>\n<script lang="ts">function duplicate() { return 2; }\nfunction run() { return shared(); }</script>', 'caller.ts': 'import { shared } from "./Counter.svelte"; export function caller() { return shared(); }', 'other.svelte': '<script>function foreign() { return 1; }</script>', 'isolated.svelte': '<script>function isolated() { return foreign(); }</script>' });
  const graph = await index(root); assert.equal(named(graph, 'duplicate').length, 2); assert.equal(graph.diagnostics.some(item => item.code === 'duplicate-symbol'), false);
  const shared = named(graph, 'shared')[0]!, caller = named(graph, 'caller')[0]!, foreign = named(graph, 'foreign')[0]!; assert.ok(graph.relations.some(item => item.type === 'calls' && item.from === caller.id && item.to === shared.id));
  assert.equal(graph.relations.some(item => item.type === 'calls' && item.to === foreign.id), false); assert.ok(graph.relations.some(item => item.type === 'calls' && item.from === named(graph, 'run')[0]!.id && item.to === shared.id));
});

test('Astro frontmatter/client scopes cannot bind each other; requests retain original lines and independent execution contexts', async () => {
  const root = await repository({ 'Page.astro': '---\nfunction serverOnly() { return 1; }\nfetch("https://api.example/server");\n---\n<main><script>\nfunction client() { serverOnly(); fetch("https://api.example/client"); }\nclient();\n</script></main>', 'api/package.json': '{"dependencies":{"express":"^5.0.0"}}', 'api/main.ts': 'import express from "express"; const app = express(); app.get("/server", () => 1); app.get("/client", () => 2);' });
  const apps: ApplicationInput[] = [{ name: 'ui', path: '.', frameworks: ['astro'] }, { name: 'api', path: 'api', apiOrigins: ['https://api.example'] }]; const graph = await index(root, undefined, undefined, apps);
  const server = named(graph, 'serverOnly')[0]!, client = named(graph, 'client')[0]!; assert.equal(graph.relations.some(item => item.type === 'calls' && item.from === client.id && item.to === server.id), false); assert.equal(client.sourceRange!.startLine, 6); assert.equal(client.metadata.executionContext, 'browser');
  const requests = graph.relations.filter(item => item.type === 'requests'); assert.equal(requests.length, 2); assert.ok(requests.every(item => item.evidence.some(proof => proof.file === 'Page.astro')));
  assert.equal(named(graph, 'frontmatter script')[0]!.metadata.executionContext, 'server');
});

test('Excluded or malformed components cannot expose embedded functions; unreviewed browser scripts remain gaps', async () => {
  const root = await repository({ 'Ignored.vue': 'x'.repeat(1_600_000), 'Broken.vue': '<script>export function broken( {</script>', 'Inline.astro': '<script is:inline>function phantom() {}</script>', 'caller.ts': 'import { phantom } from "./Inline.astro"; import { broken } from "./Broken.vue"; export function caller() { phantom(); broken(); }' });
  const graph = await index(root); assert.equal(named(graph, 'phantom').length, 0); assert.equal(named(graph, 'broken').length, 0); const broken = graph.entities.find(item => item.type === 'file' && item.path === 'Broken.vue')!; assert.equal((broken.metadata.analysis as any).features.structure.status, 'failed'); assert.ok(graph.diagnostics.some(item => item.code === 'embedded-unprocessed-script')); assert.equal(graph.entities.some(item => item.path?.includes('.__codiluce_')), false);
});

test('Embedded cache/warm/revision replay agrees and source edits invalidate consumers while inserted lines preserve declaration identities', async () => {
  const source = '<template>😀</template>\n<script setup lang="ts">\nimport { leaf } from "./helper";\nfunction save() { return leaf(); }\n</script>', root = await repository({ 'View.vue': source, 'helper.ts': 'export function leaf() { return 1; }' }), cache = new AnalysisCache(path.join(root, '.cache'));
  const cold = await index(root, cache); assert.equal(stored(await index(root, cache)), stored(cold)); assert.equal(stored(await index(root, undefined, 'fixture-revision')), stored(cold)); assert.ok(cache.events.some(item => item.analyzer === 'embedded-source' && item.hit)); assert.ok(cache.events.some(item => item.analyzer === 'typescript-nextjs' && item.hit));
  await writeFile(path.join(root, 'View.vue'), `<!-- shifted -->\n${source}`); const shifted = await index(root, cache); assert.equal(named(shifted, 'save')[0]!.id, named(cold, 'save')[0]!.id); assert.equal(named(shifted, 'save')[0]!.sourceRange!.startLine, 5); assert.equal(stored(shifted), stored(await index(root)));
});

test('Declared workspace component exports bind exact named declarations across project programs and invalidation reaches consumers', async () => {
  const root = await repository({ 'package.json': '{"private":true,"workspaces":["packages/*"]}', 'packages/ui/package.json': '{"name":"@test/ui","version":"1.0.0","exports":"./Card.vue"}', 'packages/ui/Card.vue': '<script lang="ts">export function helper() { return 1; }</script><template><div/></template>', 'packages/app/package.json': '{"name":"app","dependencies":{"@test/ui":"workspace:*"}}', 'packages/app/main.ts': 'import { helper } from "@test/ui"; export function caller() { return helper(); }' });
  const cache = new AnalysisCache(path.join(root, '.cache')), graph = await index(root, cache); const caller = named(graph, 'caller')[0]!, helper = named(graph, 'helper')[0]!; assert.ok(graph.relations.some(item => item.type === 'calls' && item.from === caller.id && item.to === helper.id));
  assert.equal(stored(await index(root, cache)), stored(graph)); await writeFile(path.join(root, 'packages/ui/Card.vue'), '<script lang="ts">export function changed() { return 1; }</script><template><div/></template>'); const changed = await index(root, cache); assert.equal(changed.relations.some(item => item.type === 'calls' && item.from === caller.id), false); assert.equal(stored(changed), stored(await index(root)));
});

test('Module locals flow into Vue setup/Svelte instances without reverse visibility, shadowing or compiler-only public exports', async () => {
  const root = await repository({ 'Pair.vue': '<script lang="ts">function privateHelper() { return 1; }\nexport function publicHelper() { return privateHelper(); }\nfunction outside() { return inside(); }</script>\n<script setup lang="ts">function inside() { return privateHelper(); }\nfunction publicHelper() { return 2; }\nfunction shadow() { return publicHelper(); }</script>', 'caller.ts': 'import { privateHelper, __codiluce_private_privateHelper, publicHelper } from "./Pair.vue"; export function caller() { privateHelper(); __codiluce_private_privateHelper(); return publicHelper(); }' });
  const graph = await index(root), inner = named(graph, 'inside')[0]!, privateHelper = named(graph, 'privateHelper')[0]!, caller = named(graph, 'caller')[0]!;
  assert.ok(graph.relations.some(item => item.type === 'calls' && item.from === inner.id && item.to === privateHelper.id)); assert.equal(graph.relations.some(item => item.type === 'calls' && item.from === named(graph, 'outside')[0]!.id && item.to === inner.id), false);
  const publicHelpers = named(graph, 'publicHelper'); assert.equal(graph.relations.filter(item => item.type === 'calls' && item.from === caller.id).length, 1); assert.ok(graph.relations.some(item => item.type === 'calls' && item.from === caller.id && item.to === publicHelpers.find(item => item.metadata.embeddedRegion === 'module')!.id));
  assert.ok(graph.relations.some(item => item.type === 'calls' && item.from === named(graph, 'shadow')[0]!.id && item.to === publicHelpers.find(item => item.metadata.embeddedRegion === 'setup')!.id));
});

test('Generated source names, collision files, type-only aliases and failed blocks cannot establish runtime calls', async () => {
  const root = await repository({ 'Target.svelte': '<script module lang="ts">import type { target } from "./helper";\nexport type { target };\n</script><script lang="ts">function local() { target(); }</script>', 'helper.ts': 'export function target() { return 1; }', 'caller.ts': 'import { target } from "./Target.svelte"; import { local } from "./Target.svelte.__codiluce_instance.ts"; export function caller() { target(); local(); }', 'Collision.vue': '<script setup>function hidden() {}</script>', 'Collision.vue.__codiluce_setup.js': 'export function actual() { return 1; }' });
  const graph = await index(root); assert.equal(graph.relations.some(item => item.type === 'calls' && item.to === named(graph, 'target')[0]!.id), false); assert.equal(named(graph, 'hidden').length, 0); assert.equal(named(graph, 'actual').length, 1); assert.ok(graph.diagnostics.some(item => item.code === 'embedded-virtual-collision'));
  assert.equal(graph.relations.some(item => item.type === 'calls' && item.from === named(graph, 'caller')[0]!.id), false);
});

test('Embedded HTTP wrappers bind across files/projects and preserve the original caller and request evidence', async () => {
  const root = await repository({ 'App.vue': '<script setup lang="ts">import { send } from "./http";\nfunction save() { return send("https://api.example/items"); }</script>', 'http.ts': 'export function send(url: string) { return fetch(url); }', 'api/package.json': '{"dependencies":{"express":"^5.0.0"}}', 'api/main.ts': 'import express from "express"; const app = express(); app.get("/items", () => 1);' });
  const graph = await index(root, undefined, undefined, [{ name: 'ui', path: '.', frameworks: ['vue'] }, { name: 'api', path: 'api', apiOrigins: ['https://api.example'] }]); const save = named(graph, 'save')[0]!;
  assert.ok(graph.relations.some(item => item.type === 'requests' && item.from === save.id && item.evidence.some(proof => proof.file === 'App.vue')));
});
