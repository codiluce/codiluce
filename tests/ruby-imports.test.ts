import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { indexRepository } from '../src/pipeline/index.js';
import { resolveConfig, type ApplicationInput } from '../src/core/config.js';
import type { SoftwareGraph } from '../src/core/graph.js';
import { canonicalJson } from '../src/history/fingerprint.js';
import { AnalysisCache } from '../src/pipeline/cache.js';
import { StructureParser } from '../src/analysis/tree-sitter/client.js';

const roots: string[] = [];
after(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });
async function repository(files: Record<string, string>) { const root = await mkdtemp(path.join(tmpdir(), 'codiluce-ruby-')); roots.push(root); for (const [file, content] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), content); } return root; }
async function index(root: string, apps: ApplicationInput[] = [{ name: 'ruby', path: '.', ecosystems: ['ruby'], sourceRoots: { ruby: ['lib'] } }], options: { cache?: AnalysisCache; revision?: string; ignore?: string[]; maxFileBytes?: number } = {}) { return indexRepository(root, { config: await resolveConfig(root, { repository: { name: 'fixture' }, applications: apps, ignore: options.ignore, maxFileBytes: options.maxFileBytes }), cache: options.cache, revision: options.revision }); }
type Outcome = { kind: string; specifier?: string; constant?: string; lazy?: boolean; wrapped?: boolean; conditions: string[]; range: { startLine: number; startColumn?: number }; scopeId?: string; outcome: { status: string; reason?: string; targets?: string[]; dependency?: string } };
const outcomes = (graph: SoftwareGraph, file = 'main.rb') => graph.entities.find(entity => entity.type === 'file' && entity.path === file)?.metadata.importOutcomes as Outcome[];
const imports = (graph: SoftwareGraph, file = 'main.rb') => graph.relations.filter(relation => relation.type === 'imports' && graph.entities.find(entity => entity.id === relation.from)?.path === file).map(relation => ({ ...relation, target: graph.entities.find(entity => entity.id === relation.to)! }));
const shape = (graph: SoftwareGraph) => canonicalJson({ entities: graph.entities, relations: graph.relations, diagnostics: graph.diagnostics.filter(item => !['git-metrics', 'indexer'].includes(item.analyzer) && item.code !== 'git-ignore-unavailable') });

test('Ruby facts retain load sites, lexical nesting, compact namespaces, original UTF-16 and CRLF coordinates', async () => {
 const parser = new StructureParser(); try {
  const facts = await parser.parse('ruby', '# 😀\r\nmodule Shop\r\n class Widget\r\n  def show; require_relative "../widget"; VALUE; end\r\n end\r\nend\r\nclass Shop::Widget\r\n def later; VALUE; end\r\nend');
  assert.ok(facts.ruby?.complete); assert.equal(facts.ruby.calls[0]?.range.startLine, 4); assert.equal(facts.ruby.calls[0]?.expression.method, 'require_relative');
  assert.ok(facts.ruby.definitions.some(item => item.name === 'Shop::Widget')); assert.equal(facts.ruby.references.filter(item => item.expression.name === 'VALUE').length, 2);
  const method = facts.ruby.scopes.find(item => item.kind === 'method' && item.name === 'show')!; assert.ok(method.owner && method.deferred); assert.ok(facts.declarations.some(item => item.key === method.owner));
 } finally { parser.close(); }
});

test('Ruby require_relative uses the original file directory, optional .rb and literal Unicode paths', async () => {
 const root = await repository({ 'src/main.rb': `require_relative '../lib/widget'\nrequire_relative '../lib/widget.rb'\nrequire_relative "../lib/caf\\xC3\\xA9"`, 'lib/widget.rb': 'class Widget; end', 'lib/café.rb': 'class Café; end' });
 const graph = await index(root); assert.deepEqual(outcomes(graph, 'src/main.rb').map(item => item.outcome.status), ['resolved', 'resolved', 'resolved']);
 assert.deepEqual(imports(graph, 'src/main.rb').map(item => item.target.path).sort(), ['lib/café.rb', 'lib/widget.rb', 'lib/widget.rb']); assert.ok(imports(graph, 'src/main.rb').every(item => item.evidence.some(fact => fact.file === 'src/main.rb')));
});

test('Ruby literal require uses recorded ordered load paths instead of repository or lib guesses', async () => {
 const root = await repository({ 'main.rb': `require 'widget'`, 'first/widget.rb': 'class First; end', 'second/widget.rb': 'class Second; end', 'lib/widget.rb': 'class Wrong; end' });
 const app: ApplicationInput = { name: 'ruby', path: '.', ecosystems: ['ruby'], sourceRoots: { ruby: ['first', 'second'] } };
 assert.equal(imports(await index(root, [app]))[0]?.target.path, 'first/widget.rb');
 assert.equal(imports(await index(root, [{ ...app, sourceRoots: { ruby: ['second', 'first'] } }]))[0]?.target.path, 'second/widget.rb');
 const unknown = await index(root, [{ name: 'ruby', path: '.', ecosystems: ['ruby'] }]); assert.equal(outcomes(unknown)[0]?.outcome.status, 'unsupported'); assert.equal(imports(unknown).length, 0);
});

test('Ruby explicit relative require/load uses recorded target cwd and load never appends .rb', async () => {
 const root = await repository({ 'src/main.rb': `require './lib/widget'\nload './lib/widget.rb'\nload 'widget.rb'\nload 'widget'`, 'lib/widget.rb': 'class Widget; end', 'other/lib/widget.rb': 'class Other; end' });
 const app: ApplicationInput = { name: 'ruby', path: '.', ecosystems: ['ruby'], sourceRoots: { ruby: ['lib'] }, ruby: { cwd: '.' } };
 const graph = await index(root, [app]); assert.deepEqual(outcomes(graph, 'src/main.rb').map(item => item.outcome.status), ['resolved', 'resolved', 'resolved', 'unresolved']);
 assert.equal(imports(graph, 'src/main.rb').length, 3); assert.ok(outcomes(graph, 'src/main.rb').filter(item => item.kind === 'load').every(item => item.conditions.length));
 assert.equal(imports(await index(root, [{ ...app, ruby: { cwd: 'other' } }]), 'src/main.rb')[0]?.target.path, 'other/lib/widget.rb');
 assert.equal(outcomes(await index(root), 'src/main.rb')[0]?.outcome.status, 'unsupported');
});

test('Ruby bounded File paths preserve __dir__/__FILE__ proof and require explicit cwd for implicit bases', async () => {
 const root = await repository({ 'src/main.rb': `require File.expand_path('../lib/widget', __dir__)\nrequire File.join(__dir__, '..', 'lib', 'widget')\nrequire File.expand_path('../lib/widget', File.dirname(__FILE__))\nrequire File.expand_path('lib/widget')`, 'lib/widget.rb': 'class Widget; end' });
 const graph = await index(root); assert.deepEqual(outcomes(graph, 'src/main.rb').map(item => item.outcome.status), ['resolved', 'resolved', 'resolved', 'unsupported']); assert.ok(imports(graph, 'src/main.rb').every(item => item.evidence.some(fact => fact.explanation?.includes('Original Ruby'))));
 assert.ok(outcomes(graph, 'src/main.rb')[2]!.conditions.some(reason => reason.includes('__FILE__')));
 assert.ok(outcomes(await index(root, [{ name: 'ruby', path: '.', ecosystems: ['ruby'], ruby: { cwd: '.' } }]), 'src/main.rb').every(item => item.outcome.status === 'resolved'));
});

test('Ruby native/gem features remain external or constrained without mapping gem names to require paths', async () => {
 const root = await repository({ 'Gemfile': `gem 'distribution_name', require: 'runtime_feature'`, 'main.rb': `require 'set'\nrequire 'runtime_feature'\nrequire 'native.so'\nrequire_relative 'missing'`, 'lib/local.rb': '' });
 const graph = await index(root); assert.deepEqual(outcomes(graph).map(item => item.outcome.status), ['external', 'external', 'unsupported', 'unresolved']); assert.deepEqual(graph.entities.find(item => item.path === 'main.rb')?.metadata.externalImports, ['runtime_feature', 'set']); assert.equal(imports(graph).length, 0);
});

test('Ruby loader and File namespace shadows suppress unsupported builtin guesses', async () => {
 const root = await repository({ 'main.rb': `def require(x); end\nrequire 'widget'\nKernel.require 'widget'\nobj.require 'widget'`, 'lib/widget.rb': 'class Widget; end' });
 assert.deepEqual(outcomes(await index(root)).map(item => item.outcome.status), ['unsupported', 'resolved', 'unsupported']);
 await writeFile(path.join(root, 'main.rb'), `module Kernel; end\nKernel.require 'widget'`); assert.equal(outcomes(await index(root))[0]?.outcome.status, 'unsupported');
 await writeFile(path.join(root, 'main.rb'), `class File; end\nrequire File.expand_path('lib/widget', __dir__)`); assert.equal(outcomes(await index(root))[0]?.outcome.status, 'unsupported');
});

test('Ruby inherited/mixin/aliased loader identities and singleton contexts stay explicit gaps', async () => {
 const root = await repository({ 'main.rb': `class Shop < ExternalBase\n require 'widget'\nend\nclass Safe\n def self.require(x); end\n require 'widget'\nend\nmodule Mixed\n include External\n require 'widget'\nend\nclass << self\n require 'widget'\nend`, 'lib/widget.rb': '' });
 assert.ok(outcomes(await index(root)).every(item => item.outcome.status === 'unsupported'));
 await writeFile(path.join(root, 'main.rb'), `alias require custom\nrequire 'widget'`); assert.equal(outcomes(await index(root))[0]?.outcome.status, 'unsupported');
});

test('Ruby conditional, deferred, lazy and wrapped loads retain separate source dependency metadata', async () => {
 const root = await repository({ 'main.rb': `if enabled\n require_relative 'widget'\nend\ndef later\n require_relative 'widget'\nend\nmodule Shop\n autoload :Widget, 'widget'\nend\nload 'widget.rb', true`, 'widget.rb': 'class Widget; end', 'lib/widget.rb': 'class Widget; end' });
 const graph = await index(root), entries = outcomes(graph); assert.ok(entries.every(item => item.outcome.status === 'resolved')); assert.match(entries[0]!.conditions.join(' '), /Conditional/); assert.match(entries[1]!.conditions.join(' '), /invocation/); assert.ok(entries[1]!.scopeId); assert.ok(entries[2]!.lazy); assert.equal(entries[2]!.constant, 'Widget'); assert.ok(entries[3]!.wrapped); assert.match(entries[3]!.conditions.join(' '), /namespace/);
 assert.equal(graph.relations.filter(item => item.type === 'calls').length, 0); assert.ok(graph.entities.filter(item => item.language === 'ruby' && item.type === 'file').every(item => (item.metadata.analysis as any).features.framework.status === 'unsupported'));
});

test('Ruby literal quoted/percent strings are decoded while interpolation, spreads and malformed loader arguments remain gaps', async () => {
 const root = await repository({ 'main.rb': `require %q[widget]\nrequire %Q{wid\\u0067et}\nrequire "#{feature}"\nrequire *paths\nrequire 'widget', 'extra'\nautoload :invalid, 'widget'\nrequire 'widget' do; end`, 'lib/widget.rb': '' });
 assert.deepEqual(outcomes(await index(root)).map(item => item.outcome.status), ['resolved', 'resolved', 'unsupported', 'unsupported', 'unsupported', 'unsupported', 'unsupported']);
});

test('Ruby load-path mutations retain relative file identity but block bare feature selection', async () => {
 for (const mutation of [`$LOAD_PATH.unshift 'other'`, `$LOAD_PATH << 'other'`, `$LOAD_PATH = ['other']`, `$:[0] = 'other'`]) {
  const root = await repository({ 'main.rb': `${mutation}\nrequire 'widget'\nrequire_relative 'lib/widget'`, 'lib/widget.rb': '' }); const graph = await index(root); assert.deepEqual(outcomes(graph).map(item => item.outcome.status), ['unsupported', 'resolved']); assert.ok(graph.diagnostics.some(item => item.code === 'ruby-path-gap'));
 }
});

test('Ruby excluded, oversized, binary and symlinked inputs never cause fallback to a later load root', async () => {
 const root = await repository({ 'main.rb': `require 'widget'`, 'first/widget.rb': 'class First; end', 'second/widget.rb': 'class Second; end' });
 const app: ApplicationInput = { name: 'ruby', path: '.', ecosystems: ['ruby'], sourceRoots: { ruby: ['first', 'second'] } };
 assert.equal(outcomes(await index(root, [app], { ignore: ['first/widget.rb'] }))[0]?.outcome.status, 'excluded');
 await rm(path.join(root, 'first/widget.rb')); await symlink(path.join(root, 'second/widget.rb'), path.join(root, 'first/widget.rb')); assert.equal(outcomes(await index(root, [app]))[0]?.outcome.status, 'excluded');
 await rm(path.join(root, 'first/widget.rb')); await writeFile(path.join(root, 'first/widget.rb'), ' '.repeat(100)); assert.equal(outcomes(await index(root, [app], { maxFileBytes: 40 }))[0]?.outcome.status, 'excluded');
 await writeFile(path.join(root, 'first/widget.rb'), Buffer.from([0, 1, 2])); assert.equal(outcomes(await index(root, [app]))[0]?.outcome.status, 'excluded');
});

test('Ruby missing/partial syntax cannot establish a builtin loader namespace', async () => {
 const root = await repository({ 'main.rb': `require_relative 'widget'\nclass Broken\ndef`, 'widget.rb': '' }); const graph = await index(root); assert.equal(outcomes(graph)[0]?.outcome.status, 'unsupported'); assert.ok(graph.diagnostics.some(item => item.analyzer === 'tree-sitter-structure'));
});

test('Ruby runtime configuration rejects host paths, escaping cwd and unsupported implicit options', async () => {
 const root = await repository({ 'main.rb': '' }); for (const ruby of [{ cwd: '/tmp' }, { cwd: '../..' }, { cwd: 'C:\\app' }, { cwd: 1 }, { groups: ['test'] }, null]) await assert.rejects(resolveConfig(root, { repository: { name: 'fixture' }, applications: [{ name: 'ruby', path: '.', ecosystems: ['ruby'], ruby: ruby as any }] }));
});

test('Ruby imports replay cold/warm/revision, invalidate load/config changes and keep identity when moved', async () => {
 const root = await repository({ 'main.rb': `require_relative 'lib/widget'`, 'lib/widget.rb': 'class Widget; end', 'lib/other.rb': 'class Other; end' }), state = await mkdtemp(path.join(tmpdir(), 'codiluce-ruby-cache-')); roots.push(state);
 const cold = await index(root, undefined, { cache: new AnalysisCache(state) }), warm = await index(root, undefined, { cache: new AnalysisCache(state) }), revision = await index(root, undefined, { revision: 'recorded' }); assert.equal(shape(cold), shape(warm)); assert.equal(shape(cold), shape(revision));
 const previous = imports(cold)[0]!; await writeFile(path.join(root, 'main.rb'), '\n\n' + await readFile(path.join(root, 'main.rb'), 'utf8')); const moved = await index(root, undefined, { cache: new AnalysisCache(state) }); assert.equal(imports(moved)[0]!.id, previous.id); assert.equal(imports(moved)[0]!.evidence.find(item => item.file === 'main.rb')?.line, 3);
 await writeFile(path.join(root, 'main.rb'), `require_relative 'lib/other'`); const changed = await index(root, undefined, { cache: new AnalysisCache(state) }); assert.equal(imports(changed)[0]!.target.path, 'lib/other.rb'); assert.equal(shape(changed), shape(await index(root)));
});

test('Ruby source suffixes precede native suffixes across load roots and retain unrecognized suffix text', async () => {
 const root = await repository({ 'main.rb': `require 'widget'\nrequire 'widget.v1'\nrequire 'native.o'`, 'first/widget.so': 'native asset', 'second/widget.rb': 'class Widget; end', 'second/widget.v1.rb': 'class WidgetV1; end' });
 const app: ApplicationInput = { name: 'ruby', path: '.', ecosystems: ['ruby'], sourceRoots: { ruby: ['first', 'second'] } };
 const graph = await index(root, [app]); assert.deepEqual(outcomes(graph).map(item => item.outcome.status), ['resolved', 'resolved', 'unsupported']); assert.equal(imports(graph).find(item => item.metadata?.specifier === 'widget')?.target.path, 'second/widget.rb');
});

test('Ruby imported source method/path mutations constrain later feature selection but do not preempt the initial load', async () => {
 for (const patch of [`def require(x); end`, `module Kernel; end`, `$LOAD_PATH.unshift 'other'`, `Object.define_method(:require) {}`]) {
  const root = await repository({ 'main.rb': `require_relative 'patch'\nrequire 'widget'`, 'patch.rb': patch, 'lib/widget.rb': '' }); const graph = await index(root); assert.deepEqual(outcomes(graph).map(item => item.outcome.status), ['resolved', 'unsupported']);
 }
});

test('Ruby source-path helpers cannot be guessed through imported or local File/__dir__ overrides', async () => {
 const root = await repository({ 'main.rb': `require_relative 'patch'\nrequire File.expand_path('lib/widget', __dir__)`, 'patch.rb': `def File.expand_path(*args); '/other'; end`, 'lib/widget.rb': '' });
 assert.deepEqual(outcomes(await index(root)).map(item => item.outcome.status), ['resolved', 'unsupported']);
 for (const mutation of [`def File.expand_path(*args); '/other'; end`, `def __dir__; '/other'; end`, `__dir__ = '/other'`]) { await writeFile(path.join(root, 'main.rb'), `${mutation}\nrequire File.expand_path('lib/widget', __dir__)`); assert.equal(outcomes(await index(root))[0]?.outcome.status, 'unsupported'); }
});

test('Ruby cwd changes constrain relative/implicit-base paths while original source directory paths remain identifiable', async () => {
 const root = await repository({ 'main.rb': `Dir.chdir 'other'\nrequire './lib/widget'\nrequire File.expand_path('lib/widget')\nrequire_relative 'lib/widget'`, 'lib/widget.rb': '' });
 const graph = await index(root, [{ name: 'ruby', path: '.', ecosystems: ['ruby'], ruby: { cwd: '.' }, sourceRoots: { ruby: ['lib'] } }]); assert.deepEqual(outcomes(graph).map(item => item.outcome.status), ['unsupported', 'unsupported', 'resolved']); assert.ok(outcomes(graph)[2]!.conditions.length);
});

test('Ruby cyclic and external earlier loads preserve explicit initialization/method-summary conditions', async () => {
 const root = await repository({ 'main.rb': `require_relative 'a'\nrequire 'set'\nrequire_relative 'widget'`, 'a.rb': `require_relative 'b'`, 'b.rb': `require_relative 'a'`, 'widget.rb': '' });
 const graph = await index(root); assert.match(outcomes(graph)[0]!.conditions.join(' '), /Cyclic/); assert.match(outcomes(graph)[2]!.conditions.join(' '), /external Ruby feature/); assert.ok(outcomes(graph).every(item => ['resolved', 'external'].includes(item.outcome.status)));
});

test('Ruby explicit Kernel singleton loader overrides remain gaps locally and after original source loads', async () => {
 const root = await repository({ 'main.rb': `def Kernel.require(x); false; end\nKernel.require 'widget'`, 'lib/widget.rb': '' }); assert.equal(outcomes(await index(root))[0]?.outcome.status, 'unsupported');
 await writeFile(path.join(root, 'patch.rb'), `def Kernel.require(x); false; end`); await writeFile(path.join(root, 'main.rb'), `require_relative 'patch'\nKernel.require 'widget'`); assert.deepEqual(outcomes(await index(root)).map(item => item.outcome.status), ['resolved', 'unsupported']);
});

test('Ruby undef, reflective constant changes and earlier unknown loads retain loader/startup boundaries', async () => {
 const root = await repository({ 'main.rb': `undef require\nrequire 'widget'`, 'lib/widget.rb': '' }); assert.equal(outcomes(await index(root))[0]?.outcome.status, 'unsupported');
 await writeFile(path.join(root, 'main.rb'), `Object.const_set(:Kernel, Object.new)\nKernel.require 'widget'`); assert.equal(outcomes(await index(root))[0]?.outcome.status, 'unsupported');
 await writeFile(path.join(root, 'main.rb'), `Object.const_set(:File, Object.new)\nrequire File.expand_path('lib/widget', __dir__)`); assert.equal(outcomes(await index(root))[0]?.outcome.status, 'unsupported');
 await writeFile(path.join(root, 'main.rb'), `require feature\nrequire_relative 'lib/widget'`); assert.match(outcomes(await index(root))[1]!.conditions.join(' '), /unresolved source\/startup/);
});

test('Ruby warm caches invalidate native/denied candidate inventories and cross-application load roots', async () => {
 const root = await repository({ 'client/main.rb': `require 'widget'`, 'shared/lib/other.rb': '' }), state = await mkdtemp(path.join(tmpdir(), 'codiluce-ruby-native-cache-')); roots.push(state);
 const apps: ApplicationInput[] = [{ name: 'client', path: 'client', ecosystems: ['ruby'], sourceRoots: { ruby: ['../shared/lib'] } }, { name: 'shared', path: 'shared', ecosystems: ['ruby'] }];
 assert.equal(outcomes(await index(root, apps, { cache: new AnalysisCache(state) }), 'client/main.rb')[0]?.outcome.status, 'external');
 await writeFile(path.join(root, 'shared/lib/widget.so'), 'native asset'); const native = await index(root, apps, { cache: new AnalysisCache(state) }); assert.equal(outcomes(native, 'client/main.rb')[0]?.outcome.status, 'unsupported'); assert.equal(shape(native), shape(await index(root, apps)));
 await writeFile(path.join(root, 'shared/lib/widget.rb'), 'class SharedWidget; end'); const local = await index(root, apps, { cache: new AnalysisCache(state) }); assert.equal(imports(local, 'client/main.rb')[0]?.target.path, 'shared/lib/widget.rb'); assert.equal(shape(local), shape(await index(root, apps)));
});
