import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { indexRepository } from '../src/pipeline/index.js';
import { SourceText } from '../src/analysis/source-map.js';
import { StructureParser } from '../src/analysis/tree-sitter/client.js';
import { grammarCatalog, verifiedGrammar } from '../src/analysis/tree-sitter/grammars.js';
import { fileAnalysis } from '../src/analysis/facts.js';
import { canonicalJson, shapeHash } from '../src/history/fingerprint.js';
import { GraphStore } from '../src/storage/sqlite.js';
import { ProjectionService } from '../src/projection/service.js';
import { AnalysisCache } from '../src/pipeline/cache.js';
import { AnalysisRegistry } from '../src/analysis/registry.js';
import { HistoryStore } from '../src/history/store.js';
import { CommitSnapshot, WorkingTreeSnapshot } from '../src/history/snapshot.js';
import { computeDiff } from '../src/history/diff.js';

const temporary: string[] = [];
after(async () => { await Promise.all(temporary.map(directory => rm(directory, { recursive: true, force: true }))); });
async function repository(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'codiluce-structure-')); temporary.push(root);
  for (const [file, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); }
  return root;
}

const snippets: Record<string, { file: string; content: string; names: string[] }> = {
  python: { file: 'api/models.py', content: '@decorator\nclass User(Base):\n    async def get(self, id: int) -> str:\n        def nested():\n            return "é😀"\n        return nested()\n', names: ['User', 'get', 'nested'] },
  go: { file: 'api/user.go', content: 'package api\ntype User struct { ID int }\ntype Service interface { Find(int) User }\nfunc (u *User) Get(id int) string { return "ok" }\nfunc Run() {}\n', names: ['User', 'Service', 'Find', 'Get', 'Run'] },
  ruby: { file: 'api/user.rb', content: 'module Shop\n class User < Base\n  def get(id)\n   id\n  end\n  def self.find(id); end\n end\nend\n', names: ['Shop', 'User', 'get', 'find'] },
  rust: { file: 'api/user.rs', content: 'pub mod api { pub struct User {} impl User { pub fn get(&self, id: u32) -> bool { true } } pub trait Service { fn run(&self); } pub fn serve() {} }\n', names: ['api', 'User', 'get', 'Service', 'run', 'serve'] },
  java: { file: 'api/User.java', content: 'package api; @Controller public class User extends Base { public User() {} @GetMapping("/users") public String get(int id) { return "ok"; } }\n', names: ['User', 'User', 'get'] },
  csharp: { file: 'api/User.cs', content: 'namespace Api; public partial class User : Base { [HttpGet("/users")] public string Get(int id) => "ok"; public int ID { get; set; } }\n', names: ['User', 'Get', 'ID'] },
  kotlin: { file: 'api/User.kt', content: 'package api\n@Controller\nclass User : Base() {\n @GetMapping("/users")\n fun get(id: Int): String = "ok"\n}\n', names: ['User', 'get'] },
};

test('seven language grammars extract evidenced declarations outside detected applications', async () => {
  const root = await repository(Object.fromEntries(Object.values(snippets).map(item => [item.file, item.content])));
  const graph = await indexRepository(root);
  assert.equal(graph.entities.filter(entity => entity.type === 'application').length, 0);
  for (const [language, item] of Object.entries(snippets)) {
    const symbols = graph.entities.filter(entity => entity.path === item.file && entity.type !== 'file');
    assert.deepEqual(symbols.map(entity => entity.name).sort(), [...item.names].sort(), language);
    const file = graph.entities.find(entity => entity.path === item.file && entity.type === 'file')!;
    assert.equal(fileAnalysis(file.metadata.analysis)?.features.structure.status, 'supported', `${language}: ${JSON.stringify(graph.diagnostics.filter(d => d.file === item.file))}`);
    assert.equal(fileAnalysis(file.metadata.analysis)?.features.references.status, language === 'python' ? 'partial' : 'unsupported');
    for (const entity of symbols) {
      assert.equal(entity.language, language);
      assert.ok(entity.metadata.bodyHash && entity.metadata.contentHash);
      assert.equal(entity.evidence[0]?.source, 'syntax');
      assert.equal(entity.evidence[0]?.analyzerVersion, fileAnalysis(file.metadata.analysis)!.adapterVersion);
      assert.equal(entity.evidence[0]?.file, item.file);
    }
  }
  const find = (file: string, name: string) => graph.entities.find(entity => entity.path === file && entity.name === name && entity.type !== 'file')!;
  for (const language of ['python', 'go', 'ruby', 'rust', 'java', 'csharp', 'kotlin']) {
    const name = ['csharp', 'go'].includes(language) ? 'Get' : 'get';
    const method = find(snippets[language]!.file, name);
    assert.equal(method.type, 'method', language);
    assert.equal(graph.entities.find(entity => entity.id === method.parentId)?.name, 'User', language);
  }
  assert.equal(find(snippets.python!.file, 'nested').type, 'function');
  assert.equal(graph.entities.find(entity => entity.id === find(snippets.python!.file, 'nested').parentId)?.name, 'get');
  assert.equal(find(snippets.rust!.file, 'serve').type, 'function');
  assert.equal(find(snippets.go!.file, 'Service').metadata.declarationKind, 'interface');
  assert.ok((find(snippets.java!.file, 'get').metadata.annotations as string[]).includes('@GetMapping("/users")'));
});

test('source coordinates use original UTF-16 offsets through Unicode, CRLF and embedded regions', async () => {
  const text = '// é😀\r\nconst TEXT: &str = "é😀"; pub fn serve() -> bool { true }\r\n';
  const source = new SourceText(text), parser = new StructureParser();
  try {
    const facts = await parser.parse('rust', text);
    assert.equal(facts.issues.length, 0);
    const serve = facts.declarations.find(item => item.name === 'serve')!;
    assert.equal(serve.start, text.indexOf('pub fn'));
    assert.equal(serve.end, text.indexOf('}') + 1);
    assert.deepEqual(serve.range, source.range(serve.start, serve.end));
    assert.equal(serve.range.startColumn, text.slice(text.indexOf('\n') + 1, serve.start).length + 1);
    const region = source.region(serve.start, serve.end);
    assert.deepEqual(region.range(0, region.text.length), serve.range);
    assert.throws(() => region.range(-1, 0));
  } finally { parser.close(); }
});

test('partial parses retain valid declarations and do not enter flow coverage', async () => {
  const root = await repository({
    'pyproject.toml': '[project]\nname="api"\nversion="0.1.0"\n',
    'models.py': 'def good():\n    return 1\n\ndef broken(:\n    return 2\n',
  });
  const graph = await indexRepository(root);
  assert.ok(graph.entities.some(entity => entity.name === 'good' && entity.type === 'function'));
  const file = graph.entities.find(entity => entity.type === 'file' && entity.path === 'models.py')!;
  assert.equal(fileAnalysis(file.metadata.analysis)?.features.structure.status, 'partial');
  assert.ok(graph.diagnostics.some(diagnostic => diagnostic.code === 'syntax-parse-error'));
  const store = new GraphStore(':memory:'); store.save(graph);
  try {
    const service = new ProjectionService(store);
    assert.equal(service.coverage().files[file.id]?.category, 'unanalyzed');
    assert.equal(service.coverage().codeFiles, 0);
    assert.equal(service.locate(file.id).node.analysis?.features.structure.status, 'partial');
  } finally { store.close(); }
});

test('imported declaration-only files remain excluded from call coverage', async () => {
  const root = await repository({
    'package.json': '{"dependencies":{"next":"*"}}',
    'app/page.tsx': 'import "../models.rs"; export default function Page() { return <span/>; }',
    'models.rs': 'fn helper() {}\n',
  });
  const graph = await indexRepository(root);
  const file = graph.entities.find(entity => entity.type === 'file' && entity.path === 'models.rs')!;
  assert.ok(graph.relations.some(relation => relation.type === 'imports' && relation.to === file.id));
  const store = new GraphStore(':memory:'); store.save(graph);
  try {
    const coverage = new ProjectionService(store).coverage();
    assert.equal(coverage.files[file.id]?.category, 'unanalyzed');
    assert.equal(coverage.codeFiles, 1, 'a supporting import does not claim reference analysis for its language');
  } finally { store.close(); }
});

test('declaration identities survive line shifts and cached facts replay exactly', async () => {
  const root = await repository({ 'models.py': 'class User:\n    def run(self):\n        return 1\n' });
  const cache = new AnalysisCache(path.join(root, '.codiluce/cache'));
  const first = await indexRepository(root, { cache });
  const second = await indexRepository(root, { cache });
  assert.equal(canonicalJson(second.entities), canonicalJson(first.entities));
  assert.equal(canonicalJson(second.relations), canonicalJson(first.relations));
  assert.ok(cache.events.some(event => event.analyzer === 'syntax-facts' && event.hit));
  const content = await readFile(path.join(root, 'models.py'), 'utf8');
  await writeFile(path.join(root, 'models.py'), `\n\n${content}`);
  const moved = await indexRepository(root, { cache });
  const symbols = (graph: typeof first) => graph.entities.filter(entity => entity.evidence.some(fact => fact.source === 'syntax')).sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(symbols(moved).map(entity => entity.id), symbols(first).map(entity => entity.id));
  for (const [index, entity] of symbols(first).entries()) {
    const current = symbols(moved)[index]!;
    assert.equal(current.sourceRange!.startLine, entity.sourceRange!.startLine + 2);
    assert.equal(shapeHash(current), shapeHash(entity));
  }
});

test('grammar integrity and parser deadlines fail predictably and the parser recovers', async () => {
  const python = grammarCatalog.get('python')!;
  assert.throws(() => verifiedGrammar({ ...python, sha256: 'incorrect' }), /checksum mismatch/);
  const tooShort = new StructureParser(1);
  try { await assert.rejects(tooShort.parse('python', 'def run(): pass'), /exceeded/); }
  finally { tooShort.close(); }
  const parser = new StructureParser();
  try {
    await assert.rejects(parser.parse('no-language', ''), /Unknown grammar/);
    assert.equal((await parser.parse('python', 'def run(): pass')).declarations[0]?.name, 'run');
  } finally { parser.close(); }
});

test('receiver methods bind to later local types, with no arbitrary owner for duplicate types', async () => {
  const root = await repository({
    'users.go': 'package api\nfunc (u *User) Run(id int) bool { return true }\ntype User struct{}\n',
    'users.rs': 'impl User { fn run(&self) { fn nested() {} } }\nstruct User {}\n',
    'ambiguous.rs': 'struct Duplicate {}\nstruct Duplicate {}\nimpl Duplicate { fn run(&self) {} }\n',
  });
  const graph = await indexRepository(root);
  for (const file of ['users.go', 'users.rs']) {
    const symbols = graph.entities.filter(entity => entity.path === file && entity.type !== 'file');
    const method = symbols.find(entity => entity.name.toLowerCase() === 'run')!;
    assert.equal(method.type, 'method');
    assert.equal(symbols.find(entity => entity.id === method.parentId)?.name, 'User');
    assert.match(String(method.metadata.qualifiedName), /User[.:]+[Rr]un$/);
  }
  const nested = graph.entities.find(entity => entity.name === 'nested')!;
  assert.equal(nested.type, 'function');
  assert.equal(nested.metadata.qualifiedName, 'User::run::nested');
  const ambiguous = graph.entities.find(entity => entity.path === 'ambiguous.rs' && entity.name === 'run')!;
  assert.equal(graph.entities.find(entity => entity.id === ambiguous.parentId)?.type, 'file');
  assert.equal(ambiguous.metadata.qualifiedName, 'Duplicate::run');
});

test('overloads and declared Kotlin return types remain distinct', async () => {
  const root = await repository({
    'Overloads.java': 'class User { String get(int id) { return "ok"; } String get(String id) { return id; } }',
    'Overloads.cs': 'class User { string Get(int id) => "ok"; string Get(string id) => id; }',
    'Overloads.kt': 'class User {\n fun get(id: Int): String = "ok"\n fun get(id: String): String = id\n}\n',
  });
  const graph = await indexRepository(root);
  for (const file of ['Overloads.java', 'Overloads.cs', 'Overloads.kt']) {
    const methods = graph.entities.filter(entity => entity.path === file && entity.type === 'method');
    assert.equal(methods.length, 2, file);
    assert.equal(new Set(methods.map(entity => entity.id)).size, 2, file);
    assert.equal(new Set(methods.map(entity => entity.metadata.signature)).size, 2, file);
    assert.ok(methods.every(entity => /→ [Ss]tring$/.test(String(entity.metadata.signature))), file);
  }
});

test('async and singleton declarations retain their modifiers; property bodies are not identity', async () => {
  const root = await repository({
    'worker.py': '@route("/a   b")\nasync def run():\n    return 1\n',
    'worker.rb': 'class Worker\n def run(id); end\n def self.run(id); end\nend\n',
    'Worker.cs': 'class Worker { public int Value { get { return 1; } } }',
  });
  const first = await indexRepository(root);
  assert.deepEqual(first.entities.find(entity => entity.path === 'worker.py' && entity.type === 'function')?.metadata.modifiers, ['async']);
  assert.deepEqual(first.entities.find(entity => entity.path === 'worker.py' && entity.type === 'function')?.metadata.annotations, ['@route("/a   b")']);
  const ruby = first.entities.filter(entity => entity.path === 'worker.rb' && entity.type === 'method');
  assert.equal(ruby.length, 2);
  assert.equal(new Set(ruby.map(entity => entity.metadata.signature)).size, 2);
  const property = first.entities.find(entity => entity.metadata.declarationKind === 'property')!;
  assert.equal(property.metadata.signature, 'int');
  await writeFile(path.join(root, 'Worker.cs'), 'class Worker { public int Value { get { return 2; } } }');
  const changed = await indexRepository(root);
  assert.equal(changed.entities.find(entity => entity.metadata.declarationKind === 'property')?.id, property.id);
});

test('the isolated parser serializes concurrent jobs and remains usable afterward', async () => {
  const parser = new StructureParser();
  try {
    const facts = await Promise.all(['One', 'Two', 'Three'].map(name => parser.parse('python', `class ${name}: pass\n`)));
    assert.deepEqual(facts.map(item => item.declarations[0]?.name), ['One', 'Two', 'Three']);
    assert.equal((await parser.parse('python', 'class Four: pass\n')).declarations[0]?.name, 'Four');
  } finally { parser.close(); }
});

test('history preserves capability outcomes without presenting adapter changes as source edits', async () => {
  const root = await repository({ 'models.py': 'class User:\n    def run(self):\n        return 1\n' });
  const first = await indexRepository(root, { revision: 'a'.repeat(40) });
  const second = await indexRepository(root, { revision: 'b'.repeat(40) });
  const file = first.entities.find(entity => entity.type === 'file' && entity.path === 'models.py')!;
  const secondFile = second.entities.find(entity => entity.id === file.id)!;
  fileAnalysis(secondFile.metadata.analysis)!.adapterVersion = 'next-adapter';
  const history = new HistoryStore(':memory:'), store = new GraphStore(':memory:');
  try {
    history.saveCommits([first, second].map(graph => ({ sha: graph.run.commitSha!, tree: 'c'.repeat(40), parents: [], authorName: 'Test', authorEmail: 'test@example.test', authoredAt: graph.run.analyzedAt, committedAt: graph.run.analyzedAt, subject: 'Fixture', body: '' })));
    const a = history.saveSnapshot(first, 'first'), b = history.saveSnapshot(second, 'second');
    store.save(first);
    const live = new WorkingTreeSnapshot(store, root, first.run).load();
    const before = new CommitSnapshot(history, a, root).load(), after = new CommitSnapshot(history, b, root).load();
    assert.deepEqual(before.entities.find(entity => entity.id === file.id)?.analysis, live.entities.find(entity => entity.id === file.id)?.analysis);
    assert.equal(after.entities.find(entity => entity.id === file.id)?.analysis?.adapterVersion, 'next-adapter');
    assert.equal(computeDiff(before, after).changes.size, 0);
    const projection = new ProjectionService(store, { root, history: () => history });
    assert.equal(projection.locate(file.id, { snapshot: b.id }).node.analysis?.adapterVersion, 'next-adapter');
    delete secondFile.metadata.analysis;
    store.save(second);
    assert.equal(new WorkingTreeSnapshot(store, root, second.run).load().entities.find(entity => entity.id === file.id)?.analysis, undefined);
    assert.equal(new ProjectionService(store).locate(file.id).node.analysis, undefined);
  } finally { history.close(); store.close(); }
});

test('pack registry rejects duplicate ownership, missing dependencies and cycles', () => {
  const registry = new AnalysisRegistry();
  registry.registerLanguage({ id: 'python', version: '1', languages: ['python'], features: { structure: 'supported' } });
  assert.throws(() => registry.registerLanguage({ id: 'other', version: '1', languages: ['python'], features: {} }), /authoritative/);
  const pack = (name: string, requires: string[]) => ({ name, requires, version: '1', frameworks: [name], features: {}, applies: () => true, analyze: async () => {} });
  registry.registerPack(pack('b', ['python'])); registry.registerPack(pack('a', ['b']));
  assert.deepEqual(registry.orderedPacks().map(item => item.name), ['b', 'a']);
  const broken = new AnalysisRegistry(); broken.registerPack(pack('a', ['missing']));
  assert.throws(() => broken.orderedPacks(), /Missing analysis dependency/);
  const cyclic = new AnalysisRegistry(); cyclic.registerPack(pack('a', ['b'])); cyclic.registerPack(pack('b', ['a']));
  assert.throws(() => cyclic.orderedPacks(), /dependency cycle/);
  assert.throws(() => cyclic.registerLanguage({ id: 'a', version: '1', languages: [], features: {} }), /Duplicate language adapter/);
});
