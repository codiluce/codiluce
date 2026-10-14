import assert from 'node:assert/strict';
import {mock} from 'node:test';
import cp from 'node:child_process';
import v8 from 'node:v8';
import {syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
const source = new URL(process.argv[2]), baseline = process.argv.includes('--expect-prior-v8');
const load = file => import(new URL(file, source));
const [{indexRepository}, {resolveConfig}, {GraphBuilder}, {filesystemAnalyzer}, {projectAnalyzer}, {AnalysisCache}, isolated, protocol] = await Promise.all([load('pipeline/index.js'), load('core/config.js'), load('core/graph.js'), load('analyzers/filesystem.js'), load('analysis/project-model.js'), load('pipeline/cache.js'), load('analyzers/typescript-isolated.js'), load('analyzers/ts-worker-protocol.js')]);
const {runTypeScriptWorker, typeScriptWorkerRequest, TypeScriptWorkerError} = isolated;
const codec = baseline ? undefined : await load('analyzers/ts-worker-codec.js');
const root = await mkdtemp(path.join(tmpdir(), 'codiluce-bounded-transport-')), originals = {'package.json': '{"dependencies":{"express":"5.1.0"}}', 'main.ts': 'import express from "express";const app=express();\nfunction leaf(){return 1;}\nfunction handler(req,res){return leaf();}\napp.get("/codec",handler);\nexport async function original(){return fetch("https://codec.original.test/codec");}\nthrow new Error("Target never executes");\n'};
for (const [file, text] of Object.entries(originals)) await writeFile(path.join(root, file), text);
const config = await resolveConfig(root, {repository: {name: 'Owned bounded transport'}, applications: [{name: 'server', path: '.', ecosystems: ['node'], frameworks: ['express'], apiOrigins: ['https://codec.original.test']}]}), cache = new AnalysisCache(path.join(root, '.codiluce/cache'));
const shape = context => JSON.stringify({entities: [...context.graph.entities.values()], relations: [...context.graph.relations.values()], diagnostics: [...context.graph.diagnostics.values()], http: context.http});
const same = graph => JSON.stringify({...graph, run: {...graph.run, id: 'owned-run', analyzedAt: 'owned-time'}});
const observations = [], serialize = v8.serialize;
let serializations = 0, passed = false;
const serializer = mock.method(v8, 'serialize', (...args) => {serializations++; if (!baseline) throw Error('Parent full-value V8 serialization is forbidden'); return serialize(...args);}); syncBuiltinESMExports();
try {
  const cold = await indexRepository(root, {config, cache}), warm = await indexRepository(root, {config, cache}), revision = await indexRepository(root, {config, revision: 'e'.repeat(40)});
  assert.equal(same(cold), same(warm)); assert.deepEqual(cold.entities, revision.entities); assert.deepEqual(cold.relations, revision.relations);
  assert.ok(cache.events.some(event => event.analyzer === 'typescript-nextjs' && event.hit));
  const request = cold.relations.find(edge => edge.type === 'requests'), caller = cold.entities.find(entity => entity.name === 'original'); assert.ok(request && caller);
  assert.ok(caller.metadata.effects.some(effect => effect.category === 'network' && effect.endpoint === request.to), 'Graph/HTTP effect ownership survives the transfer and matching');
  observations.push({case: 'healthy-cold-warm-revision', entities: cold.entities.length, relations: cold.relations.length, graphSha256: createHash('sha256').update(same(cold)).digest('hex'), actualWarmCacheHit: true, matchedHttpEffect: true});
  const graph = new GraphBuilder(config.repository.name), context = {root, config, graph, repositoryId: graph.id('repository'), files: new Map(), applicationIds: new Map(), http: []};
  await filesystemAnalyzer.analyze(context); await projectAnalyzer.analyze(context); const before = shape(context), payload = typeScriptWorkerRequest(context);
  payload.graph.namespace = '.'.repeat(protocol.TYPESCRIPT_WORKER_LIMITS.maxMessageBytes + 1);
  let forks = 0; const fork = mock.method(cp, 'fork', () => {forks++; throw Error('Oversized input must fail before a fork');}); syncBuiltinESMExports();
  try {await assert.rejects(runTypeScriptWorker(payload), /input exceeds 67108864 bytes/); assert.equal(forks, 0); assert.equal(shape(context), before);} finally {fork.mock.restore(); syncBuiltinESMExports();}
  const stats = {}; if (codec) {assert.throws(() => codec.encodeTypeScriptPayload(payload, protocol.TYPESCRIPT_WORKER_LIMITS.maxMessageBytes, stats), codec.TypeScriptCodecLimitError); assert.ok(stats.allocatedBlockBytes <= protocol.TYPESCRIPT_WORKER_LIMITS.maxMessageBytes); assert.equal(stats.concatenatedBytes, 0); assert.ok(stats.peakBlockBytes <= 65536);}
  observations.push({case: 'default-64MiB-input-rejection', forkCount: forks, parentGraphUnchanged: true, stats, originalStringUnits: payload.graph.namespace.length});
  if (!baseline) {
    // Original source remains admitted. A smaller owned transport budget
    // exercises the actual child's encoder rather than a fake oversized reply.
    const small = typeScriptWorkerRequest(context), input = codec.encodeTypeScriptPayload(small, 67108864); let failure;
    try {await runTypeScriptWorker(small, {maxMessageBytes: input.length + 8});} catch (error) {failure = error;}
    assert.ok(failure instanceof TypeScriptWorkerError); assert.ok(failure.code !== null || failure.signal !== null); assert.match(failure.message, /compiler payload exceeds/); assert.equal(shape(context), before); assert.equal(context.typescriptFiles, undefined);
    observations.push({case: 'real-child-output-encoding-rejection', inputBytes: input.length, selectedOwnedBytes: input.length + 8, code: failure.code, signal: failure.signal, pid: failure.pid, parentGraphUnchanged: true});
    assert.equal(serializations, 0);
  } else assert.ok(serializations >= 4);
  for (const [file, text] of Object.entries(originals)) assert.equal(await readFile(path.join(root, file), 'utf8'), text);
  const receipt = {schema: 1, passed: true, caseCount: observations.length, expectedPriorV8: baseline, parentFullValueV8Serializations: serializations, node: process.version, sourceLoader: process.execArgv.some(arg => /tsx/.test(arg)), observations, targetExecution: false, scope: 'Actual default compiler transport with parent full-value V8 serialization forbidden, full original cold/warm/revision graph and HTTP effect equality, default 64MiB input rejection before fork and real-child output encoding rejection under a smaller owned probe budget. Buffer ownership is separate from graph/reference/traversal/decoded allocations and total RSS.'};
  await writeFile(process.argv[3], JSON.stringify(receipt, null, 2) + '\n', {flag: 'wx'}); console.log(JSON.stringify(receipt)); passed = true;
} finally {serializer.mock.restore(); syncBuiltinESMExports(); if (passed) await rm(root, {recursive: true, force: true}); else console.error('Retained bounded transport originals:', root);}
