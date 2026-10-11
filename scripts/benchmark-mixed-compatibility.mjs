// Source-only release qualification. Only Codiluce, its parsers and Git run.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {mkdir,mkdtemp,readFile,readdir,rm,symlink,writeFile,stat} from 'node:fs/promises';
import {tmpdir,cpus} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {performance} from 'node:perf_hooks';
import {processPeakRssKiB,sampleProcessTreeRssKiB} from './process-memory.mjs';

const project=fileURLToPath(new URL('../',import.meta.url)),args=process.argv.slice(2),option=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback;
const execute=promisify(execFile),worker=option('--worker');
const hash=value=>createHash('sha256').update(value).digest('hex');
const put=async(root,file,content)=>{await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),content);};
if(worker){
 const implementation=option('--implementation'),importFrom=relative=>import(pathToFileURL(path.join(implementation,relative)).href);
 const [{indexRepository},{resolveConfig},{AnalysisCache},{canonicalJson},{indexHistory,HISTORY_DATABASE},{HistoryStore}]=await Promise.all([
  importFrom('src/pipeline/index.ts'),importFrom('src/core/config.ts'),importFrom('src/pipeline/cache.ts'),importFrom('src/history/fingerprint.ts'),importFrom('src/history/indexer.ts'),importFrom('src/history/store.ts'),
 ]);
 const fixture=JSON.parse(await readFile(path.join(worker,'.codiluce/benchmark-input.json'),'utf8')),config=await resolveConfig(worker,fixture.config),unit=option('--cache-unit');
 const result={phases:{},graphs:{}};
 const shape=(graph,history=false)=>hash(canonicalJson({entities:graph.entities.map(entity=>history?{...entity,metrics:entity.metrics?Object.fromEntries(Object.entries(entity.metrics).filter(([key])=>!['commits','authors','churn','lastChangedAt','lastCommit'].includes(key))):undefined}:entity),relations:graph.relations,diagnostics:graph.diagnostics.filter(d=>!['indexer','git-metrics'].includes(d.analyzer)&&d.code!=='git-ignore-unavailable')}));
 const start=phase=>new Promise((resolve,reject)=>{const ready=message=>{if(message?.type==='go'&&message.phase===phase){process.off('message',ready);resolve();}};process.on('message',ready);process.send({type:'begin',phase},error=>{if(error){process.off('message',ready);reject(error);}});});
 async function measure(phase,work){await start(phase);const begun=performance.now(),value=await work();result.phases[phase]={ms:performance.now()-begun,parentVmHwmKiB:processPeakRssKiB()};process.send({type:'end',phase});return value;}
 const cacheDirectory=path.join(worker,'.codiluce',unit,'cache'),cache=()=>new AnalysisCache(cacheDirectory);
 const cold=await measure('cold',()=>indexRepository(worker,{config}));
 const populationCache=cache(),population=await measure('population',()=>indexRepository(worker,{config,cache:populationCache}));
 const warmCache=cache(),warm=await measure('warm',()=>indexRepository(worker,{config,cache:warmCache}));
 assert.equal(shape(cold),shape(population));assert.equal(shape(cold),shape(warm));assert.ok(warmCache.events.length);assert.ok(warmCache.events.every(event=>event.hit));
 const requests=cold.relations.filter(edge=>edge.type==='requests');assert.equal(requests.length,fixture.expectedRequests);
 for(const language of fixture.languages)assert.ok(cold.entities.some(entity=>entity.language===language&&entity.sourceRange),language);
 for(const {application}of fixture.routes)assert.ok(cold.entities.some(entity=>entity.type==='api_endpoint'&&entity.path?.startsWith(application+'/')),application);
 const load=cold.entities.find(entity=>entity.path==='node/shared/index.ts'&&entity.name==='load');assert.ok(load);
 for(const consumer of ['web','admin']){const run=cold.entities.find(entity=>entity.path===`node/${consumer}/index.ts`&&entity.name==='run');assert.ok(run);assert.ok(cold.relations.some(edge=>edge.type==='calls'&&edge.from===run.id&&edge.to===load.id));}
 result.graphs={cold:shape(cold),population:shape(population),warm:shape(warm)};
 const shared=path.join(worker,'node/shared/index.ts'),original=await readFile(shared,'utf8'),changedCache=cache();
 try{
  await writeFile(shared,original.replace('/items0/2','/items0/3'));
  const changed=await measure('invalidation',()=>indexRepository(worker,{config,cache:changedCache}));
  const component=changedCache.events.find(event=>event.analyzer==='typescript-nextjs'&&!event.hit&&event.unit.includes('node/web'));
  assert.ok(component?.unit.includes('node/admin')&&component.unit.includes('node/shared'));
  assert.ok(changedCache.events.filter(event=>event.analyzer==='typescript-nextjs'&&event.unit!==component.unit).every(event=>event.hit));
  assert.notEqual(changed.entities.find(entity=>entity.id===load.id).metadata.bodyHash,load.metadata.bodyHash);
  const independent=await measure('invalidation-check',()=>indexRepository(worker,{config}));assert.equal(shape(changed),shape(independent));result.graphs.changed=shape(changed);
 }finally{await writeFile(shared,original);}
 const state=path.join(worker,'.codiluce',unit,'history');await put(state,'config.yml',JSON.stringify(fixture.config));
 const history=await measure('history',()=>indexHistory({root:worker,stateDirectory:state,ref:'main',jobs:2}));assert.equal(history.failed,0);assert.equal(history.indexed,fixture.commits.length);assert.equal(history.snapshots,fixture.commits.length);
 const resume=await measure('resume',()=>indexHistory({root:worker,stateDirectory:state,ref:'main',jobs:2}));assert.equal(resume.indexed,0);assert.equal(resume.skipped,fixture.commits.length);assert.equal(resume.failed,0);
 function historyGraphs(directory){const store=new HistoryStore(path.join(directory,HISTORY_DATABASE),true);try{return store.snapshots().map(snapshot=>{
  const rows=(table,membership)=>store.db.prepare(`SELECT v.data FROM ${membership} m JOIN ${table} v ON v.vid=m.version WHERE m.snapshot=?`).all(snapshot.seq).map(row=>JSON.parse(row.data));
  const graph={entities:rows('entity_versions','snapshot_entities').sort((a,b)=>a.id.localeCompare(b.id)),relations:rows('relation_versions','snapshot_relations').sort((a,b)=>a.id.localeCompare(b.id)),diagnostics:rows('diagnostic_versions','snapshot_diagnostics').sort((a,b)=>a.id.localeCompare(b.id))};
  return {sha:snapshot.commitSha,digest:shape(graph),entities:graph.entities.length,relations:graph.relations.length,diagnostics:graph.diagnostics.length};
 }).sort((a,b)=>a.sha.localeCompare(b.sha));}finally{store.close();}}
 const snapshots=historyGraphs(state);assert.equal(new Set(snapshots.map(snapshot=>snapshot.sha)).size,fixture.commits.length);
 assert.equal(snapshots.find(snapshot=>snapshot.sha===fixture.commits.at(-1)).digest,shape(warm,true));
 if(args.includes('--verify-serial')){const serial=path.join(worker,'.codiluce',unit,'serial');await put(serial,'config.yml',JSON.stringify(fixture.config));const reference=await measure('serial-check',()=>indexHistory({root:worker,stateDirectory:serial,ref:'main',jobs:1}));assert.equal(reference.failed,0);assert.deepEqual(historyGraphs(serial),snapshots);result.serialEqual=true;}
 const eventSummary=events=>{const summary={};for(const event of events){const entry=summary[event.analyzer]??={hits:0,misses:0,ms:0};entry[event.hit?'hits':'misses']++;entry.ms+=event.ms;}return summary;};
 const cacheFiles=(await readdir(cacheDirectory)).filter(name=>name.endsWith('.json.gz')),cacheBytes=(await Promise.all(cacheFiles.map(name=>stat(path.join(cacheDirectory,name))))).reduce((sum,entry)=>sum+entry.size,0);assert.ok(cacheBytes<=256*1024*1024);
 Object.assign(result,{files:cold.entities.filter(entity=>entity.type==='file').length,entities:cold.entities.length,relations:cold.relations.length,diagnostics:cold.diagnostics.length,endpoints:cold.entities.filter(entity=>entity.type==='api_endpoint').length,requests:requests.length,cacheFiles:cacheFiles.length,cacheBytes,cache:{population:eventSummary(populationCache.events),warm:eventSummary(warmCache.events),invalidation:eventSummary(changedCache.events)},history,resume,snapshots,replayEqual:true,invalidationEqual:true});
 process.send({type:'result',result},()=>process.disconnect());
}else{
 if(process.platform!=='linux')throw Error('Mixed process-tree qualification requires Linux /proc; native OS gates are separate');
 const repetitions=Number(option('--repetitions','3'));if(!Number.isInteger(repetitions)||repetitions<3||repetitions>20)throw Error('Repetitions must be 3–20');
 const run=(command,parameters,options={})=>execute(command,parameters,{cwd:project,timeout:240000,maxBuffer:128<<20,...options});
 const temporary=await mkdtemp(path.join(tmpdir(),'codiluce-mixed-benchmark-')),output=path.resolve(project,option('--output','docs/mixed-compatibility-performance.html'));
 function measure(parameters){return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['--experimental-sqlite','--import','tsx',fileURLToPath(import.meta.url),...parameters],{cwd:project,detached:true,serialization:'advanced',stdio:['ignore','pipe','pipe','ipc']});
  let phase,result,errorText='',failure;const samples={};
  const stop=()=>{try{process.kill(-child.pid,'SIGTERM');}catch{}};
  const poll=()=>{if(!phase)return;const memory=sampleProcessTreeRssKiB(child.pid),sample=samples[phase];if(!memory.available)return;sample.polls++;sample.incompletePolls+=Number(memory.incomplete);sample.treePeakKiB=Math.max(sample.treePeakKiB,memory.rssKiB);sample.childPeakKiB=Math.max(sample.childPeakKiB,memory.childRssKiB);sample.maxProcesses=Math.max(sample.maxProcesses,memory.processes);};
  const timer=setInterval(poll,25),deadline=setTimeout(()=>{failure=Error('Mixed qualification worker exceeded 240 seconds');stop();},240000);
  child.stderr.on('data',chunk=>{if(errorText.length<65536)errorText+=String(chunk);});child.stdout.resume();
  child.on('message',message=>{if(message.type==='begin'){phase=message.phase;samples[phase]={polls:0,incompletePolls:0,treePeakKiB:0,childPeakKiB:0,maxProcesses:0};poll();child.send({type:'go',phase});}else if(message.type==='end'){poll();phase=undefined;}else if(message.type==='result')result=message.result;});
  child.once('error',error=>{failure=error;stop();});
  child.once('close',(code,signal)=>{clearInterval(timer);clearTimeout(deadline);stop();if(failure||code!==0||!result){reject(failure??Error(`Mixed worker failed (${signal??code}): ${errorText}`));return;}for(const [name,sample]of Object.entries(samples)){assert.ok(sample.polls>0,`${name} must have RSS samples`);Object.assign(result.phases[name],sample);}resolve(result);});
 });}
 try{
  const revision=(await run('git',['rev-parse','--verify',`${option('--baseline-ref','HEAD')}^{commit}`])).stdout.trim(),baseline=path.join(temporary,'baseline');await mkdir(baseline);
  const archive=path.join(temporary,'baseline.tar');await writeFile(archive,(await run('git',['archive',revision],{encoding:'buffer'})).stdout);await run('tar',['-xf',archive,'-C',baseline]);await symlink(path.join(project,'node_modules'),path.join(baseline,'node_modules'));
  const [{mixedWorkload},{STRUCTURAL_LANGUAGES}]=await Promise.all([import('./fixtures/mixed-workload.ts'),import('../src/analysis/tree-sitter/grammars.ts')]);
  const results=[];
  const chosen=option('--sample');if(chosen&&!['Small','Medium','Large'].includes(chosen))throw Error('Sample must be Small, Medium or Large');
  for(const [name,count]of [['Small',1],['Medium',4],['Large',16]].filter(([name])=>!chosen||name===chosen)){
   const root=path.join(temporary,name),workload=await mixedWorkload(count);for(const [file,content]of Object.entries(workload.files))await put(root,file,content);
   const env={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'Qualification',GIT_AUTHOR_EMAIL:'qualification@example.test',GIT_COMMITTER_NAME:'Qualification',GIT_COMMITTER_EMAIL:'qualification@example.test'};
   const git=(...parameters)=>run('git',['-c','core.hooksPath=/dev/null',...parameters],{cwd:root,env});await git('init','-q','-b','main');
   const commits=[];const commit=async message=>{await git('add','-A');await git('commit','-q','-m',message);commits.push((await git('rev-parse','HEAD')).stdout.trim());};
   await commit('Initial mixed source contracts');await put(root,'node/shared/index.ts',workload.files['node/shared/index.ts'].replace('/items0/1','/items0/2'));await commit('Edit a shared workspace dependency');
   await put(root,'laravel/app/Http/Controllers/ItemsController.php',workload.files['laravel/app/Http/Controllers/ItemsController.php'].replace('return "ok"','return "changed"'));await commit('Edit an original Laravel method body');
   await git('mv','jvm/vue/Component0.vue','jvm/vue/Renamed.vue');await commit('Rename an original Vue component');
   await put(root,'.codiluce/benchmark-input.json',JSON.stringify({...workload,files:undefined,commits,languages:[...STRUCTURAL_LANGUAGES,'php','typescript','vue','svelte','astro']}));
   const fixtureDigest=hash(JSON.stringify(Object.entries(workload.files).sort(([a],[b])=>a.localeCompare(b)).map(([file,content])=>[file,hash(content)]))),runs={baseline:[],current:[]};
   for(let repetition=0;repetition<repetitions;repetition++)for(const label of repetition%2?['current','baseline']:['baseline','current']){
    console.log(`${name}: ${label} ${repetition+1}/${repetitions} · cold/cache/edit/history/resume`);
    runs[label].push(await measure(['--worker',root,'--implementation',label==='baseline'?baseline:project,'--cache-unit',`${label}-${repetition}`,...repetition===0?['--verify-serial']:[]]));
   }
   const median=values=>{const ordered=[...values].sort((a,b)=>a-b),i=Math.floor(ordered.length/2);return ordered.length%2?ordered[i]:(ordered[i-1]+ordered[i])/2;};
   const summarize=runs=>({phases:Object.fromEntries(['cold','population','warm','invalidation','history','resume'].map(phase=>[phase,Object.fromEntries(['ms','treePeakKiB','childPeakKiB','maxProcesses','parentVmHwmKiB'].map(key=>[key,median(runs.map(run=>run.phases[phase][key]))]))])),...Object.fromEntries(['files','entities','relations','diagnostics','endpoints','requests','cacheFiles','cacheBytes'].map(key=>[key,median(runs.map(run=>run[key]))]))});
   for(const label of ['baseline','current'])for(const sample of runs[label]){for(const key of ['files','entities','relations','diagnostics','endpoints','requests'])assert.equal(sample[key],runs.baseline[0][key]);assert.deepEqual(sample.graphs,runs.baseline[0].graphs);assert.deepEqual(sample.snapshots,runs.baseline[0].snapshots);}
   results.push({name,resourcesPerProfile:count,fixtureDigest,commits,profiles:workload.profileNames,baseline:summarize(runs.baseline),current:summarize(runs.current),runs});
  }
  const gates=results.map(result=>({name:result.name,cold:result.current.phases.cold.ms<=result.baseline.phases.cold.ms*1.1,warm:result.current.phases.warm.ms<=result.baseline.phases.warm.ms*1.1,history:result.current.phases.history.ms<=result.baseline.phases.history.ms*1.1,memory:['cold','warm','history'].every(phase=>result.current.phases[phase].treePeakKiB<=result.baseline.phases[phase].treePeakKiB*1.1)})),passed=gates.every(gate=>gate.cold&&gate.warm&&gate.history&&gate.memory);
  const sourcePaths=(await run('git',['ls-files','-z','--cached','--others','--exclude-standard','--','src','grammars','package.json','package-lock.json','scripts/fixtures/mixed-workload.ts','scripts/fixtures/jvm-dotnet-workload.ts','scripts/fixtures/rust-workload.ts','scripts/benchmark-mixed-compatibility.mjs','scripts/process-memory.mjs','tests/cache.test.ts','tests/php-analysis-cache.test.ts','tests/process-memory.test.ts','tests/mixed-release.test.ts','tests/fixtures/structure'])).stdout.split('\0').filter(Boolean).sort(),implementationHash=createHash('sha256');for(const file of sourcePaths)implementationHash.update(file+'\0').update(await readFile(path.join(project,file))).update('\0');
  const data={phase:option('--phase','P10d1'),measuredAt:new Date().toISOString(),baseline:revision,current:'qualified working tree',implementationFiles:sourcePaths.length,implementationDigest:implementationHash.digest('hex'),node:process.version,platform:`${process.platform}/${process.arch}`,cpu:cpus()[0]?.model,repetitions,pollMilliseconds:25,memoryMethod:'linux-proc-all-thread-descendants-sampled-rss',cacheLimits:{perUnit:2,maxBytes:256*1024*1024,maxEntryBytes:64*1024*1024},passed,gates,results};
  const esc=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])),change=(current,baseline)=>`${((current/baseline-1)*100).toFixed(1)}%`;
  const rows=results.map(result=>`<tr><th>${result.name}<small>${result.current.files} files · ${result.current.endpoints} endpoints · ${result.current.requests} requests</small></th>${['cold','warm','history'].map(phase=>`<td>${result.baseline.phases[phase].ms.toFixed(0)} / ${result.current.phases[phase].ms.toFixed(0)}<small>${change(result.current.phases[phase].ms,result.baseline.phases[phase].ms)}</small></td>`).join('')}<td>${(result.current.phases.history.treePeakKiB/1024).toFixed(1)}<small>${change(result.current.phases.history.treePeakKiB,result.baseline.phases.history.treePeakKiB)}</small></td><td>${(result.current.cacheBytes/1024).toFixed(1)}</td></tr>`).join('');
  await writeFile(output,`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mixed compatibility and history qualification</title><style>body{margin:0;padding:clamp(16px,4vw,40px);font:16px/1.6 system-ui,sans-serif;background:#101822;color:#e5ecf4}main{max-width:1200px;margin:auto}h1{line-height:1.2;font-size:clamp(28px,5vw,40px)}a,code{color:#8bddd8}p,code{overflow-wrap:anywhere}.status{border:1px solid #b69459;border-radius:8px;padding:18px}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;min-width:850px}th,td{padding:12px;text-align:left;border-bottom:1px solid #344353}small{display:block;color:#b6c5d6}pre{font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}summary{cursor:pointer;padding:12px 0}</style></head><body><main><h1>Mixed language, cache and history qualification</h1><p>${esc(data.phase)} · ${esc(data.measuredAt)} · ${esc(data.node)} · ${esc(data.platform)} · ${esc(data.cpu)}. ${repetitions} alternating fresh processes per implementation and size.</p><p class="status"><strong>Local cold/warm/history/tree-memory comparison: ${passed?'PASS':'NEEDS WORK'}</strong><br>Ten-percent limits against the archived baseline implementation on identical authored mixed workloads. Exact full graph digests hold across cold/population/warm, edited dependency replay versus uncached source, every baseline/current run, and all four stored historical snapshots. Every first repetition also compares two history jobs with an independent single-job run. History resume skips all four completed snapshots.</p><div class="scroll"><table><thead><tr><th>Sample</th><th>Cold before / after ms</th><th>Warm before / after ms</th><th>Four-commit history before / after ms</th><th>Current sampled history tree MiB</th><th>Current cache KiB</th></tr></thead><tbody>${rows}</tbody></table></div><p>The monorepo combines all eighteen Tree-sitter structural adapters, PHP, TypeScript and original Vue/Svelte/Astro sources; Express/Nest, FastAPI/Flask/Django, Rails/Laravel, eight Go router profiles, Java/Kotlin MVC/WebFlux and ASP.NET 8/9/10, and six Rust router/version profiles. Recorded target inputs qualify source contracts on Linux; they do not establish native Windows/macOS execution or framework runtime validity. Target dependencies, toolchains, applications, plugins and hooks never run. The literal fixtures are authored qualification inputs, not upstream repository accuracy evidence.</p><p>Cold scans have no cache. Population, warm and a shared Node dependency edit are timed separately. Both original consumer call targets bind to the shared source; the edit invalidates their connected cache unit while unrelated TypeScript units stay hits. Warm graph, syntax and semantic cache events are recorded by analyzer; a qualified PHP graph hit skips native-tree hydration. The cache keeps at most two versions per unit, 256 MiB compressed overall and 64 MiB decoded per entry; oversized/corrupt entries fall back to source rather than blocking indexing.</p><p>The four-commit history edits the shared dependency and an original PHP body, then renames a Vue component. Two history workers materialize original Git trees; snapshots include complete entities, relations and diagnostics, not just counts. Only working-tree Git metrics and Git-availability diagnostics are normalized for live-versus-revision comparisons. All semantic metadata, evidence and original ranges remain in the digest.</p><p>A separate process polls every thread's descendant list every 25 ms, with an acknowledged start marker before synchronous work. RSS sums include history and parser children; shared pages can be counted repeatedly, exiting processes can make a poll incomplete, and peaks between polls can be missed. Raw parent VmHWM is cumulative since exec, not an isolated warm/history peak. Native OS readers, isolated grammar-load latency, deeper histories, production-repository accuracy remain additional P10d gates. This report records the current PHP warm profile against its named baseline.</p><p>Baseline: <code>${esc(revision)}</code>. Frozen current source: <code>${esc(data.implementationDigest)}</code> (${sourcePaths.length} files). Reproduce: <code>node --import tsx scripts/benchmark-mixed-compatibility.mjs --baseline-ref ${esc(revision)} --repetitions ${repetitions} --phase ${esc(data.phase)} --output ${esc(path.relative(project,output))}</code>. <a href="language-framework-compatibility.html#implementation">Roadmap</a>.</p><details><summary>Raw phase timings, cache events, snapshot digests, profiles and limits</summary><pre>${esc(JSON.stringify(data,null,2))}</pre></details></main></body></html>`);
  console.log(JSON.stringify({output,passed,gates,results:results.map(({runs,...result})=>result)},null,2));if(!passed)process.exitCode=1;
 }finally{await rm(temporary,{recursive:true,force:true});}
}
