import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { indexRepository } from '../src/pipeline/index.js';
import { resolveConfig, type ApplicationInput } from '../src/core/config.js';
import { AnalysisCache } from '../src/pipeline/cache.js';
import { canonicalJson } from '../src/history/fingerprint.js';
import type { SoftwareGraph } from '../src/core/graph.js';
const roots: string[] = [];
after(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });
const configured: ApplicationInput = { name: 'jvm', path: '.', ecosystems: ['jvm'], sourceRoots: { java: ['java'], kotlin: ['kotlin'] }, jvm: { dependencies: [] } };
async function put(root: string, name: string, text: string) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), text); }
async function repository(files: Record<string, string>) { const root = await mkdtemp(path.join(tmpdir(), 'codiluce-jvm-references-')); roots.push(root); for (const [name, text] of Object.entries(files)) await put(root, name, text); return root; }
async function index(root: string, cache?: AnalysisCache, revision?: string) { return indexRepository(root, { config: await resolveConfig(root, { repository: { name: 'jvm-references' }, applications: [configured] }), cache, revision }); }
const symbol = (graph: SoftwareGraph, name: string, file?: string) => graph.entities.find(entity => entity.name === name && entity.type !== 'file' && (!file || entity.path === file))!;
const calls = (graph: SoftwareGraph) => graph.relations.filter(edge => edge.type === 'calls' && edge.metadata?.adapter === 'jvm');
const links = (graph: SoftwareGraph) => calls(graph).map(edge => `${graph.entities.find(entity => entity.id === edge.from)?.name}->${graph.entities.find(entity => entity.id === edge.to)?.name}`);
const outcomes = (graph: SoftwareGraph, file: string) => graph.entities.find(entity => entity.path === file && entity.type === 'file')!.metadata.jvmCallOutcomes as {status:string;reason?:string;range:{startLine:number};target?:string;candidates?:string[]}[];
const shape = (graph: SoftwareGraph) => canonicalJson({ entities: graph.entities, relations: graph.relations, diagnostics: graph.diagnostics.filter(item => !['git-metrics', 'indexer'].includes(item.analyzer) && item.code !== 'git-ignore-unavailable') });

test('Java source methods, exact overloads, static imports and original constructors retain direct call proof', async () => {
  const root = await repository({
    'java/demo/Service.java': 'package demo; public final class Service { public Service(){} public String find(String id){return id;} public static void pick(int n){} public static void pick(String s){} private void hidden(){} public void self(){hidden();} }',
    'java/client/Api.java': '// 😀\r\npackage client;\r\nimport demo.Service;\r\nimport static demo.Service.pick;\r\npublic class Api {\r\n public String show(String id){ final Service service=new Service(); pick(1); return service.find(id); }\r\n}'
  }), graph = await index(root);
  assert.ok(links(graph).includes('show->Service'), JSON.stringify(outcomes(graph, 'java/client/Api.java')));
  assert.ok(links(graph).includes('show->find'), JSON.stringify(outcomes(graph, 'java/client/Api.java')));
  assert.ok(links(graph).includes('show->pick')); assert.ok(links(graph).includes('self->hidden'));
  const call = calls(graph).find(edge => edge.to === symbol(graph, 'find').id)!;
  assert.ok(call.evidence.some(item => item.file === 'java/client/Api.java' && item.line === 6));
  assert.ok(call.evidence.some(item => item.file === 'java/demo/Service.java'));
  assert.equal(call.metadata?.dispatch, 'direct');
  assert.deepEqual(symbol(graph, 'show').metadata.callSites, { resolved: 3, external: 0, unresolved: 0, unresolvedNames: {} });
});

test('Virtual, interface, inherited, generic, vararg and unknown overload calls remain unresolved', async () => {
  const root = await repository({
    'java/demo/Api.java': `package demo;
public class Api {
 public void run(Open value, Contract face){ value.work(); face.work(); inherited.work(); generic.work(); pick(unknown); variadic(1); external(); }
 final Child inherited = new Child(); final Generic generic = new Generic();
 public static void pick(int n){} public static void pick(String s){} public static void variadic(int... args){}
}
class Open { public void work(){} }
interface Contract { void work(); }
class Base { public void work(){} }
final class Child extends Base {}
class Generic<T> { public void work(){} }`
  }), graph = await index(root), result = outcomes(graph, 'java/demo/Api.java').filter(item => item.range.startLine === 3);
  assert.equal(result.length, 7); assert.ok(result.every(item => item.status === 'unresolved'), JSON.stringify(result));
  assert.ok(result[0]?.candidates?.length); assert.equal(links(graph).filter(link => link.startsWith('run->')).length, 0);
  assert.ok(result.some(item => item.reason?.includes('argument type')));
});

test('Kotlin aliases, final methods, exact named arguments, nested functions and original lambda owners bind', async () => {
  const root = await repository({
    'kotlin/demo/Tools.kt': 'package demo\nclass Service {\n fun work(x: String): String = x\n}\nfun helper(x: Int) {}\n',
    'kotlin/client/Api.kt': 'package client\nimport demo.Service as Imported\nimport demo.helper as help\nfun run(){\n val service = Imported()\n val f = { x: String -> service.work(x) }\n fun nested(){help(x=1)}\n nested()\n f("ok")\n}\n'
  }), graph = await index(root);
  for (const link of ['nested->helper', 'run->nested', 'run-><lambda>', '<lambda>->work']) assert.ok(links(graph).includes(link), `${link}: ${JSON.stringify(outcomes(graph, 'kotlin/client/Api.kt'))}`);
  const lambda = symbol(graph, '<lambda>'); assert.equal(lambda.parentId, symbol(graph, 'run').id); assert.equal(lambda.sourceRange?.startLine, 6);
  assert.ok(graph.relations.some(edge => edge.type === 'contains' && edge.to === lambda.id));
  assert.ok(outcomes(graph, 'kotlin/client/Api.kt').some(item => item.reason?.includes('constructor')));
});

test('Lexical shadows, changed captures, nullable receivers and static instance access cannot borrow types', async () => {
  const root = await repository({
    'java/demo/Service.java': 'package demo; public class Service { public void work(){} }',
    'java/client/Api.java': 'package client; import demo.Service; public class Api { public void work(){} public static void bad(){work();} public void run(){ final Service receiver=new Service(); { String receiver="shadow"; receiver.work(); } Service Service=null; Service.work(); } }',
    'kotlin/demo/Service.kt': 'package kd\nopen class Service {\n open fun work() {}\n}\n',
    'kotlin/client/Use.kt': 'package client\nimport kd.Service\nfun run(value: Service?){\n var changed = Service()\n val f = { x: String -> changed.work() }\n changed = unknown()\n value?.work()\n f("ok")\n}\n'
  }), graph = await index(root);
  assert.equal(links(graph).filter(link => link === 'bad->work' || link === 'run->work' || link === '<lambda>->work').length, 0, JSON.stringify(links(graph)));
  assert.ok(outcomes(graph, 'kotlin/client/Use.kt').some(item => item.reason?.includes('Nullable')));
  assert.ok(outcomes(graph, 'java/client/Api.java').some(item => item.reason?.includes('static')));
});

test('Same spelling in another configured application is never a JVM reference target', async () => {
  const root = await repository({ 'java/client/Api.java': 'package client; import foreign.Service; public class Api { public void run(){Service.work();} }', 'other/java/foreign/Service.java': 'package foreign; public class Service { public static void work(){} }' });
  const graph = await indexRepository(root, { config: await resolveConfig(root, { repository: { name: 'jvm-references' }, applications: [configured, { name: 'other', path: 'other', sourceRoots: { java: ['java'] }, jvm: { dependencies: [] } }] }) });
  assert.equal(calls(graph).length, 0); assert.ok(outcomes(graph, 'java/client/Api.java')[0]?.reason?.includes('External spelling'));
});

test('Warm cache and revision replay preserve original JVM call and lambda identities and invalidate changed inputs', async () => {
  const root = await repository({ 'kotlin/demo/Tools.kt': 'package demo\nfun helper(x: String){}\nfun run(){\n val f={x: String -> helper(x)}\n f("ok")\n}\n' });
  const cache = new AnalysisCache(path.join(root, '.codiluce', 'cache')), cold = await index(root, cache), warm = await index(root, cache), revision = await index(root, undefined, 'fixture-revision');
  assert.equal(shape(warm), shape(cold)); assert.equal(shape(revision), shape(cold)); assert.ok(links(cold).includes('<lambda>->helper'));
  await put(root, 'kotlin/demo/Tools.kt', '// shifted\npackage demo\nfun helper(x: String){}\nfun run(){\n val f={x: String -> helper(x)}\n f("ok")\n}\n');
  const shifted = await index(root, cache); assert.deepEqual(calls(shifted).map(edge => edge.id).sort(), calls(cold).map(edge => edge.id).sort()); assert.equal(symbol(shifted, '<lambda>').sourceRange?.startLine, 5);
  await put(root, 'kotlin/demo/Tools.kt', 'package demo\nfun helper(x: Int){}\nfun run(){\n val f={x: String -> helper(x)}\n f("ok")\n}\n');
  const changed = await index(root, cache); assert.equal(links(changed).includes('<lambda>->helper'), false);
});

test('Declared receiver types and shadowed generic/pattern heads cannot acquire an initializer/import identity',async()=>{
 const root=await repository({'java/demo/Api.java':'package demo; public class Api<T> { public static void leaf(){} public void run(Object value){final Object thing=new Service();thing.work();if(value instanceof Service s){s.work();}Service future=null;future.work();} } class Service { public void work(){} }','kotlin/demo/Api.kt':'package kd\nopen class Service {\n open fun work() {}\n}\nfun run(){\n var receiver = Service()\n receiver = unknown()\n receiver.work()\n val invalid = Service("bad")\n invalid.work()\n}\n'}),graph=await index(root);
 assert.equal(links(graph).filter(link=>link==='run->work').length,0);assert.ok(outcomes(graph,'java/demo/Api.java').some(item=>item.reason?.includes('Pattern')));assert.ok(outcomes(graph,'kotlin/demo/Api.kt').some(item=>item.reason?.includes('receiver')));
});
