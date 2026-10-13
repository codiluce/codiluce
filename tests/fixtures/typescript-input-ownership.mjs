// Run against the ordinary compiled source directory or an installed package.
// Inspect only Codiluce/TypeScript objects; original application code never runs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import inspector from 'node:inspector';
import path from 'node:path';

const sourceRoot = new URL(process.argv[2]);
const { createTypeScriptServices } = await import(new URL('analysis/languages/typescript-services.js', sourceRoot));
const { resolveConfig } = await import(new URL('core/config.js', sourceRoot));
const { GraphBuilder } = await import(new URL('core/graph.js', sourceRoot));
const { filesystemAnalyzer } = await import(new URL('analyzers/filesystem.js', sourceRoot));
const { projectAnalyzer } = await import(new URL('analysis/project-model.js', sourceRoot));
const root = path.resolve('owned-installed-compiler-inputs');
const hash = text => createHash('sha256').update(text).digest('hex');
const texts = new Map(Array.from({ length: 40 }, (_, i) => [
  path.join(root, `original${i}.ts`),
  `// é😀 original ${i}\r\n/*${'.'.repeat(250000)}*/\r\nexport function original${i}(){return ${i};}\r\nthrow new Error("Target never executes");`,
]));
await mkdir(root);
for (const [file, text] of texts) await writeFile(file, text);
await writeFile(path.join(root, 'package.json'), '{"name":"owned-compiler-input-probe","private":true}');
await writeFile(path.join(root, 'tsconfig.json'), '{"compilerOptions":{"noLib":true,"target":"ESNext","module":"ESNext","moduleResolution":"Bundler"}}');
const config = await resolveConfig(root, { repository: { name: 'Installed compiler input ownership' } });
const graph = new GraphBuilder(config.repository.name);
const context = { root, config, graph, repositoryId: graph.id('repository'), applicationIds: new Map(), files: new Map(), http: [] };
for (const analyzer of [filesystemAnalyzer, projectAnalyzer]) await analyzer.analyze(context);
const services = createTypeScriptServices(context);
assert.equal(services.projects.length, 1);
const runtime = services.projects[0];
const first = runtime.program();
first.getTypeChecker();
runtime.releaseProgram();
context.sources.clear();
const program = runtime.program();
assert.deepEqual(program.getSyntacticDiagnostics(), []);
program.getTypeChecker();
const sources = program.getSourceFiles().map(source => ({ file: source.fileName, sha256: hash(source.text), utf16Bytes: 2 * source.text.length }));
assert.equal(sources.length, texts.size);
for (const source of program.getSourceFiles()) {
  assert.equal(source.text, texts.get(source.fileName));
  assert.equal(source, first.getSourceFile(source.fileName), 'Unchanged originals reuse parsed ASTs');
}

const session = new inspector.Session();
session.connect();
const post = (method, args = {}) => new Promise((resolve, reject) => session.post(method, args, (error, result) => error ? reject(error) : resolve(result)));
const properties = async objectId => (await post('Runtime.getProperties', { objectId, ownProperties: true })).result;
async function scopesOf(objectId) {
  const result = await post('Runtime.getProperties', { objectId, ownProperties: true });
  const scopes = result.internalProperties?.find(property => property.name === '[[Scopes]]')?.value?.objectId;
  assert.ok(scopes, 'The actual function exposes its closure scopes');
  return (await properties(scopes)).filter(property => /^\d+$/.test(property.name)).map(property => property.value.objectId);
}
globalThis.__codiluceInputOwnerProgram = program;
try {
  await post('Runtime.enable');
  const getter = (await post('Runtime.evaluate', { expression: 'globalThis.__codiluceInputOwnerProgram.getSourceFile', objectGroup: 'owned-source-input-audit' })).result.objectId;
  let host;
  for (const scope of await scopesOf(getter)) {
    const property = (await properties(scope)).find(property => property.name === 'host');
    if (property?.value?.objectId) host = property.value.objectId;
  }
  assert.ok(host, 'The live ts.Program closure exposes its compiler host');
  const sourceGetter = (await properties(host)).find(property => property.name === 'getSourceFile')?.value?.objectId;
  assert.ok(sourceGetter);
  let owner;
  for (const scope of await scopesOf(sourceGetter)) {
    const property = (await properties(scope)).find(property => property.name === 'files');
    if (property?.value?.objectId) owner = property.value.objectId;
  }
  assert.ok(owner, 'The live compiler host exposes its registered input collection');
  const observed = (await post('Runtime.callFunctionOn', {
    objectId: owner,
    functionDeclaration: 'function(){const hasText=typeof this.get==="function";let textBytes=0;for(const key of this.keys())if(hasText)textBytes+=2*this.get(key).length;return {kind:Object.prototype.toString.call(this),entries:this.size,textBytes};}',
    returnByValue: true,
  })).result.value;
  assert.deepEqual(observed, { kind: '[object Set]', entries: texts.size, textBytes: 0 });
  const read = async file => (await post('Runtime.callFunctionOn', {
    objectId: host, functionDeclaration: 'function(file){return this.readFile(file);}', arguments: [{ value: file }], returnByValue: true,
  })).result.value;
  const lateFile = sources[0].file;
  context.sources.clear();
  const late = await read(lateFile);
  assert.equal(late, texts.get(lateFile), 'Late registered-root reads preserve original bytes');
  await writeFile(lateFile, `${late}\r\n// changed after the scan`);
  context.sources.clear();
  assert.equal(await read(lateFile), undefined, 'The host does not replay changed source from retained input text');
  assert.match(context.sources.failures.get(path.relative(root, lateFile).split(path.sep).join('/')), /changed after the scan/);
  await writeFile(lateFile, late);
  context.sources.clear();
  assert.equal(await read(lateFile), late);
  const record = {
    schema: 1, passed: true, sourceLoader: false, targetExecution: false,
    actualCompilerHostClosureObserved: observed,
    realProjectService: true, astReuseObserved: true,
    lateRegisteredRootReadFilePreserved: { file: lateFile, sha256: hash(late) },
    changedOriginalReadRejected: true, restoredOriginalReadPreserved: true,
    programSourceCount: sources.length,
    programSourceUtf16Bytes: sources.reduce((bytes, source) => bytes + source.utf16Bytes, 0),
    sources,
    scope: 'Actual live compiler input collection ownership. AST/checker allocations, source memos and physical RSS remain separate.',
  };
  if (process.argv[3]) await writeFile(process.argv[3], `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify(record));
} finally {
  await post('Runtime.releaseObjectGroup', { objectGroup: 'owned-source-input-audit' });
  session.disconnect();
  delete globalThis.__codiluceInputOwnerProgram;
  services.releasePrograms();
}
