import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { indexRepository } from '../src/pipeline/index.js';
import { resolveConfig, type ApplicationInput } from '../src/core/config.js';
import type { SoftwareGraph } from '../src/core/graph.js';
import { AnalysisCache } from '../src/pipeline/cache.js';
import { canonicalJson } from '../src/history/fingerprint.js';

const roots: string[] = [];
after(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });
async function repository(files: Record<string, string>) { const root = await mkdtemp(path.join(tmpdir(), 'codiluce-ruby-symbols-')); roots.push(root); for (const [file, content] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), content); } return root; }
async function index(root: string, options: { apps?: ApplicationInput[]; cache?: AnalysisCache; revision?: string; ignore?: string[] } = {}) { return indexRepository(root, { config: await resolveConfig(root, { repository: { name: 'fixture' }, applications: options.apps ?? [{ name: 'ruby', path: '.', ecosystems: ['ruby'], sourceRoots: { ruby: ['lib'] } }], ignore: options.ignore }), cache: options.cache, revision: options.revision }); }
type Call = { method: string; kind: string; target?: string; reason?: string; range: { startLine: number }; conditions: string[] };
type Reference = { spelling: string; kind: string; name?: string; targets?: string[]; reason?: string; value?: unknown; range: { startLine: number }; conditions: string[] };
const file = (graph: SoftwareGraph, name = 'main.rb') => graph.entities.find(entity => entity.type === 'file' && entity.path === name)!;
const calls = (graph: SoftwareGraph, name = 'main.rb') => file(graph, name).metadata.rubyCallOutcomes as Call[];
const references = (graph: SoftwareGraph, name = 'main.rb') => file(graph, name).metadata.rubyReferenceOutcomes as Reference[];
const targets = (graph: SoftwareGraph, name = 'main.rb') => calls(graph, name).filter(item => item.target).map(item => ({ call: item, entity: graph.entities.find(entity => entity.id === item.target)! }));
const shape = (graph: SoftwareGraph) => canonicalJson({ entities: graph.entities, relations: graph.relations, diagnostics: graph.diagnostics.filter(item => !['git-metrics', 'indexer'].includes(item.analyzer) && item.code !== 'git-ignore-unavailable') });

test('Ruby nested and compact lexical namespaces differ and absolute constants bypass nesting', async () => {
 const root = await repository({ 'main.rb': `class Global; end\nmodule Shop\n class Item; end\n module Nested\n  Item\n  ::Global\n end\nend\nmodule Shop::Compact\n Item\n ::Shop::Item\nend` });
 const graph = await index(root), refs = references(graph);
 assert.equal(refs.find(item => item.range.startLine === 5)?.name, 'Shop::Item');
 assert.equal(refs.find(item => item.range.startLine === 6)?.name, 'Global');
 assert.equal(refs.find(item => item.range.startLine === 10)?.kind, 'unknown');
 assert.equal(refs.find(item => item.range.startLine === 11)?.name, 'Shop::Item');
});

test('Ruby compact namespace heads resolve in their lexical scope and absent parents do not invent globals', async () => {
 const root = await repository({ 'main.rb': `module Top; module Outer; end; end\nmodule Host\n module Top; module Outer; end; end\n module Top::Outer::Inner\n  ::Top::Outer\n end\nend\nmodule Missing::Invented; class Hidden; end; end\nMissing::Invented::Hidden` });
 const graph = await index(root), namespaces = graph.entities.filter(entity => entity.metadata.rubyNamespace).map(entity => (entity.metadata.rubyNamespace as { name: string }).name);
 assert.ok(namespaces.includes('Host::Top::Outer::Inner')); assert.ok(!namespaces.some(name => name.includes('Invented')));
 assert.equal(references(graph).at(-1)?.kind, 'unknown');
});

test('Ruby source-order lookup excludes later constants in class bodies but retains deferred conditions', async () => {
 const root = await repository({ 'main.rb': `module Shop\n Later\n def self.run; Later; end\n class Later; end\nend` });
 const graph = await index(root), refs = references(graph).filter(item => item.spelling === 'Later');
 assert.equal(refs[0]?.kind, 'unknown'); assert.equal(refs[1]?.name, 'Shop::Later'); assert.ok(refs[1]?.conditions.length);
});

test('Ruby reopened classes retain every original definition and select the latest initialized method', async () => {
 const root = await repository({ 'main.rb': `class Widget\n def self.run; end\nend\nWidget.run\nclass Widget\n def self.run; end\nend\nWidget.run\nWidget` });
 const graph = await index(root), bound = targets(graph);
 assert.deepEqual(bound.map(item => item.entity.sourceRange?.startLine), [2, 6]);
 const original = graph.entities.filter(entity => entity.type === 'class' && entity.name === 'Widget'); assert.equal(original.length, 2); assert.notEqual(original[0]?.id, original[1]?.id);
 assert.deepEqual(references(graph).at(-1)?.targets?.sort(), original.map(item => item.id).sort());
 assert.ok(graph.relations.filter(item => item.type === 'calls').every(item => item.evidence.some(proof => proof.file === 'main.rb' && [4, 8].includes(proof.line ?? 0))));
});

test('Ruby explicit source requires add namespaces in order and unrequired indexed files stay isolated', async () => {
 const root = await repository({ 'main.rb': `Widget.run\nrequire_relative 'lib/widget'\nWidget.run\nrequire_relative 'lib/reopen'\nWidget.run\nUnloaded.run`, 'lib/widget.rb': 'class Widget; def self.run; end; end', 'lib/reopen.rb': 'class Widget; def self.run; end; end', 'lib/unloaded.rb': 'class Unloaded; def self.run; end; end' });
 const graph = await index(root); assert.deepEqual(targets(graph).map(item => item.entity.path), ['lib/widget.rb', 'lib/reopen.rb']);
 assert.equal(calls(graph).find(item => item.range.startLine === 1)?.kind, 'unresolved'); assert.equal(calls(graph).find(item => item.range.startLine === 6)?.kind, 'unresolved');
 const last = targets(graph).at(-1)!; const edge = graph.relations.find(item => item.type === 'calls' && item.to === last.entity.id)!;
 assert.ok(edge.evidence.some(item => item.file === 'main.rb' && item.line === 4 && item.explanation?.includes('activates original source')));
});

test('Ruby constant namespace aliases and immutable local instances bind original direct methods and initializers', async () => {
 const root = await repository({ 'main.rb': `class Widget\n def initialize; end\n def show; end\n def self.build; end\nend\nAlias = Widget\nklass = Alias\nklass.build\nwidget = Alias.new\ncopy = widget\ncopy.show\nWidget.new.show` });
 const graph = await index(root); assert.deepEqual(targets(graph).map(item => item.entity.name), ['build', 'initialize', 'show', 'show', 'initialize']);
 const sites = file(graph).metadata.callSites as { resolved: number; unresolved: number }; assert.equal(sites.resolved, 5); assert.equal(sites.unresolved, 0);
 assert.equal(references(graph).find(item => item.spelling === 'Alias')?.name, 'Widget');
});

test('Ruby literal constants shadow outer namespaces and reassignments invalidate alias guesses', async () => {
 const root = await repository({ 'main.rb': `class Widget; def self.run; end; end\nmodule Shop\n Widget = 3\n Widget.run\nend\nAlias = Widget\nAlias = 4\nAlias.run` });
 const graph = await index(root); assert.equal(targets(graph).length, 0); assert.equal(references(graph).find(item => item.range.startLine === 4)?.value, 3); assert.match(calls(graph).at(-1)?.reason ?? '', /reassigned/);
});

test('Ruby method and block parameters shadow locals without becoming method call sites', async () => {
 const root = await repository({ 'main.rb': `class Widget; def self.run; end; def show; end; end\ndef run; end\ndef test(run, obj:, *rest, **options, &blk)\n run\n obj.show\n rest.show\n options.show\n blk.show\nend\nobj = Widget.new\nunknown { |obj; local| obj.show; local.show }` });
 const graph = await index(root); assert.equal(targets(graph).length, 0); assert.ok(!calls(graph).some(item => item.method === 'run')); assert.ok(calls(graph).filter(item => item.method === 'show').every(item => item.kind === 'unresolved'));
});

test('Ruby control-flow and captured block writes invalidate immutable receiver bindings', async () => {
 const root = await repository({ 'main.rb': `class Widget; def show; end; end\nobj = Widget.new\nunknown { obj = other }\nobj.show\nother_obj = Widget.new\nif enabled; other_obj = other; end\nother_obj.show\nlast = Widget.new\nlast ||= other\nlast.show` });
 const graph = await index(root); assert.equal(targets(graph).filter(item => item.entity.name === 'show').length, 0); assert.ok(calls(graph).filter(item => item.method === 'show').every(item => /mutable|conditional/.test(item.reason ?? '')));
});

test('Ruby blocks can read immutable captures while method scopes cannot capture file locals', async () => {
 const root = await repository({ 'main.rb': `class Widget; def show; end; end\nobj = Widget.new\nunknown { obj.show }\ndef test; obj.show; end` });
 const graph = await index(root), show = calls(graph).filter(item => item.method === 'show'); assert.equal(show[0]?.kind, 'resolved'); assert.ok(show[0]?.conditions.length); assert.equal(show[1]?.kind, 'unresolved');
});

test('Ruby singleton and instance methods remain separate and explicit receiver returns are not inferred', async () => {
 const root = await repository({ 'main.rb': `class Widget\n def self.run; end\n def run; end\n def self.factory; Widget.new; end\nend\nWidget.run\nWidget.new.run\nWidget.factory.run` });
 const graph = await index(root), run = targets(graph).filter(item => item.entity.name === 'run'); assert.deepEqual(run.map(item => item.entity.sourceRange?.startLine), [2, 3]); assert.match(calls(graph).filter(item => item.method === 'run').at(-1)?.reason ?? '', /return values/);
});

test('Ruby runtime self dispatch remains unbound inside deferred methods and blocks', async () => {
 const root = await repository({ 'main.rb': `class Widget\n def run; other; self.other; end\n def other; end\n def self.build; self.run; run; end\nend\nWidget.new.run` });
 const graph = await index(root); assert.equal(targets(graph).length, 1); assert.equal(targets(graph)[0]?.entity.name, 'run'); assert.ok(calls(graph).filter(item => [2, 4].includes(item.range.startLine)).every(item => /runtime self/.test(item.reason ?? '')));
});

test('Ruby private methods, superclass fallback, mixins and generated aliases retain dispatch gaps', async () => {
 const root = await repository({ 'main.rb': `class Private\n private\n def hidden; end\nend\nPrivate.new.hidden\nclass Base; def work; end; end\nclass Child < Base; end\nChild.new.work\nclass Mixed; def show; end; prepend Other; end\nMixed.new.show\nclass Changed; def show; end; alias other show; end\nChanged.new.show` });
 const graph = await index(root); assert.equal(targets(graph).length, 0); assert.match(calls(graph).find(item => item.method === 'hidden')?.reason ?? '', /private/); assert.ok(calls(graph).filter(item => item.method === 'show').every(item => item.kind === 'unresolved'));
});

test('Ruby inherited constants do not fall through to unrelated root declarations', async () => {
 const root = await repository({ 'main.rb': `class Value; end\nclass Base; class Value; end; end\nclass Child < Base\n Value\n ::Value\nend` });
 const graph = await index(root), refs = references(graph).filter(item => item.spelling === 'Value' || item.spelling === '::Value'); assert.match(refs[0]?.reason ?? '', /Inherited/); assert.equal(refs[1]?.name, 'Value');
});

test('Ruby conditional reopenings and namespace mutations cannot prove direct calls', async () => {
 const root = await repository({ 'main.rb': `class Widget; def self.run; end; end\nif enabled; class Widget; def self.run; end; end; end\nWidget.run\nObject.const_set(:Other, Widget)\nWidget.run` });
 const graph = await index(root); assert.equal(targets(graph).length, 0); assert.ok(calls(graph).filter(item => item.method === 'run').every(item => item.kind === 'unresolved'));
});

test('Ruby external, conditional and wrapped startup boundaries retain earlier proven calls only', async () => {
 for (const setup of [`require 'external'`, `require_relative 'lib/widget' if enabled`, `load 'widget.rb', true`, `def setup; require 'external'; end`]) {
  const root = await repository({ 'main.rb': `class Widget; def self.run; end; end\nWidget.run\n${setup}\nWidget.run`, 'lib/widget.rb': 'class Other; end' }); const graph = await index(root); assert.equal(targets(graph).length, 1, setup); assert.equal(calls(graph).filter(item => item.method === 'run').at(-1)?.kind, 'unresolved', setup);
 }
});

test('Ruby source-receiver singleton definitions, absolute reopening names and module constructors are distinct', async () => {
 const root = await repository({ 'main.rb': `class Widget; end\ndef Widget.run; end\nmodule Host; class ::Widget; def show; end; end; end\nWidget.run\nWidget.new.show\nmodule Tool; self.new; end\nTool.new` });
 const graph = await index(root); assert.deepEqual(targets(graph).map(item => item.entity.name), ['run', 'show']); assert.ok(calls(graph).filter(item => item.method === 'new' && item.range.startLine >= 6).every(item => item.kind === 'unresolved'));
});

test('Ruby cold, warm and revision symbol graphs agree and dependency edits invalidate caller bindings', async () => {
 const root = await repository({ 'main.rb': `require_relative 'lib/widget'\nWidget.run`, 'lib/widget.rb': 'class Widget; def self.run; end; end' }), state = await mkdtemp(path.join(tmpdir(), 'codiluce-ruby-symbol-cache-')); roots.push(state);
 const cold = await index(root, { cache: new AnalysisCache(state) }), warm = await index(root, { cache: new AnalysisCache(state) }), revision = await index(root, { revision: 'pinned-source' }); assert.equal(shape(cold), shape(warm)); assert.equal(shape(cold), shape(revision)); assert.equal(targets(cold).length, 1);
 await writeFile(path.join(root, 'lib/widget.rb'), 'class Widget; def self.changed; end; end'); const changed = await index(root, { cache: new AnalysisCache(state) }); assert.equal(targets(changed).length, 0); assert.match(calls(changed).find(item => item.method === 'run')?.reason ?? '', /No initialized direct/);
});

test('Ruby shared load roots preserve the consumer context and denied/incomplete sources cannot supply symbols', async () => {
 const root = await repository({ 'one/main.rb': `require 'widget'\nWidget.run`, 'two/main.rb': `require 'widget'\nWidget.run`, 'shared/a/widget.rb': 'class Widget; def self.run; end; end', 'shared/b/widget.rb': 'class Widget; def self.run; end; end' });
 const apps: ApplicationInput[] = [{ name: 'one', path: 'one', ecosystems: ['ruby'], sourceRoots: { ruby: ['../shared/a'] } }, { name: 'two', path: 'two', ecosystems: ['ruby'], sourceRoots: { ruby: ['../shared/b'] } }, { name: 'shared', path: 'shared', ecosystems: ['ruby'] }];
 const graph = await index(root, { apps }); assert.equal(targets(graph, 'one/main.rb')[0]?.entity.path, 'shared/a/widget.rb'); assert.equal(targets(graph, 'two/main.rb')[0]?.entity.path, 'shared/b/widget.rb');
 const denied = await index(root, { apps, ignore: ['shared/a/**'] }); assert.equal(targets(denied, 'one/main.rb').length, 0);
 await writeFile(path.join(root, 'shared/b/widget.rb'), 'class Widget; def self.run('); const broken = await index(root, { apps }); assert.equal(targets(broken, 'two/main.rb').length, 0);
});

test('Ruby original UTF-16/CRLF call sites and call identity survive an unrelated line insertion', async () => {
 const source = '# 😀\r\nclass Café; def self.run; end; end\r\nCafé.run\r\n'; const root = await repository({ 'main.rb': source }); const before = await index(root), edge = before.relations.find(item => item.type === 'calls')!; assert.equal(calls(before).at(-1)?.range.startLine, 3); assert.ok(edge.evidence.some(item => item.file === 'main.rb' && item.line === 3));
 await writeFile(path.join(root, 'main.rb'), '# extra\r\n' + source); const after = await index(root); assert.equal(after.relations.find(item => item.type === 'calls')?.id, edge.id); assert.equal(calls(after).at(-1)?.range.startLine, 4);
});

test('Ruby alias reopenings update the original namespace and incompatible class headers retain gaps', async () => {
 const root = await repository({ 'main.rb': `class Widget; def self.run; end; end\nAlias = Widget\nclass Alias; def self.run; end; end\nWidget.run\nAlias.run\nclass Wrong; end\nclass Wrong < Widget; def self.go; end; end\nWrong.go` });
 const graph = await index(root); assert.deepEqual(targets(graph).map(item => item.entity.sourceRange?.startLine), [3, 3]); assert.match(calls(graph).at(-1)?.reason ?? '', /superclass/);
});

test('Ruby forced calls do not reuse same-name locals as returned receiver values', async () => {
 const root = await repository({ 'main.rb': `class Widget; def show; end; end\ndef obj; unknown; end\nobj = Widget.new\nobj.show\nobj().show` });
 const graph = await index(root), show = calls(graph).filter(item => item.method === 'show'); assert.equal(show[0]?.kind, 'resolved'); assert.equal(show[1]?.kind, 'unresolved'); assert.match(show[1]?.reason ?? '', /return values/);
});

test('Ruby destructured parameters, loop/rescue/pattern writes and deferred definitions invalidate receiver guesses', async () => {
 const root = await repository({ 'main.rb': `class Widget; def show; end; end\nobj = Widget.new\nfor obj in items; end\nobj.show\nrescued = Widget.new\nbegin; unknown; rescue => rescued; end\nrescued.show\nmatched = Widget.new\ncase value; in {matched:}; end\nmatched.show\ndef test((obj, other)); obj.show; end\nunknown { def Widget.show; end }\nWidget.new.show` });
 const graph = await index(root); assert.equal(targets(graph).filter(item => item.entity.name === 'show').length, 0);
});

test('Ruby object singleton definitions and custom new methods cannot preserve an assumed instance receiver', async () => {
 const root = await repository({ 'main.rb': `class Widget; def show; end; end\nobj = Widget.new\ndef obj.show; end\nobj.show\nclass Factory; def self.new; other; end; def show; end; end\nFactory.new.show` });
 const graph = await index(root); assert.equal(targets(graph).filter(item => item.entity.name === 'show').length, 0);
});

test('Ruby generated methods, class-method visibility, reflective sends and source hooks remain explicit gaps', async () => {
 for (const mutation of ['private_class_method :run', 'attr_reader :run', 'send(:define_singleton_method, :run)', 'def self.singleton_method_added(name); unknown; end']) {
  const root = await repository({ 'main.rb': `class Widget; def self.run; end; ${mutation}; end\nWidget.run` }); const graph = await index(root); assert.equal(targets(graph).length, 0, mutation);
 }
});

test('Ruby regular-expression named captures invalidate a previous concrete local value', async () => {
 const root = await repository({ 'main.rb': `class Widget; def show; end; end\nobj = Widget.new\n/(?<obj>.+)/ =~ input\nobj.show` }); const graph = await index(root); assert.equal(targets(graph).filter(item => item.entity.name === 'show').length, 0);
});

test('Ruby bare top-level methods bind while local references and forced same-name calls retain their distinction', async () => {
 const root = await repository({ 'main.rb': `def run; end\nrun\nrun = 3\nrun\nrun()` }); const graph = await index(root); assert.deepEqual(targets(graph).map(item => item.call.range.startLine), [2, 5]); assert.equal(calls(graph).length, 2);
});

test('Ruby operator, index and setter calls keep original sites while super/yield remain unresolved', async () => {
 const root = await repository({ 'main.rb': `class Widget\n def +(other); end\n def [](key); end\n def []=(key, value); end\n def value=(value); end\n def run; super; yield; end\nend\nobj = Widget.new\nobj + 1\nobj[0]\nobj[0] = 2\nobj.value = 3` });
 const graph = await index(root); assert.deepEqual(targets(graph).map(item => item.entity.name), ['+', '[]', '[]=', 'value=']); assert.ok(calls(graph).filter(item => ['super', 'yield'].includes(item.method)).every(item => item.kind === 'unresolved')); assert.equal(calls(graph).filter(item => ['super', 'yield'].includes(item.method)).length, 2);
});

test('Ruby shared source cannot borrow a different owning application load path for consumer startup', async () => {
 const root = await repository({ 'client/main.rb': `require 'widget'\nHelper.run`, 'shared/lib/widget.rb': `require 'helper'`, 'shared/other/helper.rb': 'class Helper; def self.run; end; end' });
 const apps: ApplicationInput[] = [{ name: 'client', path: 'client', ecosystems: ['ruby'], sourceRoots: { ruby: ['../shared/lib'] } }, { name: 'shared', path: 'shared', ecosystems: ['ruby'], sourceRoots: { ruby: ['other'] } }];
 const graph = await index(root, { apps }); assert.equal(targets(graph, 'client/main.rb').length, 0); assert.match(calls(graph, 'client/main.rb').find(item => item.method === 'run')?.reason ?? '', /consumer initialization/);
});

test('Ruby excessive reopenings retain original declarations and a bounded unresolved outcome', async () => {
 const root = await repository({ 'main.rb': Array.from({ length: 130 }, () => 'class Widget; def self.run; end; end').join('\n') + '\nWidget.run\nWidget' }); const graph = await index(root);
 assert.equal(graph.entities.filter(item => item.type === 'class' && item.name === 'Widget').length, 130); assert.equal(targets(graph).length, 0); assert.match(calls(graph).at(-1)?.reason ?? '', /candidate budget/); assert.match(references(graph).at(-1)?.reason ?? '', /candidate budget/);
});

test('Ruby singleton-class reopenings constrain later calls while retaining earlier original method evidence', async () => {
 const root = await repository({ 'main.rb': `class Widget; def self.run; end; end\nWidget.run\nclass << Widget; def run; end; end\nWidget.run` }); const graph = await index(root); assert.equal(targets(graph).length, 1); assert.equal(targets(graph)[0]?.call.range.startLine, 2); assert.match(calls(graph).at(-1)?.reason ?? '', /Singleton.class/);
 const deferred = await repository({ 'main.rb': `class Widget; def show; end; def alter; alias show other; end; end\nWidget.new.show` }); const altered = await index(deferred); assert.equal(targets(altered).length, 0); assert.match(calls(altered).find(item => item.method === 'show')?.reason ?? '', /aliases/);
});
