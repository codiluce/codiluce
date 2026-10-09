// Only Codiluce's parser/indexer runs. Target gems/configuration never execute.
// node --experimental-sqlite --import tsx scripts/qualify-ruby-source.mjs
//   --source /path/to/checkout --commit <commit> --output /tmp/ruby-source.json
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { indexRepository } from '../src/pipeline/index.ts';
import { resolveConfig } from '../src/core/config.ts';
import { AnalysisCache } from '../src/pipeline/cache.ts';
import { canonicalJson } from '../src/history/fingerprint.ts';

const args = process.argv.slice(2), option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
assert.ok(option('--source') && option('--commit'), '--source and --commit are required');
const source = path.resolve(option('--source'));
const git = params => execFileSync('git', params, { cwd: source, encoding: 'utf8', maxBuffer: 16 << 20 });
const commit = git(['rev-parse', '--verify', `${option('--commit')}^{commit}`]).trim();
assert.equal(git(['rev-parse', 'HEAD']).trim(), commit, 'checkout must match the pinned commit');
const files = git(['ls-files', '-z']).split('\0').filter(file => /\.(?:rb|rake|gemspec|ru|so|bundle|dll)$/.test(file) || ['Gemfile', 'Gemfile.lock', 'Rakefile'].includes(path.posix.basename(file)));
assert.ok(files.length); git(['diff', '--exit-code', commit, '--', ...files]);
const temporary = await mkdtemp(path.join(tmpdir(), 'codiluce-ruby-source-'));
try {
 const root = path.join(temporary, 'source'), state = path.join(temporary, 'cache');
 for (const file of files) {
  const target = path.join(root, file); assert.ok(target.startsWith(root + path.sep));
  assert.ok((await lstat(path.join(source, file))).isFile(), 'qualification inputs must be regular tracked files');
  await mkdir(path.dirname(target), { recursive: true }); await cp(path.join(source, file), target);
 }
 // These are explicit qualification inputs, not inferred upstream runtime flags.
 const config = await resolveConfig(root, { repository: { name: 'ruby-source-qualification' }, applications: [{ name: 'source', path: '.', ecosystems: ['ruby'], sourceRoots: { ruby: ['lib'] }, ruby: { cwd: '.' } }] });
 const cold = await indexRepository(root, { config, cache: new AnalysisCache(state) }), warm = await indexRepository(root, { config, cache: new AnalysisCache(state) }), revision = await indexRepository(root, { config, revision: commit });
 const shape = graph => canonicalJson({ entities: graph.entities, relations: graph.relations, diagnostics: graph.diagnostics.filter(item => !['git-metrics', 'indexer'].includes(item.analyzer) && item.code !== 'git-ignore-unavailable') });
 assert.equal(shape(cold), shape(warm)); assert.equal(shape(cold), shape(revision));
 const ruby = cold.entities.filter(entity => entity.type === 'file' && entity.language === 'ruby'), outcomes = ruby.flatMap(entity => entity.metadata.importOutcomes ?? []);
 const identities = new Map(cold.entities.map(entity => [entity.id, entity]));
 const edges = cold.relations.filter(relation => relation.type === 'imports' && identities.get(relation.from)?.language === 'ruby');
 for (const edge of edges) { assert.ok(files.includes(identities.get(edge.to)?.path)); assert.ok(edge.evidence.some(fact => fact.analyzer === 'ruby-imports' && fact.line > 0)); }
 const count = values => values.reduce((counts, value) => ({ ...counts, [value]: (counts[value] ?? 0) + 1 }), {});
 const result = { source, commit, copiedFiles: files.length, rubyFiles: ruby.length, declarations: cold.entities.filter(entity => entity.language === 'ruby' && ['class', 'method', 'function'].includes(entity.type)).length, qualificationInputs: { loadPaths: ['lib'], cwd: '.' }, loads: count(outcomes.map(item => item.outcome.status)), importEdges: edges.length, constrainedLoads: outcomes.filter(item => item.conditions.length).length, resolverDiagnostics: count(cold.diagnostics.filter(item => item.analyzer === 'ruby-imports').map(item => item.reason)), cacheEqual: true };
 const json = JSON.stringify(result, null, 2); if (option('--output')) await writeFile(path.resolve(option('--output')), json + '\n'); console.log(json);
} finally { await rm(temporary, { recursive: true, force: true }); }
