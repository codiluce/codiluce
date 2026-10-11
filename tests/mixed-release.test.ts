import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {mixedWorkload} from '../scripts/fixtures/mixed-workload.js';
import {indexRepository} from '../src/pipeline/index.js';
import {resolveConfig} from '../src/core/config.js';
import {AnalysisCache} from '../src/pipeline/cache.js';
import {canonicalJson} from '../src/history/fingerprint.js';
import {STRUCTURAL_LANGUAGES} from '../src/analysis/tree-sitter/grammars.js';

test('all language adapters and framework families coexist with exact cache replay and shared-workspace invalidation',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'codiluce-mixed-release-'));
 try{
  const workload=await mixedWorkload();for(const [file,content]of Object.entries(workload.files)){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),content);}
  const config=await resolveConfig(root,workload.config),cache=new AnalysisCache(path.join(root,'.codiluce/cache'));
  await mkdir(cache.directory,{recursive:true});
  const cold=await indexRepository(root,{config,cache}),warmCache=new AnalysisCache(cache.directory),warm=await indexRepository(root,{config,cache:warmCache});
  const shape=(graph:typeof cold)=>canonicalJson({entities:graph.entities,relations:graph.relations,diagnostics:graph.diagnostics.filter(d=>!['git-metrics','indexer'].includes(d.analyzer)&&d.code!=='git-ignore-unavailable')});
  assert.equal(shape(warm),shape(cold));assert.equal(cold.relations.filter(r=>r.type==='requests').length,workload.expectedRequests);
  assert.ok(warmCache.events.every(e=>e.hit),JSON.stringify(warmCache.events.filter(e=>!e.hit)));
  for(const language of [...STRUCTURAL_LANGUAGES,'php','typescript','vue','svelte','astro'])assert.ok(cold.entities.some(e=>e.language===language&&e.sourceRange),language);
  for(const {application}of workload.routes)assert.ok(cold.entities.some(e=>e.type==='api_endpoint'&&e.path?.startsWith(application+'/')),application);
  const load=cold.entities.find(e=>e.name==='load'&&e.path==='node/shared/index.ts')!;
  for(const name of ['web','admin']){const run=cold.entities.find(e=>e.name==='run'&&e.path===`node/${name}/index.ts`)!;assert.ok(cold.relations.some(r=>r.type==='calls'&&r.from===run.id&&r.to===load.id));}
  const shared=path.join(root,'node/shared/index.ts');await writeFile(shared,(await readFile(shared,'utf8')).replace('/items0/1','/items0/2'));
  const changedCache=new AnalysisCache(cache.directory),changed=await indexRepository(root,{config,cache:changedCache});
  const component=changedCache.events.find(e=>e.analyzer==='typescript-nextjs'&&!e.hit&&e.unit.includes('node/web'));
  assert.ok(component,JSON.stringify(changedCache.events.filter(e=>e.analyzer==='typescript-nextjs')));assert.ok(component.unit.includes('node/admin'));assert.ok(component.unit.includes('node/shared'));
  assert.ok(changedCache.events.filter(e=>e.analyzer==='typescript-nextjs'&&e.unit!==component.unit).every(e=>e.hit));
  assert.equal(shape(changed),shape(await indexRepository(root,{config})));assert.notEqual(changed.entities.find(e=>e.id===load.id)!.metadata.bodyHash,load.metadata.bodyHash);
  assert.equal(changed.relations.filter(r=>r.type==='requests').length,workload.expectedRequests);
 }finally{await rm(root,{recursive:true,force:true});}
});
