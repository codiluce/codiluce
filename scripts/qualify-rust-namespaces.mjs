// Manual ground truth, immutable original inputs and Codiluce's own Node/WASM
// indexer only. No Cargo/rustc, dependency, target source or macro executes.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parse as parseToml } from 'smol-toml';
import { axumSourcePin as pin, axumSourcePortfolio as portfolio } from './fixtures/axum-source-portfolio.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2), option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
assert.ok(option('--axum-book'), '--axum-book immutable pinned checkout required');
const source = path.resolve(option('--axum-book')), run = promisify(execFile);
const git = (cwd, params) => execFileSync('git', params, { cwd, maxBuffer: 64 << 20 });
const baselineCommit = git(project, ['rev-parse', '--verify', `${option('--baseline-ref') ?? 'b79d9f4'}^{commit}`]).toString().trim();
const temporary = await mkdtemp(path.join(tmpdir(), 'codiluce-axum-accuracy-'));
const prefix = sample => `src/examples/${sample.directory}/`;
const routeKey = route => JSON.stringify([route.routePath, route.methods, route.fallback ?? null, route.handler[0]?.path, route.handler[0]?.name]);
const expectedKey = (sample, route) => routeKey({ routePath: route.path, methods: route.methods, fallback: route.fallback, handler: [{ path: prefix(sample) + route.file, name: route.handler }] });
const sorted = values => values.sort((a, b) => a.localeCompare(b, 'en'));
const original = file => git(source, ['cat-file', 'blob', `${pin.commit}:${file}`]).toString('utf8');
const snippet = (file, range) => {
    const lines = original(file).split('\n');
    return lines.slice(range.startLine - 1, range.endLine).map((line, index, selected) => line.slice(index ? 0 : range.startColumn - 1, index === selected.length - 1 ? range.endColumn - 1 : undefined)).join('\n');
};

try {
    const baseline = path.join(temporary, 'baseline');
    await mkdir(baseline);
    await writeFile(path.join(temporary, 'baseline.tar'), git(project, ['archive', baselineCommit]));
    execFileSync('tar', ['-xf', path.join(temporary, 'baseline.tar'), '-C', baseline]);
    await symlink(path.join(project, 'node_modules'), path.join(baseline, 'node_modules'));
    const qualify = async (implementation, inputs) => {
        const { stdout } = await run(process.execPath, ['--experimental-sqlite', '--import', 'tsx', path.join(implementation, 'scripts/qualify-rust-source.mjs'), '--source', source, '--commit', pin.commit, '--inputs', JSON.stringify(inputs)], { cwd: implementation, timeout: 300000, maxBuffer: 32 << 20 });
        return JSON.parse(stdout);
    };
    const results = [];
    for (const sample of portfolio) {
        console.log(`Qualifying original Axum ${sample.directory}`);
        const manifest = parseToml(original(prefix(sample) + 'Cargo.toml'));
        assert.equal(manifest.package.name, sample.target, 'original implicit bin name, never the directory name');
        assert.equal(manifest.package.edition, '2024');
        assert.equal(manifest.dependencies.axum, pin.requirement);
        assert.equal(manifest.dependencies.tokio.version, '1.50.0');
        const inputs = { applications: [{ name: 'sample', path: '.', rust: { package: prefix(sample) + 'Cargo.toml', target: { kind: 'bin', name: sample.target }, features: [], defaultFeatures: false } }] };
        const before = await qualify(baseline, inputs), evidence = await qualify(project, inputs);
        assert.equal(evidence.commit, pin.commit);
        assert.ok(evidence.compilationCount > 0 && evidence.selectedFiles.includes(prefix(sample) + 'src/main.rs'), 'every reviewed profile selects its original bin; missing targets cannot masquerade as uncertainty');
        assert.equal(before.trackedBlobDigest, evidence.trackedBlobDigest, 'identical original source tree across implementations');
        assert.ok(evidence.cacheEqual && evidence.revisionEqual && evidence.cacheHits['rust-routers']);
        const qualified = evidence.routerSamples.filter(route => !route.conditions.length && route.registration === 'explicit');
        let review;
        if (sample.supported) {
            const expected = sample.routes.map(route => expectedKey(sample, route));
            assert.deepEqual(sorted(qualified.map(routeKey)), sorted(expected), `all manual original ${sample.directory} path/method/fallback/handler pairs, without extra routes`);
            assert.equal(evidence.originalHandlerEdges, expected.length);
            assert.equal(evidence.qualifiedRouterEndpoints, evidence.routerEndpoints, 'every emitted native default also qualified');
            for (const route of qualified) {
                assert.equal(route.handler.length, 1);
                assert.equal(route.dialect, 'axum-0.8');
                assert.ok(snippet(route.path, route.range).includes(route.handler[0].name), 'original registration coordinates contain the manual handler operand');
                assert.ok(new RegExp(`\\bfn\\s+${route.handler[0].name}\\b`).test(snippet(route.handler[0].path, route.handler[0].range)), 'original declaration coordinates contain the manual function');
            }
            const functions = Object.entries(sample.functions).flatMap(([file, names]) => names.map(name => JSON.stringify([prefix(sample) + file, name])));
            const declarations = evidence.selectedDeclarations.filter(declaration => declaration.kind === 'function');
            assert.deepEqual(sorted(declarations.map(declaration => JSON.stringify([declaration.path, declaration.name]))), sorted(functions), 'complete manual selected source function inventory');
            for (const declaration of declarations)
                assert.ok(new RegExp(`\\bfn\\s+${declaration.name}\\b`).test(snippet(declaration.path, declaration.range)));
            assert.deepEqual(sorted(evidence.selectedFiles), sorted(Object.keys(sample.functions).map(file => prefix(sample) + file)), 'only original selected modules and local crate');
            const localModules = (sample.modules ?? []).map(module => {
                const outcome = evidence.samples.find(item => item.file === prefix(sample) + module.from && item.kind === 'module' && item.specifier === module.name);
                assert.ok(outcome, 'reviewed source module declaration keeps its general Rust outcome');
                assert.equal(outcome.status, 'resolved', 'native main namespace proof restores the original module, without expansion');
                const edge = evidence.localImportSamples.find(edge => edge.from === prefix(sample) + module.from && edge.to === prefix(sample) + module.to && edge.specifier === module.name);
                assert.ok(edge && edge.kind === 'module');
                assert.ok(snippet(edge.from, edge.range).includes('mod ' + module.name), 'manual original mod coordinates');
                assert.ok(edge.proof.some(fact => fact.file === prefix(sample) + 'src/main.rs' && fact.explanation?.includes('containing-module namespace only')));
                for (const fact of edge.proof.filter(fact => fact.explanation?.includes('containing-module namespace only'))) {
                    const lines = original(fact.file).split('\n');
                    assert.ok(lines.slice(fact.line - 1, fact.endLine).join('\n').includes('#[tokio::main]'), 'namespace evidence points to the original attribute');
                }
                return { ...module, status: outcome.status, range: edge.range };
            });
            assert.deepEqual(sorted(evidence.localImportSamples.map(edge => JSON.stringify([edge.from, edge.to, edge.specifier]))), sorted(localModules.map(module => JSON.stringify([prefix(sample) + module.from, prefix(sample) + module.to, module.name]))), 'all manual active module edges, without extras');
            const beforeRoutes = before.routerSamples.filter(route => !route.conditions.length && route.registration === 'explicit');
            assert.deepEqual(sorted(beforeRoutes.map(routeKey)), sorted(expected), 'native route control already matches at the baseline');
            assert.deepEqual(sorted(qualified.map(route => route.handler[0].id)), sorted(beforeRoutes.map(route => route.handler[0].id)), 'unchanged original native handler IDs');
            assert.deepEqual(evidence.selectedDeclarations, before.selectedDeclarations, 'original declaration coordinates and inventories unchanged');
            const mainCalls = evidence.sourceCallSamples.filter(item => item.owner === 'main');
            assert.ok(mainCalls.length && mainCalls.every(item => item.status === 'unsupported' && item.reason.includes('tokio::main')), 'the generated main body cannot acquire general call winners');
            review = { functions: functions.length, expectedRoutes: expected.length, truePositiveRoutes: qualified.length, falsePositiveRoutes: 0, missedRoutes: 0, handlerPairs: qualified.length, localModuleImports: localModules, beforeGeneralLocalImportEdges: before.localImportSamples.length, generalImportRecall: localModules.length ? 1 : null, mainSourceCalls: mainCalls.length, confirmedMainSourceCalls: 0 };
        } else {
            const known = sample.knownRoutes ?? [], constrained = sample.constrainedRoutes ?? [];
            assert.deepEqual(sorted(qualified.map(routeKey)), sorted(known.map(route => expectedKey(sample, route))), 'boundary profile retains exactly its known original registrations');
            const partial = evidence.routerSamples.filter(route => route.registration === 'explicit' && route.conditions.length);
            assert.deepEqual(sorted(partial.map(routeKey)), sorted(constrained.map(route => expectedKey(sample, route))), 'custom extractor remains a conditional original registration');
            for (const route of partial) assert.ok(route.conditions.some(condition => condition.includes('Axum handler extractor')));
            assert.equal(evidence.originalHandlerEdges, known.length + constrained.length);
            if (!known.length && !constrained.length) assert.equal(evidence.qualifiedRouterEndpoints, 0, 'unreviewed crate macros cannot become confirmed endpoints');
            review = { expectedRoutes: sample.sourceRoutes, outsideSupportedSubset: sample.sourceRoutes - known.length, knownBoundaryRoutes: known.length, constrainedRoutes: constrained.length, boundary: sample.boundary, confirmedEndpoints: evidence.qualifiedRouterEndpoints };
        }
        results.push({ sample, url: `https://github.com/${pin.repository}/tree/${pin.commit}/${prefix(sample)}`, before: { declaredRoutes: before.declaredRouterEndpoints, qualifiedEndpoints: before.qualifiedRouterEndpoints, originalHandlers: before.originalHandlerEdges, graphFingerprint: before.graphFingerprint, generalLocalImportEdges: before.localImportSamples.length }, review, evidence });
    }
    assert.equal(new Set(results.map(result => result.evidence.trackedBlobDigest)).size, 1, 'all profiles retain the complete same pinned tree');
    const supported = results.filter(result => result.sample.supported), sum = key => supported.reduce((total, result) => total + result.review[key], 0);
    const digest = createHash('sha256');
    const implementationFiles = git(project, ['ls-files', '-co', '--exclude-standard', '-z', 'src', 'grammars', 'package.json', 'package-lock.json']).toString().split('\0').filter(Boolean).sort();
    implementationFiles.push('scripts/qualify-rust-source.mjs', 'scripts/qualify-rust-namespaces.mjs', 'scripts/fixtures/axum-source-portfolio.mjs');
    for (const file of implementationFiles) digest.update(file + '\0').update(await readFile(path.join(project, file))).update('\0');
    const data = { phase: 'P9e2b1', measuredAt: new Date().toISOString(), node: process.version, platform: `${process.platform}/${process.arch}`, pin, baselineCommit, implementationHead: git(project, ['rev-parse', 'HEAD']).toString().trim(), implementationDigest: digest.digest('hex'), trackedBlobDigest: results[0].evidence.trackedBlobDigest, counts: { supportedProfiles: supported.length, boundaryProfiles: results.length - supported.length, reviewedFunctions: sum('functions'), reviewedRoutes: sum('expectedRoutes'), confirmedRoutes: sum('truePositiveRoutes'), reviewedHandlerPairs: sum('handlerPairs'), falsePositiveRoutes: sum('falsePositiveRoutes'), missedSupportedRoutes: sum('missedRoutes'), beforeGeneralLocalImportEdges: sum('beforeGeneralLocalImportEdges'), mainSourceCalls: sum('mainSourceCalls'), confirmedMainSourceCalls: sum('confirmedMainSourceCalls'), reviewedLocalModuleImports: supported.flatMap(result => result.review.localModuleImports).length, confirmedGeneralLocalImportEdges: supported.reduce((n, result) => n + result.evidence.localImportSamples.length, 0), outsideSupportedRoutes: results.filter(result => !result.sample.supported).reduce((n, result) => n + result.review.outsideSupportedSubset, 0) }, results };
    const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const rows = results.map(({ sample, url, before, review, evidence: e }) => `<tr><th><a href="${esc(url)}">${esc(sample.directory)}</a><small>Original bin: ${esc(sample.target)}</small></th><td>${e.selectedFiles.length}</td><td>${review.functions ?? '—'}</td><td>${before.generalLocalImportEdges} → ${e.localImportSamples.length}</td><td>${sample.supported ? `${review.truePositiveRoutes}/${review.expectedRoutes}` : 'Boundary retained'}</td><td>${e.cacheHits['rust-imports']}/${e.cacheHits['rust-symbols']}/${e.cacheHits['rust-routers']}</td></tr>`).join('');
    const modules = supported.flatMap(result => result.review.localModuleImports.map(module => `<li><a href="${esc(result.url + module.from)}">${esc(result.sample.directory + '/' + module.from)}</a> → <code>${esc(module.to)}</code>: resolved at original line ${module.range.startLine}.</li>`)).join('');
    const output = path.resolve(option('--output') ?? path.join(project, 'docs/rust-runtime-namespace-accuracy.html'));
    await writeFile(output, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rust runtime namespace accuracy · P9e2b1</title><style>body{font:16px/1.6 system-ui,sans-serif;background:#101822;color:#e5ecf4;margin:0;padding:32px}main{max-width:1200px;margin:auto}h1{line-height:1.2}p{max-width:1000px;color:#bdcbdc}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;border-bottom:1px solid #344353;padding:12px;vertical-align:top}small{display:block;color:#9dafc4;font-weight:400}a,code{color:#79ced3}code{overflow-wrap:anywhere}.status{border:1px solid #5a7882;padding:16px;border-radius:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere}@media(max-width:600px){body{padding:18px}}</style><main><h1>Rust runtime namespace accuracy</h1><p>${esc(data.measuredAt)} · ${esc(data.node)} · ${esc(data.platform)} · P9e2b1.</p><p class="status"><strong>Source namespace PASS.</strong> ${data.counts.confirmedGeneralLocalImportEdges}/${data.counts.reviewedLocalModuleImports} manually reviewed active module edges now resolve, versus ${data.counts.beforeGeneralLocalImportEdges} at ${baselineCommit.slice(0,8)}. All ${data.counts.reviewedRoutes} supported route/handler pairs and ${data.counts.reviewedFunctions} selected function declarations remain exact. Generated main bodies retain zero general source-call winners. P9e2/P9/P10 remain open.</p><p>Every profile copies the same unchanged <a href="https://github.com/${pin.repository}/tree/${pin.commit}">${esc(pin.repository)} at ${pin.commit.slice(0,8)}</a>: ${results[0].evidence.copiedFiles} tracked inputs, ${results[0].evidence.files} Rust files, original crates.io Axum ${pin.requirement}/Tokio 1.50.0/Rust edition 2024 manifests and original package/bin names. No target source or manifest is rewritten. Selected application features are empty and defaults disabled; dependency features remain original.</p><div class="scroll"><table><thead><tr><th>Original profile</th><th>Selected Rust files</th><th>Reviewed functions</th><th>General module edges before → after</th><th>Supported routes</th><th>Actual import/symbol/router cache hits</th></tr></thead><tbody>${rows}</tbody></table></div><h2>Independent source inventory</h2><p>The manually reviewed original module edges all match, with no extra or missed local import winners on the ten supported profiles. Precision and recall on this three-edge sample are 100%; this small one-repository sample does not establish broader import accuracy. Each original mod statement, native attribute proof and target file keeps checked coordinates. The original local Cargo library remains a distinct compilation; no library use edge is invented.</p><ul>${modules}</ul><p>The same 55 source declarations and 31 original route/handler pairs retain their baseline inventories, ranges and handler IDs. All twelve baseline/current profiles have exact cold/warm/revision graphs within each implementation and actual import/symbol/router cache hits. Main bodies still contain ${data.counts.mainSourceCalls} general call outcomes, all unsupported under their original tokio::main condition; no generated signature or body is borrowed. Native framework registration uses its separate existing source contracts.</p><h2>Namespace and runtime boundaries</h2><p>Canonical Tokio 1, Actix Web 4 and Rocket 0.5 main attributes have bounded containing-module namespace contracts. Original annotated function signatures and bodies remain opaque to general Rust binding. Rocket launch, source/fork lookalikes, unsupported requirements/features/options, renamed-only Actix delegation, conditional generation, opaque lifted inner attributes and composed wrappers retain gaps. Standard println/eprintln/format token trees can supply namespace proof only with a literal format string and bounded operands free of items, attributes and nested macros. This does not certify formatting, method dispatch or runtime registration effects. Explicit unresolved imports and unavailable globs cannot borrow standard prelude macro identities. Every selected source scope, item/import attribute, reachable module and macro site is checked for unknown crate-export effects before these contracts apply.</p><p>Two original boundary profiles remain unchanged: serde generation keeps api-calculator unqualified; versioning-get retains its known root and conditional custom extractor registration with the original handler binding. These are source contracts without macro expansion, target compilation, runtime execution or extractor success. Original <a href="https://github.com/tokio-rs/tokio/blob/tokio-1.50.0/tokio-macros/src/entry.rs">Tokio entry source</a>, <a href="https://docs.rs/tokio/1.50.0/tokio/attr.main.html">Tokio main semantics</a>, <a href="https://github.com/actix/actix-web/blob/web-v4.11.0/actix-web-codegen/src/lib.rs">Actix delegation</a> and <a href="https://github.com/rwf2/Rocket/blob/f53611f74f2c777b9d7ebb40f8ec3f8dadd0a6f6/core/codegen/src/attribute/entry/main.rs">Rocket main source</a> support the reviewed namespace boundary. <a href="axum-source-accuracy.html">P9e2a report</a> preserves the preceding 0/3 result.</p><h2>Reproduction and remaining gates</h2><p>Run <code>node scripts/qualify-rust-namespaces.mjs --axum-book /path/to/axum.code-maven.com</code> from this release. The driver archives ${baselineCommit.slice(0,8)}, uses Codiluce's own Node/WASM indexer and installed dependencies, and fails on changed immutable inputs, extra/missing manual imports/routes/functions/handlers, changed original handler identities or generated-main call winners. No Cargo/rustc, dependency, build script, target configuration/source or macro executes. Broader Rust consumers, Axum 0.7/Rocket/Warp source/version coverage and native OS/P10 release gates remain. Implementation digest: <code>${data.implementationDigest}</code>. <a href="language-framework-compatibility.html#implementation">Roadmap</a>.</p><details><summary>Original ground truth, source coordinates, baseline summaries and raw current qualification</summary><pre>${esc(JSON.stringify(data,null,2))}</pre></details></main></html>`);
    console.log(JSON.stringify({ output, counts:data.counts, replayEqual:true, baselineCommit, implementationDigest:data.implementationDigest },null,2));
} finally {
    await rm(temporary, { recursive: true, force: true });
}
