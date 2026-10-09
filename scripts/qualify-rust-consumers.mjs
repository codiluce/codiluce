// Independent immutable source audit. Only Codiluce's own Node/WASM indexer runs.
// No Cargo/rustc, macros, target/dependency/configuration code or build scripts.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parse as parseToml } from 'smol-toml';
import { rustConsumerPins as pins, rustConsumerPortfolio as portfolio } from './fixtures/rust-consumer-portfolio.mjs';

const project = fileURLToPath(new URL('../', import.meta.url)), args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
assert.ok(option('--rocket-consumer') && option('--web-benchmark'), 'both immutable pinned source checkouts required');
const sources = { rocket: path.resolve(option('--rocket-consumer')), benchmark: path.resolve(option('--web-benchmark')) };
const git = (cwd, params) => execFileSync('git', params, { cwd, maxBuffer: 64 << 20 });
const baselineCommit = git(project, ['rev-parse', '--verify', `${option('--baseline-ref') ?? '771d9d0'}^{commit}`]).toString().trim();
const temporary = await mkdtemp(path.join(tmpdir(), 'codiluce-rust-consumer-accuracy-')), run = promisify(execFile);
const sorted = values => values.sort((a, b) => a.localeCompare(b, 'en'));
const original = (sample, file = sample.file) => git(sources[sample.pin], ['cat-file', 'blob', `${pins[sample.pin].commit}:${file}`]).toString('utf8');
const snippet = (sample, range, file = sample.file) => original(sample, file).split('\n').slice(range.startLine - 1, range.endLine).map((line, index, selected) => line.slice(index ? 0 : range.startColumn - 1, index === selected.length - 1 ? range.endColumn - 1 : undefined)).join('\n');
const routeKey = route => JSON.stringify([route.routePath, route.methods, route.handler.map(handler => [handler.path, handler.name, handler.kind, handler.range.startLine])]);
const expectedKey = (sample, route) => routeKey({ routePath: route.path, methods: route.methods, handler: [{ path: sample.file, name: route.handler, kind: route.kind, range: { startLine: route.line } }] });

try {
    const baseline = path.join(temporary, 'baseline');
    await mkdir(baseline);
    await writeFile(path.join(temporary, 'baseline.tar'), git(project, ['archive', baselineCommit]));
    execFileSync('tar', ['-xf', path.join(temporary, 'baseline.tar'), '-C', baseline]);
    await symlink(path.join(project, 'node_modules'), path.join(baseline, 'node_modules'));
    // Use the SAME audit adapter against both implementations. It adds source
    // evidence/identity serialization, never changes any target source input.
    await writeFile(path.join(baseline, 'scripts/qualify-rust-source.mjs'), await readFile(path.join(project, 'scripts/qualify-rust-source.mjs')));
    const qualify = async (implementation, sample, inputs) => {
        const { stdout } = await run(process.execPath, ['--experimental-sqlite', '--import', 'tsx', path.join(implementation, 'scripts/qualify-rust-source.mjs'), '--source', sources[sample.pin], '--commit', pins[sample.pin].commit, '--inputs', JSON.stringify(inputs), '--details'], { cwd: implementation, timeout: 300000, maxBuffer: 32 << 20 });
        return JSON.parse(stdout);
    };
    const results = [];
    for (const sample of portfolio) {
        console.log(`Qualifying ${sample.name}`);
        const manifest = parseToml(original(sample, sample.manifest));
        assert.equal(manifest.package.name, sample.target);
        assert.equal(manifest.package.edition, sample.edition);
        assert.equal(manifest.dependencies[sample.framework], sample.requirement, 'original dependency, without widening or rewriting');
        const inputs = { applications: [{ name: 'sample', path: '.', rust: { package: sample.manifest, target: { kind: 'bin', name: sample.target }, features: [], defaultFeatures: false } }] };
        const before = await qualify(baseline, sample, inputs), evidence = await qualify(project, sample, inputs);
        assert.equal(evidence.commit, pins[sample.pin].commit);
        assert.equal(evidence.compilationCount, 1);
        assert.deepEqual(evidence.selectedFiles, [sample.file], 'inactive tests and other projects cannot supply selected handlers');
        assert.equal(evidence.trackedBlobDigest, before.trackedBlobDigest, 'identical original source tree before/after');
        assert.ok(evidence.cacheEqual && evidence.revisionEqual);
        for (const analyzer of ['rust-imports', 'rust-symbols', 'rust-routers']) assert.ok(evidence.cacheHits[analyzer], 'actual ' + analyzer + ' cache hit');
        assert.deepEqual(evidence.selectedDeclarations, before.selectedDeclarations, 'same complete ORIGINAL declaration IDs/ranges; no generated main/context/trait declarations');
        assert.deepEqual(sorted(evidence.selectedDeclarations.map(declaration => JSON.stringify([declaration.name, declaration.kind, declaration.range.startLine]))), sorted(sample.declarations.map(declaration => JSON.stringify(declaration))), 'independent complete source declaration inventory');
        for (const declaration of evidence.selectedDeclarations) {
            const text = snippet(sample, declaration.range);
            assert.ok(declaration.kind === 'closure' ? text.startsWith('|name|') : text.includes(declaration.name), 'checked original declaration coordinates');
        }
        assert.equal(evidence.localImportSamples.length, 0, 'these selected bins have no active source module import edges; no import recall claim');
        assert.ok(evidence.sourceCallSamples.length && evidence.sourceCallSamples.every(call => call.status === 'unsupported'), 'generated entry/body and original form traits cannot become general call winners');
        assert.equal(evidence.callEdges, 0);
        assert.equal(before.qualifiedRouterEndpoints, sample.beforeQualified);
        assert.equal(before.originalHandlerEdges, sample.beforeQualified, 'baseline original-handler control');
        const qualified = evidence.routerSamples.filter(route => route.registration === 'explicit' && !route.conditions.length);
        const conditional = evidence.routerSamples.filter(route => route.registration === 'explicit' && route.conditions.length);
        const expected = sample.routes.filter(route => !route.conditional), constrained = sample.routes.filter(route => route.conditional);
        assert.deepEqual(sorted(qualified.map(routeKey)), sorted(expected.map(route => expectedKey(sample, route))), 'exact manual path/method/ORIGINAL handler pairs; no extra or missing supported routes');
        assert.deepEqual(sorted(conditional.map(routeKey)), sorted(constrained.map(route => expectedKey(sample, route))), 'all reviewed conditional source routes retain exact original handlers');
        assert.equal(evidence.routerEndpoints, sample.routes.length, 'no extra automatic/legacy/generated routes');
        assert.equal(evidence.originalHandlerEdges, sample.routes.length);
        for (const route of evidence.routerSamples) {
            assert.equal(route.dialect, sample.dialect);
            assert.equal(route.handler.length, 1);
            assert.ok(evidence.selectedDeclarations.some(declaration => declaration.id === route.handler[0].id && declaration.range.startLine === route.handler[0].range.startLine));
            assert.ok(snippet(sample, route.range).includes(sample.framework === 'warp' ? 'warp::path!' : 'fn ' + route.handler[0].name), 'original registration coordinates');
            for (const derive of sample.derives ?? []) {
                const proof = route.proof.find(fact => fact.file === sample.file && fact.line === derive.line && fact.explanation?.includes(' ' + derive.name + ' derive'));
                assert.ok(proof, 'each sibling namespace proof points to its original native derive');
                assert.ok(original(sample).split('\n')[proof.line - 1].includes(derive.name));
            }
        }
        for (const route of conditional) assert.ok(route.conditions.some(gap => gap.includes('Rocket query/body conversion')), 'native form-query success remains unqualified');
        if (sample.framework === 'warp') {
            const prior = before.routerSamples.find(route => !route.conditions.length);
            assert.equal(qualified[0].handler[0].id, prior.handler[0].id, 'unchanged original Warp callback identity');
            assert.equal(qualified[0].methods, '*', 'an informal GET comment cannot add a source method filter');
        }
        results.push({ sample, pin: pins[sample.pin], url: `https://github.com/${pins[sample.pin].repository}/blob/${pins[sample.pin].commit}/${sample.file}`, before: { qualifiedEndpoints: before.qualifiedRouterEndpoints, originalHandlers: before.originalHandlerEdges, selectedDeclarations: before.selectedDeclarations.length, graphFingerprint: before.graphFingerprint }, review: { declarations: sample.declarations.length, functions: sample.declarations.filter(declaration => declaration[1] === 'function').length, closures: sample.declarations.filter(declaration => declaration[1] === 'closure').length, sourceRoutes: sample.routes.length + (sample.outsideRoutes ?? 0), supportedRoutes: expected.length, confirmedRoutes: qualified.length, conditionalRoutes: conditional.length, outsideProfileRoutes: sample.outsideRoutes ?? 0, originalHandlerPairs: evidence.originalHandlerEdges, falsePositiveRoutes: 0, missedSupportedRoutes: 0, generalCalls: evidence.sourceCallSamples.length, generalCallWinners: 0 }, evidence });
    }
    assert.equal(results[1].evidence.trackedBlobDigest, results[2].evidence.trackedBlobDigest, 'both benchmark selections use the complete same original tree');
    const digest = createHash('sha256'), implementationFiles = git(project, ['ls-files', '-co', '--exclude-standard', '-z', 'src', 'grammars', 'package.json', 'package-lock.json']).toString().split('\0').filter(Boolean).sort();
    implementationFiles.push('scripts/qualify-rust-source.mjs', 'scripts/qualify-rust-consumers.mjs', 'scripts/fixtures/rust-consumer-portfolio.mjs');
    for (const file of implementationFiles) digest.update(file + '\0').update(await readFile(path.join(project, file))).update('\0');
    const sum = key => results.reduce((total, result) => total + result.review[key], 0);
    const data = { phase: 'P9e2b2a', measuredAt: new Date().toISOString(), node: process.version, platform: `${process.platform}/${process.arch}`, pins, baselineCommit, implementationHead: git(project, ['rev-parse', 'HEAD']).toString().trim(), implementationDigest: digest.digest('hex'), counts: Object.fromEntries(['declarations', 'functions', 'closures', 'sourceRoutes', 'supportedRoutes', 'confirmedRoutes', 'conditionalRoutes', 'outsideProfileRoutes', 'originalHandlerPairs', 'falsePositiveRoutes', 'missedSupportedRoutes', 'generalCalls', 'generalCallWinners'].map(key => [key, sum(key)])), results };
    const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const rows = results.map(({ sample, url, before, review, evidence: e }) => `<tr><th><a href="${esc(url)}">${esc(sample.name)}</a><small>${esc(sample.manifest)} · original bin ${esc(sample.target)}</small></th><td>${review.declarations}</td><td>${review.sourceRoutes}</td><td>${before.qualifiedEndpoints} → ${review.confirmedRoutes}/${review.supportedRoutes}</td><td>${review.conditionalRoutes} conditional, ${review.outsideProfileRoutes} legacy</td><td>${e.cacheHits['rust-imports']}/${e.cacheHits['rust-symbols']}/${e.cacheHits['rust-routers']}</td></tr>`).join('');
    const boundaries = results.map(({ sample }) => `<li><strong>${esc(sample.name)}:</strong> ${esc(sample.boundary)}</li>`).join('');
    const output = path.resolve(option('--output') ?? path.join(project, 'docs/rust-consumer-source-accuracy.html'));
    await writeFile(output, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rust consumer source accuracy · P9e2b2a</title><style>body{font:16px/1.6 system-ui,sans-serif;background:#101822;color:#e5ecf4;margin:0;padding:32px}main{max-width:1200px;margin:auto}h1{line-height:1.2}p{max-width:1050px;color:#bdcbdc}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;border-bottom:1px solid #344353;padding:12px;vertical-align:top}small{display:block;color:#9dafc4;font-weight:400}a,code{color:#79ced3}code{overflow-wrap:anywhere}.status{border:1px solid #5a7882;padding:16px;border-radius:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere}@media(max-width:600px){body{padding:18px}}</style><main><h1>Rust consumer source accuracy</h1><p>${esc(data.measuredAt)} · ${esc(data.node)} · ${esc(data.platform)} · P9e2b2a.</p><p class="status"><strong>Bounded consumer source PASS.</strong> The original Rocket 0.5 consumer improves from zero to three qualified routes and four original handler bindings. Warp 0.3 retains its all-method control. ${data.counts.confirmedRoutes}/${data.counts.supportedRoutes} supported route/handler pairs match; the complete source inventory contains ${data.counts.sourceRoutes} routes, including one conditional form query and one legacy Rocket route outside the reviewed profile. P9e2b2/P9/P10 remain open.</p><p>Both repositories retain every original tracked Rust, Cargo, lock and relevant ignore/configuration input: ${results[0].evidence.copiedFiles} inputs / ${results[0].evidence.files} Rust files for Rocket, ${results[1].evidence.copiedFiles} inputs / ${results[1].evidence.files} Rust files for the benchmark. No source or manifest is changed. Each profile selects its original package/bin, empty application features and disabled application defaults; dependency declarations/features remain original. The same audit adapter runs against archived ${baselineCommit.slice(0,8)} and the current implementation.</p><div class="scroll"><table><thead><tr><th>Unchanged original profile</th><th>Reviewed declarations</th><th>All source routes</th><th>Qualified before → current/supported</th><th>Retained boundary</th><th>Actual import/symbol/router cache hits</th></tr></thead><tbody>${rows}</tbody></table></div><h2>Independent inventory and source proof</h2><p>Manual source review accounts for all ${data.counts.declarations} selected declarations, ${data.counts.functions} original functions and one original closure; IDs and coordinates remain identical across implementations. No generated main, context or trait implementation is invented. All five supported/conditional handler bindings point to original declarations. Every Rocket endpoint carries FromFormField evidence at original line 5 and FromForm evidence at original line 14. Supported route precision and recall are 100% on this four-route sample, which does not establish production or population accuracy. These bins have zero active local module edges; no import-recall denominator is claimed.</p><p>All three profiles have exact cold/warm/revision graphs within each implementation and actual import, symbol and router cache hits. All ${data.counts.generalCalls} general source-call outcomes remain unsupported; generated entry bodies and original derived-type traits do not acquire general winners.</p><h2>Native contracts and boundaries</h2><p>Qualified path prefixes now select Rust's type namespace; direct functions use the value namespace and known framework macros use the macro namespace. An original function named rocket or get no longer masks the crate or attribute macro. Opaque imports still cannot lend an external namespace. The <a href="https://doc.rust-lang.org/reference/names/namespaces.html">Rust namespace reference</a> defines these separate source spaces.</p><p>Canonical Rocket 0.5 FromForm/FromFormField derives use <a href="https://github.com/rwf2/Rocket/blob/f53611f74f2c777b9d7ebb40f8ec3f8dadd0a6f6/core/codegen/src/derive/from_form.rs">native form codegen</a> and <a href="https://github.com/rwf2/Rocket/blob/f53611f74f2c777b9d7ebb40f8ec3f8dadd0a6f6/core/codegen/src/derive/from_form_field.rs">field codegen</a> with <a href="https://docs.rs/devise_core/0.4.2/src/devise_core/generator.rs.html">Devise's anonymous const wrapper</a>. Original <a href="https://github.com/rwf2/Rocket/blob/c20efb9a26968abb8c289f3e4af690c2e282c81e/core/codegen/src/derive/from_form.rs">Rocket 0.5.0 form codegen</a> and its original manifest also use Devise 0.4; the anonymous wrapper is unchanged in reviewed Devise 0.4.0–0.4.2 source. Bounded macro-free original struct/enum input can preserve only the containing-module namespace. Original derived types, generated guards and conversion behavior remain opaque. Unknown/composed derives or attributes, opaque inputs, renamed-only delegation, unavailable/fork identities and unsupported version/feature profiles retain gaps.</p><ul>${boundaries}</ul><h2>Reproduction and remaining qualification</h2><p>Run <code>node scripts/qualify-rust-consumers.mjs --rocket-consumer /path/to/rocket-rust-hello-world --web-benchmark /path/to/rust-web-frameworks-benchmark</code> at the pinned commits in the raw evidence. Only Codiluce's own Node/WASM source analysis runs; no Cargo/rustc, macro expansion, build script, target configuration, dependency or source code executes. Broader Axum 0.7, Warp 0.4 and real-consumer import/version accuracy remain P9e2b2b; native-platform and wider release qualification remain open. Implementation digest: <code>${data.implementationDigest}</code>. <a href="language-framework-compatibility.html#implementation">Roadmap</a>.</p><details><summary>Manual ground truth, immutable pins, source coordinates, baseline summaries and raw current evidence</summary><pre>${esc(JSON.stringify(data, null, 2))}</pre></details></main></html>`);
    console.log(JSON.stringify({ output, counts: data.counts, implementationDigest: data.implementationDigest }, null, 2));
} finally {
    await rm(temporary, { recursive: true, force: true });
}
