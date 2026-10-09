import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { indexRepository } from '../src/pipeline/index.js';
import { resolveConfig, type GoBuildConfig } from '../src/core/config.js';
import type { Entity, SoftwareGraph } from '../src/core/graph.js';
import { fileAnalysis } from '../src/analysis/facts.js';
import { AnalysisCache } from '../src/pipeline/cache.js';
import { canonicalJson } from '../src/history/fingerprint.js';

const temporary: string[] = [];
after(async () => { await Promise.all(temporary.map(root => rm(root, { recursive: true, force: true }))); });
async function repository(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'codiluce-go-symbols-')); temporary.push(root);
  for (const [file, text] of Object.entries({ 'go.mod': 'module example.com/app\ngo 1.25\n', ...files })) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); } return root;
}
async function index(root: string, go: GoBuildConfig = {}, cache?: AnalysisCache, revision?: string) {
  return indexRepository(root, { config: await resolveConfig(root, { repository: { name: 'go-symbols' }, applications: [{ name: 'app', path: '.', ecosystems: ['go'], go }] }), cache, revision });
}
const entity = (g: SoftwareGraph, name: string, file?: string) => g.entities.find(item => item.name === name && (!file || item.path === file))!;
const calls = (g: SoftwareGraph, from: Entity) => g.relations.filter(item => item.type === 'calls' && item.from === from.id);
const targets = (g: SoftwareGraph, from: Entity) => calls(g, from).map(item => g.entities.find(target => target.id === item.to)!.name).sort();
const outcomes = (g: SoftwareGraph, file: string) => entity(g, path.basename(file), file).metadata.goCallOutcomes as any[];
const stored = (g: SoftwareGraph) => canonicalJson({ entities: g.entities, relations: g.relations, diagnostics: g.diagnostics.filter(item => !['indexer', 'git-metrics'].includes(item.analyzer) && item.code !== 'git-ignore-unavailable') });

test('Go package symbols span files and imports bind actual namespaces and exported Unicode members', async () => {
  const root = await repository({ 'main.go': 'package app\nimport (r "example.com/app/lib"; "example.com/app/pkg/v2")\nfunc Entry(){Local();r.Handle();r.Écho();r.hidden();renamed.Other()}\n', 'local.go': 'package app\nfunc Local(){}\n', 'lib/handlers.go': 'package lib\nfunc Handle(){}\nfunc Écho(){}\nfunc hidden(){}\n', 'pkg/v2/lib.go': 'package renamed\nfunc Other(){}\n' });
  const g = await index(root), entry = entity(g, 'Entry'); assert.deepEqual(targets(g, entry), ['Handle', 'Local', 'Other', 'Écho']); assert.equal(entity(g, 'Écho').metadata.exported, true);
  assert.equal((entry.metadata.callSites as any).unresolved, 1); assert.equal(fileAnalysis(entity(g, 'main.go').metadata.analysis)?.features.references.status, 'partial');
  const edge = calls(g, entry).find(item => item.to === entity(g, 'Handle').id)!; assert.ok(edge.evidence.some(item => item.file === 'main.go' && item.line === 3)); assert.ok(edge.evidence.some(item => item.file === 'lib/handlers.go'));
});

test('Go file imports stay file-scoped and local variables shadow namespace and universe functions', async () => {
  const root = await repository({ 'one.go': 'package app\nimport "fmt"\nfunc One(){fmt.Println("ok");fmt:=func(){};fmt()}\n', 'two.go': 'package app\nfunc Two(fmt func(),len func()){fmt();len();fmt.Println("bad")}\n' });
  const g = await index(root); assert.equal((entity(g, 'One').metadata.callSites as any).external, 1); assert.deepEqual(targets(g, entity(g, 'One')), ['<closure>']); assert.equal((entity(g, 'Two').metadata.callSites as any).external, 0); assert.equal((entity(g, 'Two').metadata.callSites as any).unresolved, 3);
});

test('Go dot imports bind only original exported members; blank and unindexed dot imports never invent targets', async () => {
  const root = await repository({ 'main.go': 'package app\nimport (. "example.com/app/lib"; _ "example.com/app/side")\nfunc Entry(){Handle();hidden();Side()}\n', 'lib/lib.go': 'package lib\nfunc Handle(){}\nfunc hidden(){}\n', 'side/side.go': 'package side\nfunc Side(){}\n' });
  const g = await index(root); assert.deepEqual(targets(g, entity(g, 'Entry')), ['Handle']); assert.equal((entity(g, 'Entry').metadata.callSites as any).unresolved, 2);
  await writeFile(path.join(root, 'main.go'), 'package app\nimport . "fmt"\nfunc Entry(){Local();Println()}\nfunc Local(){}\n'); const gap = await index(root); assert.deepEqual(targets(gap, entity(gap, 'Entry')), []); assert.ok(outcomes(gap, 'main.go').every(item => item.reason?.includes('dot import')));
});

test('Go activation points preserve initializer bindings and nested block, if and for scopes', async () => {
  const root = await repository({ 'main.go': 'package app\nfunc Handle(){}\nfunc Other(){}\nfunc Entry(){Handle:=Handle;Handle();{Handle:=Other;Handle()};Handle();if Handle:=Other;true{Handle()};Handle();for Handle:=Other;false;{Handle()};Handle()}\n' });
  const g = await index(root); assert.deepEqual(targets(g, entity(g, 'Entry')), ['Handle', 'Other']); assert.equal((entity(g, 'Entry').metadata.callSites as any).resolved, 7); assert.equal((entity(g, 'Entry').metadata.callSites as any).unresolved, 0);
});

test('Go short redeclaration, assignment, augmentation, closure writes and address escape invalidate function identity', async () => {
  const root = await repository({ 'main.go': 'package app\nfunc Handle(){}\nfunc Other(){}\nvar Global=Handle\nfunc Entry(){a:=Handle;a();a,b:=Other,0;a();_ = b;var f=Handle;f();f=Other;f();g:=Handle;_=&g;g();h:=Handle;_ = func(){h=Other};h();Global()}\nfunc Change(){Global=Other}\n' });
  const g = await index(root); assert.deepEqual(targets(g, entity(g, 'Entry')), []); assert.equal((entity(g, 'Entry').metadata.callSites as any).unresolved, 7); assert.ok(outcomes(g, 'main.go').filter(item => item.kind === 'unresolved').every(item => /Reassigned/.test(item.reason)));
});

test('Go immutable function aliases, package initializers and original function literals retain call ownership and timing', async () => {
  const root = await repository({ 'main.go': 'package app\nfunc Handle(){}\nvar Global=Handle\nfunc Entry(){var f func()=Global;f();g:=func(){Handle()};g();defer g();go g();(func(){Handle()})()}\n' });
  const g = await index(root), entry = entity(g, 'Entry'), closures = g.entities.filter(item => item.metadata.declarationKind === 'closure'); assert.equal(closures.length, 2); assert.deepEqual(targets(g, entry), ['<closure>', '<closure>', '<closure>', '<closure>', 'Handle']);
  for (const closure of closures) { assert.equal(closure.parentId, entry.id); assert.deepEqual(targets(g, closure), ['Handle']); }
  assert.deepEqual(calls(g, entry).filter(item => item.to === closures.find(c => calls(g, entry).filter(edge => edge.to === c.id).length === 3)!.id).map(item => item.metadata?.timing).sort(), ['deferred', 'goroutine', 'immediate']);
});

test('Go direct receiver methods attach across package files and pointer method sets respect addressability', async () => {
  const root = await repository({ 'types.go': 'package app\ntype Service struct{}\n', 'methods.go': 'package app\nfunc(s Service)Value(){}\nfunc(s *Service)Pointer(){}\n', 'main.go': 'package app\nfunc Entry(){v:=Service{};v.Value();v.Pointer();Service{}.Value();Service{}.Pointer();(&Service{}).Pointer();Service.Value(v);Service.Pointer(v);(*Service).Pointer(&v)}\n' });
  const g = await index(root), entry = entity(g, 'Entry'); assert.equal(entity(g, 'Value').parentId, entity(g, 'Service').id); assert.equal(entity(g, 'Pointer').parentId, entity(g, 'Service').id); assert.deepEqual(targets(g, entry), ['Pointer', 'Pointer', 'Value', 'Value']); assert.equal((entry.metadata.callSites as any).resolved, 6); assert.equal((entry.metadata.callSites as any).unresolved, 2);
  assert.ok(calls(g, entry).some(item => item.to === entity(g, 'Pointer').id && item.metadata?.methodExpression === true));
});

test('Go concrete parameters, new, static factories, method values and variable reassignment bind receiver methods', async () => {
  const root = await repository({ 'main.go': 'package app\ntype Service struct{}\nfunc(s *Service)Handle(){}\nfunc Make()*Service{return &Service{}}\nfunc Entry(s *Service){s.Handle();n:=new(Service);n.Handle();Make().Handle();f:=s.Handle;f();n=&Service{};n.Handle()}\n' });
  const g = await index(root), entry = entity(g, 'Entry'); assert.deepEqual(targets(g, entry), ['Handle', 'Make']); assert.equal((entry.metadata.callSites as any).resolved, 6); assert.equal((entry.metadata.callSites as any).external, 1); assert.equal((entry.metadata.callSites as any).unresolved, 0);
});

test('Go interface dispatch, function parameters, function fields, collection values and higher-order returns remain gaps', async () => {
  const root = await repository({ 'main.go': 'package app\ntype Service struct{}\nfunc(s Service)Handle(){}\ntype Contract interface{Handle()}\ntype Box struct{Callback func()}\nfunc Handler(){}\nfunc Factory()func(){return Handler}\nfunc Entry(i Contract,cb func(),box Box,fs []func()){i.Handle();cb();box.Callback();fs[0]();Factory()();var j Contract=Service{};j.Handle()}\n' });
  const g = await index(root), entry = entity(g, 'Entry'); assert.deepEqual(targets(g, entry), ['Factory']); assert.equal((entry.metadata.callSites as any).unresolved, 6); assert.ok(outcomes(g, 'main.go').some(item => item.reason?.includes('Interface')));
});

test('Go aliases share direct methods while new defined types and promoted selectors require their own proof', async () => {
  const root = await repository({ 'main.go': 'package app\ntype Base struct{}\nfunc(b Base)Handle(){}\ntype Alias=Base\ntype New Base\ntype Embedded struct{Base}\nfunc Entry(){Alias{}.Handle();New{}.Handle();Embedded{}.Handle()}\n' });
  const g = await index(root); assert.deepEqual(targets(g, entity(g, 'Entry')), ['Handle']); assert.equal((entity(g, 'Entry').metadata.callSites as any).unresolved, 2); assert.ok(outcomes(g, 'main.go').some(item => item.reason?.includes('Promoted')));
});

test('Go direct named struct fields select receiver types and never turn function field assignments into direct callbacks', async () => {
  const root = await repository({ 'main.go': 'package app\ntype Child struct{}\nfunc(c *Child)Handle(){}\ntype Parent struct{Child *Child;Callback func()}\nfunc Handler(){}\nfunc Entry(p Parent){p.Child.Handle();p.Callback=Handler;p.Callback()}\n' });
  const g = await index(root); assert.deepEqual(targets(g, entity(g, 'Entry')), ['Handle']); assert.equal((entity(g, 'Entry').metadata.callSites as any).unresolved, 1);
});

test('Go conversions reference types without counting calls and generic direct functions retain declaration identity', async () => {
  const root = await repository({ 'main.go': 'package app\ntype Value int\nfunc Identity[T any](x T)T{return x}\nfunc Entry(){_ = Value(1);_ = int(2);_ = Identity[int](3);f:=Identity[int];_ = f(4)}\n' });
  const g = await index(root), entry = entity(g, 'Entry'); assert.deepEqual(targets(g, entry), ['Identity']); assert.equal((entry.metadata.callSites as any).resolved, 2); assert.equal(outcomes(g, 'main.go').filter(item => item.kind === 'conversion').length, 2); assert.ok(g.relations.some(item => item.type === 'references' && item.from === entry.id && item.to === entity(g, 'Value').id));
});

test('Go generic parameters cannot inherit same-named package types and non-generic function indexes are unresolved', async () => {
  const root = await repository({ 'main.go': 'package app\ntype T struct{}\nfunc(t T)Handle(){}\ntype Box[T any]struct{Value T}\nfunc(b Box[T])Get()T{return b.Value}\ntype Scalar int\nfunc(s Scalar)Handle(){}\nfunc Identity[T any](x T)T{return x}\nfunc Handler(){}\nfunc Entry(){Identity[int](1).Handle();f:=Handler[0];f();var b Box[int];b.Value.Handle();b.Get().Handle();Scalar{}.Handle()}\n' });
  const g = await index(root), entry = entity(g, 'Entry'); assert.deepEqual(targets(g, entry), ['Get', 'Identity']); assert.equal((entry.metadata.callSites as any).unresolved, 5);
});

test('Go imported concrete results and receiver callbacks use the consumer build inputs across application boundaries', async () => {
  const root = await repository({ 'go.work': 'go 1.25\nuse (\n ./consumer\n ./shared\n)\n', 'consumer/go.mod': 'module example.com/consumer\ngo 1.25\n', 'consumer/main.go': 'package consumer\nimport r "example.com/shared"\nfunc Entry(){v:=r.New();f:=v.Serve;f()}\n', 'shared/go.mod': 'module example.com/shared\ngo 1.25\n', 'shared/service_linux.go': 'package shared\ntype Service struct{}\nfunc New()*Service{return &Service{}}\nfunc(s *Service)Serve(){}\n', 'shared/service_windows.go': 'package shared\ntype Service struct{}\nfunc New()*Service{return &Service{}}\nfunc(s *Service)Serve(){}\n' });
  const config = await resolveConfig(root, { repository: { name: 'go-symbols' }, applications: [{ name: 'consumer', path: 'consumer', ecosystems: ['go'], go: { goos: 'linux' } }, { name: 'shared', path: 'shared', ecosystems: ['go'], go: { goos: 'windows' } }] });
  const g = await indexRepository(root, { config }), entry = entity(g, 'Entry'); assert.deepEqual(targets(g, entry), ['New', 'Serve']); assert.ok(calls(g, entry).every(edge => g.entities.find(item => item.id === edge.to)?.path === 'shared/service_linux.go'));
  assert.equal(fileAnalysis(entity(g, 'service_linux.go').metadata.analysis)?.features.references.status, 'disabled'); assert.equal(fileAnalysis(entity(g, 'service_windows.go').metadata.analysis)?.features.references.status, 'partial');
});

test('Go type-switch aliases, range variables and select cases shadow package names only in their scopes', async () => {
  const root = await repository({ 'main.go': 'package app\nfunc Handle(){}\ntype Service struct{}\nfunc(s *Service)Work(){}\nfunc Entry(x any,items []func(),ch chan func()){switch Handle:=x.(type){case *Service:Handle.Work();default:Handle()};Handle();for _,Handle:=range items{Handle()};Handle();select{case Handle:= <-ch:Handle();default:Handle()};Handle()}\n' });
  const g = await index(root), entry = entity(g, 'Entry'); assert.deepEqual(targets(g, entry), ['Handle', 'Work']); assert.equal((entry.metadata.callSites as any).resolved, 5); assert.equal((entry.metadata.callSites as any).unresolved, 3);
});

test('Go package import cycles, duplicate declarations and file/package collisions cannot prove call targets', async () => {
  for (const files of [
    { 'main.go': 'package app\nimport "example.com/app/a"\nfunc Entry(){a.A()}\n', 'a/a.go': 'package a\nimport "example.com/app/b"\nfunc A(){b.B()}\n', 'b/b.go': 'package b\nimport "example.com/app/a"\nfunc B(){a.A()}\n' },
    { 'main.go': 'package app\nfunc Entry(){Handle()}\nfunc Handle(){}\n', 'other.go': 'package app\nfunc Handle(){}\n' },
    { 'main.go': 'package app\nimport "fmt"\nfunc Entry(){fmt()}\n', 'other.go': 'package app\nfunc fmt(){}\n' },
  ] as Record<string, string>[]) { const g = await index(await repository(files)); assert.deepEqual(targets(g, entity(g, 'Entry')), []); assert.ok(g.diagnostics.some(item => item.analyzer === 'go-symbols') || outcomes(g, 'main.go').some(item => item.kind === 'unresolved')); }
});

test('Go unknown build alternatives and inactive tests retain gaps; explicit inputs select actual function declarations', async () => {
  const root = await repository({ 'main.go': 'package app\nfunc Entry(){Handle()}\n', 'handlers_linux.go': 'package app\nfunc Handle(){}\n', 'handlers_windows.go': 'package app\nfunc Handle(){}\n', 'main_test.go': 'package app\nfunc Test(){Entry()}\n' });
  const unknown = await index(root); assert.deepEqual(targets(unknown, entity(unknown, 'Entry')), []); assert.equal(fileAnalysis(entity(unknown, 'main_test.go').metadata.analysis)?.features.references.status, 'disabled');
  const selected = await index(root, { goos: 'linux' }); assert.equal(calls(selected, entity(selected, 'Entry'))[0]!.to, entity(selected, 'Handle', 'handlers_linux.go').id); const tests = await index(root, { goos: 'linux', includeTests: true }); assert.deepEqual(targets(tests, entity(tests, 'Test')), ['Entry']);
});

test('Go external test package callbacks bind exports without merging private package scopes', async () => {
  const root = await repository({ 'main.go': 'package app\nfunc Handle(){}\nfunc private(){}\n', 'main_test.go': 'package app_test\nimport "example.com/app"\nfunc Test(){app.Handle();app.private();private()}\n' });
  const g = await index(root, { includeTests: true }); assert.deepEqual(targets(g, entity(g, 'Test')), ['Handle']); assert.equal((entity(g, 'Test').metadata.callSites as any).unresolved, 2);
});

test('Go original Unicode/CRLF positions and cold/warm/revision replay preserve callbacks and cross-file containment', async () => {
  const root = await repository({ 'main.go': '// 😀 original\r\npackage app\r\nfunc Entry(){f:=func(){Handle()};f()}\r\n', 'type.go': 'package app\ntype Service struct{}', 'method.go': 'package app\nfunc(s Service)Work(){}', 'handler.go': 'package app\nfunc Handle(){}' }), state = await mkdtemp(path.join(tmpdir(), 'codiluce-go-symbol-cache-')); temporary.push(state);
  const cold = await index(root, {}, new AnalysisCache(state)), warm = await index(root, {}, new AnalysisCache(state)), revision = await index(root, {}, undefined, 'recorded'); assert.equal(stored(cold), stored(warm)); assert.equal(stored(cold), stored(revision));
  const closure = cold.entities.find(item => item.metadata.declarationKind === 'closure')!; assert.equal(closure.sourceRange?.startLine, 3); assert.equal(closure.sourceRange?.startColumn, 17); assert.equal(entity(cold, 'Work').parentId, entity(cold, 'Service').id);
  await writeFile(path.join(root, 'main.go'), '\n// 😀 original\r\npackage app\r\nfunc Entry(){f:=func(){Handle()};f()}\r\n'); const moved = await index(root, {}, new AnalysisCache(state)); assert.equal(entity(moved, 'Entry').id, entity(cold, 'Entry').id); assert.equal(moved.entities.find(item => item.metadata.declarationKind === 'closure')!.id, closure.id); assert.equal(calls(moved, entity(moved, 'Entry'))[0]!.id, calls(cold, entity(cold, 'Entry'))[0]!.id); assert.equal(moved.entities.find(item => item.id === closure.id)?.sourceRange?.startLine, 4);
  await writeFile(path.join(root, 'handler.go'), 'package app\nfunc Other(){}'); const changed = await index(root, {}, new AnalysisCache(state)); assert.deepEqual(targets(changed, changed.entities.find(item => item.id === closure.id)!), []); assert.equal((changed.entities.find(item => item.id === closure.id)!.metadata.callSites as any).unresolved, 1);
});
