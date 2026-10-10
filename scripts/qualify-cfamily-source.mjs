// Immutable original-source audit. Fetches or reads bytes; never compiles source,
// expands macros, runs target tests or installs target dependencies.
// node --experimental-sqlite --import tsx scripts/qualify-cfamily-source.mjs
//   [--source /tmp/codiluce-p10-original] [--output docs/cfamily-source-accuracy.html]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { StructureParser } from '../src/analysis/tree-sitter/client.ts';
import { indexRepository } from '../src/pipeline/index.ts';
import { AnalysisCache } from '../src/pipeline/cache.ts';
import { resolveConfig } from '../src/core/config.ts';
import { canonicalJson } from '../src/history/fingerprint.ts';

const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const project = fileURLToPath(new URL('../', import.meta.url));
const measureGrammar = language => {
  const code = `import {Parser,Language} from 'web-tree-sitter';import {performance} from 'node:perf_hooks';
    const start=performance.now();await Parser.init();const runtimeMs=performance.now()-start;
    const load=performance.now(),language=await Language.load(process.argv[1]),loadMs=performance.now()-load;
    const parser=new Parser();parser.setLanguage(language);const parse=performance.now(),tree=parser.parse('int original(int value){return value;}');
    if(tree.rootNode.hasError)throw Error('Grammar load sample did not parse');
    console.log(JSON.stringify({runtimeMs,loadMs,firstParseMs:performance.now()-parse,peakRssKiB:process.resourceUsage().maxRSS}));tree.delete();parser.delete();`;
  const runs = Array.from({ length: 3 }, () => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code, path.join(project, `grammars/tree-sitter-${language}.wasm`)], { cwd: project, encoding: 'utf8', timeout: 30_000 })));
  const median = key => runs.map(run => run[key]).sort((a, b) => a - b)[1];
  return { language, wasmBytes: statSync(path.join(project, `grammars/tree-sitter-${language}.wasm`)).size, repetitions: 3, median: Object.fromEntries(Object.keys(runs[0]).map(key => [key, median(key)])), runs };
};
const pinned = [
  { name: 'zlib', repo: 'madler/zlib', commit: '51b7f2abdade71cd9bb0e7a373ef2610ec6f9daf', version: '1.3.1', file: 'examples/zpipe.c', language: 'c', sha256: '68140a82582ede938159630bca0fb13a93b4bf1cb2e85b08943c26242cf8f3a6', inventory: [
    [23, 'SET_BINARY_MODE', 'macro'], [25, 'SET_BINARY_MODE', 'macro'], [28, 'CHUNK', 'macro'],
    [36, 'def', 'function'], [92, 'inf', 'function'], [151, 'zerr', 'function'], [176, 'main', 'function'],
  ] },
  { name: 'googletest', repo: 'google/googletest', commit: '52eb8108c5bdec04579160ae17225d66034bd723', version: '1.17.0', file: 'samples/sample1.h', upstream: 'googletest/samples/sample1.h', language: 'cpp', sha256: '14967e01473758779a4908a29578a1fb0696dfe2075f5e10ecd3454c32402e2a', inventory: [
    [33, 'GOOGLETEST_SAMPLES_SAMPLE1_H_', 'macro'], [36, 'Factorial', 'function'], [39, 'IsPrime', 'function'],
  ] },
  { name: 'googletest', repo: 'google/googletest', commit: '52eb8108c5bdec04579160ae17225d66034bd723', version: '1.17.0', file: 'samples/sample1.cc', upstream: 'googletest/samples/sample1.cc', language: 'cpp', sha256: '663ac4c10de9fd37b0352533506d5c114b2fa6e1431d63cad840bd627577cc9b', inventory: [
    [35, 'Factorial', 'function'], [45, 'IsPrime', 'function'],
  ] },
  { name: 'googletest', repo: 'google/googletest', commit: '52eb8108c5bdec04579160ae17225d66034bd723', version: '1.17.0', file: 'samples/sample2.h', upstream: 'googletest/samples/sample2.h', language: 'cpp', sha256: 'dc7708619ff5643fa3577a2551f2dead573c1c18069ce3b82d80a4c58aa3fb46', inventory: [
    [33, 'GOOGLETEST_SAMPLES_SAMPLE2_H_', 'macro'], [38, 'MyString', 'class'], [40, 'c_string_', 'property'],
    [41, 'operator=', 'method'], [45, 'CloneCString', 'method'], [52, 'MyString', 'constructor'],
    [55, 'MyString', 'constructor'], [60, 'MyString', 'constructor'], [68, '~MyString', 'destructor'],
    [71, 'c_string', 'method'], [73, 'Length', 'method'], [76, 'Set', 'method'],
  ] },
  { name: 'googletest', repo: 'google/googletest', commit: '52eb8108c5bdec04579160ae17225d66034bd723', version: '1.17.0', file: 'samples/sample2.cc', upstream: 'googletest/samples/sample2.cc', language: 'cpp', sha256: '2d895439f245dfc502e9429b1bc666a41b7f5e1ba241bd7b089561dd7f5dc7f2', inventory: [
    [37, 'CloneCString', 'qualified-function'], [49, 'Set', 'qualified-function'],
  ] },
];
const temporary = await mkdtemp(path.join(tmpdir(), 'codiluce-cfamily-source-'));
const root = path.join(temporary, 'source'), state = path.join(temporary, 'cache');
const parser = new StructureParser(), results = [], texts = new Map();
const shape = graph => canonicalJson({ entities: graph.entities, relations: graph.relations, diagnostics: graph.diagnostics.filter(item => !['git-metrics', 'indexer'].includes(item.analyzer) && item.code !== 'git-ignore-unavailable') });
const position = (text, offset) => {
  const lines = text.slice(0, offset).split('\n');
  return { line: lines.length, column: lines.at(-1).length + 1 };
};
try {
  for (const input of pinned) {
    const relative = `${input.name}/${input.file}`;
    const url = `https://raw.githubusercontent.com/${input.repo}/${input.commit}/${input.upstream ?? input.file}`;
    let bytes;
    if (option('--source')) bytes = await readFile(path.join(path.resolve(option('--source')), relative));
    else {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      assert.ok(response.ok, `Pinned source fetch failed: ${url}`);
      bytes = Buffer.from(await response.arrayBuffer());
    }
    assert.equal(createHash('sha256').update(bytes).digest('hex'), input.sha256, `Original source changed: ${relative}`);
    const text = bytes.toString('utf8'); texts.set(relative, text);
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), bytes);
    const facts = await parser.parse(input.language, text);
    assert.deepEqual(facts.issues, [], `Reviewed source must parse without recovery: ${relative}`);
    const inventory = declarations => declarations.map(fact => [fact.range.startLine, fact.name, fact.kind]).sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
    assert.deepEqual(inventory(facts.declarations), inventory(input.inventory.map(([line, name, kind]) => ({ range: { startLine: line }, name, kind }))), `Independent source inventory differs: ${relative}`);
    for (const fact of facts.declarations) {
      assert.ok(fact.start >= 0 && fact.end <= text.length && fact.end > fact.start);
      const start = position(text, fact.start), end = position(text, fact.end);
      assert.deepEqual(fact.range, { startLine: start.line, startColumn: start.column, endLine: end.line, endColumn: end.column });
      assert.ok(text.slice(fact.start, fact.end).includes(fact.name), 'Original declaration range must contain its reviewed name');
    }
    assert.equal(facts.cfamily.complete, true);
    results.push({ ...input, url: `https://github.com/${input.repo}/blob/${input.commit}/${input.upstream ?? input.file}`, declarations: facts.declarations, preprocessor: facts.cfamily.preprocessor });
  }
  parser.close();
  const config = await resolveConfig(root, { repository: { name: 'original-cfamily-source' }, applications: [{ name: 'source', path: '.' }] });
  const start = performance.now();
  const cold = await indexRepository(root, { config, cache: new AnalysisCache(state) });
  const coldMs = performance.now() - start;
  const warmStart = performance.now();
  const replayCache = new AnalysisCache(state);
  const warm = await indexRepository(root, { config, cache: replayCache });
  const factHits = replayCache.events.filter(event => event.analyzer === 'syntax-facts' && event.hit).length;
  assert.equal(factHits, 5, 'All original files must replay actual cached syntax facts');
  const warmMs = performance.now() - warmStart;
  const revision = await indexRepository(root, { config, revision: 'pinned-original-source-audit' });
  assert.equal(shape(cold), shape(warm), 'Actual cache replay must retain graph identities and source evidence');
  assert.equal(shape(cold), shape(revision), 'Revision analysis mode must retain the same original facts');
  const symbols = cold.entities.filter(entity => entity.type !== 'file' && entity.evidence.some(item => item.analyzer === 'tree-sitter-structure'));
  assert.equal(symbols.length, 26);
  for (const input of pinned) {
    const relative = `${input.name}/${input.file}`;
    const file = cold.entities.find(entity => entity.type === 'file' && entity.path === relative);
    assert.equal(file.language, input.language);
    assert.equal(file.metadata.analysis.features.structure.status, 'supported');
    for (const capability of ['imports', 'references', 'framework', 'effects', 'guards']) assert.equal(file.metadata.analysis.features[capability].status, 'unsupported');
    const text = texts.get(relative);
    for (const symbol of symbols.filter(entity => entity.path === relative)) {
      assert.ok(symbol.sourceRange.startLine > 0 && symbol.sourceRange.endLine <= text.split('\n').length);
      assert.ok(symbol.metadata.declarationForm);
    }
  }
  assert.ok(!cold.relations.some(edge => ['calls', 'imports', 'handles', 'requests'].includes(edge.type)), 'Structure-only source must not invent semantic links');
  const implementationFiles = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'src', 'grammars', 'package.json', 'package-lock.json', 'scripts/qualify-cfamily-source.mjs'], { cwd: project, encoding: 'utf8' }).split('\0').filter(Boolean).sort();
  const digest = createHash('sha256');
  for (const file of implementationFiles) digest.update(file + '\0').update(await readFile(path.join(project, file))).update('\0');
  const implementationDigest = digest.digest('hex');
  const grammarLoads = ['c', 'cpp'].map(measureGrammar);
  const data = { measuredAt: new Date().toISOString(), baseline: '5295873', implementationDigest, node: process.version, platform: `${process.platform}/${process.arch}`, files: 5, reviewedDeclarations: 26, matchedDeclarations: 26, extraDeclarations: 0, missedDeclarations: 0, qualifiedDefinitionsWithoutTypeBinding: 2, graphEntities: cold.entities.length, graphRelations: cold.relations.length, syntaxFactCacheHits: factHits, coldWarmEqual: true, revisionModeEqual: true, coldMs, warmMs, grammarLoads, sources: results };
  const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const rows = results.map(input => `<tr><td><a href="${escape(input.url)}">${escape(input.name + '/' + input.file)}</a><small>${escape(input.version)} · ${escape(input.commit)}</small></td><td>${input.language}</td><td>${input.inventory.length}</td><td>${input.preprocessor.length}</td></tr>`).join('');
  const startup = grammarLoads.map(input => `<li>${input.language === 'c' ? 'C' : 'C++'}: ${(input.wasmBytes / 1024 / 1024).toFixed(2)} MiB WASM; ${input.median.runtimeMs.toFixed(1)} ms runtime initialization, ${input.median.loadMs.toFixed(1)} ms grammar load, ${input.median.firstParseMs.toFixed(1)} ms first parse; ${(input.median.peakRssKiB / 1024).toFixed(1)} MiB direct parser-process peak RSS.</li>`).join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>C/C++ original source qualification</title><style>body{font:16px/1.6 system-ui,sans-serif;background:#101822;color:#e5ecf4;margin:0;padding:clamp(16px,4vw,48px)}main{max-width:1120px;margin:auto}h1{font-size:clamp(28px,5vw,42px);line-height:1.2}p,li{max-width:950px}a,code{color:#8bddd8}code{overflow-wrap:anywhere}table{border-collapse:collapse;width:100%;min-width:650px}th,td{padding:12px;text-align:left;border-bottom:1px solid #344353}small{display:block;font-size:12px;color:#b4c8dc}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}.scroll{overflow:auto}.status{padding:18px;border:1px solid #688c8d;border-radius:8px}summary{cursor:pointer;padding:12px 0}</style></head><body><main><h1>C/C++ original source qualification</h1><p>P10a1 · ${escape(data.measuredAt)} · ${escape(data.node)} · ${escape(data.platform)}. Exact immutable bytes, recorded SHA-256, independent line/name/kind inventory, original source ranges and actual graph-cache replay.</p><p class="status"><strong>26 / 26 reviewed declarations · 0 missed · 0 extra</strong><br>Five original zlib 1.3.1 / GoogleTest 1.17.0 files retain types, fields, macros, prototypes, definitions, overloads, constructors and destructors. Cold/warm and revision-analysis modes yield identical graph identities and evidence. This is a bounded original-source sample; broader precision/recall and full Git-history throughput remain open.</p><div class="scroll"><table><thead><tr><th>Immutable source</th><th>Language</th><th>Reviewed declarations</th><th>Original directives</th></tr></thead><tbody>${rows}</tbody></table></div><p>GoogleTest's two <code>MyString::</code> source definitions remain <code>qualified-function</code> with explicit translation-unit/type-binding conditions. A header-defined class is not inferred as their owner. Include directives and both zlib macro branches are preserved as original syntax; no preprocessing, includes, macro expansion, compiler, template instantiation, application or dependency code executes. Imports, references, framework, effects and guards remain unsupported for these files.</p><p>Source-condition arrays retain enclosing original directives in source order. They describe source context; they are not evaluated predicates. Function-pointer data remains data, and prototypes and definitions have separate declaration forms and identities. Anonymous original scopes have explicit anonymous metadata.</p><h2>Grammar startup on this Linux host</h2><p>Medians of three fresh direct parser processes per language; runtime initialization, grammar loading and first parse are timed separately. Process startup, graph extraction and parser-worker IPC are excluded. Peak RSS includes the parser runtime and WASM memory, not a whole index process tree. This sample records cost; it does not set a native-platform or production throughput guarantee.</p><ul>${startup}</ul><p>The initial single source-index observation was ${coldMs.toFixed(0)} ms cold / ${warmMs.toFixed(0)} ms warm; it is not a regression benchmark. <a href="cfamily-compatibility-performance.html">Repeated TS/Laravel comparison</a> measures existing workloads separately. Package checks exercise installed CLI/API/source evidence, cache/history and a missing C grammar with surviving C++ structure. Native Windows/macOS qualification, translation-unit binding and other P10 languages remain later gates.</p><p>Implementation digest (source, grammar assets/catalog/queries, dependency pins and audit driver): <code>${implementationDigest}</code>.</p><p>Reproduce: <code>node --experimental-sqlite --import tsx scripts/qualify-cfamily-source.mjs --output docs/cfamily-source-accuracy.html</code>. Optional <code>--source</code> reads the five files under the displayed repository/file paths and verifies identical hashes. <a href="language-framework-compatibility.html#implementation">Implementation roadmap</a></p><details><summary>Original declarations, source ranges and immutable input hashes</summary><pre>${escape(JSON.stringify(data, null, 2))}</pre></details></main></body></html>`;
  await writeFile(path.resolve(option('--output') ?? 'docs/cfamily-source-accuracy.html'), html);
  console.log(JSON.stringify({ ...data, sources: results.map(({ declarations, preprocessor, inventory, ...input }) => ({ ...input, declarations: declarations.length, directives: preprocessor.length })) }, null, 2));
} finally { parser.close(); await rm(temporary, { recursive: true, force: true }); }
