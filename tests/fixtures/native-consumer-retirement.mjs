import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {mock} from 'node:test';

const source = new URL(process.argv[2]);
const prior = process.argv[4] === '--expect-prior-retention';
assert.equal(typeof global.gc, 'function', 'Run the owned lifetime probe with --expose-gc');
const load = file => import(new URL(file, source).href);
const [{analyzers, indexRepository}, {resolveConfig}, {AnalysisCache}] = await Promise.all([load('pipeline/index.js'), load('core/config.js'), load('pipeline/cache.js')]);
const fields = ['syntax', 'python', 'go', 'goSymbols', 'ruby', 'rubySymbols', 'rubyAutoload', 'jvm', 'jvmSymbols', 'csharp', 'csharpSymbols', 'rust', 'rustSymbols'];
const roots = [], observations = [];
const bytes = {
  'package.json': '{"dependencies":{"express":"5.1.0"}}',
  'main.ts': 'import express from "express";const app=express();function ts_original(){return fetch("/native")};app.get("/native",ts_original);',
  'pyproject.toml': '[project]\nname="owned-native-retirement"\nversion="1.0.0"\n',
  'original.py': '# é😀\r\ndef python_leaf(): return 1\r\ndef python_original(): return python_leaf()\r\n',
  'go.mod': 'module example.com/owned/native\n\ngo 1.24\n',
  'original.go': 'package native\nfunc go_leaf() int {return 1}\nfunc go_original() int {return go_leaf()}\n',
  'original.rb': '# é😀\r\ndef ruby_leaf; 1; end\r\ndef ruby_original; ruby_leaf; end\r\n',
  'pom.xml': '<project><modelVersion>4.0.0</modelVersion><groupId>owned</groupId><artifactId>native</artifactId><version>1</version></project>',
  'src/main/java/Original.java': 'class Original {static int java_leaf(){return 1;}static int java_original(){return java_leaf();}}',
  'Original.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>',
  'Original.cs': 'class Original {static int csharp_leaf()=>1;static int csharp_original()=>csharp_leaf();}',
  'Cargo.toml': '[package]\nname="owned-native-retirement"\nversion="1.0.0"\nedition="2021"\n',
  'src/lib.rs': 'pub fn rust_leaf()->i32 {1}\npub fn rust_original()->i32 {rust_leaf()}\n',
  'generic/Original.php': '<?php function php_leaf(){return 1;} function php_original(){return php_leaf();}\n',
};
const hash = value => createHash('sha256').update(value).digest('hex');
const shape = graph => hash(JSON.stringify({entities: [...graph.entities.values()], relations: [...graph.relations.values()], diagnostics: [...graph.diagnostics.values()]}));
const same = graph => JSON.stringify({...graph, run: {...graph.run, id: 'owned-run', analyzedAt: 'owned-time'}});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'codiluce-native-consumer-retirement-')); roots.push(root);
  for (const [file, text] of Object.entries(bytes)) {await mkdir(path.dirname(path.join(root, file)), {recursive: true}); await writeFile(path.join(root, file), text);}
  return root;
}
function capture(context, mode) {
  const refs = new Map();
  for (const key of fields) {assert.ok(context[key], `Expected live ${key} after its native consumers`); refs.set(key, new WeakRef(context[key]));}
  return {mode, refs, graphBefore: shape(context.graph), sourceMemoBefore: context.sources.memoStats()};
}
async function collected(refs) {
  let live = fields.length;
  for (let attempt = 0; attempt < 12 && live; attempt++) {
    await new Promise(resolve => setImmediate(resolve)); global.gc();
    live = [...refs.values()].filter(ref => ref.deref() !== undefined).length;
  }
  return live;
}
async function inspectRetirement(context, observation) {
  assert.equal(shape(context.graph), observation.graphBefore, 'Retirement changed completed native graph facts');
  for (const key of fields) assert.equal(!!context[key], prior, `${key} ownership at the next phase`);
  if (prior) {assert.ok(context.sources.memoStats().entries > 0); observation.liveAfter = fields.length;}
  else {assert.equal(context.sources.memoStats().entries, 0); assert.equal(context.sources.memoStats().bytes, 0); observation.liveAfter = await collected(observation.refs); assert.equal(observation.liveAfter, 0, 'Retired native context roots remain reachable');}
  observations.push({mode: observation.mode, rootsObserved: fields.length, liveAtNextPhase: observation.liveAfter, sourceMemoBefore: observation.sourceMemoBefore, sourceMemoAfter: context.sources.memoStats(), completedGraphUnchanged: true});
}
const native = analyzers.find(analyzer => analyzer.name === 'rust-routers');
const embedded = analyzers.find(analyzer => analyzer.name === 'embedded-source');
const analyzeNative = native.analyze, analyzeEmbedded = embedded.analyze;
let active, fail = false, failedContext, enteredEmbedded = false, passed = false;
const nativeProbe = mock.method(native, 'analyze', async function(context) {
  await analyzeNative.call(this, context); active = capture(context, fail ? 'failed-native-phase' : mode);
  if (fail) {failedContext = context; throw Error('Injected owned failure after the final native consumer');}
});
const embeddedProbe = mock.method(embedded, 'analyze', async function(context) {
  enteredEmbedded = true; await inspectRetirement(context, active); await analyzeEmbedded.call(this, context);
});
let mode = 'cold';
try {
  const root = await fixture(), config = await resolveConfig(root, {repository: {name: 'Owned native lifetime proof'}}), cache = new AnalysisCache(path.join(root, '.codiluce/cache'));
  const cold = await indexRepository(root, {config, cache}); mode = 'warm';
  const warm = await indexRepository(root, {config, cache}); mode = 'revision';
  const revision = await indexRepository(root, {config, revision: 'e'.repeat(40)});
  assert.equal(same(cold), same(warm), 'Complete warm graph changed beyond UUID/time');
  assert.equal(JSON.stringify(cold.entities), JSON.stringify(revision.entities));
  assert.equal(JSON.stringify(cold.relations), JSON.stringify(revision.relations));
  assert.ok(cache.events.some(event => event.analyzer === 'go-imports' && event.hit));
  assert.ok(cache.events.some(event => event.analyzer === 'typescript-nextjs' && event.hit));
  for (const language of ['python', 'go', 'ruby', 'java', 'csharp', 'rust', 'php']) assert.ok(cold.entities.some(entity => entity.language === language && entity.name.endsWith('_original')), `Original ${language} declaration missing`);
  const php = cold.entities.find(entity => entity.name === 'php_original'), leaf = cold.entities.find(entity => entity.name === 'php_leaf');
  assert.ok(cold.relations.some(edge => edge.type === 'calls' && edge.from === php.id && edge.to === leaf.id), 'Later PHP syntax consumers did not bind the original handler');
  enteredEmbedded = false; fail = true;
  await assert.rejects(indexRepository(root, {config}), /Injected owned failure after the final native consumer/);
  assert.equal(enteredEmbedded, false); await inspectRetirement(failedContext, active);
  for (const [file, text] of Object.entries(bytes)) assert.equal(await readFile(path.join(root, file), 'utf8'), text);
  passed = true;
  const receipt = {schema: 1, passed, caseCount: 2, cases: ['complete-cold-warm-revision-native-consumer-retirement', 'failed-native-phase-retirement'], observations, expectedPriorRetention: prior, rootsPerObservation: fields.length, originalFiles: Object.keys(bytes).length, graph: {entities: cold.entities.length, relations: cold.relations.length, diagnostics: cold.diagnostics.length, coldWarmSha256: hash(same(cold))}, node: process.version, sourceLoader: process.execArgv.some(arg => /tsx/.test(arg)), targetExecution: false, scope: 'Context ownership and forced-GC reachability after completed native consumers and on failure; later PHP and TypeScript facts, complete warm parity and revision records. This is not a global parent heap/RSS budget.'};
  if (process.argv[3]) await writeFile(process.argv[3], JSON.stringify(receipt, null, 2) + '\n', {flag: 'wx'});
  console.log(JSON.stringify(receipt));
} finally {
  nativeProbe.mock.restore(); embeddedProbe.mock.restore();
  if (passed) for (const root of roots) await rm(root, {recursive: true, force: true});
  else console.error('Retained native lifetime originals:', roots);
}
