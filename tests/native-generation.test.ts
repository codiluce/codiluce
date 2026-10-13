import assert from 'node:assert/strict';
import {after, mock, test} from 'node:test';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {StructureParser} from '../src/analysis/tree-sitter/client.js';
import {IndexedStructureParser, reservedGrammars} from '../src/analysis/tree-sitter/native-budget.js';
import {structureAnalyzer} from '../src/analysis/tree-sitter/analyzer.js';
import {IndexedSources} from '../src/analysis/indexed-sources.js';
import {TemplateScriptParser} from '../src/analysis/tree-sitter/template-scripts.js';
import {canonicalJson} from '../src/history/fingerprint.js';
import {verifyNativeWorkerBundle} from '../scripts/build-native-worker.mjs';
import {filesystemAnalyzer} from '../src/analyzers/filesystem.js';
import {resolveConfig} from '../src/core/config.js';
import {GraphBuilder} from '../src/core/graph.js';
import type {AnalysisContext} from '../src/core/analyzer.js';
import type {StructureFacts} from '../src/analysis/facts.js';
import {AnalysisCache} from '../src/pipeline/cache.js';
import {indexRepository} from '../src/pipeline/index.js';

const roots: string[] = [];
after(async () => { await Promise.all(roots.map(root => rm(root, {recursive: true, force: true}))); });
async function scanned(files: Record<string, string>): Promise<AnalysisContext> {
  const root = await mkdtemp(path.join(tmpdir(), 'codiluce-native-budget-')); roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), {recursive: true}); await writeFile(path.join(root, file), text);
  }
  const config = await resolveConfig(root, {repository: {name: 'fixture'}}), graph = new GraphBuilder('fixture');
  const context: AnalysisContext = {root, config, graph, repositoryId: graph.id('repository'), files: new Map(), applicationIds: new Map(), http: []};
  await filesystemAnalyzer.analyze(context); context.sources = new IndexedSources(context, {maxBytes: 0}); return context;
}
function observeWorkers() {
  const original = childProcess.fork, children: childProcess.ChildProcess[] = [];
  const observer = mock.method(childProcess, 'fork', ((...args: unknown[]) => {
    for (const child of children) assert.ok(child.exitCode !== null || child.signalCode !== null, 'Retire a native address space before starting its successor');
    const child = Reflect.apply(original, childProcess, args); children.push(child); return child;
  }) as typeof childProcess.fork);
  syncBuiltinESMExports();
  return {children, restore() { observer.mock.restore(); syncBuiltinESMExports(); }};
}

test('plain native worker exactly matches approved typed helpers and lazy optional imports', verifyNativeWorkerBundle);

test('all twenty native profiles preserve typed facts while grammar generations retire without overlap', async () => {
  type Options = Parameters<StructureParser['parse']>[2];
  const profiles: Array<[string, string | null, Options?]> = [
    ['python', 'python.py'], ['go', 'go.go'], ['ruby', 'ruby.rb'], ['rust', 'rust.rs'],
    ['java', 'Java.java'], ['csharp', 'CSharp.cs'], ['kotlin', 'Kotlin.kt'], ['c', 'c.c'], ['cpp', 'cpp.cpp'],
    ['objective-c', 'objc-cpp.mm', {objectiveCpp: true}], ['swift', 'swift.swift'], ['scala', 'scala.scala'],
    ['groovy', 'groovy.groovy'], ['fsharp', 'fsharp.fs'], ['fsharp-signature', 'fsharp.fsi'], ['vbnet', 'vbnet.vb'],
    ['erb', 'erb.html.erb', {erbHost: 'html'}], ['razor', 'Counter.razor', {razorKind: 'component'}],
    ['liquid', 'template.html.liquid', {liquidHost: 'html', liquidEngine: 'shopify', liquidBodyTags: true}], ['html', null],
  ];
  const cases = await Promise.all(profiles.map(async ([language, file, options]) => ({language, options: {...options, nativeOnly: true}, content: file ? await readFile(new URL(`./fixtures/structure/${file}`, import.meta.url), 'utf8') : '<p>é😀</p>\r\n'})));
  cases.push({language: 'python', content: '# é😀\r\ndef valid(): pass\r\ndef broken(:', options: {nativeOnly: true}});
  const typed = new StructureParser(10_000, fileURLToPath(new URL('../src/analysis/tree-sitter/worker.ts', import.meta.url)), ['--max-old-space-size=256', '--import', 'tsx']);
  const expected: string[] = [];
  try { for (const item of cases) expected.push(canonicalJson(await typed.parse(item.language, item.content, item.options))); }
  finally { await typed.closeAndWait(); }
  const observation = observeWorkers(), bounded = new IndexedStructureParser(10_000, {maxGrammars: 3, maxSourceBytes: 1_000_000_000});
  try {
    for (const [index, item] of cases.entries()) {
      assert.equal(canonicalJson(await bounded.parse(item.language, item.content, item.options)), expected[index], item.language);
      assert.ok(bounded.generationStats().grammars <= 3);
    }
    assert.ok(bounded.generationStats().rotations >= 6); assert.equal(bounded.generationStats().peakGrammars, 3);
    assert.equal(observation.children.length, bounded.generationStats().rotations + 1);
    await bounded.closeAndWait(); assert.equal(bounded.generationStats().grammars, 0);
    for (const child of observation.children) {
      assert.ok(child.exitCode !== null || child.signalCode !== null); assert.equal(child.listenerCount('message'), 0); assert.equal(child.listenerCount('error'), 0);
    }
  } finally { await bounded.closeAndWait(); observation.restore(); }
});

test('byte generations return complete oversized originals only after actual exit; failed jobs also retire', async () => {
  const observation = observeWorkers(), parser = new IndexedStructureParser(10_000, {maxGrammars: 6, maxSourceBytes: 80});
  try {
    const source = '# é😀\r\n' + '# original\n'.repeat(40) + 'def retained(): pass\n';
    assert.ok((await parser.parse('python', source, {nativeOnly: true})).declarations.some(item => item.name === 'retained'));
    assert.equal(parser.generationStats().oversizedJobs, 1); assert.ok(parser.generationStats().peakSourceBytes > 80);
    assert.equal(parser.generationStats().sourceBytes,0);assert.equal(parser.generationStats().grammars,0);
    assert.ok(observation.children[0]!.exitCode!==null||observation.children[0]!.signalCode!==null,'The oversized native address space exits before parse resolves');
    await parser.parse('python', 'def next(): pass\n', {nativeOnly: true}); assert.equal(parser.generationStats().rotations, 1);
    for (let i = 0; i < 6; i++) await parser.parse('python', `def value${i}(): pass\n`, {nativeOnly: true});
    assert.ok(parser.generationStats().rotations >= 2);
    await assert.rejects(parser.parse('unavailable-language', 'original'), /grammar|language|catalog/i);
    assert.equal(parser.generationStats().grammars, 0); assert.equal(parser.generationStats().sourceBytes, 0);
    assert.ok((await parser.parse('python', 'def recovered(): pass\n', {nativeOnly: true})).declarations.some(item => item.name === 'recovered'));
  } finally { await parser.closeAndWait(); observation.restore(); }
  for (const limits of [{maxGrammars: 2, maxSourceBytes: 1}, {maxGrammars: 3, maxSourceBytes: 0}, {maxGrammars: 3, maxSourceBytes: Infinity}]) assert.throws(() => new IndexedStructureParser(10_000, limits), /limits/);
  assert.deepEqual(reservedGrammars('erb', {erbHost: 'html'}), ['erb', 'ruby', 'html']);
  assert.deepEqual(reservedGrammars('erb', {erbHost: 'javascript'}), ['erb', 'ruby']);
  assert.deepEqual(reservedGrammars('razor'), ['razor', 'html']);
  assert.deepEqual(reservedGrammars('liquid', {liquidHost: 'html'}), ['liquid', 'html']);
  assert.deepEqual(reservedGrammars('objective-c', {objectiveCpp: true}), ['objective-c', 'cpp']);
});

test('native deadlines retire before a later independent indexed job; concurrent dispatch is rejected', async () => {
  const observation = observeWorkers(), short = new IndexedStructureParser(1);
  try { await assert.rejects(short.parse('python', 'def original(): pass\n'), /exceeded/); assert.equal(short.generationStats().grammars, 0); }
  finally { await short.closeAndWait(); }
  const healthy = new IndexedStructureParser();
  try {
    const first = healthy.parse('python', 'def healthy(): pass\n');
    await assert.rejects(healthy.parse('ruby', 'def another; end'), /sequential/);
    assert.ok((await first).declarations.some(item => item.name === 'healthy'));
  } finally { await healthy.closeAndWait(); observation.restore(); }
});

test('unproven native retirement blocks every subsequent dispatch until exit is proven', async () => {
  const observation = observeWorkers(), parser = new IndexedStructureParser();
  try {
    await parser.parse('python', 'def original(): pass\n'); assert.equal(observation.children.length, 1);
    const failure = mock.method(parser, 'closeAndWait', async () => { throw Error('Injected unproven native retirement'); });
    parser.close();
    try {
      for (let attempt = 0; attempt < 3; attempt++) await assert.rejects(parser.parse('ruby', 'def later; end'), /unproven native retirement/);
      assert.equal(observation.children.length, 1, 'No new native process may start while retirement remains unproven');
      assert.equal(parser.generationStats().retirementPending, true);
    } finally { failure.mock.restore(); }
    assert.ok((await parser.parse('ruby', 'def recovered; end')).declarations.some(item => item.name === 'recovered'));
    assert.equal(parser.generationStats().retirementPending, false); assert.equal(observation.children.length, 2);
  } finally { await parser.closeAndWait(); observation.restore(); }
});

test('ordinary native files finish before another original is read; deferred template originals are validated after native retirement', async () => {
  const context = await scanned({'a.html.erb': '<script>function client(){}</script>', 'b.py': 'def first(): pass\n', 'c.py': 'def second(): pass\n'});
  context.sources = new IndexedSources(context);
  const reads: Array<{file: string; forced: boolean}> = [], originalRead = context.sources!.readText;
  const reader = mock.method(context.sources!, 'readText', function (this: IndexedSources, file: string, options: Parameters<IndexedSources['readText']>[1]) {
    if(file==='b.py'||file==='c.py')assert.equal(this.memoStats().entries,0,'Prior originals must leave the shared memo before the next file');
    reads.push({file, forced: !!options?.revalidate}); return originalRead.call(this, file, options);
  });
  const originalParse = StructureParser.prototype.parse, nativeEvents: string[] = [];
  const parse = mock.method(StructureParser.prototype, 'parse', async function (this: StructureParser, language: string, content: string, options: Parameters<StructureParser['parse']>[2]) {
    nativeEvents.push(language);
    if (language === 'erb') assert.ok(!reads.some(item => item.file === 'b.py'));
    if (content.includes('first')) assert.ok(!reads.some(item => item.file === 'c.py'));
    if (content.includes('second')) assert.ok([...context.graph.entities.values()].some(entity => entity.name === 'first'), 'Ordinary facts must be consumed before reading the next original');
    return originalParse.call(this, language, content, options);
  });
  const originalFinish = TemplateScriptParser.prototype.finish;
  const finish = mock.method(TemplateScriptParser.prototype, 'finish', async function (this: TemplateScriptParser, content: string, facts: StructureFacts) {
    assert.deepEqual(nativeEvents, ['erb', 'python', 'python']); assert.ok(reads.some(item => item.file === 'a.html.erb' && item.forced));
    return originalFinish.call(this, content, facts);
  });
  try { await structureAnalyzer.analyze(context); assert.ok([...context.graph.entities.values()].some(entity => entity.name === 'client')); }
  finally { reader.mock.restore(); parse.mock.restore(); finish.mock.restore(); }
});

test('separate applications dispatch shared grammar families together while every original declaration remains', async () => {
  const context = await scanned({
    'a/first.py': 'def firstPython(): pass\n', 'a/first.rb': 'def firstRuby; end\n',
    'b/second.py': 'def secondPython(): pass\n', 'b/second.rb': 'def secondRuby; end\n',
    'c/template.html.erb': '<script>function erbClient(){}</script>',
    'd/template.html.liquid': '<script>function liquidClient(){}</script>',
    'e/component.razor': '<script>function razorClient(){}</script>',
    'f/core.c': 'void firstC(void) {}', 'g/core.cpp': 'void firstCpp() {}',
    'h/core.mm': '@interface OriginalObjc\n@end\n',
  });
  const originalParse = StructureParser.prototype.parse, languages: string[] = [];
  const parse = mock.method(StructureParser.prototype, 'parse', async function (this: StructureParser, language: string, content: string, options: Parameters<StructureParser['parse']>[2]) {
    languages.push(language); return originalParse.call(this, language, content, options);
  });
  try { await structureAnalyzer.analyze(context); }
  finally { parse.mock.restore(); }
  assert.deepEqual(languages, ['erb', 'liquid', 'razor', 'ruby', 'ruby', 'c', 'cpp', 'objective-c', 'python', 'python']);
  const names = new Set([...context.graph.entities.values()].map(entity => entity.name));
  for (const name of ['firstPython', 'secondPython', 'firstRuby', 'secondRuby', 'erbClient', 'liquidClient', 'razorClient', 'firstC', 'firstCpp', 'OriginalObjc']) assert.ok(names.has(name), name);
});

test('completed structure retires its original source memo; later consumers validate rereads', async () => {
  const context = await scanned({'original.py': 'def retained(): pass\n', 'template.html.erb': '<script>function client(){}</script>'});
  context.sources = new IndexedSources(context);
  const originals = new Map([...context.files.keys()].map(file => [file, context.sources!.readText(file)]));
  assert.ok(context.sources.memoStats().bytes > 0);
  await structureAnalyzer.analyze(context);
  assert.equal(context.sources.memoStats().bytes, 0); assert.equal(context.sources.memoStats().entries, 0);
  const names = new Set([...context.graph.entities.values()].map(entity => entity.name));
  assert.ok(names.has('retained')); assert.ok(names.has('client'));
  assert.equal(context.sources.readText('template.html.erb'), originals.get('template.html.erb'));
  await writeFile(path.join(context.root, 'original.py'), 'def changed(): pass\n');
  assert.throws(() => context.sources!.readText('original.py'), /changed after the scan/);
});

test('index completion waits for every native, script and PHP parser address space to exit', async () => {
  const context = await scanned({'original.py': 'def retained(): pass\n', 'template.html.erb': '<script>function client(){}</script>', 'original.php': '<?php function phpOriginal() { return 1; }'});
  const original=childProcess.fork,children:childProcess.ChildProcess[]=[];
  const observer=mock.method(childProcess,'fork',((...args:unknown[])=>{const child=Reflect.apply(original,childProcess,args);children.push(child);return child;}) as typeof childProcess.fork);
  syncBuiltinESMExports();
  try {
    const graph=await indexRepository(context.root,{config:context.config});
    assert.ok(graph.entities.some(entity=>entity.name==='phpOriginal'));
    assert.ok(graph.entities.some(entity=>entity.name==='client'));
    assert.ok(children.some(child=>child.spawnargs.some(argument=>argument.endsWith('/php/native-worker.mjs'))));
    assert.ok(children.some(child=>child.spawnargs.some(argument=>argument.endsWith('/tree-sitter/native-worker.mjs'))));
    assert.ok(children.some(child=>child.spawnargs.some(argument=>argument.endsWith('/tree-sitter/native-script-worker.mjs'))));
    for(const child of children)assert.ok(child.exitCode!==null||child.signalCode!==null,'No parser address space may survive completed indexing');
  } finally {observer.mock.restore();syncBuiltinESMExports();}
});

test('an original changed during the native phase fails only its deferred file and cannot cache partial facts', async () => {
  const context = await scanned({'a.html.erb': '<script>function staleClient(){}</script>', 'b.py': 'def healthy(): pass\n', 'c.razor': '<script>function otherClient(){}</script>'});
  context.cache = new AnalysisCache(path.join(context.root, '.codiluce/cache'));
  const originalParse = StructureParser.prototype.parse;
  const parse = mock.method(StructureParser.prototype, 'parse', async function (this: StructureParser, language: string, content: string, options: Parameters<StructureParser['parse']>[2]) {
    if (language === 'python') await writeFile(path.join(context.root, 'a.html.erb'), '<script>function changedClient(){}</script>');
    return originalParse.call(this, language, content, options);
  });
  try { await structureAnalyzer.analyze(context); }
  finally { parse.mock.restore(); }
  const graph = {entities: [...context.graph.entities.values()], diagnostics: [...context.graph.diagnostics.values()]};
  assert.ok(graph.entities.some(entity => entity.name === 'healthy')); assert.ok(graph.entities.some(entity => entity.name === 'otherClient'));
  assert.ok(!graph.entities.some(entity => ['staleClient', 'changedClient'].includes(entity.name)));
  assert.ok(graph.diagnostics.some(item => item.file === 'a.html.erb' && item.code === 'syntax-analysis-failed'));
  assert.ok(!(await readdir(context.cache.directory)).some(file => file.startsWith('syntax-facts.a_html_erb')));
});
