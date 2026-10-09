import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { indexRepository, analyzers } from '../src/pipeline/index.js';
import { resolveConfig, type RustConfig } from '../src/core/config.js';
import { AnalysisCache } from '../src/pipeline/cache.js';
import { canonicalJson } from '../src/history/fingerprint.js';
import { GraphBuilder, type SoftwareGraph } from '../src/core/graph.js';
import type { AnalysisContext } from '../src/core/analyzer.js';
import { StructureParser } from '../src/analysis/tree-sitter/client.js';

const roots: string[] = [];
after(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });
async function put(root: string, file: string, text: string) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); }
async function repo(source: string, files: Record<string, string> = {}, extra = '', edition = '2021') {
  const root = await mkdtemp(path.join(tmpdir(), 'codiluce-rust-symbols-')); roots.push(root);
  for (const [file, content] of Object.entries({ 'Cargo.toml': `[package]\nname="api"\nversion="1.0.0"\nedition="${edition}"\n${extra}`, 'src/lib.rs': source, ...files })) await put(root, file, content);
  return root;
}
const selected: RustConfig = { features: [], defaultFeatures: false };
async function index(root: string, rust: RustConfig = selected, cache?: AnalysisCache, revision?: string, ignore?: string[]) {
  return indexRepository(root, { config: await resolveConfig(root, { applications: [{ name: 'api', path: '.', rust }], ignore }), cache, revision });
}
type Outcome = { name?: string; start: number; compilation: string; owner: string; status: string; target?: string; reason?: string; execution?: string; range: { startLine: number }; proof: { file?: string; line?: number }[] };
const unit = (g: SoftwareGraph, file = 'src/lib.rs') => g.entities.find(e => e.type === 'file' && e.path === file)!;
const calls = (g: SoftwareGraph, file = 'src/lib.rs') => (unit(g, file).metadata.rustCallOutcomes ?? []) as Outcome[];
const references = (g: SoftwareGraph, file = 'src/lib.rs') => (unit(g, file).metadata.rustReferenceOutcomes ?? []) as Outcome[];
const entity = (g: SoftwareGraph, name: string, file = 'src/lib.rs') => g.entities.find(e => e.name === name && e.path === file && e.type !== 'file')!;
const call = (g: SoftwareGraph, name: string) => calls(g).filter(c => c.name === name);
const targets = (g: SoftwareGraph) => calls(g).filter(c => c.status === 'resolved').map(c => g.entities.find(e => e.id === c.target)?.name);
const shape = (g: SoftwareGraph) => canonicalJson({ entities: g.entities, relations: g.relations, diagnostics: g.diagnostics.filter(d => !['git-metrics', 'indexer'].includes(d.analyzer) && d.code !== 'git-ignore-unavailable') });

test('Rust direct source calls retain original definitions, owner, ranges and proof through CRLF/emoji', async () => {
  const g = await index(await repo('// 😀\r\nfn leaf(){}\r\npub fn run(){leaf();}\r\n'));
  const leaf = entity(g, 'leaf'), run = entity(g, 'run'), c = call(g, 'leaf')[0]!;
  assert.equal(c.status, 'resolved'); assert.equal(c.target, leaf.id); assert.equal(c.owner, run.id); assert.equal(c.range.startLine, 3);
  assert.ok(c.proof.some(p => p.file === 'src/lib.rs' && p.line === 2));
  assert.ok(g.relations.some(e => e.type === 'calls' && e.from === run.id && e.to === leaf.id));
  assert.deepEqual(run.metadata.callSites, { resolved: 1, external: 0, unresolved: 0, unresolvedNames: {} });
  assert.equal((unit(g).metadata.analysis as any).features.references.status, 'partial');
});
test('Renamed use and source re-exports bind the original function rather than a new alias', async () => {
  const g = await index(await repo('mod inner;pub use crate::inner::leaf as exported;mod client{use crate::exported as renamed;pub fn run(){renamed();}}', { 'src/inner.rs': 'pub fn leaf(){}' }));
  assert.equal(call(g, 'renamed')[0]!.target, entity(g, 'leaf', 'src/inner.rs').id);
  assert.ok(references(g).some(r => r.target === entity(g, 'leaf', 'src/inner.rs').id));
});
test('Edition 2015 expression paths stay lexical even when use paths start at the root', async () => {
  const g = await index(await repo('mod a{pub fn root(){}}mod b{mod a{pub fn local(){}}fn run(){a::local();a::root();}}', {}, '', '2015'));
  assert.equal(call(g, 'a::local')[0]!.status, 'resolved'); assert.equal(call(g, 'a::root')[0]!.status, 'unresolved');
});
test('Immutable aliases activate after their initializer and each shadowing declaration keeps its operand', async () => {
  const g = await index(await repo('fn first(){}fn second(){}fn run(){let cb=first;cb();let cb=cb;cb();{let cb=second;cb();}cb();}'));
  assert.deepEqual(call(g, 'cb').map(c => c.target), ['first', 'first', 'second', 'first'].map(name => entity(g, name).id));
});
test('Parameters shadow source function names and typed function pointers alone have no original callback', async () => {
  const g = await index(await repo('fn cb(){}fn run(cb:fn()){cb();}'));
  assert.equal(call(g, 'cb')[0]!.status, 'unresolved'); assert.equal(targets(g).length, 0);
});
test('Mutable callbacks and later assignments cannot produce a fixed source call edge', async () => {
  const g = await index(await repo('fn a(){}fn b(){}fn run(){let mut cb=a;cb();cb=b;cb();}'));
  assert.ok(call(g, 'cb').every(c => c.status === 'unresolved')); assert.equal(targets(g).length, 0);
});
test('Mutable borrowing of an alias invalidates a fixed callback even before the borrow', async () => {
  const g = await index(await repo('fn a(){}fn take(_: &mut fn()){}fn run(){let mut cb=a as fn();cb();take(&mut cb);cb();}'));
  assert.ok(call(g, 'cb').every(c => c.status !== 'resolved')); assert.equal(call(g, 'take')[0]!.status, 'resolved');
});
test('Function pointer casts and shared references preserve an immutable original function operand', async () => {
  const g = await index(await repo('fn leaf(){}fn run(){let ptr=leaf as fn();ptr();let cb=&leaf;cb();(*cb)();}'));
  assert.deepEqual(targets(g), ['leaf', 'leaf', 'leaf']);
});
test('Original source constants can carry callbacks but mutable statics cannot', async () => {
  const g = await index(await repo('fn leaf(){}const CB:fn()=leaf;static mut BAD:fn()=leaf;fn run(){CB();unsafe{BAD();}}'));
  assert.equal(call(g, 'CB')[0]!.target, entity(g, 'leaf').id); assert.equal(call(g, 'BAD')[0]!.status, 'unresolved');
});
test('Each original closure owns its body calls while the enclosing function calls the closure', async () => {
  const g = await index(await repo('fn leaf(){}fn run(){let cb=||leaf();cb();}'));
  const closure = entity(g, '<closure>'), run = entity(g, 'run'); assert.ok(closure); assert.equal(closure.parentId, run.id);
  assert.equal(call(g, 'leaf')[0]!.owner, closure.id); assert.equal(call(g, 'cb')[0]!.owner, run.id); assert.equal(call(g, 'cb')[0]!.target, closure.id);
});
test('Immediately called and nested closures keep distinct original identities and lexical captures', async () => {
  const g = await index(await repo('fn leaf(){}fn run(){let cb=leaf;let outer=||{let inner=||cb();inner();};outer();(||leaf())();}'));
  const closures = g.entities.filter(e => e.metadata.declarationKind === 'closure'); assert.equal(closures.length, 3);
  assert.equal(call(g, 'cb')[0]!.target, entity(g, 'leaf').id); assert.equal(call(g, 'inner')[0]!.status, 'resolved'); assert.equal(call(g, 'outer')[0]!.status, 'resolved');
});
test('Closure parameters shadow captures without inventing compiler type inference', async () => {
  const g = await index(await repo('fn cb(){}fn run(){let lambda=|cb:fn()|cb();lambda(cb);}'));
  assert.equal(call(g, 'cb')[0]!.status, 'unresolved'); assert.equal(call(g, 'lambda')[0]!.status, 'resolved');
});
test('Nested named functions cannot capture outer locals but can bind their own nested source items', async () => {
  const g = await index(await repo('fn leaf(){}fn run(){let cb=leaf;fn nested(){cb();fn inner(){}inner();}nested();}'));
  assert.equal(call(g, 'cb')[0]!.status, 'unresolved'); assert.equal(call(g, 'inner')[0]!.status, 'resolved'); assert.equal(call(g, 'nested')[0]!.status, 'resolved');
});
test('if-let bindings stay in their positive control scope and do not leak into else/after', async () => {
  const g = await index(await repo('fn cb(){}fn run(){if let Some(cb)=None{cb();}else{cb();}cb();}'));
  assert.deepEqual(call(g, 'cb').map(c => c.status), ['unsupported', 'resolved', 'resolved']);
});
test('for and match bindings shadow only their body/arm and guards keep pattern scope', async () => {
  const g = await index(await repo('fn cb(){}fn run(){for cb in []{cb();}cb();match None{Some(cb) if cb()=>{cb();},_=>cb(),}cb();}'));
  assert.deepEqual(call(g, 'cb').map(c => c.status), ['unresolved', 'resolved', 'unsupported', 'unsupported', 'resolved', 'resolved']);
});
test('Tuple aliases can preserve literal callback operands; destructured fields require inference', async () => {
  const g = await index(await repo('fn leaf(){}struct State{cb:fn()}fn run(){let (a,b)=(leaf,leaf);a();b();let State{cb}=State{cb:leaf};cb();}'));
  assert.deepEqual(call(g, 'a').map(c => c.status), ['resolved']); assert.equal(call(g, 'b')[0]!.status, 'resolved'); assert.equal(call(g, 'cb')[0]!.status, 'unsupported');
});
test('Qualified inherent functions, concrete receiver annotations, aliases and Self keep source method targets', async () => {
  const g = await index(await repo('struct State;type Alias=State;impl State{fn create()->Self{State}fn run(&self){Self::helper();}fn helper(){}}fn entry(){State::helper();let state:Alias=State;state.run();}'));
  assert.ok(call(g, 'State::helper').every(c => c.status === 'resolved')); assert.equal(call(g, 'Self::helper')[0]!.status, 'resolved'); assert.equal(call(g, 'state.run')[0]!.status, 'resolved');
});
test('Concrete immutable factory return annotations bind original inherent methods', async () => {
  const g = await index(await repo('struct State;impl State{fn run(&self){}}fn factory()->State{State}fn entry(){let state=factory();state.run();}'));
  assert.equal(call(g, 'state.run')[0]!.status, 'resolved');
});
test('Exact borrowed receivers bind source inherent methods without claiming arbitrary deref search', async () => {
  const g = await index(await repo('struct State;impl State{fn run(&self){}}fn entry(state:&State){state.run();let extra=&state;extra.run();}'));
  assert.equal(call(g, 'state.run')[0]!.status, 'resolved'); assert.equal(call(g, 'extra.run')[0]!.status, 'unresolved');
});
test('Trait candidate precedence prevents autoref certification even for an original inherent name', async () => {
  const g = await index(await repo('struct State;trait Trait{fn run(self);}impl Trait for State{fn run(self){}}impl State{fn run(&mut self){}}fn entry(state:State){state.run();}'));
  assert.equal(call(g, 'state.run')[0]!.status, 'unresolved');
});
test('Blanket source traits and prelude method names retain uncertain dispatch', async () => {
  const g = await index(await repo('struct State;trait Trait{fn run(self);}impl<T> Trait for T{fn run(self){}}impl State{fn run(&self){}fn clone(&self){}}fn entry(state:State){state.run();state.clone();}'));
  assert.ok(calls(g).every(c => c.status !== 'resolved'));
});
test('Trait-qualified and generic inherent dispatch never gets an inferred source winner', async () => {
  const g = await index(await repo('struct State<T>(T);trait Trait{fn run();}impl<T> State<T>{fn run(){}}fn entry(){State::<u32>::run();<State<u32> as Trait>::run();}'));
  assert.ok(calls(g).every(c => c.status !== 'resolved'));
});
test('Competing inherent declarations, privacy and wrong argument counts remain gaps', async () => {
  const g = await index(await repo('mod inner{pub struct State;impl State{fn hidden(){}pub fn one(x:u32){}}}struct Dup;impl Dup{fn run(){}}impl Dup{fn run(){}}fn entry(){inner::State::hidden();inner::State::one();Dup::run();}'));
  assert.ok(calls(g).every(c => c.status !== 'resolved'));
});
test('Generic free callable identity is preserved as an unsupported instantiation', async () => {
  const g = await index(await repo('fn generic<T>(_:T){}fn run(){generic(1);generic::<u32>(1);}'));
  assert.ok(calls(g).every(c => c.status === 'unsupported')); assert.ok(calls(g).every(c => /Generic/.test(c.reason ?? '')));
});
test('Direct immutable source helper returns bind callback parameters at each caller', async () => {
  const g = await index(await repo('fn a(){}fn b(){}fn identity(cb:fn())->fn(){cb}fn run(){let first=identity(a);let second=identity(b);first();second();}'));
  assert.equal(call(g, 'first')[0]!.target, entity(g, 'a').id); assert.equal(call(g, 'second')[0]!.target, entity(g, 'b').id);
});
test('Conditional, recursive and mutable parameter callback returns require compiler/flow inference', async () => {
  const g = await index(await repo('fn a(){}fn conditional(flag:bool)->fn(){if flag{return a;}a}fn recursive()->fn(){recursive()}fn mutable(mut cb:fn())->fn(){cb}fn run(){let x=conditional(true);x();let y=recursive();y();let z=mutable(a);z();}'));
  for (const name of ['x', 'y', 'z']) assert.equal(call(g, name)[0]!.status, 'unresolved');
});
test('Async functions record future construction/awaiting and original async block ownership', async () => {
  const g = await index(await repo('fn leaf(){}async fn work(){leaf();}async fn run(){let future=work();work().await;let block=async{leaf();};block.await;}'));
  assert.deepEqual(call(g, 'work').map(c => c.execution), ['future-construction', 'awaited']);
  const block = entity(g, '<async block>'); assert.ok(block); assert.ok(call(g, 'leaf').some(c => c.owner === block.id)); assert.equal(block.metadata.deferred, true);
});
test('Recorded cfg excludes inactive bodies and does not certify unknown source alternatives', async () => {
  const root = await repo('fn leaf(){}#[cfg(feature="api")]fn active(){leaf();}#[cfg(unix)]fn platform(){leaf();}', {}, '[features]\napi=[]');
  const g = await index(root); assert.deepEqual(call(g, 'leaf').map(c => c.status), ['excluded', 'unsupported']);
  const enabled = await index(root, { features: ['api'], defaultFeatures: false, cfg: { flags: ['unix'] } }); assert.deepEqual(call(enabled, 'leaf').map(c => c.status), ['resolved', 'resolved']);
});
test('Macro source and incomplete parse retain syntax gaps without certified calls', async () => {
  for (const source of ['fn leaf(){}fn run(){unknown!();leaf();}', 'fn leaf(){}fn run(){leaf();let x =']) {
    const g = await index(await repo(source)); assert.ok(calls(g).every(c => c.status !== 'resolved')); assert.equal(g.relations.filter(e => e.type === 'calls').length, 0);
  }
  const targetBudget = await index(await repo('mod target;fn run(){target::leaf();}', { 'src/target.rs': 'pub fn leaf(){}pub fn large(){' + 'leaf;'.repeat(40_010) + '}' }));
  assert.equal((unit(targetBudget, 'src/target.rs').metadata.analysis as any).features.references.status, 'failed');
  assert.equal(call(targetBudget, 'target::leaf')[0]!.status, 'unsupported');
  assert.equal(targetBudget.relations.filter(e => e.type === 'calls').length, 0);
});
test('Original enum types/fields keep source references while field callback calls remain opaque', async () => {
  const g = await index(await repo('enum E{A}struct State{cb:fn()}fn run(state:State,e:E){state.cb;let cb=state.cb;cb();}'));
  assert.ok(references(g).some(r => r.target === entity(g, 'E').id)); assert.ok(references(g).some(r => r.target === entity(g, 'cb').id)); assert.equal(call(g, 'cb')[0]!.status, 'unresolved');
});
test('Cargo local dependency callbacks retain original shared files and separate compilation identities', async () => {
  const g = await index(await repo('use shared::leaf as cb;pub fn run(){cb();}', { 'shared/Cargo.toml': '[package]\nname="shared"\nversion="1.0.0"\nedition="2021"', 'shared/src/lib.rs': 'pub fn leaf(){}', 'src/main.rs': 'fn main(){api::run();}' }, '[dependencies]\nshared={path="shared"}'));
  const rows = call(g, 'cb'); assert.equal(rows.length, 2); assert.equal(new Set(rows.map(r => r.compilation)).size, 2); assert.ok(rows.every(r => r.target === entity(g, 'leaf', 'shared/src/lib.rs').id));
  assert.equal(calls(g, 'src/main.rs')[0]!.target, entity(g, 'run').id);
  assert.equal((entity(g, 'run').metadata.callSites as any).resolved, 1);
});
test('External runtime operands retain dependency identity without fabricating source callees', async () => {
  const g = await index(await repo('use remote::callback;fn run(){callback();remote::other();}', {}, '[dependencies]\nremote="1"'));
  assert.deepEqual(calls(g).map(c => c.status), ['external', 'external']); assert.equal(targets(g).length, 0);
});
test('Original anonymous IDs survive harmless line shifts and ranges advance with their source', async () => {
  const source = 'fn leaf(){}fn run(){let cb=||leaf();cb();}', root = await repo(source), before = await index(root);
  await put(root, 'src/lib.rs', '// 😀 shifted\n\n' + source); const after = await index(root);
  assert.equal(entity(before, '<closure>').id, entity(after, '<closure>').id); assert.equal(entity(after, '<closure>').sourceRange!.startLine, 3); assert.equal(entity(before, 'leaf').id, entity(after, 'leaf').id);
});
test('Orphan files are disabled and grammar extraction provides original scope/closure facts', async () => {
  const root = await repo('fn leaf(){}', { 'orphan.rs': 'fn cb(){}fn run(){cb();}' }), g = await index(root);
  assert.equal((unit(g, 'orphan.rs').metadata.analysis as any).features.references.status, 'disabled'); assert.equal(calls(g, 'orphan.rs').length, 0);
  const parser = new StructureParser(); try { const facts = await parser.parse('rust', 'fn run(){let cb=|x:u32|x;cb(1);}'); assert.equal(facts.rust?.semantic?.complete, true); assert.ok(facts.rust?.scopes.some(s => s.kind === 'lambda' && s.owner)); assert.ok(facts.rust?.semantic?.definitions.some(d => d.kind === 'closure')); } finally { await parser.close(); }
});
test('Cold/warm/revision Rust symbols replay exactly and shared source/config/deny inputs invalidate it', async () => {
  const root = await repo('mod shared;fn run(){shared::leaf();let cb=||shared::leaf();cb();}', { 'src/shared.rs': 'pub fn leaf(){}' }), state = await mkdtemp(path.join(tmpdir(), 'codiluce-rust-symbol-cache-')); roots.push(state);
  const cold = await index(root, selected, new AnalysisCache(state)), cache = new AnalysisCache(state), warm = await index(root, selected, cache), revision = await index(root, selected, undefined, 'recorded-revision');
  assert.equal(shape(cold), shape(warm)); assert.equal(shape(cold), shape(revision)); assert.ok(cache.events.some(e => e.analyzer === 'rust-symbols' && e.hit));
  await put(root, 'src/shared.rs', 'pub fn other(){}'); const changed = await index(root, selected, new AnalysisCache(state)); assert.ok(call(changed, 'shared::leaf').every(c => c.status !== 'resolved')); assert.equal(shape(changed), shape(await index(root)));
  await put(root, 'src/shared.rs', 'pub fn leaf(){}'); const denied = await index(root, selected, new AnalysisCache(state), undefined, ['src/shared.rs']); assert.ok(call(denied, 'shared::leaf').every(c => c.status !== 'resolved'));
  await put(root, 'Cargo.toml', '[package]\nname="api"\nversion="1.0.0"\nedition="2021"\n[lib]\npath="other.rs"'); const excluded = await index(root, selected, new AnalysisCache(state)); assert.equal(calls(excluded).length, 0);
});
test('Direct handler service binds original functions/closures/helper-return aliases after warm cache replay', async () => {
  const root = await repo('fn leaf(){}fn generic<T>(){}fn identity(cb:fn())->fn(){cb}fn run(){let alias=identity(leaf);register(alias);register(||leaf());register(generic);}'), state = await mkdtemp(path.join(tmpdir(), 'codiluce-rust-handler-cache-')); roots.push(state);
  const targets: string[][] = [];
  for (let pass = 0; pass < 2; pass++) {
    const config = await resolveConfig(root, { applications: [{ name: 'api', path: '.', rust: selected }] }), graph = new GraphBuilder(config.repository.name), context: AnalysisContext = { root, config, graph, repositoryId: graph.id('repository'), applicationIds: new Map(), files: new Map(), http: [], cache: new AnalysisCache(state) };
    for (const analyzer of analyzers) { await analyzer.analyze(context); if (analyzer.name === 'rust-symbols') break; }
    const symbols = context.rustSymbols!, registrations = symbols.facts('src/lib.rs')!.calls.filter(c => c.expression.callee.kind === 'path' && c.expression.callee.segments[0] === 'register');
    const selectedScope = context.rust!.membership.get('src/lib.rs')!.find(s => s.fact.key === registrations[0]!.scope)!;
    // Exhaust a preceding semantic request: handler allowance is independent of
    // cold extraction work or whether graph patches were replayed from cache.
    for (let i = 0; i < 500_001; i++) symbols.value(selectedScope, { ...registrations[0]!, kind: 'unknown', text: 'unreviewed operand' });
    const results = registrations.map(c => symbols.handler(context.rust!.membership.get('src/lib.rs')!.find(s => s.fact.key === c.scope)!, c.expression.args[0]!));
    assert.deepEqual(results.map(r => r.status), ['resolved', 'resolved', 'unresolved']);
    targets.push(results.flatMap(r => r.status === 'resolved' ? [r.definition.id] : []));
    assert.ok(targets[pass]!.every(id => graph.entities.has(id)));
    if (pass) assert.ok(context.cache!.events.some(e => e.analyzer === 'rust-symbols' && e.hit));
  }
  assert.deepEqual(targets[0], targets[1]);
});
test('let-else failure bodies bind outer names before the new pattern activates', async () => {
  const g = await index(await repo('fn cb(){}fn run(){let Some(cb)=None else{cb();return;};cb();}'));
  assert.deepEqual(call(g, 'cb').map(c => c.status), ['resolved', 'unsupported']);
});
test('Local dependency aliases keep the canonical crate for public inherent members and privacy', async () => {
  const g = await index(await repo('use shared::State as Alias;fn run(){Alias::public();Alias::private();}', { 'shared/Cargo.toml': '[package]\nname="shared"\nversion="1.0.0"\nedition="2021"', 'shared/src/lib.rs': 'pub struct State;impl State{pub fn public(){}fn private(){}}' }, '[dependencies]\nshared={path="shared"}'));
  assert.equal(call(g, 'Alias::public')[0]!.target, entity(g, 'public', 'shared/src/lib.rs').id); assert.equal(call(g, 'Alias::private')[0]!.status, 'unresolved');
});
test('Callback parameters changed through a borrow never pass a caller operand into the return summary', async () => {
  const g = await index(await repo('fn leaf(){}fn borrow(_: &mut fn()){}fn changed(mut cb:fn())->fn(){borrow(&mut cb);cb}fn run(){let cb=changed(leaf);cb();}'));
  assert.equal(call(g, 'cb')[0]!.status, 'unresolved');
});
test('Default source traits, consumer-crate traits and standard blanket impls block uncertain autoref lookup', async () => {
  const g = await index(await repo('use shared::State;trait Local{fn run(self){}}impl Local for State{}struct Own;trait Defaulted{fn run(self){}}impl Defaulted for Own{}impl Own{fn run(&self){}fn to_string(&mut self){}}fn entry(state:State,own:Own){state.run();own.run();own.to_string();}', { 'shared/Cargo.toml': '[package]\nname="shared"\nversion="1.0.0"\nedition="2021"', 'shared/src/lib.rs': 'pub struct State;impl State{pub fn run(&self){}}' }, '[dependencies]\nshared={path="shared"}'));
  assert.ok(calls(g).every(c => c.status !== 'resolved'));
});
test('Inactive local cfg bindings leave outer names available and explicit boxed self stays opaque', async () => {
  const g = await index(await repo('fn cb(){}struct State;impl State{fn run(self:Box<Self>){self.run();}}fn entry(){#[cfg(feature="api")]let cb=||{};cb();}', {}, '[features]\napi=[]'));
  assert.equal(call(g, 'cb')[0]!.target, entity(g, 'cb').id); assert.equal(call(g, 'self.run')[0]!.status, 'unresolved');
});
test('Tail async expression-statement wrappers preserve source closure ownership without containment cycles',async()=>{
  const g=await index(await repo('fn leaf(){}fn entry(){let factory=||{async{leaf();}};let inline=||async{leaf();};}')),closures=g.entities.filter(entity=>entity.metadata.declarationKind==='closure'),blocks=g.entities.filter(entity=>entity.metadata.declarationKind==='async');assert.equal(closures.length,2);assert.equal(blocks.length,2);assert.ok(blocks.every(block=>closures.some(closure=>closure.id===block.parentId)));assert.ok(blocks.every(block=>g.relations.some(relation=>relation.type==='calls'&&relation.from===block.id&&g.entities.find(entity=>entity.id===relation.to)?.name==='leaf')));assert.ok(blocks.every(block=>block.id!==block.parentId));
});
