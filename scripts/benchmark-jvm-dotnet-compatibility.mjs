// Run with node --import tsx. Only Codiluce's parser/compiler/indexer executes.
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
import { jvmDotnetWorkload, jvmProfiles, aspnetProfiles } from './fixtures/jvm-dotnet-workload.ts';

const project = fileURLToPath(new URL('../', import.meta.url)), args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const worker = option('--worker');
const escaped = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
if (worker) {
  const implementation = option('--implementation');
  const { indexRepository } = await import(pathToFileURL(path.join(implementation, 'src/pipeline/index.ts')).href);
  const { canonicalJson } = await import(pathToFileURL(path.join(implementation, 'src/history/fingerprint.ts')).href);
  const { resolveConfig } = await import(pathToFileURL(path.join(implementation, 'src/core/config.ts')).href);
  const { AnalysisCache } = await import(pathToFileURL(path.join(implementation, 'src/pipeline/cache.ts')).href);
  const config = await resolveConfig(worker, JSON.parse(await readFile(path.join(worker, 'benchmark-config.json'), 'utf8')));
  const shape = graph => createHash('sha256').update(canonicalJson({ entities: graph.entities, relations: graph.relations, diagnostics: graph.diagnostics.filter(d => !['indexer', 'git-metrics'].includes(d.analyzer) && d.code !== 'git-ignore-unavailable') })).digest('hex');
  const started = performance.now(), cold = await indexRepository(worker, { config }), coldMs = performance.now() - started;
  console.log(JSON.stringify({ phase: 'cold', coldMs, coldParentPeakKiB: process.resourceUsage().maxRSS }));
  // Keep cache state outside the source tree: creating an in-tree directory
  // changes the resolver's observed path inventory between population/replay.
  const directory = option('--cache');
  await indexRepository(worker, { config, cache: new AnalysisCache(directory) });
  console.log(JSON.stringify({ phase: 'warm-start' }));
  const cache = new AnalysisCache(directory), warmStart = performance.now(), warm = await indexRepository(worker, { config, cache }), warmMs = performance.now() - warmStart;
  assert.equal(shape(cold), shape(warm), 'cold/warm entities, relations and diagnostics must agree');
  for (const analyzer of ['syntax-facts', 'jvm-imports', 'csharp-imports', 'embedded-source', 'typescript-nextjs']) assert.ok(cache.events.some(e => e.analyzer === analyzer && e.hit), `${analyzer}: actual warm cache hit required`);
  console.log(JSON.stringify({ phase: 'done', warmMs, files: cold.entities.filter(e => e.type === 'file').length, entities: cold.entities.length, relations: cold.relations.length, endpoints: cold.entities.filter(e => e.type === 'api_endpoint').length, requests: cold.relations.filter(e => e.type === 'requests').length, handlers: cold.relations.filter(e => e.type === 'handles').length, diagnostics: cold.diagnostics.length, graphDigest: shape(cold), cacheHits: cache.events.filter(e => e.hit).length, cacheMisses: cache.events.filter(e => !e.hit).length, replayEqual: true }));
} else {
  if (process.platform !== 'linux') throw new Error('Process-tree RSS sampling requires Linux /proc; native OS release checks are separate');
  const repetitions = Number(option('--repetitions', '3'));
  if (!Number.isInteger(repetitions) || repetitions < 3 || repetitions > 20) throw new Error('repetitions must be 3–20');
  const temporary = await mkdtemp(path.join(tmpdir(), 'codiluce-jvm-dotnet-benchmark-')), run = promisify(execFile);
  const command = (cmd, params, opts = {}) => run(cmd, params, { cwd: project, timeout: 300_000, maxBuffer: 64 << 20, ...opts });
  const put = async (root, file, text) => { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); };
  // The driver timer continues through synchronous indexing and parser work.
  function memory(pid, seen = new Set()) {
    if (seen.has(pid)) return { rss: 0, children: 0 }; seen.add(pid);
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8'), own = Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0);
      const pids = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean);
      const children = pids.reduce((sum, p) => sum + memory(Number(p), seen).rss, 0);
      return { rss: own + children, children };
    } catch { return { rss: 0, children: 0 }; }
  }
  function measure(parameters) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--experimental-sqlite', '--import', 'tsx', fileURLToPath(import.meta.url), ...parameters], { cwd: project, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', pending = '', phase = 'cold', cold = {}, result, peak = 0, childPeak = 0;
      const poll = () => { const sample = memory(child.pid); peak = Math.max(peak, sample.rss); childPeak = Math.max(childPeak, sample.children); };
      const timer = setInterval(poll, 25), deadline = setTimeout(() => child.kill('SIGTERM'), 300_000);
      child.stderr.on('data', text => { stderr += text; });
      child.stdout.on('data', text => {
        stdout += text; pending += text;
        for (let end; (end = pending.indexOf('\n')) >= 0;) {
          const line = pending.slice(0, end); pending = pending.slice(end + 1); if (!line) continue;
          const item = JSON.parse(line);
          if (item.phase === 'cold') { poll(); cold = { ...item, coldTreePeakKiB: peak, coldChildPeakKiB: childPeak }; phase = 'population'; }
          else if (item.phase === 'warm-start') { phase = 'warm'; peak = 0; childPeak = 0; }
          else if (item.phase === 'done') { poll(); result = { ...cold, ...item, warmTreePeakKiB: peak, warmChildPeakKiB: childPeak }; }
        }
      });
      child.once('error', error => { clearInterval(timer); clearTimeout(deadline); reject(error); });
      child.once('exit', (code, signal) => { clearInterval(timer); clearTimeout(deadline); if (code !== 0 || !result) reject(new Error(`Worker ${phase} failed (${signal ?? code}): ${stderr}\n${stdout}`)); else { delete result.phase; resolve(result); } });
    });
  }
  try {
    const baseline = path.join(temporary, 'baseline'); await mkdir(baseline);
    const revision = (await command('git', ['rev-parse', '--verify', `${option('--baseline-ref', '040fbe3')}^{commit}`])).stdout.trim(), archive = path.join(temporary, 'baseline.tar');
    await writeFile(archive, (await command('git', ['archive', revision], { encoding: 'buffer' })).stdout);
    await command('tar', ['-xf', archive, '-C', baseline]); await symlink(path.join(project, 'node_modules'), path.join(baseline, 'node_modules'));
    const results = [];
    for (const [name, count] of [['Small', 3], ['Medium', 20], ['Large', 80]]) {
      const root = path.join(temporary, name), workload = jvmDotnetWorkload(count);
      await put(root, 'benchmark-config.json', JSON.stringify(workload.config));
      for (const [file, text] of Object.entries(workload.files)) await put(root, file, text);
      const runs = { baseline: [], current: [] };
      for (let repetition = 0; repetition < repetitions; repetition++) for (const label of repetition % 2 ? ['current', 'baseline'] : ['baseline', 'current']) {
        console.log(`${name}: ${label} ${repetition + 1}/${repetitions}`);
        runs[label].push(await measure(['--worker', root, '--implementation', label === 'baseline' ? baseline : project, '--cache', path.join(temporary, 'cache', name, `${label}-${repetition}`)]));
      }
      const median = values => { const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; };
      const summarize = samples => Object.fromEntries(Object.keys(samples[0]).filter(k => typeof samples[0][k] === 'number').map(key => [key, median(samples.map(sample => sample[key]))]));
      const before = summarize(runs.baseline), after = summarize(runs.current);
      assert.equal(after.endpoints, workload.expectedEndpoints); assert.equal(after.requests, workload.expectedRequests); assert.equal(after.handlers, after.endpoints);
      for (const samples of Object.values(runs)) for (const sample of samples) {
        for (const key of ['files', 'entities', 'relations', 'endpoints', 'requests', 'handlers']) assert.equal(sample[key], after[key], `${name}: every run preserves ${key}`);
        assert.equal(sample.graphDigest, runs.baseline[0].graphDigest, `${name}: before/after graph fingerprints agree`);
      }
      results.push({ name, resourcesPerProfile: count, baseline: before, current: after, runs });
    }
    const data = { measuredAt: new Date().toISOString(), baseline: revision, current: 'working tree', node: process.version, platform: `${process.platform}/${process.arch}`, cpu: cpus()[0]?.model, repetitions, pollMilliseconds: 25, profiles: { jvm: jvmProfiles, aspnet: aspnetProfiles }, results };
    const percent = (a, b) => ((a / b - 1) * 100).toFixed(1) + '%', passed = results.every(r => r.current.coldMs <= r.baseline.coldMs * 1.1 && r.current.coldTreePeakKiB <= r.baseline.coldTreePeakKiB * 1.1);
    const rows = results.map(r => `<tr><th>${r.name}<small>${r.current.files} files · ${r.current.endpoints} endpoints · ${r.current.requests} requests</small></th><td>${r.baseline.coldMs.toFixed(0)}</td><td>${r.current.coldMs.toFixed(0)}</td><td>${percent(r.current.coldMs, r.baseline.coldMs)}</td><td>${r.baseline.warmMs.toFixed(0)}</td><td>${r.current.warmMs.toFixed(0)}</td><td>${(r.baseline.coldTreePeakKiB / 1024).toFixed(1)}</td><td>${(r.current.coldTreePeakKiB / 1024).toFixed(1)}</td><td>${percent(r.current.coldTreePeakKiB, r.baseline.coldTreePeakKiB)}</td></tr>`).join('');
    const output = path.resolve(project, option('--output', 'docs/jvm-dotnet-compatibility-performance.html'));
    await writeFile(output, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>JVM/.NET and component compatibility performance</title><style>body{font:16px/1.6 system-ui,sans-serif;background:#101822;color:#e5ecf4;margin:0;padding:32px}main{max-width:1200px;margin:auto}h1{line-height:1.2}p{max-width:1000px;color:#bdcbdc}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;border-bottom:1px solid #344353;padding:12px}small{display:block;color:#9dafc4;font-weight:400}a,code{color:#79ced3}code{overflow-wrap:anywhere}.status{border:1px solid #5a7882;padding:16px;border-radius:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere}@media(max-width:600px){body{padding:18px}}</style><main><h1>JVM/.NET and component compatibility performance</h1><p>${escaped(data.measuredAt)} · ${escaped(data.node)} · ${escaped(data.platform)} · ${escaped(data.cpu)}. Medians of ${repetitions} fresh processes per implementation/sample; alternating order and identical installed parser/compiler dependencies.</p><p class="status"><strong>Local mixed-stack comparison: ${passed ? 'PASS' : 'NEEDS WORK'}</strong> — suggested 10% guardrails for cold indexing and sampled combined parent/parser-child RSS against the archived P8d2 baseline.</p><div class="scroll"><table><thead><tr><th>Sample</th><th>Before cold ms</th><th>After cold ms</th><th>Change</th><th>Before warm ms</th><th>After warm ms</th><th>Before tree MiB</th><th>After tree MiB</th><th>Change</th></tr></thead><tbody>${rows}</tbody></table></div><p>Eleven server profiles: Java and Kotlin MVC/WebFlux under recorded Spring Framework 6.2.0/7.0.0 and Boot 3.5.0/4.0.0, plus ASP.NET 8/9/10 minimal and MVC routing. Sizes use 3 / 20 / 80 resources per profile, with original handlers/helpers, .NET source-project references and TS/Vue/Svelte/Astro requests. Every expected endpoint has an original handler and every expected frontend request links. Each run asserts exact cold/warm graph fingerprints, actual syntax/import/component/compiler cache hits and equal before/after graph fingerprints/cardinalities. These generated source-contract fixtures qualify the bounded profiles; dependencies and target builds/configuration/generators never execute.</p><p>Cold indexing has no parser/graph cache. Warm replay follows a separate cache-population pass. An independent driver samples the entire worker/parser process tree through Linux /proc every 25 ms, including synchronous phases; short spikes between samples can be missed. Exact parent high-water RSS, sampled child/tree peaks, cache counts and graph digests are retained below. Warm sampled memory includes the process retained after cold/population passes. The large current sample retains ${(results.at(-1).current.warmTreePeakKiB / (1024 * 1024)).toFixed(2)} GiB median sampled tree RSS; this is visible retained memory and is outside the cold guardrail. This qualifies the current Linux host and synthetic workloads; native Windows/macOS, full-history performance, grammar latency and production-repository recall remain separate gates. The <a href="compatibility-performance.html">TS/Laravel baseline</a>, <a href="go-compatibility-performance.html">Go comparison</a> and <a href="ruby-compatibility-performance.html">Ruby comparison</a> remain separate reports.</p><p>Baseline: <code>${escaped(revision)}</code>. Reproduce: <code>node --import tsx scripts/benchmark-jvm-dotnet-compatibility.mjs --baseline-ref ${escaped(revision)} --repetitions ${repetitions}</code>. <a href="language-framework-compatibility.html#implementation">Roadmap and evidence</a>.</p><details><summary>Raw measurements and recorded profiles</summary><pre>${escaped(JSON.stringify(data, null, 2))}</pre></details></main></html>`);
    console.log(JSON.stringify({ output, passed, results: results.map(({ runs, ...r }) => r) }, null, 2));
    if (!passed) process.exitCode = 1;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
