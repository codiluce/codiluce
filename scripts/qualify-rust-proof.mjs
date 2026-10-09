// Compare our native indexer releases on fixed source-contract fixtures.
// Only Codiluce's Node/TS/WASM code executes, without target tools or macros.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rustWorkload } from './fixtures/rust-workload.ts';
import { canonicalJson } from '../src/history/fingerprint.ts';

export async function qualifyRustProof(project, baselineRef = '888bdb7') {
  const temporary = await mkdtemp(path.join(tmpdir(), 'codiluce-rust-proof-')), baseline = path.join(temporary, 'baseline'), root = path.join(temporary, 'source');
  const git = args => execFileSync('git', args, { cwd: project, maxBuffer: 64 << 20 });
  try {
    const revision = git(['rev-parse', '--verify', `${baselineRef}^{commit}`]).toString().trim();
    await mkdir(baseline); await writeFile(path.join(temporary, 'baseline.tar'), git(['archive', revision]));
    execFileSync('tar', ['-xf', path.join(temporary, 'baseline.tar'), '-C', baseline]);
    await symlink(path.join(project, 'node_modules'), path.join(baseline, 'node_modules'));
    const workload = rustWorkload(12);
    for (const [file, text] of Object.entries(workload.files)) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); }
    const graphs = {};
    for (const [label, implementation] of [['before', baseline], ['after', project]]) {
      const { indexRepository } = await import(pathToFileURL(path.join(implementation, 'src/pipeline/index.ts')).href);
      const { resolveConfig } = await import(pathToFileURL(path.join(implementation, 'src/core/config.ts')).href);
      graphs[label] = await indexRepository(root, { config: await resolveConfig(root, workload.config) });
    }
    const normalize = value => {
      if (Array.isArray(value)) return value.map(normalize);
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(Object.entries(value).map(([key, item]) => {
        if (key === 'analyzerVersion' && value.analyzer === 'rust-routers' || key === 'version' && value.adapter === 'rust-routers') return [key, 'router-cache-version'];
        if (key === 'evidence') return [key, [...new Map(item.map(normalize).map(fact => [canonicalJson(fact), fact])).values()].sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)))];
        return [key, normalize(item)];
      }));
    };
    const shape = graph => normalize({ entities: graph.entities, relations: graph.relations, diagnostics: graph.diagnostics.filter(d => !['indexer', 'git-metrics'].includes(d.analyzer) && d.code !== 'git-ignore-unavailable') });
    const hash = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
    const before = shape(graphs.before), after = shape(graphs.after);
    assert.equal(hash(before), hash(after), 'IDs, native contracts, calls, conditions, coordinates and all distinct evidence preserved; only duplicate proof and Rust router analyzer/cache version normalized');
    const sizes = Object.fromEntries(Object.entries(graphs).map(([label, graph]) => [label, { bytes: Buffer.byteLength(JSON.stringify(graph)), entities: graph.entities.length, relations: graph.relations.length, requests: graph.relations.filter(e => e.type === 'requests').length, maxEndpointEvidence: Math.max(...graph.entities.filter(e => e.type === 'api_endpoint').map(e => e.evidence.length)) }]));
    assert.ok(sizes.before.maxEndpointEvidence > 256, 'the pre-fix native release must reproduce repeated proof');
    assert.ok(sizes.after.maxEndpointEvidence < 256, 'fixed original endpoint evidence fits its budget');
    assert.equal(sizes.after.requests, workload.expectedRequests);
    return { baseline: revision, resourcesPerProfile: 12, fixtureDigest: createHash('sha256').update(await readFile(path.join(project, 'scripts/fixtures/rust-workload.ts'))).digest('hex'), semanticAndDistinctProofEqual: true, normalizedGraphDigest: hash(after), normalization: 'Exact duplicate evidence and only rust-routers analyzer/cache version; all other entities, relations, metadata and diagnostics retained', sizes };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), baseline = args.includes('--baseline-ref') ? args[args.indexOf('--baseline-ref') + 1] : '888bdb7';
  console.log(JSON.stringify(await qualifyRustProof(fileURLToPath(new URL('../', import.meta.url)), baseline), null, 2));
}
