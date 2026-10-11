// Pool every observation from compatible performance-only qualification
// series. Never select runs or discard an earlier failed comparison.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const args=process.argv.slice(2),inputs=args.flatMap((arg,index)=>arg==='--input'?[args[index+1]]:[]);
assert.ok(inputs.length>=2&&inputs.every(Boolean),'Supply at least two --input HTML reports');
assert.equal(new Set(inputs.map(input=>path.resolve(input))).size,inputs.length,'Each input must be a distinct series');
const output=path.resolve(args[args.indexOf('--output')+1]??'docs/php-warm-compatibility-performance.html');
assert.ok(args.includes('--output'),'Supply --output separately from the input reports');
assert.ok(inputs.every(input=>path.resolve(input)!==output),'Preserve input reports until pooling finishes');
const decode=value=>value.replaceAll('&quot;','"').replaceAll('&#39;',"'").replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&');
const esc=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const reports=await Promise.all(inputs.map(async input=>{
 const html=await readFile(input,'utf8'),raw=html.match(/<pre>([\s\S]*?)<\/pre>/);assert.ok(raw,`${input}: missing raw observations`);
 return {input,data:JSON.parse(decode(raw[1]))};
}));
reports.sort((a,b)=>Date.parse(a.data.measuredAt)-Date.parse(b.data.measuredAt));
assert.equal(new Set(reports.map(({data})=>JSON.stringify(data.results.map(row=>row.runs)))).size,reports.length,'Copied observations cannot count as another fresh series');
const first=reports[0].data;
for(const {data}of reports){
 for(const key of ['phase','baseline','node','platform','cpu','memoryMethod','implementationFiles','implementationDigest'])assert.equal(data[key],first[key],`Same frozen implementation/environment: ${key}`);
 assert.match(data.implementationDigest,/^[a-f0-9]{64}$/);assert.ok(Number.isFinite(Date.parse(data.measuredAt)));
 assert.ok(Number.isInteger(data.repetitions)&&data.repetitions>=3);assert.deepEqual(data.results.map(row=>[row.name,row.generatedModulesPerLanguage]),first.results.map(row=>[row.name,row.generatedModulesPerLanguage]));
 assert.equal(data.series,undefined,'Only original, unpooled reports can be inputs');
}
const median=values=>{const sorted=[...values].sort((a,b)=>a-b),middle=Math.floor(sorted.length/2);return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;};
const summarize=runs=>Object.fromEntries(Object.keys(runs[0]).map(key=>[key,typeof runs[0][key]==='number'?median(runs.map(run=>run[key])):runs[0][key]]));
const gates=results=>results.map(row=>({name:row.name,cold:row.current.coldMs<=row.baseline.coldMs*1.1,memory:row.current.coldPeakRssKiB<=row.baseline.coldPeakRssKiB*1.1,warm:row.current.warmMs<=row.baseline.warmMs*1.1}));
const results=first.results.map((row,index)=>{
 const runs={baseline:[],current:[]};
 for(const {data}of reports)for(const label of ['baseline','current']){
  const samples=data.results[index].runs[label];assert.equal(samples.length,data.repetitions,'Every measured run is included');runs[label].push(...samples);
 }
 for(const label of ['baseline','current'])for(const run of runs[label]){
  for(const key of ['coldMs','warmMs','coldPeakRssKiB','warmPeakRssKiB'])assert.ok(Number.isFinite(run[key])&&run[key]>0,key);
  for(const key of ['files','entities','relations','diagnostics','legacyPhpSymbols','legacyPhpRelations','legacyIdentity','graphDigest'])assert.equal(run[key],runs.baseline[0][key],`Identical full graph in every series: ${row.name} ${label} ${key}`);
  assert.match(run.graphDigest,/^[a-f0-9]{64}$/);
 }
 return {...row,runs,baseline:summarize(runs.baseline),current:summarize(runs.current)};
});
const repetitions=reports.reduce((sum,{data})=>sum+data.repetitions,0),gateResults=gates(results),passed=gateResults.every(gate=>gate.cold&&gate.memory&&gate.warm);
const series=reports.map(({input,data})=>({input,measuredAt:data.measuredAt,repetitions:data.repetitions,gates:gates(data.results),summaries:data.results.map(({runs,...row})=>row)}));
const data={...first,measuredAt:reports.at(-1).data.measuredAt,repetitions,series,results,gates:gateResults,passed,pooling:'all observations; medians recomputed from raw runs; alternating order within each original series',qualifierDigest:createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex')};
const change=(current,baseline)=>`${((current/baseline-1)*100).toFixed(1)}%`;
const rows=results.map(row=>`<tr><th>${esc(row.name)}<small>${row.current.files} files · ${row.current.entities} entities · ${row.current.relations} relations</small></th><td>${row.baseline.coldMs.toFixed(0)} / ${row.current.coldMs.toFixed(0)}<small>${change(row.current.coldMs,row.baseline.coldMs)}</small></td><td>${row.baseline.warmMs.toFixed(0)} / ${row.current.warmMs.toFixed(0)}<small>${change(row.current.warmMs,row.baseline.warmMs)}</small></td><td>${(row.baseline.coldPeakRssKiB/1024).toFixed(1)} / ${(row.current.coldPeakRssKiB/1024).toFixed(1)}<small>${change(row.current.coldPeakRssKiB,row.baseline.coldPeakRssKiB)}</small></td></tr>`).join('');
const seriesRows=series.map((item,index)=>`<tr><th>Series ${index+1}<small>${item.repetitions} repetitions · ${esc(item.measuredAt)}</small></th><td>${item.gates.every(gate=>gate.cold&&gate.memory&&gate.warm)?'PASS':'NEEDS WORK'}</td><td>${item.summaries.map(row=>`${esc(row.name)}: cold ${change(row.current.coldMs,row.baseline.coldMs)}, warm ${change(row.current.warmMs,row.baseline.warmMs)}`).join('<br>')}</td></tr>`).join('');
await writeFile(output,`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PHP warm replay performance qualification</title><style>body{margin:0;padding:clamp(16px,4vw,40px);font:16px/1.6 system-ui,sans-serif;background:#101822;color:#e5ecf4}main{max-width:1200px;margin:auto}h1{font-size:clamp(28px,5vw,40px);line-height:1.2}a,code{color:#8bddd8}p,code{overflow-wrap:anywhere}.status{padding:18px;border:1px solid #b69459;border-radius:8px}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;min-width:750px}th,td{text-align:left;padding:12px;border-bottom:1px solid #344353}small{display:block;color:#b6c5d6}pre{font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}summary{cursor:pointer;padding:12px 0}</style></head><body><main><h1>PHP warm replay performance qualification</h1><p>${esc(data.phase)} · ${esc(data.node)} · ${esc(data.platform)} · ${esc(data.cpu)}. ${repetitions} fresh processes per implementation and size, pooled from ${series.length} alternating series (${series.map(item=>item.repetitions).join(' + ')} repetitions).</p><p class="status"><strong>Combined local cold/warm/parent-memory comparison: ${passed?'PASS':'NEEDS WORK'}</strong><br>All original observations remain included. The first medium cold median exceeded the ten-percent guard by 0.8 percentage points and varied substantially across repetitions. A predeclared larger second series investigates that uncertainty; both individual outcomes remain visible below. Pooling checks identical source digests, environment, sample identities and complete graph digests before recomputing medians. Timing remains a host-specific observation, not a causal proof.</p><div class="scroll"><table><thead><tr><th>Sample</th><th>Cold baseline / current ms</th><th>Warm baseline / current ms</th><th>Cold parent peak baseline / current MiB</th></tr></thead><tbody>${rows}</tbody></table></div><p>The small sample is the Next/Laravel integration fixture; medium and large have 250/1,500 TypeScript modules and as many PHP controllers. Every cold/warm pair preserves complete entities, relations and diagnostics. All baseline/current observations retain the same full graph digest, Laravel symbol identities, original source ranges and established relationship projection.</p><p>Ten-percent guards apply to cold time, warm time and cold parent RSS. Linux /proc VmHWM is cumulative since exec and excludes parser children. The separate <a href="php-warm-mixed-performance.html">mixed-language history/process-tree report</a> qualifies descendant memory and four original Git snapshots. The PHP transaction skips native tree hydration on qualified warm hits while freshly revalidating every recorded indexed read; failed, bounded, corrupt or over-budget inputs fall back to original sources. Cache-population costs, invalidation and native parser memory are separate observations.</p><div class="scroll"><table><thead><tr><th>Original series</th><th>Individual guards</th><th>Cold and warm median changes</th></tr></thead><tbody>${seriesRows}</tbody></table></div><p>Other project validation was idle during measurements. Host activity is uncontrolled; grammar latency, deeper/production histories, compiler/WASM budgets, native operating systems and broader source accuracy remain open. No target dependency, toolchain or application executes.</p><p>Baseline: <code>${esc(data.baseline)}</code>. Frozen implementation: <code>${esc(data.implementationDigest)}</code> (${data.implementationFiles} files). Pooling qualifier: <code>${data.qualifierDigest}</code>. <a href="php-warm-source-accuracy.html">Original-source audit</a> · <a href="language-framework-compatibility.html#implementation">Roadmap</a>.</p><p>Reproduce each series with <code>node --import tsx scripts/benchmark-compatibility.mjs --baseline-ref ${esc(data.baseline)} --phase ${esc(data.phase)} --repetitions N --output series-N.html</code>, using N=${series.map(item=>item.repetitions).join(' and ')}. Then run <code>node scripts/combine-compatibility-benchmarks.mjs ${series.map(item=>`--input series-${item.repetitions}.html`).join(' ')} --output ${esc(path.relative(process.cwd(),output))}</code>.</p><details><summary>All raw runs, original series outcomes, pooled medians and source identity</summary><pre>${esc(JSON.stringify(data,null,2))}</pre></details></main></body></html>`);
console.log(JSON.stringify({output,repetitions,passed,gates:gateResults,series:series.map(({summaries,...item})=>item),results:results.map(({runs,...row})=>row)},null,2));
if(!passed)process.exitCode=1;
