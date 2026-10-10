// Full original-source denominators; this audit exposes the still-open gate.
// Only Codiluce's own Node/WASM analysis runs. No target tools or code execute.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parse as parseToml } from 'smol-toml';
import { rustBroaderConsumers, rustDeriveConsumers, rustWarpExtractionConsumers, rustWarpWrapperConsumers } from './fixtures/rust-broader-consumer-portfolio.mjs';

const project=fileURLToPath(new URL('../',import.meta.url)), args=process.argv.slice(2);
const option=name=>args.includes(name)?args[args.indexOf(name)+1]:undefined;
const wrapperPhase=args.includes('--wrappers'),statePhase=wrapperPhase||args.includes('--state'), derivePhase=statePhase||args.includes('--derive'), portfolio=wrapperPhase?rustWarpWrapperConsumers:statePhase?rustWarpExtractionConsumers:derivePhase?rustDeriveConsumers:rustBroaderConsumers, phase=wrapperPhase?'P9e2b2b2c1':statePhase?'P9e2b2b2b':derivePhase?'P9e2b2b2a':'P9e2b2b1';
const git=(cwd,params)=>execFileSync('git',params,{cwd,maxBuffer:64<<20});
const run=promisify(execFile), sorted=values=>values.sort((a,b)=>a.localeCompare(b,'en'));
const baselineCommit=git(project,['rev-parse','--verify',`${option('--baseline-ref')??(wrapperPhase?'cf34dba':statePhase?'4174da3':derivePhase?'e9eb724':'6a44ca3')}^{commit}`]).toString().trim();
const temporary=await mkdtemp(path.join(tmpdir(),'codiluce-rust-broader-'));
const key=route=>JSON.stringify([route.routePath,route.methods]);
try {
    const baseline=path.join(temporary,'baseline'); await mkdir(baseline);
    await writeFile(path.join(temporary,'baseline.tar'),git(project,['archive',baselineCommit]));
    execFileSync('tar',['-xf',path.join(temporary,'baseline.tar'),'-C',baseline]);
    await symlink(path.join(project,'node_modules'),path.join(baseline,'node_modules'));
    await writeFile(path.join(baseline,'scripts/qualify-rust-source.mjs'),await readFile(path.join(project,'scripts/qualify-rust-source.mjs')));
    const results=[];
    for(const sample of portfolio){
        assert.ok(option('--'+sample.key),'pinned --'+sample.key+' checkout required');
        const source=path.resolve(option('--'+sample.key));
        const blob=file=>git(source,['cat-file','blob',`${sample.commit}:${file}`]).toString('utf8');
        const manifest=parseToml(blob('Cargo.toml'));
        assert.equal(manifest.package.name,sample.target);assert.equal(manifest.package.edition,sample.edition);
        assert.deepEqual(JSON.parse(JSON.stringify(manifest.dependencies[sample.framework])),sample.requirement,'unchanged original dependency/features');
        for(const route of sample.routes){
            assert.ok(blob(route.file).split('\n')[route.line-1].includes(sample.framework==='axum'?'.route(':sample.key==='warp-placey'?(route.line===8?'warp::get()':'warp::path!'):'warp::'),'manual original registration site');
            const declaration=blob(route.handlerFile).split('\n')[route.handlerLine-1];
            assert.ok(route.handler==='<closure>'?declaration.includes('|'):declaration.includes('fn '+route.handler),'manual original callback');
        }
        for(const item of sample.modules)assert.ok(blob(item.file).split('\n')[item.line-1].includes('mod '+item.name+';'),'manual original module declaration');
        for(const service of sample.services)assert.ok(blob(service.file).split('\n')[service.line-1].includes(sample.framework==='axum'?'nest_service':'warp::fs::dir'),'separate original static service');
        const inputs={applications:[{name:'sample',path:'.',rust:{package:'Cargo.toml',target:{kind:'bin',name:sample.target},features:[],defaultFeatures:false}}]};
        const qualify=async implementation=>JSON.parse((await run(process.execPath,['--experimental-sqlite','--import','tsx',path.join(implementation,'scripts/qualify-rust-source.mjs'),'--source',source,'--commit',sample.commit,'--inputs',JSON.stringify(inputs),'--details'],{cwd:implementation,timeout:300000,maxBuffer:64<<20})).stdout);
        console.log('Qualifying '+sample.key);
        const before=await qualify(baseline), evidence=await qualify(project);
        assert.equal(evidence.trackedBlobDigest,before.trackedBlobDigest,'identical original tracked inputs');
        assert.equal(evidence.compilationCount,sample.compilations);
        assert.deepEqual(sorted([...evidence.selectedFiles]),sorted([...sample.selectedFiles]),'complete original selected module files');
        assert.deepEqual(evidence.selectedDeclarations,before.selectedDeclarations,'all original IDs/ranges remain stable');
        assert.ok(evidence.cacheEqual&&evidence.revisionEqual);
        for(const analyzer of ['rust-imports','rust-symbols','rust-routers'])assert.ok(evidence.cacheHits[analyzer]);
        const moduleKey=item=>JSON.stringify([item.file,item.range?.startLine??item.line,item.specifier??item.name,item.status]);
        const modules=[...new Set(evidence.importDetails.filter(item=>item.kind==='module').map(moduleKey))];
        assert.deepEqual(sorted(modules),sorted(sample.modules.map(moduleKey)),'full manual module-declaration denominator, including unresolved sites');
        const explicit=evidence.routerSamples.filter(route=>route.registration==='explicit');
        const registrations=sample.routes.filter(route=>route.status!=='missing');
        assert.deepEqual(sorted(explicit.map(key)),sorted(registrations.map(route=>key({routePath:route.path,methods:route.methods}))),'exact manual emitted path/method set; no automatic fallback in recall');
        for(const route of explicit){
            const expected=registrations.find(item=>key(route)===key({routePath:item.path,methods:item.methods}));
            assert.equal(route.dialect,sample.dialect);
            assert.equal(route.path,expected.file);
            if(expected.registrationStartLine!==undefined){assert.equal(route.range.startLine,expected.registrationStartLine);assert.ok(blob(expected.file).split('\n')[expected.mappingLine-1].includes('.map('));assert.ok(route.proof.some(fact=>fact.file===expected.file&&fact.line===expected.line),'original filter-construction site proof');}
            else assert.ok(route.range.startLine>=expected.line&&route.range.startLine<=expected.line+6,'original registration range');
            if(expected.status==='unbound'){assert.equal(route.handler.length,0);assert.ok(route.conditions.length);continue;}
            assert.equal(route.handler.length,1);const handler=route.handler[0];
            assert.equal(handler.path,expected.handlerFile);assert.equal(handler.name,expected.handler);assert.equal(handler.range.startLine,expected.handlerLine);
            assert.equal(route.conditions.length===0,expected.status==='qualified');
            assert.ok(evidence.selectedDeclarations.some(item=>item.id===handler.id&&item.path===handler.path));
        }
        const review={sourceRoutes:sample.routes.length,qualifiedPairs:explicit.filter(route=>!route.conditions.length&&route.handler.length===1).length,conditionalPairs:explicit.filter(route=>route.conditions.length&&route.handler.length===1).length,unboundRegistrations:explicit.filter(route=>!route.handler.length).length,missingRegistrations:sample.routes.length-explicit.length,automaticCandidates:evidence.routerSamples.length-explicit.length,sourceModules:sample.modules.length,resolvedModules:sample.modules.filter(item=>item.status==='resolved').length,staticServices:sample.services.length};
        assert.equal(review.qualifiedPairs,sample.routes.filter(route=>route.status==='qualified').length);
        assert.equal(before.routerSamples.filter(route=>route.registration==='explicit'&&!route.conditions.length&&route.handler.length===1).length,review.qualifiedPairs,'broader controls remain unchanged; no invented improvement');
        if(derivePhase&&sample.key==='warp-qa'){
            assert.equal(before.originalHandlerEdges,statePhase?5:0,'original baseline Q&A callback denominator');
            assert.equal(evidence.originalHandlerEdges,5,'all five original Q&A callbacks bind conditionally');
            for(const route of explicit){
                assert.ok(route.proof.some(fact=>fact.file==='Cargo.lock'&&fact.line===486&&fact.explanation?.includes('serde_derive 1.0.228')),'owning original lock provider proof');
                assert.ok(route.proof.some(fact=>fact.file==='src/main.rs'&&fact.explanation?.includes('serde::Deserialize derive')),'original derive site proof');
            }
            if(statePhase){
                assert.equal(before.extractionSamples.length,wrapperPhase?5:0);assert.equal(evidence.extractionSamples.length,5,'one original state callback reference for each original endpoint');
                const expected=sample.extractions[0];assert.ok(blob(expected.file).split('\n')[expected.line-1].includes('warp::any().map(move || store.clone())'),'manual original extraction source');
                for(const item of evidence.extractionSamples){assert.equal(item.source.file,expected.file);assert.equal(item.source.line,expected.line);assert.equal(item.callback.path,expected.file);assert.equal(item.callback.range.startLine,expected.callbackLine);}
                for(const route of explicit){assert.ok(!route.conditions.some(gap=>gap.includes('Multiple Warp mapper stages')||gap.includes('callback extraction arity')),'native state/deserializer slot order is retained');assert.ok(route.conditions.some(gap=>gap.includes('Clone/Send')));}
            }
        }
        if(wrapperPhase&&sample.key==='warp-placey'){
            assert.equal(before.originalHandlerEdges,0);assert.equal(evidence.originalHandlerEdges,5);
            assert.ok(blob(sample.instrument.file).split('\n')[sample.instrument.line-1].includes('#[tracing::instrument]'));
            for(const route of explicit){
                assert.ok(route.conditions.some(gap=>gap.includes('Generated tracing instrument')));
                assert.ok(route.conditions.some(gap=>gap.includes('subscriber effects')));
                assert.ok(route.proof.some(fact=>fact.file==='Cargo.lock'&&fact.line===sample.instrument.providerLine&&fact.explanation?.includes('tracing-attributes 0.1.31')));
                assert.ok(route.proof.some(fact=>fact.file==='Cargo.lock'&&fact.line===sample.instrument.testProviderLine&&fact.explanation?.includes('tokio-macros 2.7.0')));
                assert.ok(route.proof.some(fact=>fact.file===sample.instrument.file&&fact.line===sample.instrument.line&&fact.explanation?.includes('instrument on outer')));
                for(const site of sample.wrapperSites){assert.ok(blob(site.file).split('\n')[site.line-1].includes(site.kind==='log'?'warp::log':'warp::trace::request'));assert.ok(route.proof.some(fact=>fact.file===site.file&&fact.line===site.line&&fact.explanation?.includes('wrapper constructor')));}
                assert.ok(route.proof.some(fact=>fact.explanation?.includes('recorded test=false')));
            }
        }
        results.push({sample,review,before:{graphFingerprint:before.graphFingerprint,imports:before.imports,explicitRegistrations:before.declaredRouterEndpoints,qualifiedPairs:review.qualifiedPairs,originalHandlers:before.originalHandlerEdges},evidence});
        console.log(JSON.stringify({profile:sample.key,...review}));
    }
    const counts=Object.fromEntries(Object.keys(results[0].review).map(key=>[key,results.reduce((total,result)=>total+result.review[key],0)]));
    const digest=createHash('sha256');
    const files=git(project,['ls-files','-co','--exclude-standard','-z','src','grammars','package.json','package-lock.json']).toString().split('\0').filter(Boolean).sort();
    files.push('scripts/qualify-rust-source.mjs','scripts/qualify-rust-broader-consumers.mjs','scripts/fixtures/rust-broader-consumer-portfolio.mjs');
    for(const file of files)digest.update(file+'\0').update(await readFile(path.join(project,file))).update('\0');
    const data={phase,measuredAt:new Date().toISOString(),node:process.version,platform:process.platform+'/'+process.arch,baselineCommit,implementationHead:git(project,['rev-parse','HEAD']).toString().trim(),implementationDigest:digest.digest('hex'),counts,results};
    const esc=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
    const rows=results.map(({sample:s,review:r})=>`<tr><th><a href="https://github.com/${esc(s.repository)}/tree/${s.commit}">${esc(s.key)}</a><small>${esc(s.target)} · edition ${s.edition}</small></th><td>${r.sourceRoutes}</td><td>${r.qualifiedPairs}</td><td>${r.conditionalPairs}</td><td>${r.unboundRegistrations}</td><td>${r.missingRegistrations}</td><td>${r.resolvedModules}/${r.sourceModules}</td></tr>`).join('');
    const emptyContract='<p>Canonical empty standard print macros preserve bounded namespace/diagnostic contracts. Source or unavailable shadows, opaque arguments and generated bodies remain unreviewed. Resolver/import version 5 and router version 8 defined the original diagnostic phase.</p>';
    const deriveContract='<p>Canonical builtin derive macro identities and recorded Serde Serialize/Deserialize providers preserve the containing namespace. Original Cargo.lock dependency edges select only reviewed serde_derive versions 1.0.169, 1.0.203, 1.0.219 or 1.0.228, paired with the canonical Serde runtime at the same recorded version. Missing, ambiguous, old, unrelated, noncanonical or denied lock selections retain gaps. <a href="https://github.com/serde-rs/serde/blob/v1.0.228/serde_derive/src/dummy.rs">Modern native Serde codegen</a> emits an anonymous constant wrapper; <a href="https://github.com/serde-rs/serde/blob/v1.0.152/serde_derive/src/dummy.rs">older codegen</a> can emit a named helper constant. Therefore a broad Cargo version requirement alone cannot borrow the modern contract. <a href="https://doc.rust-lang.org/reference/attributes/derive.html">Derives resolve macro identities</a>; builtin-looking source/import shadows stay opaque. No generated implementations, trait conversions or original derived type validity are certified, including macros aliased to builtin spellings. The original Q&amp;A improves from zero to five conditional callback bindings; all four qualified controls remain unchanged. Resolver/import contracts are version 6 and routers version 9.</p>';
    const stateContract='<p>Native Warp map/then/and_then outputs become deferred single extraction stages when consumed by a later mapper. Only the final source response callback owns an HTTP handler; earlier original callbacks carry extraction references and source coordinates, with no invented direct calls or execution. Query, JSON and form filters supply one ordered slot while deserialization, Send and request predicates remain unreviewed. Original function items and closed capture-free or moved scalar-literal closures supply the bounded mapper Clone/Send contract; mutable, borrowed, macro-bearing and unknown captures retain gaps. Boxed filters expose native Arc-backed Clone independently of Copy. Literal IPv4 and eight-segment IPv6 address/port bounds are reviewed in awaited source serving chains. A final mapped bool/integer from the reviewed guard set or an unawaited Future cannot qualify as a native Reply; broader Reply/type inference remains unreviewed. <a href="https://github.com/seanmonstar/warp/blob/v0.4.2/src/filter/map.rs">Native map output and callback bounds</a>, <a href="https://github.com/seanmonstar/warp/blob/v0.4.2/src/filter/then.rs">then output</a>, <a href="https://github.com/seanmonstar/warp/blob/v0.4.2/src/filter/and_then.rs">fallible output</a>, <a href="https://github.com/seanmonstar/warp/blob/v0.4.2/src/filter/boxed.rs">boxed Clone</a>, <a href="https://github.com/seanmonstar/warp/blob/v0.4.2/src/filters/body.rs">body slots</a> and <a href="https://github.com/seanmonstar/warp/blob/v0.4.2/src/filters/query.rs">query slots</a> are read without running target code. The unchanged Q&amp;A now retains all five original state extraction references and proves callback slot counts; its callbacks remain conditional. Four qualified controls, 14 conditional pairs and 11 misses are unchanged. Rust router version is 10; import/resolver versions remain 6.</p>';
    const wrapperContract='<p>Recorded tracing-attributes 0.1.31 with canonical tracing 0.1.44 preserves parameter-free original helper signatures and body reachability under the native empty instrument attribute. Original Cargo.lock owning dependency paths, feature activation and the generated canonical runtime delegate are required. Fields, parameters, const/generic functions, composed wrappers, unavailable providers and renamed-only runtimes remain outside this contract. Generated spans/subscribers retain conditions and general Rust calls stay opaque. Default Warp log and trace::request wrappers preserve original callback ownership, native path/method rejection and input Error while yielding one Logged/Traced Reply; native Reply/Send/Clone/IsReject and subscriber effects remain unreviewed. Recorded tokio-macros 2.7.0 with Tokio 1.53.1 emits a standard test attribute, allowing valid parameter-free unit-returning test functions to be excluded only from the recorded non-test compilation. Literal include_str supplies namespace-only proof without reading included contents. <a href="https://github.com/tokio-rs/tracing/blob/tracing-attributes-0.1.31/tracing-attributes/src/expand.rs">Native instrumentation</a>, <a href="https://github.com/tokio-rs/tokio/blob/tokio-1.53.1/tokio-macros/src/entry.rs">Tokio test codegen</a>, <a href="https://doc.rust-lang.org/reference/attributes/testing.html">standard test selection</a>, <a href="https://github.com/seanmonstar/warp/blob/v0.4.2/src/filters/log.rs">Warp log</a>, <a href="https://github.com/seanmonstar/warp/blob/v0.4.2/src/filters/trace.rs">Warp trace</a> and <a href="https://doc.rust-lang.org/std/macro.include_str.html">literal included text</a> are read without target execution. All five original placey callbacks now bind conditionally; Q&amp;A extraction references and all four qualified controls remain unchanged. The full 29-route denominator has four qualified pairs, 19 conditional bindings and six misses. Rust router version is 11; general import/resolver versions remain 6.</p>';
    const title=wrapperPhase?'Warp wrapper and serving delegation source accuracy':statePhase?'Warp extraction and serving source accuracy':derivePhase?'Rust derive namespace accuracy':'Broader Rust consumer accuracy';
    const output=path.resolve(option('--output')??path.join(project,wrapperPhase?'docs/warp-wrapper-source-accuracy.html':statePhase?'docs/warp-extraction-source-accuracy.html':derivePhase?'docs/rust-derive-source-accuracy.html':'docs/rust-broader-consumer-accuracy.html'));
    await writeFile(output,`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:16px/1.6 system-ui,sans-serif;background:#101822;color:#e5ecf4;margin:0;padding:32px}main{max-width:1200px;margin:auto}h1{line-height:1.2}p{color:#bdcbdc}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;border-bottom:1px solid #344353;padding:12px;vertical-align:top}small{display:block;color:#9dafc4;font-weight:400}a,code{color:#79ced3}code,pre{overflow-wrap:anywhere}pre{white-space:pre-wrap}.status{border:1px solid #c59265;padding:16px;border-radius:8px}@media(max-width:600px){body{padding:18px}}</style><main><h1>${title}</h1><p>${esc(data.measuredAt)} · ${esc(data.node)} · ${esc(data.platform)} · ${phase}.</p><p class="status"><strong>Broader accuracy gate remains OPEN.</strong> ${counts.qualifiedPairs}/${counts.sourceRoutes} original route/handler pairs qualify. ${counts.conditionalPairs} original handlers bind conditionally, ${counts.unboundRegistrations} registrations have no handler winner, and ${counts.missingRegistrations} source registrations are missed. These are full manual source denominators, not a production accuracy certification.</p><div class="scroll"><table><thead><tr><th>Unchanged original profile</th><th>All user routes</th><th>Qualified pairs</th><th>Conditional pairs</th><th>Unbound registrations</th><th>Missed registrations</th><th>Resolved modules/all</th></tr></thead><tbody>${rows}</tbody></table></div><h2>What the audit proves</h2><p>Original Axum 0.7.4/0.7 and Warp 0.4/0.4.2 dependency declarations, server features, Rust editions, selected bins and library compilation contexts remain unchanged. All tracked Rust/Cargo/lock/ignore/configuration inputs are copied from immutable Git blobs. The same adapter compares archived ${baselineCommit.slice(0,8)} with current source; the four qualified controls are unchanged. Every selected declaration retains its original baseline ID and coordinates. Cold, warm and revision graphs match within each implementation with actual import/symbol/router cache hits.</p><p>The module denominator covers all ${counts.sourceModules} original module declarations in the selected files; ${counts.resolvedModules} resolves, while the others retain generation gaps. It does not measure all use/re-export imports. Framework-only original handler proof cannot certify general import or call binding. ${counts.automaticCandidates} automatic fallback candidates are excluded from the user registration denominator. ${counts.staticServices} original static-service registrations are inventoried separately because their file-serving contracts are unreviewed. Query/body conversion, application execution, compiler validity, runtime behavior and population recall are unqualified.</p><h2>Implemented source contract</h2>${wrapperPhase?wrapperContract:statePhase?stateContract:derivePhase?deriveContract:emptyContract}<h2>Recorded boundaries and next implementation</h2><ul>${results.map(({sample})=>`<li><strong>${esc(sample.key)}:</strong> ${esc(sample.boundary)}</li>`).join('')}</ul><p>Next: address remaining Warp custom state/CORS/recovery and Axum helper/middleware contracts, then rerun this complete denominator. Broad P9/P10 accuracy and native platform checks remain open.</p><h2>Reproduce</h2><p>Clone the immutable repositories listed below, then run <code>node scripts/qualify-rust-broader-consumers.mjs ${wrapperPhase?'--wrappers ':statePhase?'--state ':derivePhase?'--derive ':''}--axum-plus /path/to/plus --axum-course /path/to/course --warp-placey /path/to/placey --warp-qa /path/to/qa</code> with each checkout at its recorded commit. No Cargo/rustc, macro expansion, target configuration, build script, dependency or application code executes. Implementation digest: <code>${data.implementationDigest}</code>. <a href="language-framework-compatibility.html#implementation">Roadmap</a>.</p><details><summary>Independent manual source inventory, pins, complete import outcomes and raw original proof</summary><pre>${esc(JSON.stringify(data,null,2))}</pre></details></main></html>`);
    console.log(JSON.stringify({output,counts,implementationDigest:data.implementationDigest}));
} finally {await rm(temporary,{recursive:true,force:true});}
