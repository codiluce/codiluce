// Reproducible source-only Ruby/Rails/component workload comparison. Only Codiluce's
// indexer/parser/compiler runs; no target toolchain or dependency executes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { cpus, tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const project = fileURLToPath(new URL('../', import.meta.url)), args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name)+1] : fallback;
const worker = option('--worker');
if (worker) {
  const implementation = option('--implementation'), {indexRepository} = await import(pathToFileURL(path.join(implementation,'src/pipeline/index.ts')).href), {canonicalJson} = await import(pathToFileURL(path.join(implementation,'src/history/fingerprint.ts')).href);
  const {resolveConfig} = await import(pathToFileURL(path.join(implementation,'src/core/config.ts')).href);
  const config = await resolveConfig(worker,JSON.parse(await readFile(path.join(worker,'benchmark-config.json'),'utf8')));
  const shape = graph => createHash('sha256').update(canonicalJson({entities:graph.entities,relations:graph.relations,diagnostics:graph.diagnostics.filter(item=>!['indexer','git-metrics'].includes(item.analyzer)&&item.code!=='git-ignore-unavailable')})).digest('hex');
  const started = performance.now(), cold = await indexRepository(worker,{config});
  const coldMs = performance.now()-started, coldParentPeakKiB = process.resourceUsage().maxRSS;
  console.log(JSON.stringify({phase:'cold',coldMs,coldParentPeakKiB}));
  const cache = path.join(worker,'.codiluce',option('--cache'));
  await indexRepository(worker,{config,cache});
  console.log(JSON.stringify({phase:'warm-start'}));
  const warmStart = performance.now(), warm = await indexRepository(worker,{config,cache}), warmMs = performance.now()-warmStart;
  assert.equal(shape(cold),shape(warm),'cold/warm entities, relations and diagnostics must agree');
  console.log(JSON.stringify({phase:'done',warmMs,files:cold.entities.filter(e=>e.type==='file').length,entities:cold.entities.length,relations:cold.relations.length,endpoints:cold.entities.filter(e=>e.type==='api_endpoint').length,requests:cold.relations.filter(e=>e.type==='requests').length,handlers:cold.relations.filter(e=>e.type==='handles').length,diagnostics:cold.diagnostics.length,replayEqual:true}));
} else {
  if(process.platform!=='linux')throw new Error('Process-tree RSS sampling requires Linux /proc; do not relabel this as an OS release check');
  const repetitions = Number(option('--repetitions','3'));
  if(!Number.isInteger(repetitions)||repetitions<3||repetitions>20)throw new Error('repetitions must be between 3 and 20');
  const temporary = await mkdtemp(path.join(tmpdir(),'codiluce-ruby-benchmark-')), run=promisify(execFile);
  const command=(cmd,params,opts={})=>run(cmd,params,{cwd:project,timeout:240_000,maxBuffer:64<<20,...opts});
  const profiles = [
    ['rails71','7.1.0','2.6.18'], ['rails72','7.2.0','2.7.1'],
    ['rails80','8.0.0','2.7.2'], ['rails81','8.1.0','2.7.5'],
  ];
  const put=async(root,file,text)=>{await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),text);};
  // Sample the worker and recursive parser children from this separate driver:
  // the worker's synchronous compiler/indexer phases cannot stall the timer.
  function memory(pid,seen=new Set()) { if(seen.has(pid))return {rss:0,children:0};seen.add(pid);try{const status=readFileSync(`/proc/${pid}/status`,'utf8'),own=Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1]??0);const pids=readFileSync(`/proc/${pid}/task/${pid}/children`,'utf8').trim().split(/\s+/).filter(Boolean);const child=pids.reduce((sum,p)=>sum+memory(Number(p),seen).rss,0);return {rss:own+child,children:child};}catch{return {rss:0,children:0};} }
  function measure(parameters) { return new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--experimental-sqlite','--import','tsx',fileURLToPath(import.meta.url),...parameters],{cwd:project,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',pending='',phase='cold',cold={},result,peak=0,childPeak=0;const poll=()=>{const sample=memory(child.pid);peak=Math.max(peak,sample.rss);childPeak=Math.max(childPeak,sample.children);};const timer=setInterval(poll,25),deadline=setTimeout(()=>child.kill('SIGTERM'),240_000);child.stderr.on('data',text=>{stderr+=text;});child.stdout.on('data',text=>{stdout+=text;pending+=text;for(let end;(end=pending.indexOf('\n'))>=0;){const line=pending.slice(0,end);pending=pending.slice(end+1);if(!line)continue;const item=JSON.parse(line);if(item.phase==='cold'){poll();cold={...item,coldTreePeakKiB:peak,coldChildPeakKiB:childPeak};phase='population';}else if(item.phase==='warm-start'){phase='warm';peak=0;childPeak=0;}else if(item.phase==='done'){poll();result={...cold,...item,warmTreePeakKiB:peak,warmChildPeakKiB:childPeak};}}});child.once('error',error=>{clearInterval(timer);clearTimeout(deadline);reject(error);});child.once('exit',(code,signal)=>{clearInterval(timer);clearTimeout(deadline);if(code!==0||!result)reject(new Error(`Benchmark worker ${phase} failed (${signal??code}): ${stderr}\n${stdout}`));else{delete result.phase;resolve(result);}});}); }
  try {
    const baseline=path.join(temporary,'baseline');await mkdir(baseline);const revision=(await command('git',['rev-parse','--verify',`${option('--baseline-ref','abda373')}^{commit}`])).stdout.trim(),archive=path.join(temporary,'baseline.tar');
    await writeFile(archive,(await command('git',['archive',revision],{encoding:'buffer'})).stdout);await command('tar',['-xf',archive,'-C',baseline]);await symlink(path.join(project,'node_modules'),path.join(baseline,'node_modules'));
    const applications=[{name:'ts',path:'ts',ecosystems:['node']},{name:'vue',path:'vue',ecosystems:['node'],frameworks:['vue']},{name:'svelte',path:'svelte',ecosystems:['node'],frameworks:['svelte']},{name:'astro',path:'astro',ecosystems:['node'],frameworks:['astro']},...profiles.map(([name])=>({name,path:name,ecosystems:['ruby'],apiOrigins:[`https://${name}.test`]}))];
    const config={repository:{name:'ruby-mixed-benchmark'},applications,ignore:['**/node_modules/**','**/.codiluce/**','**/.git/**'],maxFileBytes:1<<20},results=[];
    for(const [name,count]of[['Small',3],['Medium',20],['Large',80]]){
      const root=path.join(temporary,name);await put(root,'benchmark-config.json',JSON.stringify(config));
      await put(root,'vue/package.json','{"dependencies":{"vue":"^3.5.0"}}');await put(root,'svelte/package.json','{"dependencies":{"svelte":"^5.57.2"}}');await put(root,'astro/package.json','{"dependencies":{"astro":"^7.3.8"}}');await put(root,'astro/astro.config.mjs','export default {output:"server"};');
      for(const [profile,version,loader]of profiles){
        await put(root,profile+'/Gemfile',`gem "rails", "${version}"`);
        await put(root,profile+'/Gemfile.lock',`GEM\n  specs:\n    rails (${version})\n    zeitwerk (${loader})\n`);
        await put(root,profile+'/config/application.rb','module Shop; class Application < Rails::Application; end; end');
        await put(root,profile+'/app/controllers/application_controller.rb','class ApplicationController < ActionController::Base; before_action :authenticate, only: [:show, :update]; private; def authenticate; end; end');
        await put(root,profile+'/config/routes.rb','Rails.application.routes.draw do; draw :api; end');
        await put(root,profile+'/config/routes/api.rb',`namespace :admin do; ${Array.from({length:count},(_,i)=>`resources :items${i}, only: [:show, :update]`).join(';')}; end`);
        for(let i=0;i<count;i++){
          await put(root,`${profile}/app/controllers/admin/items${i}_controller.rb`,`# original action source\nclass Admin::Items${i}Controller < ApplicationController\n def show; end\n def update; end\nend`);
          await put(root,`ts/${profile}${i}.ts`,`export function load(){return fetch("https://${profile}.test/admin/items${i}/1.json");} export function save(){return fetch("https://${profile}.test/admin/items${i}/1",{method:"PATCH"});}`);
        }
      }
      for(let i=0;i<count;i++){
        const calls=profiles.map(([profile])=>`fetch('https://${profile}.test/admin/items${i}/1.json')`);
        await put(root,`vue/Component${i}.vue`,`<script setup>const native=fetch;</script><template>${calls.map(call=>`<button @click="${call.replace('fetch(', 'native(')}"/>`).join('')}</template>`);
        await put(root,`svelte/Component${i}.svelte`,`<script>const native=fetch;</script>${calls.map(call=>`<button onclick={()=>${call.replace('fetch(', 'native(')}}>Load</button>`).join('')}`);
        await put(root,`astro/src/pages/page${i}.astro`,calls.map(call=>`{${call}}`).join('\n'));
      }
      const runs={baseline:[],current:[]};for(let repetition=0;repetition<repetitions;repetition++)for(const label of repetition%2?['current','baseline']:['baseline','current']){console.log(`${name}: ${label} ${repetition+1}/${repetitions}`);runs[label].push(await measure(['--worker',root,'--implementation',label==='baseline'?baseline:project,'--cache',`${label}-${repetition}`]));}
      const median=values=>{const v=[...values].sort((a,b)=>a-b),m=Math.floor(v.length/2);return v.length%2?v[m]:(v[m-1]+v[m])/2;},summarize=runs=>Object.fromEntries(Object.keys(runs[0]).filter(k=>typeof runs[0][k]==='number').map(key=>[key,median(runs.map(run=>run[key]))]));
      const before=summarize(runs.baseline),after=summarize(runs.current);for(const key of ['files','entities','relations','endpoints','requests','handlers'])assert.equal(before[key],after[key],`${name}: changed ${key}`);assert.equal(after.requests,count*20,'all TS/component requests reach Rails');assert.equal(after.endpoints,count*8,'all four Rails profiles show/update appear');assert.equal(after.handlers,after.endpoints);
      for(const samples of Object.values(runs))for(const sample of samples)for(const key of ['files','entities','relations','endpoints','requests','handlers'])assert.equal(sample[key],after[key],`${name}: every run must preserve ${key}`);
      results.push({name,routesPerProfile:count,baseline:before,current:after,runs});
    }
    const data={measuredAt:new Date().toISOString(),baseline:revision,current:'working tree',node:process.version,platform:`${process.platform}/${process.arch}`,cpu:cpus()[0]?.model,repetitions,pollMilliseconds:25,profiles:profiles.map(p=>({name:p[0],rails:p[1],zeitwerk:p[2]})),results};
    const escaped=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])),percent=(a,b)=>((a/b-1)*100).toFixed(1)+'%',passed=results.every(r=>r.current.coldMs<=r.baseline.coldMs*1.1&&r.current.coldTreePeakKiB<=r.baseline.coldTreePeakKiB*1.1);
    const rows=results.map(r=>`<tr><th>${r.name}<small>${r.current.files} files · ${r.current.endpoints} endpoints · ${r.current.requests} requests</small></th><td>${r.baseline.coldMs.toFixed(0)}</td><td>${r.current.coldMs.toFixed(0)}</td><td>${percent(r.current.coldMs,r.baseline.coldMs)}</td><td>${r.baseline.warmMs.toFixed(0)}</td><td>${r.current.warmMs.toFixed(0)}</td><td>${(r.baseline.coldTreePeakKiB/1024).toFixed(1)}</td><td>${(r.current.coldTreePeakKiB/1024).toFixed(1)}</td><td>${percent(r.current.coldTreePeakKiB,r.baseline.coldTreePeakKiB)}</td></tr>`).join('');
    const output=path.resolve(project,option('--output','docs/ruby-compatibility-performance.html'));
    await writeFile(output,`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ruby/Rails and component compatibility performance</title><style>body{font:16px/1.6 system-ui,sans-serif;background:#101822;color:#e5ecf4;margin:0;padding:32px}main{max-width:1200px;margin:auto}h1{line-height:1.2}p{max-width:1000px;color:#bdcbdc}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;border-bottom:1px solid #344353;padding:12px}small{display:block;color:#9dafc4;font-weight:400}a,code{color:#79ced3}code{overflow-wrap:anywhere}.status{border:1px solid #5a7882;padding:16px;border-radius:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere}@media(max-width:600px){body{padding:18px}}</style><main><h1>Ruby/Rails and component compatibility performance</h1><p>${escaped(data.measuredAt)} · ${escaped(data.node)} · ${escaped(data.platform)} · ${escaped(data.cpu)}. Medians of ${repetitions} fresh processes per implementation/sample; alternating order, identical installed parser/compiler dependencies.</p><p class="status"><strong>Local mixed-stack comparison: ${passed?'PASS':'NEEDS WORK'}</strong> — suggested 10% guardrails for cold-index time and sampled combined parent/parser-child RSS against the archived P7c baseline on these fixed workloads.</p><div class="scroll"><table><thead><tr><th>Sample</th><th>Before cold ms</th><th>After cold ms</th><th>Change</th><th>Before warm ms</th><th>After warm ms</th><th>Before tree MiB</th><th>After tree MiB</th><th>Change</th></tr></thead><tbody>${rows}</tbody></table></div><p>Each sample contains four Ruby/Rails application profiles (7.1, 7.2, 8.0, 8.1 with locked Zeitwerk 2.6/2.7), original namespaced controller actions, inherited private callback references, a source draw file, TypeScript clients and Vue/Svelte/Astro requests. Sizes use 3 / 20 / 80 resources per profile, each exposing show and update. Every endpoint has an original handler and all expected requests link; graph cardinalities agree before/after, and each cold/warm graph agrees on entities, relations and diagnostics. Fixtures use the shared P7c contract, including three-component versions and bracket action lists; newly supported four-component versions and symbol arrays have separate conformance tests. Literal manifests and source fixtures are generated by this harness. Target Ruby/Rails dependencies, toolchains, plugins and configuration never run.</p><p>Cold indexing has no parser/graph cache. Warm replay follows a cache-population pass. A separate driver samples the entire worker/parser process tree from Linux /proc every 25 ms, including synchronous indexing phases; short memory spikes between samples can be missed. Exact parent high-water RSS and sampled child/tree peaks are retained in the raw data. These results qualify this Linux host and synthetic workloads. They do not prove native Windows/macOS execution, full-history performance, grammar latency or production-repository accuracy. The original TS/Laravel guardrail remains a separate <a href="compatibility-performance.html">baseline report</a>.</p><p>Baseline: <code>${escaped(revision)}</code>. Current: working tree. Reproduce: <code>node scripts/benchmark-ruby-compatibility.mjs --baseline-ref ${escaped(revision)} --repetitions ${repetitions}</code>. <a href="language-framework-compatibility.html#implementation">Roadmap and evidence</a>.</p><details><summary>Raw measurements and profiles</summary><pre>${escaped(JSON.stringify(data,null,2))}</pre></details></main></html>`);console.log(JSON.stringify({output,passed,results:results.map(({runs,...r})=>r)},null,2));
  } finally {await rm(temporary,{recursive:true,force:true});}
}
