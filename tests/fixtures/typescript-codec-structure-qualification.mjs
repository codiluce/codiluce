import assert from 'node:assert/strict';
import {mock} from 'node:test';
import cp from 'node:child_process';
import v8 from 'node:v8';
import {syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
const source = new URL(process.argv[2]), baseline = false;
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
  const limits = codec.TYPESCRIPT_CODEC_STRUCTURE_LIMITS;
  payload.graph.entities.length = limits.arraySlots + 1;
  let forks = 0; const fork = mock.method(cp, 'fork', () => {forks++; throw Error('Sparse input must fail before a fork');}); syncBuiltinESMExports();
  try {await assert.rejects(runTypeScriptWorker(payload), /input exceeds structural limit: TypeScript compiler arraySlots/); assert.equal(forks, 0); assert.equal(shape(context), before);} finally {fork.mock.restore(); syncBuiltinESMExports();}
  observations.push({case: 'default-sparse-request-rejection', selectedArraySlots: limits.arraySlots, requestedArraySlots: payload.graph.entities.length, forkCount: forks, parentGraphUnchanged: true});
  let length = limits.arraySlots + 1; const raw = [0x43,0x44,0x54,1,13];
  do {const digit=length%128;length=Math.floor(length/128);raw.push(digit+(length?128:0));} while(length);
  raw.push(0);const tiny=Buffer.from(raw),Original=globalThis.Array;let allocations=0;
  globalThis.Array=new Proxy(Original,{construct(){allocations++;throw Error('Unadmitted Array allocation');}});
  try {assert.throws(()=>codec.decodeTypeScriptPayload(tiny,67108864),error=>error instanceof codec.TypeScriptCodecStructureLimitError&&error.resource==='arraySlots');assert.equal(allocations,0);} finally {globalThis.Array=Original;}
  observations.push({case:'tiny-default-decoder-rejection',frameBytes:tiny.length,requestedArraySlots:limits.arraySlots+1,arrayConstructorCalls:allocations});
  const small=typeScriptWorkerRequest(context),inputStats={},outputStats={};codec.encodeTypeScriptPayload(small,67108864,inputStats);
  const healthyResult=await runTypeScriptWorker(small);codec.encodeTypeScriptPayload(healthyResult,67108864,outputStats);
  const pool=['objects','properties','strings','arraySlots','stringUnits','binaryBytes'].find(key=>inputStats[key]>0&&outputStats[key]>inputStats[key]);assert.ok(pool,'Original compiler output must exceed one input structure pool');
  const policy={[pool]:inputStats[pool]};let failure;
  try {await runTypeScriptWorker(small,{codecLimits:policy});}catch(error){failure=error;}
  assert.ok(failure instanceof TypeScriptWorkerError);assert.ok(failure.code!==null||failure.signal!==null);assert.ok(failure.message.includes('compiler '+pool+' exceeds '+policy[pool]+' limit'));assert.equal(shape(context),before);assert.equal(context.typescriptFiles,undefined);assert.equal(serializations,0);
  observations.push({case:'real-child-structure-rejection',pool,inputUnits:inputStats[pool],outputUnits:outputStats[pool],selectedOwnedLimit:policy[pool],code:failure.code,signal:failure.signal,pid:failure.pid,parentGraphUnchanged:true});
  for(const [file,text]of Object.entries(originals))assert.equal(await readFile(path.join(root,file),'utf8'),text);
  const receipt={schema:1,passed:true,caseCount:observations.length,node:process.version,sourceLoader:process.execArgv.some(arg=>/tsx/.test(arg)),limits,observations,parentFullValueV8Serializations:serializations,targetExecution:false,scope:'Fixed logical encoder/decoder structure pools, default sparse request rejection before fork, tiny hostile-frame array rejection before constructor allocation and real-child output rejection under a lower owned pool cap. Complete original graphs/effects and aliases retained. Object.keys pre-admission allocation and graph/project/native/WASM/total RSS remain separate.'};
  await writeFile(process.argv[3],JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(receipt));passed=true;
}finally{serializer.mock.restore();syncBuiltinESMExports();if(passed)await rm(root,{recursive:true,force:true});else console.error('Retained structural transport originals:',root);}
