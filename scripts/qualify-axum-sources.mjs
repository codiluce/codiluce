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
const baselineCommit = git(project, ['rev-parse', '--verify', `${option('--baseline-ref') ?? 'c2bd5ac'}^{commit}`]).toString().trim();
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
                // General Rust intentionally retains the tokio::main generation
                // gap; only the native framework resolver reviews that attribute.
                assert.equal(outcome.status, 'unsupported');
                assert.ok(outcome.reason.includes('tokio::main'));
                return { ...module, status: outcome.status, reason: outcome.reason };
            });
            assert.equal(evidence.localImportSamples.length, 0, 'no invented general Rust import winners');
            review = { functions: functions.length, expectedRoutes: expected.length, truePositiveRoutes: qualified.length, falsePositiveRoutes: 0, missedRoutes: 0, handlerPairs: qualified.length, localModuleImports: localModules, generalImportRecall: localModules.length ? 0 : null };
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
        results.push({ sample, url: `https://github.com/${pin.repository}/tree/${pin.commit}/${prefix(sample)}`, before: { declaredRoutes: before.declaredRouterEndpoints, qualifiedEndpoints: before.qualifiedRouterEndpoints, originalHandlers: before.originalHandlerEdges, graphFingerprint: before.graphFingerprint }, review, evidence });
    }
    assert.equal(new Set(results.map(result => result.evidence.trackedBlobDigest)).size, 1, 'all profiles retain the complete same pinned tree');
    const supported = results.filter(result => result.sample.supported), sum = key => supported.reduce((total, result) => total + result.review[key], 0);
    const digest = createHash('sha256');
    const implementationFiles = git(project, ['ls-files', '-z', 'src', 'grammars', 'package.json', 'package-lock.json']).toString().split('\0').filter(Boolean).sort();
    implementationFiles.push('scripts/qualify-rust-source.mjs', 'scripts/qualify-axum-sources.mjs', 'scripts/fixtures/axum-source-portfolio.mjs');
    for (const file of implementationFiles) digest.update(file + '\0').update(await readFile(path.join(project, file))).update('\0');
    const data = { phase: 'P9e2a', measuredAt: new Date().toISOString(), node: process.version, platform: `${process.platform}/${process.arch}`, pin, baselineCommit, implementationHead: git(project, ['rev-parse', 'HEAD']).toString().trim(), implementationDigest: digest.digest('hex'), trackedBlobDigest: results[0].evidence.trackedBlobDigest, counts: { supportedProfiles: supported.length, boundaryProfiles: results.length - supported.length, reviewedFunctions: sum('functions'), reviewedRoutes: sum('expectedRoutes'), confirmedRoutes: sum('truePositiveRoutes'), reviewedHandlerPairs: sum('handlerPairs'), falsePositiveRoutes: sum('falsePositiveRoutes'), missedSupportedRoutes: sum('missedRoutes'), reviewedLocalModuleImports: supported.flatMap(result => result.review.localModuleImports).length, confirmedGeneralLocalImportEdges: supported.reduce((n, result) => n + result.evidence.localImportSamples.length, 0), outsideSupportedRoutes: results.filter(result => !result.sample.supported).reduce((n, result) => n + result.review.outsideSupportedSubset, 0) }, results };
    const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const rows = results.map(({ sample, url, before, review, evidence: e }) => `<tr><th><a href="${esc(url)}">${esc(sample.directory)}</a><small>Original bin: ${esc(sample.target)}</small></th><td>${e.selectedFiles.length}</td><td>${review.functions ?? '—'}</td><td>${before.originalHandlers} → ${e.originalHandlerEdges}</td><td>${sample.supported ? `${review.truePositiveRoutes}/${review.expectedRoutes}` : `Outside subset: ${sample.sourceRoutes}`}</td><td>${e.qualifiedRouterEndpoints}/${e.routerEndpoints}</td><td>${e.cacheHits['rust-routers']}</td><td>${sample.supported ? 'Routing pass' : 'Boundary retained'}</td></tr>`).join('');
    const gaps = supported.flatMap(result => result.review.localModuleImports.map(module => `<li><a href="${esc(result.url + module.from)}">${esc(result.sample.directory + '/' + module.from)}</a> → <code>${esc(module.to)}</code>: ${esc(module.reason)}</li>`)).join('');
    const output = path.resolve(option('--output') ?? path.join(project, 'docs/axum-source-accuracy.html'));
    await writeFile(output, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Axum unchanged-source accuracy · P9e2a</title><style>body{font:16px/1.6 system-ui,sans-serif;background:#101822;color:#e5ecf4;margin:0;padding:32px}main{max-width:1200px;margin:auto}h1{line-height:1.2}p{max-width:1000px;color:#bdcbdc}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;border-bottom:1px solid #344353;padding:12px;vertical-align:top}small{display:block;color:#9dafc4;font-weight:400}a,code{color:#79ced3}code{overflow-wrap:anywhere}.status{border:1px solid #5a7882;padding:16px;border-radius:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere}@media(max-width:600px){body{padding:18px}}</style><main><h1>Axum unchanged-source accuracy</h1><p>${esc(data.measuredAt)} · ${esc(data.node)} · ${esc(data.platform)} · P9e2a.</p><p class="status"><strong>${data.counts.supportedProfiles} reviewed Axum profiles: routing PASS.</strong> ${data.counts.confirmedRoutes}/${data.counts.reviewedRoutes} supported path/method/fallback registrations and original handler pairs match manual ground truth, with zero extra or missed supported routes. Two additional unchanged profiles retain their macro/extractor boundaries. P9e2/P9/P10 remain open.</p><p>All profiles use unchanged <a href="https://github.com/${pin.repository}/tree/${pin.commit}">${esc(pin.repository)} at ${pin.commit.slice(0, 8)}</a>, with original crates.io Axum ${pin.requirement}, Tokio 1.50.0 and Rust edition 2024 manifests. Every run copies the same complete ${results[0].evidence.copiedFiles}-input tracked tree (${results[0].evidence.files} Rust files); selecting the original Cargo package/bin changes the reachable source graph. No source or manifest is rewritten. Directory and bin names remain distinct: <code>path-precedence</code> and <code>wildcard-path-parameters</code> keep the original <code>path-parameters</code> bin; <code>calculator-path</code> keeps <code>calculator</code>. Features are explicitly empty and defaults disabled for the application; dependency feature declarations remain original.</p><div class="scroll"><table><thead><tr><th>Pinned original profile</th><th>Selected Rust files</th><th>Reviewed functions</th><th>Handler pairs before → after</th><th>Reviewed supported routes</th><th>Qualified native endpoints</th><th>Router cache hits</th><th>Outcome</th></tr></thead><tbody>${rows}</tbody></table></div><h2>What the sample proves</h2><p>The inventory is manually reviewed from source independently of indexer output and covers literal/HTML responses, source factories, named and terminal wildcard captures, separate slash roots, literal-versus-capture precedence, nested module/local Cargo library routers, typed tuple captures, explicit versus implicit HEAD and a custom fallback. ${data.counts.reviewedFunctions} selected original function declarations have exact reviewed file/name inventories and checked source snippets. All ${data.counts.reviewedHandlerPairs} registration/handler pairs have checked original operand and declaration ranges. Cold, warm and revision graphs are exactly equal for all twelve profiles, with actual Rust import, symbol and router cache hits. Native 404/405 endpoints are separate from original handlers.</p><p>Reviewed supported endpoint precision is 100% (${data.counts.confirmedRoutes}/${data.counts.confirmedRoutes}); reviewed supported endpoint recall is 100% (${data.counts.confirmedRoutes}/${data.counts.reviewedRoutes}). Original handler pairing is 100% on that same sample. These small, purposefully selected examples come from one upstream repository and one closed version family; they do not establish population accuracy, all Axum versions, request/extractor success, compiler/Reply validity, runtime serving or native OS compatibility.</p><h2>Remaining source gaps</h2><p>General Rust local-import accuracy is a separate result: ${data.counts.confirmedGeneralLocalImportEdges}/${data.counts.reviewedLocalModuleImports} reviewed active module edges are confirmed (0% recall; confirmed-edge precision is not measurable). General Rust retains the original <code>tokio::main</code> macro generation gap; the framework resolver separately reviews that exact native attribute to follow original handlers. The original local Cargo library in the nested profile is followed by its source identity without inventing a general import edge. This gap remains visible and prevents claiming the complete declaration/import/route accuracy release gate.</p><ul>${gaps}</ul><p>The original <code>api-calculator</code> and <code>versioning-get</code> profiles contain ${data.counts.outsideSupportedRoutes} source registrations outside the declared supported subset. The original serde derives retain crate-wide macro generation gaps and produce zero confirmed endpoints or handler winners. Built-in Debug is already reviewed. In the Version profile, the root route remains qualified while the custom extractor constrains its API handler entry; both original registrations retain their real source bindings. Arbitrary external/local handler parameter types and opaque Path conversion types retain extractor conditions. Native Path scalar/flat-tuple and Method identities have bounded source contracts; nested tuple shapes retain conditions. <a href="https://github.com/tokio-rs/axum/blob/axum-v0.8.8/axum/src/extract/path/de.rs">Original Axum Path deserialization</a> supplies the native source boundary; request conversion success and compiler validity are not executed checks. Generated/source macros, arbitrary formatting operands and dynamic registration remain outside this slice.</p><h2>Implementation and reproduction</h2><p>Against Codiluce ${baselineCommit.slice(0, 8)}, the unchanged startup diagnostic previously blocked these router factories. The framework-only contract recognizes original standard <code>println!</code>/<code>eprintln!</code> with a literal and no formatting operands, or exactly one <code>{}</code> and an immutable source binding already proven to be a native Tokio listener's <code>local_addr().unwrap()</code>. Every delimiter retains original token-tree coordinates. Trailing comments after a router factory tail expression are ignored as trivia, preserving its actual returned original expression; semicolons still prevent a returned router. Custom/source/import macro shadows, disabled preludes, mutable or unknown receivers and arbitrary formatting arguments keep uncertainty; no macro expands. <a href="https://docs.rs/tokio/1.50.0/tokio/net/struct.TcpListener.html#method.local_addr">Tokio's original local_addr signature</a> returns standard <a href="https://doc.rust-lang.org/std/net/enum.SocketAddr.html#impl-Display-for-SocketAddr">SocketAddr with native Display</a>; <a href="https://doc.rust-lang.org/std/macro.println.html">standard println semantics</a> provide the bounded diagnostic contract. Success-path I/O/unwrap assumptions remain the existing native source-contract boundary.</p><p>Reproduce from the exact clean checkout: <code>node scripts/qualify-axum-sources.mjs --axum-book /path/to/axum.code-maven.com</code>. The driver archives the pinned Codiluce baseline, reuses our installed Node/WASM dependencies, checks identical upstream digests, and fails on extra/missing manual routes, handlers, declarations or changed uncertainty. Baseline and current each perform cold/warm/revision reads. No Cargo/rustc, target configuration, build scripts, dependency, source code or macro executes. Implementation digest: <code>${data.implementationDigest}</code>. <a href="language-framework-compatibility.html#implementation">Roadmap</a> · <a href="rust-router-source-qualification.html">Actix source evidence</a> · <a href="rust-compatibility-performance.html">Rust mixed-stack comparison</a>.</p><details><summary>Manual ground truth, source evidence and recorded Cargo inputs</summary><pre>${esc(JSON.stringify(data, null, 2))}</pre></details></main></html>`);
    console.log(JSON.stringify({ output, counts: data.counts, replayEqual: true, baselineCommit, implementationDigest: data.implementationDigest }, null, 2));
} finally {
    await rm(temporary, { recursive: true, force: true });
}
