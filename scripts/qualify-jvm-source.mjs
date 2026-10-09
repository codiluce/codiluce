// Only Codiluce's parsers/indexer run; target Maven/Gradle/JVM inputs are data.
// node --experimental-sqlite --import tsx scripts/qualify-jvm-source.mjs
//   --source /path/to/unchanged/checkout --commit PIN --output /tmp/jvm-source.json
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { indexRepository } from '../src/pipeline/index.ts';
import { resolveConfig } from '../src/core/config.ts';
import { AnalysisCache } from '../src/pipeline/cache.ts';
import { canonicalJson } from '../src/history/fingerprint.ts';

const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
assert.ok(option('--source') && option('--commit'), '--source and --commit are required');
const source = path.resolve(option('--source'));
const git = params => execFileSync('git', params, { cwd: source, encoding: 'utf8', maxBuffer: 16 << 20 });
const commit = git(['rev-parse', '--verify', `${option('--commit')}^{commit}`]).trim();
assert.equal(git(['rev-parse', 'HEAD']).trim(), commit, 'checkout must match the pinned commit');
const files = git(['ls-files', '-z']).split('\0').filter(file => /\.(?:java|kt|kts|gradle|xml|properties|toml)$/.test(file));
assert.ok(files.some(file => /\.(?:java|kt)$/.test(file)), 'tracked JVM sources are required');
git(['diff', '--exit-code', commit, '--', ...files]);
const temporary = await mkdtemp(path.join(tmpdir(), 'codiluce-jvm-source-'));
try {
  const root = path.join(temporary, 'source'), state = path.join(temporary, 'cache');
  for (const file of files) {
    const target = path.join(root, file);
    assert.ok(target.startsWith(root + path.sep));
    assert.ok((await lstat(path.join(source, file))).isFile(), 'qualification inputs must be regular tracked files');
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(source, file), target);
  }
  // Optional selections are labeled qualification inputs, never executed or
  // written into upstream Maven/Gradle manifests.
  const inputs = JSON.parse(option('--inputs') ?? '{}');
  const config = await resolveConfig(root, { ...inputs, repository: { name: 'jvm-source-qualification' } });
  const cold = await indexRepository(root, { config, cache: new AnalysisCache(state) });
  const warm = await indexRepository(root, { config, cache: new AnalysisCache(state) });
  const revision = await indexRepository(root, { config, revision: commit });
  const shape = graph => canonicalJson({ entities: graph.entities, relations: graph.relations, diagnostics: graph.diagnostics.filter(item => !['git-metrics', 'indexer'].includes(item.analyzer) && item.code !== 'git-ignore-unavailable') });
  assert.equal(shape(cold), shape(warm)); assert.equal(shape(cold), shape(revision));
  const units = cold.entities.filter(entity => entity.type === 'file' && ['java','kotlin'].includes(entity.language));
  const identities = new Map(cold.entities.map(entity => [entity.id,entity]));
  const outcomes = units.flatMap(unit => (unit.metadata.importOutcomes ?? []).map(item => ({file:unit.path,...item})));
  const imports = cold.relations.filter(edge => edge.type === 'imports' && ['java','kotlin'].includes(identities.get(edge.from)?.language));
  for (const edge of imports) {
    assert.ok(files.includes(identities.get(edge.to)?.path));
    assert.ok(edge.evidence.some(fact => fact.analyzer === 'jvm-imports' && files.includes(fact.file) && fact.line > 0));
    for (const id of edge.metadata.declarations) {
      const declaration = identities.get(id);
      assert.equal(declaration?.path,identities.get(edge.to)?.path);
      assert.ok(declaration.sourceRange?.startLine > 0, 'imports retain original indexed declarations');
    }
  }
  const count = values => values.reduce((counts,value) => ({...counts,[value]:(counts[value] ?? 0)+1}),{});
  const result = {
    source, commit, copiedFiles:files.length, qualificationInputs:inputs,
    files:count(units.map(unit=>unit.language)),
    declarations:cold.entities.filter(entity=>['java','kotlin'].includes(entity.language)&&['class','method','function'].includes(entity.type)).length,
    structure:count(units.map(unit=>unit.metadata.analysis?.features.structure.status)),
    imports:count(outcomes.map(item=>item.outcome.status)), importEdges:imports.length,
    projects:cold.entities.find(entity=>entity.type==='repository').metadata.jvmProjects,
    diagnostics:count(cold.diagnostics.filter(item=>item.analyzer==='jvm-imports').map(item=>item.reason)),
    samples:outcomes.slice(0,40).map(item=>({file:item.file,line:item.range.startLine,specifier:item.specifier,status:item.outcome.status,reason:item.outcome.reason})),
    cacheEqual:true, revisionEqual:true,
    boundary:'Unchanged tracked source integration under recorded inputs; no binary resolution, target builds/plugins, call/routing accuracy or runtime certification',
  };
  const json = JSON.stringify(result,null,2);
  if (option('--output')) await writeFile(path.resolve(option('--output')),json+'\n');
  console.log(json);
} finally { await rm(temporary,{recursive:true,force:true}); }
