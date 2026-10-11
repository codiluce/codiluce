import {canonicalJson} from '../src/history/fingerprint.ts';
import {processPeakRssKiB} from './process-memory.mjs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
// Fixed mixed TS/Laravel samples, measured in fresh processes with identical
// installed compiler/parser versions. The baseline is an archived git ref;
// no target dependency installation or target application execution occurs.
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir, cpus } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';

const execute = promisify(execFile), projectRoot = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2), argument = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const workerRoot = argument('--worker');
if (workerRoot) {
  const { indexRepository } = await import(pathToFileURL(path.join(argument('--implementation'), 'src/pipeline/index.ts')).href);
  const config = JSON.parse(await readFile(path.join(workerRoot, 'benchmark-config.json'), 'utf8'));
  const started = performance.now();
  const graph = await indexRepository(workerRoot, { config });
  const coldMs = performance.now() - started, coldPeakRssKiB = processPeakRssKiB();
  const cache = path.join(workerRoot, '.codiluce', argument('--cache-unit'));
  await indexRepository(workerRoot, { config, cache });
  const warmStart = performance.now();
  const replay = await indexRepository(workerRoot, { config, cache });
  const warmMs = performance.now() - warmStart;
  const graphShape=value=>canonicalJson({entities:value.entities,relations:value.relations,diagnostics:value.diagnostics});assert.equal(graphShape(graph),graphShape(replay),'full cold/warm graph replay');const graphDigest=createHash('sha256').update(graphShape(graph)).digest('hex');
  const legacyPhp=graph.entities.filter(entity=>entity.evidence.some(proof=>proof.analyzer==='php-laravel'));
  const legacyIds=new Set(legacyPhp.map(entity=>entity.id));
  const legacyRelations=graph.relations.filter(edge=>(legacyIds.has(edge.from)||legacyIds.has(edge.to))&&edge.evidence.some(proof=>!['php-symbols','php-imports','php-laravel-structure'].includes(proof.analyzer)));
  const legacyIdentity=createHash('sha256').update(JSON.stringify({entities:legacyPhp.map(({id,type,parentId,sourceRange})=>({id,type,parentId,sourceRange})),relations:legacyRelations.map(({id,from,to,type,metadata})=>({id,from,to,type,metadata}))})).digest('hex');
  console.log(JSON.stringify({ coldMs, coldPeakRssKiB, warmMs, warmPeakRssKiB: processPeakRssKiB(), files: graph.entities.filter(entity => entity.type === 'file').length, entities: graph.entities.length, relations: graph.relations.length, diagnostics: graph.diagnostics.length, legacyPhpSymbols:legacyPhp.length, legacyPhpRelations:legacyRelations.length, legacyIdentity,graphDigest }));
} else {
  const repetitions = Number(argument('--repetitions', '5')), ref = argument('--baseline-ref', 'HEAD');
  if (!Number.isInteger(repetitions) || repetitions < 3 || repetitions > 20) throw new Error('repetitions must be between 3 and 20');
  const temporary = await mkdtemp(path.join(tmpdir(), 'codiluce-compatibility-benchmark-'));
  const output = path.resolve(projectRoot, argument('--output', 'docs/compatibility-performance.html'));
  const run = (command, parameters, options = {}) => execute(command, parameters, { cwd: projectRoot, timeout: 120_000, maxBuffer: 128 * 1024 * 1024, ...options });
  const config = { repository: { name: 'benchmark' }, applications: [{ name: 'frontend', path: 'frontend', frameworks: ['nextjs'], ecosystems: ['node'] }, { name: 'backend', path: 'backend', frameworks: ['laravel'], ecosystems: ['php'], apiOrigins: ['https://api.fixture.test'] }], ignore: ['**/node_modules/**', '**/.codiluce/**', '**/.git/**'], maxFileBytes: 1024 * 1024 };
  const samples = [];
  const put = async (root, relative, text) => { await mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await writeFile(path.join(root, relative), text); };
  try {
    const baseline = path.join(temporary, 'baseline'); await mkdir(baseline);
    const revision = (await run('git', ['rev-parse', '--verify', `${ref}^{commit}`])).stdout.trim();
    const archive = path.join(temporary, 'baseline.tar');
    await writeFile(archive, (await run('git', ['archive', revision], { encoding: 'buffer' })).stdout);
    await run('tar', ['-xf', archive, '-C', baseline]);
    await symlink(path.join(projectRoot, 'node_modules'), path.join(baseline, 'node_modules'));
    const sourceScope=['src','grammars','package.json','package-lock.json','scripts/benchmark-compatibility.mjs','scripts/process-memory.mjs','scripts/build-native-worker.mjs','scripts/build-native-worker.d.mts','scripts/build-script-worker.mjs','scripts/build-script-worker.d.mts','scripts/build-cli.mjs','scripts/test-package.mjs','tests/cache.test.ts','tests/php-analysis-cache.test.ts','tests/php-structure.test.ts','tests/native-generation.test.ts','tests/parser-lifetimes.test.ts','tests/fixtures/repository'];
    async function fingerprint(){const files=(await run('git',['ls-files','-z','--cached','--others','--exclude-standard','--',...sourceScope])).stdout.split('\0').filter(Boolean).sort(),hash=createHash('sha256');for(const file of files)hash.update(file+'\0').update(await readFile(path.join(projectRoot,file))).update('\0');return {files:files.length,digest:hash.digest('hex')};}
    const frozen=await fingerprint(),requireEqualGraphs=args.includes('--require-equal-graphs'),requireWarmGuard=args.includes('--require-warm-guard');
    const fixture = path.join(temporary, 'small');
    await cp(path.join(projectRoot, 'tests/fixtures/repository'), fixture, { recursive: true });
    await put(fixture, 'benchmark-config.json', JSON.stringify(config));
    samples.push({ name: 'Small · integration fixture', root: fixture, generated: 0 });
    for (const [name, count] of [['Medium', 250], ['Large', 1500]]) {
      const root = path.join(temporary, name.toLowerCase());
      await put(root, 'frontend/package.json', '{"dependencies":{"next":"*"}}');
      await put(root, 'backend/composer.json', '{"require":{"laravel/framework":"*"}}');
      await put(root, 'benchmark-config.json', JSON.stringify(config));
      const routes = ['<?php', 'use Illuminate\\Support\\Facades\\Route;'];
      for (let index = 0; index < count; index++) {
        const previous = index ? `import { value${index - 1} } from './module${index - 1}';\n` : '';
        await put(root, `frontend/src/module${index}.ts`, `${previous}export function value${index}(input: string): string { return ${index ? `value${index - 1}(input)` : 'input.trim()'}; }\nexport async function load${index}() { return fetch('https://api.fixture.test/resource${index}/1'); }\n`);
        await put(root, `backend/app/Http/Controllers/Resource${index}Controller.php`, `<?php\nnamespace App\\Http\\Controllers;\nclass Resource${index}Controller { public function show(string $id) { return response()->json(['id' => $id]); } }\n`);
        routes.push(`Route::get('/resource${index}/{id}', [\\App\\Http\\Controllers\\Resource${index}Controller::class, 'show']);`);
      }
      await put(root, 'backend/routes/api.php', routes.join('\n'));
      await put(root, 'backend/bootstrap/app.php', "<?php\nuse Illuminate\\Foundation\\Application;\nreturn Application::configure(basePath: dirname(__DIR__))->withRouting(api: __DIR__.'/../routes/api.php', apiPrefix: '')->create();\n");
      samples.push({ name: `${name} · generated mixed stack`, root, generated: count });
    }
    const results = [];
    for (const sample of samples) {
      const measurements = { baseline: [], current: [] };
      // Alternate order to reduce systematic host warming bias.
      for (let repetition = 0; repetition < repetitions; repetition++) for (const label of repetition % 2 ? ['current', 'baseline'] : ['baseline', 'current']) {
        console.log(`${sample.name}: ${label}, repetition ${repetition + 1}/${repetitions}`);
        const result = await run(process.execPath, ['--experimental-sqlite', '--import', 'tsx', fileURLToPath(import.meta.url), '--worker', sample.root, '--implementation', label === 'baseline' ? baseline : projectRoot, '--cache-unit', `${label}-${repetition}`]);
        measurements[label].push(JSON.parse(result.stdout));
      }
      const median = values => { const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; };
      for(const label of ['baseline','current'])for(const run of measurements[label])for(const key of ['files','entities','relations','diagnostics','legacyPhpSymbols','legacyPhpRelations','legacyIdentity','graphDigest'])assert.equal(run[key],measurements[label][0][key],`${sample.name} ${label} stable ${key}`);
      for(const key of ['files','legacyPhpSymbols','legacyPhpRelations','legacyIdentity'])assert.equal(measurements.current[0][key],measurements.baseline[0][key],`${sample.name} preserved ${key}`);
      if(requireEqualGraphs)for(const label of ['baseline','current'])for(const run of measurements[label])assert.equal(run.graphDigest,measurements.baseline[0].graphDigest,`${sample.name} identical complete graph across implementations`);
      const summarize = runs => Object.fromEntries(Object.keys(runs[0]).map(key => [key,typeof runs[0][key]==='number'?median(runs.map(run => run[key])):runs[0][key]]));
      results.push({ name: sample.name, generatedModulesPerLanguage: sample.generated, baseline: summarize(measurements.baseline), current: summarize(measurements.current), runs: measurements });
    }
    assert.deepEqual(await fingerprint(),frozen,'qualified source changed during measurement');
    const data = { implementationFiles:frozen.files,implementationDigest:frozen.digest,sourceScope,sourceFrozenVerified:true,requireEqualGraphs,requireWarmGuard,phase:argument('--phase','compatibility'), memoryMethod:'linux-proc-vmhwm', measuredAt: new Date().toISOString(), baseline: revision, current: 'working tree', node: process.version, platform: `${process.platform}/${process.arch}`, cpu: cpus()[0]?.model, repetitions, results };
    const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
    const percent = (current, baseline) => `${((current / baseline - 1) * 100).toFixed(1)}%`;
    const rows = results.map(result => `<tr><th>${escape(result.name)}<small>${result.current.files} files · ${result.current.entities} entities · ${result.current.relations} relations</small></th><td>${result.baseline.coldMs.toFixed(0)}</td><td>${result.current.coldMs.toFixed(0)}</td><td>${percent(result.current.coldMs, result.baseline.coldMs)}</td><td>${result.baseline.warmMs.toFixed(0)}</td><td>${result.current.warmMs.toFixed(0)}</td><td>${(result.baseline.coldPeakRssKiB / 1024).toFixed(1)}</td><td>${(result.current.coldPeakRssKiB / 1024).toFixed(1)}</td><td>${percent(result.current.coldPeakRssKiB, result.baseline.coldPeakRssKiB)}</td></tr>`).join('');
    data.gates=results.map(result=>({name:result.name,cold:result.current.coldMs<=result.baseline.coldMs*1.1,warm:result.current.warmMs<=result.baseline.warmMs*1.1,parentMemory:result.current.coldPeakRssKiB<=result.baseline.coldPeakRssKiB*1.1}));
    const passed = (!requireWarmGuard||data.gates.every(gate=>gate.warm))&&results.every(result => result.current.coldMs <= result.baseline.coldMs * 1.1 && result.current.coldPeakRssKiB <= result.baseline.coldPeakRssKiB * 1.1);
    data.passed=passed;
    const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codiluce compatibility performance</title><style>body{font:16px/1.55 system-ui,sans-serif;background:#101822;color:#e5ecf4;margin:0;padding:clamp(16px,4vw,40px)}main{max-width:1200px;margin:auto}h1{font-size:36px;line-height:1.15}p{max-width:1000px;color:#bdcbdc}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;border-bottom:1px solid #344353;padding:12px}thead{color:#79ced3}small{display:block;color:#9dafc4;font-weight:400}.scroll{overflow:auto}.status{border:1px solid #5a7882;padding:16px;border-radius:8px}code{color:#a6d7df;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere}a{color:#7ad0d6}</style><main><h1>Compatibility performance baseline</h1><p>${escape(data.phase)} · ${escape(data.measuredAt)} · ${escape(data.node)} · ${escape(data.platform)} · ${escape(data.cpu)}. Medians of ${repetitions} fresh processes per implementation/sample, alternating baseline/current order. Both use identical installed compiler/parser dependencies.</p><p class="status"><strong>TS/Laravel ${requireWarmGuard?'cold/warm':'cold'} guardrails: ${passed ? 'PASS' : 'NEEDS WORK'}</strong> — at most 10% slower median ${requireWarmGuard?'cold/warm':'cold'} indexing and 10% higher parent high-water memory against the archived baseline on these fixed samples. These measurements qualify this host and sample set.</p><div class="scroll"><table><thead><tr><th>Sample</th><th>Baseline cold ms</th><th>Current cold ms</th><th>Time change</th><th>Baseline warm ms</th><th>Current warm ms</th><th>Baseline cold peak MiB</th><th>Current cold peak MiB</th><th>Memory change</th></tr></thead><tbody>${rows}</tbody></table></div><p>The small sample is the existing Next/Laravel integration fixture. Medium and large samples contain ${samples[1].generated}/${samples[2].generated} TS modules plus as many PHP controllers, indexed local calls, HTTP requests and registered API routes. Cold indexing starts with no parser/graph cache. Warm replay follows a cache-population pass in the same process. Peak memory is the parent process's Linux /proc VmHWM since exec (kernel RSS accounting can be approximate) at the end of cold indexing; it does not include concurrent parser child memory.</p><p>${requireEqualGraphs?'Every complete baseline/current graph digest also agrees; this phase permits no semantic additions. ':''}Every raw run preserves the exact full cold/warm graph and stable graph digests within its implementation. Baseline and current runs also retain the same Laravel source symbol identities, original ranges and established relationship projection, recorded as a SHA-256 legacyIdentity. Wider original structure and separately qualified source references may deliberately add graph facts; total cross-implementation counts are recorded separately rather than assumed equal. These additions remain subject to the same cold-time and parent-memory guards.</p><p>Baseline commit: <code>${escape(revision)}</code>. Current source digest (${data.implementationFiles} files): <code>${escape(data.implementationDigest)}</code>. This comparison measures existing TS/Laravel workloads. Mixed Tree-sitter/workspace samples, grammar-load latency, full-history throughput and supported-OS qualification remain additional measurements. Synthetic module depth and framework features are bounded; production repositories can behave differently.</p><p>Reproduce: <code>node scripts/benchmark-compatibility.mjs --baseline-ref ${escape(revision)} --repetitions ${repetitions} --phase ${escape(data.phase)} ${requireEqualGraphs?'--require-equal-graphs ':''}${requireWarmGuard?'--require-warm-guard ':''}--output ${escape(path.relative(projectRoot, output))}</code>. The command archives the baseline into a temporary directory and cleans its samples afterward. <a href="language-framework-compatibility.html#implementation">Implementation audit</a></p><details><summary>Raw measurements</summary><pre>${escape(JSON.stringify(data, null, 2))}</pre></details></main></html>`;
    await writeFile(output, html);
    console.log(JSON.stringify({ output, passed, results: results.map(({ runs, ...result }) => result) }, null, 2));if(!passed)process.exitCode=1;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
