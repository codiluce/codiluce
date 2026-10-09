// Own Node/TS/WASM indexers only. Cargo, target dependencies and macros never run.
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
import { rustWorkload, rustProfiles } from './fixtures/rust-workload.ts';

const project = fileURLToPath(new URL('../', import.meta.url)), args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const worker = option('--worker');
const escaped = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
if (worker) {
  const implementation = option('--implementation'), modules = {};
  for (const [name, file] of Object.entries({ index: 'src/pipeline/index.ts', fingerprint: 'src/history/fingerprint.ts', config: 'src/core/config.ts', cache: 'src/pipeline/cache.ts' })) modules[name] = await import(pathToFileURL(path.join(implementation, file)).href);
  const config = await modules.config.resolveConfig(worker, JSON.parse(await readFile(path.join(worker, 'benchmark-config.json'), 'utf8')));
  const shape = graph => createHash('sha256').update(modules.fingerprint.canonicalJson({ entities: graph.entities, relations: graph.relations, diagnostics: graph.diagnostics.filter(d => !['indexer', 'git-metrics'].includes(d.analyzer) && d.code !== 'git-ignore-unavailable') })).digest('hex');
  const start = performance.now(), cold = await modules.index.indexRepository(worker, { config }), coldMs = performance.now() - start;
  console.log(JSON.stringify({ phase: 'cold', coldMs, coldParentPeakKiB: process.resourceUsage().maxRSS }));
  const directory = option('--cache');
  await modules.index.indexRepository(worker, { config, cache: new modules.cache.AnalysisCache(directory) });
  console.log(JSON.stringify({ phase: 'warm-start' }));
  const cache = new modules.cache.AnalysisCache(directory), warmStart = performance.now(), warm = await modules.index.indexRepository(worker, { config, cache }), warmMs = performance.now() - warmStart;
  assert.equal(shape(cold), shape(warm), 'exact cold/warm graph fingerprint');
  const required = ['embedded-source', 'typescript-nextjs'];
  if (option('--mode') === 'rust') required.push('syntax-facts', 'rust-imports', 'rust-symbols', ...option('--label') === 'current' ? ['rust-routers'] : []);
  for (const analyzer of required) assert.ok(cache.events.some(e => e.analyzer === analyzer && e.hit), `${analyzer}: actual warm hit`);
  const declared = cold.entities.filter(e => e.type === 'api_endpoint' && e.metadata.registration === 'explicit'), handles = cold.relations.filter(e => e.type === 'handles'), requests = cold.relations.filter(e => e.type === 'requests');
  const expected = Number(option('--expected', '0'));
  assert.equal(declared.length, expected); assert.equal(handles.length, expected); assert.equal(requests.length, expected * 4);
  for (const edge of handles) { const source = cold.entities.find(e => e.id === edge.to); assert.ok(source?.path?.endsWith('/src/routes.rs') && source.sourceRange); }
  console.log(JSON.stringify({ phase: 'done', warmMs, files: cold.entities.filter(e => e.type === 'file').length, entities: cold.entities.length, relations: cold.relations.length, endpoints: cold.entities.filter(e => e.type === 'api_endpoint').length, declared: declared.length, requests: requests.length, handlers: handles.length, diagnostics: cold.diagnostics.length, graphDigest: shape(cold), cacheHits: cache.events.filter(e => e.hit).length, cacheMisses: cache.events.filter(e => !e.hit).length, replayEqual: true }));
} else {
  if (process.platform !== 'linux') throw new Error('Process-tree RSS sampling requires Linux /proc; native OS release checks are separate');
  const repetitions = Number(option('--repetitions', '3'));
  if (!Number.isInteger(repetitions) || repetitions < 3 || repetitions > 20) throw new Error('repetitions must be 3–20');
  const temporary = await mkdtemp(path.join(tmpdir(), 'codiluce-rust-benchmark-')), run = promisify(execFile);
  const command = (cmd, params, opts = {}) => run(cmd, params, { cwd: project, timeout: 300_000, maxBuffer: 64 << 20, ...opts });
  const put = async (root, file, text) => { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); };
  function memory(pid, seen = new Set()) {
    if (seen.has(pid)) return { rss: 0, children: 0 }; seen.add(pid);
    try {
      const own = Number(/^VmRSS:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? 0);
      const children = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).reduce((sum, p) => sum + memory(Number(p), seen).rss, 0);
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
    const revision = (await command('git', ['rev-parse', '--verify', `${option('--baseline-ref', '011b5ae')}^{commit}`])).stdout.trim(), archive = path.join(temporary, 'baseline.tar');
    await writeFile(archive, (await command('git', ['archive', revision], { encoding: 'buffer' })).stdout);
    await command('tar', ['-xf', archive, '-C', baseline]); await symlink(path.join(project, 'node_modules'), path.join(baseline, 'node_modules'));
    const results = [], median = values => { const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; };
    for (const mode of ['control', 'rust']) for (const [name, count] of [['Small', 3], ['Medium', 12], ['Large', 32]]) {
      const root = path.join(temporary, mode, name), workload = rustWorkload(count, mode === 'rust');
      await put(root, 'benchmark-config.json', JSON.stringify(workload.config));
      for (const [file, text] of Object.entries(workload.files)) await put(root, file, text);
      const runs = { baseline: [], current: [] };
      for (let repetition = 0; repetition < repetitions; repetition++) for (const label of repetition % 2 ? ['current', 'baseline'] : ['baseline', 'current']) {
        console.log(`${mode}/${name}: ${label} ${repetition + 1}/${repetitions}`);
        runs[label].push(await measure(['--worker', root, '--implementation', label === 'baseline' ? baseline : project, '--cache', path.join(temporary, 'cache', mode, name, `${label}-${repetition}`), '--mode', mode, '--label', label, '--expected', String(label === 'current' ? workload.expectedEndpoints : 0)]));
      }
      const summarize = samples => Object.fromEntries(Object.keys(samples[0]).filter(k => typeof samples[0][k] === 'number').map(key => [key, median(samples.map(sample => sample[key]))]));
      for (const [label, samples] of Object.entries(runs)) for (const sample of samples) {
        assert.equal(sample.graphDigest, samples[0].graphDigest, `${mode}/${name}/${label}: deterministic graph`);
        assert.equal(sample.files, runs.current[0].files, 'same original input files');
        if (mode === 'control') assert.equal(sample.graphDigest, runs.baseline[0].graphDigest, 'unchanged frontend graph before/after');
      }
      results.push({ mode, name, resourcesPerProfile: count, baseline: summarize(runs.baseline), current: summarize(runs.current), runs });
    }
    const sourceFiles = (await command('git', ['ls-files', '-z', 'src'])).stdout.split('\0').filter(Boolean), digest = createHash('sha256');
    for (const file of sourceFiles) digest.update(file + '\0').update(await readFile(path.join(project, file))).update('\0');
    // This audit runs after timed workers and cannot influence their measurements.
    const { qualifyRustProof } = await import('./qualify-rust-proof.mjs');
    const proofAudit = await qualifyRustProof(project, option('--proof-baseline-ref', '888bdb7'));
    const data = { measuredAt: new Date().toISOString(), baseline: revision, current: (await command('git', ['rev-parse', 'HEAD'])).stdout.trim() + ' + working-tree Rust proof deduplication', currentSourceDigest: digest.digest('hex'), fixtureDigest: createHash('sha256').update(await readFile(path.join(project, 'scripts/fixtures/rust-workload.ts'))).digest('hex'), node: process.version, platform: `${process.platform}/${process.arch}`, cpu: cpus()[0]?.model, repetitions, pollMilliseconds: 25, profiles: rustProfiles, proofAudit, results };
    const percent = (a, b) => ((a / b - 1) * 100).toFixed(1) + '%';
    const passed = results.filter(r => r.mode === 'control').every(r => r.current.coldMs <= r.baseline.coldMs * 1.1 && r.current.coldTreePeakKiB <= r.baseline.coldTreePeakKiB * 1.1);
    const rows = results.map(r => `<tr><th>${escaped(r.mode)} · ${r.name}<small>${r.current.files} files · ${r.current.declared} source routes · ${r.current.requests} linked requests</small></th><td>${r.baseline.coldMs.toFixed(0)}</td><td>${r.current.coldMs.toFixed(0)}</td><td>${percent(r.current.coldMs, r.baseline.coldMs)}</td><td>${r.baseline.warmMs.toFixed(0)}</td><td>${r.current.warmMs.toFixed(0)}</td><td>${(r.baseline.coldTreePeakKiB / 1024).toFixed(1)}</td><td>${(r.current.coldTreePeakKiB / 1024).toFixed(1)}</td><td>${percent(r.current.coldTreePeakKiB, r.baseline.coldTreePeakKiB)}</td></tr>`).join('');
    const output = path.resolve(project, option('--output', 'docs/rust-compatibility-performance.html'));
    const auditParagraph = `<p>Separate proof-payload audit against the archived native P9d2 release: the same 72-source-route / 288-request medium fixture shrinks from ${(proofAudit.sizes.before.bytes / (1 << 20)).toFixed(1)} MiB to ${(proofAudit.sizes.after.bytes / (1 << 20)).toFixed(1)} MiB. Exact normalized graph fingerprints agree: IDs, native contracts, calls, conditions, source coordinates and every distinct evidence fact are retained. Only duplicate evidence and the Rust router analyzer/cache version are normalized. Reproduce with <code>node --import tsx scripts/qualify-rust-proof.mjs --baseline-ref ${escaped(proofAudit.baseline)}</code>. This audit runs after timed measurements.</p>`;
    await writeFile(output, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rust and component compatibility performance</title><style>body{font:16px/1.6 system-ui,sans-serif;background:#101822;color:#e5ecf4;margin:0;padding:32px}main{max-width:1200px;margin:auto}h1{line-height:1.2}p{max-width:1000px;color:#bdcbdc}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;border-bottom:1px solid #344353;padding:12px}small{display:block;color:#9dafc4;font-weight:400}a,code{color:#79ced3}code{overflow-wrap:anywhere}.status{border:1px solid #5a7882;padding:16px;border-radius:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere}@media(max-width:600px){body{padding:18px}}</style><main><h1>Rust and component compatibility performance</h1><p>${escaped(data.measuredAt)} · ${escaped(data.node)} · ${escaped(data.platform)} · ${escaped(data.cpu)}. Medians of ${repetitions} fresh processes per implementation/sample; alternating order with identical installed parser/compiler dependencies.</p><p class="status"><strong>Local frontend control: ${passed ? 'PASS' : 'NEEDS WORK'}</strong> — suggested 10% cold indexing and sampled process-tree RSS guardrails against the archived pre-router P9b implementation.</p><div class="scroll"><table><thead><tr><th>Sample</th><th>Before cold ms</th><th>After cold ms</th><th>Change</th><th>Before warm ms</th><th>After warm ms</th><th>Before tree MiB</th><th>After tree MiB</th><th>Change</th></tr></thead><tbody>${rows}</tbody></table></div><p>Controls contain only original TS, Vue, Svelte and Astro frontend fixtures: every before/after graph fingerprint must agree. The Rust samples add six registry/version profiles (Axum 0.7/0.8, Actix Web 4, Rocket 0.5, Warp 0.3/0.4), original source factories, native mounts, a shared local crate and recorded Linux/amd64 cfg/features. Small/medium/large use 3 / 12 / 32 resources per profile, within the bounded filter tree budget. Every current source route has its original handler; every expected frontend request reaches that route. Native 404/405 response contracts are counted separately from source handlers.</p><p>The pre-router Rust baseline already parses original declarations and resolves Cargo/import/direct call facts, but has zero native Rust endpoints or request links. Its graph differs deliberately from the current mixed-stack graph; the table measures the cost of added analysis rather than applying an equal-work 10% guardrail to the Rust rows. Every run verifies deterministic graph fingerprints, exact cold/warm equality and actual component/compiler cache hits; Rust runs also require syntax/import/symbol cache hits and current native router cache hits. The <a href="compatibility-performance.html">existing TS/Laravel comparison</a> remains a separate gate.</p>${auditParagraph}<p>An independent driver samples the complete worker/parser process tree through Linux /proc every 25 ms, including synchronous parsing. Short spikes between samples can be missed; exact parent high-water RSS and sampled child/tree peaks are retained below. Warm replay follows a separate cache-population pass and includes retained process memory. These are local synthetic source-contract measurements, without target execution. Native Windows/macOS execution, full-history performance, grammar latency and broad production accuracy remain open.</p><p>Baseline: <code>${escaped(revision)}</code>. Reproduce: <code>node --import tsx scripts/benchmark-rust-compatibility.mjs --baseline-ref ${escaped(revision)} --repetitions ${repetitions}</code>. <a href="language-framework-compatibility.html#implementation">Roadmap</a>.</p><details><summary>Raw measurements and recorded profiles</summary><pre>${escaped(JSON.stringify(data, null, 2))}</pre></details></main></html>`);
    console.log(JSON.stringify({ output, passed, results: results.map(({ runs, ...r }) => r) }, null, 2));
    if (!passed) process.exitCode = 1;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
