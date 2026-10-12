// Owned indexers only. No target runtime, dependency, hook or build executes.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {productionGraphDigest} from './production-graph-digest.mjs';
import {verifySourceContracts} from './production-source-contracts.mjs';
import {processPeakRssKiB} from './process-memory.mjs';

const request=JSON.parse(await readFile(process.argv[2],'utf8'));
const importFrom=file=>import(pathToFileURL(path.join(request.implementation,file)).href);
const [{indexRepository},{AnalysisCache}]=await Promise.all([importFrom('src/pipeline/index.ts'),importFrom('src/pipeline/cache.ts')]);
const acknowledge=type=>new Promise((resolve,reject)=>{
 const cleanup=()=>{process.off('message',receive);process.off('disconnect',disconnected);};
 const disconnected=()=>{cleanup();reject(Error('Observer disconnected before measurement acknowledgment'));};
 const receive=message=>{if(message?.type===type){cleanup();resolve();}};
 process.on('message',receive);process.once('disconnect',disconnected);process.send({type:type==='go'?'begin':'end'},error=>{if(error){cleanup();reject(error);}});
});
const cache=request.mode==='cold'?undefined:new AnalysisCache(request.cache);
await acknowledge('go');
// Revision scans intentionally disable the cache. Use the working-tree API
// with the observer's isolated, pinned, hooks-disabled Git metadata instead.
const started=performance.now(),graph=await indexRepository(request.tree,{config:structuredClone(request.profile.config),...cache?{cache}:{}});
const milliseconds=performance.now()-started,parentVmHwmKiB=processPeakRssKiB();
await acknowledge('digest-go'); // End the sampler before any verification work.
const logical=productionGraphDigest(graph);
const contracts=await verifySourceContracts({manifest:request.manifest,corpus:request.corpus,observations:{[request.profile.id]:request.observation},graphs:{[request.profile.id]:graph}});
assert.equal(contracts.graphContractsVerified,true,'Original named source contracts must remain verified');
assert.equal(graph.run.commitSha,request.profile.commit);
const result={mode:request.mode,milliseconds,parentVmHwmKiB,logical,contracts,cacheEvents:cache?.events??[],node:process.version};
await new Promise((resolve,reject)=>process.send({type:'result',result},error=>error?reject(error):resolve()));
process.disconnect();
