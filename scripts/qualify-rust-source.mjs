// Original tracked Rust/Cargo inputs only. Cargo/rustc, build scripts, macros,
// dependencies and target configuration never execute.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { indexRepository } from '../src/pipeline/index.ts';
import { resolveConfig } from '../src/core/config.ts';
import { AnalysisCache } from '../src/pipeline/cache.ts';
import { canonicalJson } from '../src/history/fingerprint.ts';
const args = process.argv.slice(2), option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
assert.ok(option('--source') && option('--commit'), '--source and --commit required');
const source = path.resolve(option('--source')), git = params => execFileSync('git', params, { cwd: source, maxBuffer: 32 << 20 });
const commit = git(['rev-parse', '--verify', `${option('--commit')}^{commit}`]).toString().trim();
assert.equal(git(['rev-parse', 'HEAD']).toString().trim(), commit, 'checkout must match the pin');
const entries = git(['ls-tree', '-r', '-z', commit]).toString().split('\0').filter(Boolean).map(value => { const [header, file] = value.split('\t'); return { mode: header.split(' ')[0], file }; });
const files = entries.filter(entry => /\.rs$|(?:^|\/)(?:Cargo\.toml|Cargo\.lock|\.gitignore)$|(?:^|\/)\.cargo\/config(?:\.toml)?$/.test(entry.file));
assert.ok(files.some(entry => entry.file.endsWith('.rs')), 'original Rust required');
git(['diff', '--exit-code', commit, '--', ...files.map(entry => entry.file)]);
const temporary = await mkdtemp(path.join(tmpdir(), 'codiluce-rust-source-'));
try {
    const root = path.join(temporary, 'source'), state = path.join(temporary, 'cache'), blobs = new Map(), digest = createHash('sha256');
    for (const entry of files) {
        assert.ok(['100644', '100755'].includes(entry.mode), 'regular tracked inputs only');
        assert.ok(!entry.file.split('/').includes('..'));
        const target = path.join(root, entry.file);
        assert.ok(target.startsWith(root + path.sep));
        const blob = git(['cat-file', 'blob', `${commit}:${entry.file}`]);
        blobs.set(entry.file, blob.toString('utf8'));
        digest.update(entry.file + '\0' + entry.mode + '\0').update(blob).update('\0');
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, blob);
    }
    const inputs = JSON.parse(option('--inputs') ?? '{}'), config = await resolveConfig(root, { ...inputs, repository: { name: 'rust-source-qualification' } }), coldCache = new AnalysisCache(state), cold = await indexRepository(root, { config, cache: coldCache }), warmCache = new AnalysisCache(state), warm = await indexRepository(root, { config, cache: warmCache }), revision = await indexRepository(root, { config, revision: commit });
    const shape = graph => canonicalJson({ entities: graph.entities, relations: graph.relations, diagnostics: graph.diagnostics.filter(d => !['git-metrics', 'indexer'].includes(d.analyzer) && d.code !== 'git-ignore-unavailable') });
    assert.equal(shape(cold), shape(warm), 'cold/warm graph');
    assert.equal(shape(cold), shape(revision), 'cold/revision graph');
    assert.ok(warmCache.events.some(e => e.analyzer === 'rust-imports' && e.hit), 'actual Rust cache hit');
    const identities = new Map(cold.entities.map(e => [e.id, e])), repository = cold.entities.find(e => e.type === 'repository'), compilations = repository.metadata.rustCompilations, compilationIds = new Set(compilations.map(c => c.id)), units = cold.entities.filter(e => e.type === 'file' && e.language === 'rust'), declarations = cold.entities.filter(e => e.language === 'rust' && typeof e.metadata.declarationKind === 'string'), imports = units.flatMap(unit => (unit.metadata.importOutcomes ?? []).map(item => ({ file: unit.path, ...item }))), edges = cold.relations.filter(e => e.type === 'imports' && e.metadata?.adapter === 'rust');
    const range = (file, r) => { assert.ok(blobs.has(file), `original path ${file}`); const lines = blobs.get(file).split('\n'); assert.ok(r.startLine > 0 && r.endLine >= r.startLine && r.endLine <= lines.length, `original lines ${file}`); assert.ok(r.startColumn > 0 && r.startColumn <= lines[r.startLine - 1].length + 1 && r.endColumn > 0 && r.endColumn <= lines[r.endLine - 1].length + 1, `original columns ${file}`); };
    for (const declaration of declarations)
        range(declaration.path, declaration.sourceRange);
    for (const item of imports) {
        range(item.file, item.range);
        assert.ok(compilationIds.has(item.compilation));
        if (item.outcome.status === 'resolved') {
            assert.equal(item.outcome.conditions.length, 0);
            for (const id of item.outcome.declarations)
                range(identities.get(id).path, identities.get(id).sourceRange);
        }
        else
            assert.ok(!item.outcome.targets && !item.outcome.declarations, 'uncertified import has no winner');
    }
    for (const edge of edges) {
        assert.ok(blobs.has(identities.get(edge.from)?.path) && blobs.has(identities.get(edge.to)?.path));
        assert.ok(compilationIds.has(edge.metadata.compilation));
        assert.ok(edge.evidence.some(fact => fact.file === identities.get(edge.from).path && fact.line > 0));
        for (const fact of edge.evidence) {
            assert.ok(blobs.has(fact.file));
            assert.ok(fact.line > 0 && fact.line <= blobs.get(fact.file).split('\n').length);
        }
        for (const id of edge.metadata.declarations) {
            const original = identities.get(id);
            assert.equal(original.path, identities.get(edge.to).path);
            range(original.path, original.sourceRange);
        }
    }
    const count = values => values.reduce((result, value) => ({ ...result, [value]: (result[value] ?? 0) + 1 }), {}), result = { commit, copiedFiles: files.length, trackedBlobDigest: digest.digest('hex'), qualificationInputs: inputs, files: units.length, declarations: declarations.length, structure: count(units.map(u => u.metadata.analysis.features.structure.status)), imports: count(imports.map(i => i.outcome.status)), importEdges: edges.length, compilationCount: compilations.length, projects: repository.metadata.rustProjects, compilations, manifestOutcomes: repository.metadata.rustManifestOutcomes, diagnostics: count(cold.diagnostics.filter(d => d.analyzer === 'rust-imports').map(d => d.reason)), samples: imports.slice(0, 60).map(i => ({ file: i.file, line: i.range.startLine, specifier: i.specifier, kind: i.kind, status: i.outcome.status, reason: i.outcome.reason, conditions: i.outcome.conditions })), cacheHits: count(warmCache.events.filter(e => e.hit).map(e => e.analyzer)), cacheEqual: true, revisionEqual: true, graphFingerprint: createHash('sha256').update(shape(cold)).digest('hex'), boundary: 'Original Cargo/module/scoped use/re-export and target/source integration only. Recorded features/cfg are assumptions; no compiler, build, macro expansion, dependency execution, runtime, router, reference/call or production accuracy qualification.' };
    const json = JSON.stringify(result, null, 2);
    if (option('--output'))
        await writeFile(path.resolve(option('--output')), json + '\n');
    console.log(json);
}
finally {
    await rm(temporary, { recursive: true, force: true });
}
