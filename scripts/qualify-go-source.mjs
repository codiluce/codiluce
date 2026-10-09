// Scan pinned tracked Go source without running its toolchain or dependencies.
// node --experimental-sqlite --import tsx scripts/qualify-go-source.mjs
//   --source /path/to/checkout --commit <commit> --output /tmp/qualification.json
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
const files = git(['ls-files', '-z']).split('\0').filter(file => file.endsWith('.go') || /(?:^|\/)go\.(?:mod|work)$/.test(file));
assert.ok(files.length, 'checkout must contain tracked Go source or manifests');
git(['diff', '--exit-code', commit, '--', ...files]);
const temporary = await mkdtemp(path.join(tmpdir(), 'codiluce-go-source-qualification-'));
try {
  const root = path.join(temporary, 'source'), state = path.join(temporary, 'cache');
  for (const file of files) {
    const target = path.join(root, file);
    assert.ok(target.startsWith(root + path.sep), 'tracked paths must remain inside the source harness');
    assert.ok((await lstat(path.join(source, file))).isFile(), `tracked source must be a regular file: ${file}`);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(source, file), target);
  }
  const build = { goos: 'linux', goarch: 'amd64', compiler: 'gc', toolchainVersion: '1.26.0', tags: [], cgoEnabled: false };
  const config = await resolveConfig(root, { repository: { name: 'source-qualification' }, applications: [{ name: 'source', path: '.', ecosystems: ['go'], go: build }] });
  const cold = await indexRepository(root, { config, cache: new AnalysisCache(state) });
  const warm = await indexRepository(root, { config, cache: new AnalysisCache(state) });
  const revision = await indexRepository(root, { config, revision: commit });
  const shape = graph => canonicalJson({ entities: graph.entities, relations: graph.relations, diagnostics: graph.diagnostics.filter(item => !['git-metrics', 'indexer'].includes(item.analyzer) && item.code !== 'git-ignore-unavailable') });
  assert.equal(shape(cold), shape(warm), 'cold/warm graphs must agree');
  assert.equal(shape(cold), shape(revision), 'cold/revision graphs must agree');
  const endpoints = cold.entities.filter(entity => entity.type === 'api_endpoint');
  const entities = new Map(cold.entities.map(entity => [entity.id, entity]));
  const tracked = new Set(files);
  for (const relation of cold.relations.filter(relation => relation.type === 'handles')) {
    const handler = entities.get(relation.to);
    assert.ok(handler?.path && tracked.has(handler.path) && handler.sourceRange?.startLine > 0, 'handler links must retain original tracked source sites');
  }
  const count = values => values.reduce((counts, value) => ({ ...counts, [value]: (counts[value] ?? 0) + 1 }), {});
  const result = {
    source, commit, build, copiedFiles: files.length,
    goFiles: cold.entities.filter(entity => entity.type === 'file' && entity.language === 'go').length,
    modules: cold.entities.find(entity => entity.type === 'repository').metadata.projects.filter(project => project.ecosystem === 'go').length,
    imports: count(cold.entities.filter(entity => entity.type === 'file' && entity.language === 'go').flatMap(entity => entity.metadata.importOutcomes ?? []).map(item => item.outcome.status)),
    endpoints: endpoints.length, qualified: endpoints.filter(endpoint => !endpoint.metadata.constraintsUnresolved).length,
    handles: cold.relations.filter(relation => relation.type === 'handles').length,
    routerDiagnostics: count(cold.diagnostics.filter(item => item.analyzer === 'go-routers').map(item => item.reason)),
    cacheEqual: true,
  };
  const json = JSON.stringify(result, null, 2);
  if (option('--output')) await writeFile(path.resolve(option('--output')), json + '\n');
  console.log(json);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
