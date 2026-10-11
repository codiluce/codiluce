// Immutable original Shopify Dawn qualification. Parse-only; no Liquid/theme,
// target application/build/dependency or generated render/bundle runs.
// node --experimental-sqlite --import tsx scripts/qualify-liquid-source.mjs
// --source DIRECTORY is an offline mirror preserving these upstream paths.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {StructureParser} from '../src/analysis/tree-sitter/client.ts';
import {indexRepository} from '../src/pipeline/index.ts';
import {AnalysisCache} from '../src/pipeline/cache.ts';
import {canonicalJson} from '../src/history/fingerprint.ts';
import {SourceText} from '../src/analysis/source-map.ts';
const project=fileURLToPath(new URL('../',import.meta.url)),option=name=>{const at=process.argv.indexOf(name);return at<0?undefined:process.argv[at+1];};
const commit='258f00f64365e2018ca4c62778a6bf55a5d3cd18';
const inputs=[
 {
  "file": "layout/theme.liquid",
  "bytes": 22743,
  "sha256": "e4031baede898d36ea61915ffd0b4f35fbd902f8c39a0a58495935d90062e22e"
 },
 {
  "file": "layout/password.liquid",
  "bytes": 14289,
  "sha256": "0c6b5d2e59debf7d149c70a56a982f96a09a73f62ff79d1b23790163cfa83b93"
 },
 {
  "file": "sections/main-password-header.liquid",
  "bytes": 4561,
  "sha256": "35ba54dfec584eb5ffb8a9de0b6e29affa422497f31f0bfbeea7a0d0795f700e"
 },
 {
  "file": "sections/main-product.liquid",
  "bytes": 101760,
  "sha256": "1b85e8e50613a45ea04a6ce5d1a0f68997195f62f42e3e7a952faf2e448f52c9"
 },
 {
  "file": "sections/main-search.liquid",
  "bytes": 19786,
  "sha256": "06aa0ec1eb2961ba2b7e99df4a885b0ee63c801c4c25a09b1f11d558bf0f5927"
 },
 {
  "file": "snippets/share-button.liquid",
  "bytes": 2030,
  "sha256": "7d39bd7b653fdd2d23d93a8e4e121664b7304c1bd825858c1fd20f2d332771a9"
 },
 {
  "file": "snippets/price.liquid",
  "bytes": 5466,
  "sha256": "b989ae6324a3ace1abf0ff6a15c33c8ee0cf268df86b187807bd1c68249b1579"
 },
 {
  "file": "snippets/buy-buttons.liquid",
  "bytes": 5997,
  "sha256": "3a8f658b979919a8d8552966cdbaaee87390f79f8e88c7384bcf392f73fdea82"
 },
 {
  "file": "snippets/cart-drawer.liquid",
  "bytes": 30350,
  "sha256": "5ad3b512f1def512bf85380192d0bc8288d4b10c683571abc671975c7c89e652"
 },
 {
  "file": "sections/header.liquid",
  "bytes": 23966,
  "sha256": "90f2795204f2ed58a09380cae361ac9a6ec49580b456cbad72aef1612cf72f2d"
 }
];
// Independently reviewed original explicit class/constructor/method binders.
const reviewedNames=[['StickyHeader','class',330],['constructor','constructor',331],['connectedCallback','method',336],['setHeaderHeight','method',365],['disconnectedCallback','method',369],['createObserver','method',375],['onScroll','method',384],['hide','method',414],['reveal','method',421],['reset','method',427],['closeMenuDisclosure','method',432],['closeSearchModal','method',437]];
// Reviewed original dependency names/lines; comment/doc examples are excluded.
const reviewedImports={
 'layout/theme.liquid':[['render','meta-tags',29],['render','cart-drawer',330],['sections','header-group',333],['sections','footer-group',345]],
 'layout/password.liquid':[['render','meta-tags',22],['section','main-password-header',202],['section','main-password-footer',208]],
 'sections/main-password-header.liquid':[],
 'sections/main-product.liquid':[['render','product-media-gallery',80],['render',null,92],['render','price',111],['render','icon-accordion',218],['render','loading-spinner',257],['render','share-button',476],['render','product-disclosures',480],['render','product-variant-picker',489],['render','buy-buttons',495],['render','icon-accordion',562],['render','card-product',609],['render','icon-with-text',690],['render','product-media-modal',701]],
 'sections/main-search.liquid':[['render','loading-spinner',108],['render','loading-spinner',201],['render','facets',219],['render','card-product',275],['render','article-card',288],['render','pagination',324]],
 'snippets/share-button.liquid':[],
 'snippets/price.liquid':[['render','unit-price',112]],
 'snippets/buy-buttons.liquid':[['render','gift-card-recipient-form',60],['render','loading-spinner',94]],
 'snippets/cart-drawer.liquid':[['render','card-collection',59],['render','cart-disclosure-indicator',160],['render','loading-spinner',246],['render','unit-price',270]],
 'sections/header.liquid':[['render','header-drawer',175],['render','header-search',179],['render','header-dropdown-menu',219],['render','header-mega-menu',221],['render','country-localization',266],['render','language-localization',277],['render','header-search',283],['render',null,298],['render','cart-notification',323]],
};
/** Independent original delimiter inventory; it does not inspect native nodes,
 * production queries or facts. Opaque bodies are bounded by original end tags;
 * original quoted strings protect closing-delimiter-looking text in tag markup. */
function inventory(text){const result=[];let at=0;while(at<text.length){const tag=text.indexOf('{%',at),output=text.indexOf('{{',at),start=tag<0?output:output<0?tag:Math.min(tag,output);if(start<0)break;const kind=text.startsWith('{%',start)?'tag':'output',close=kind==='tag'?'%}':'}}';let quote,end;for(let i=start+2;i<text.length-1;i++){const c=text[i];if(quote){if(c===quote)quote=undefined;}else if(c==='"'||c==="'")quote=c;else if(text.startsWith(close,i)){end=i+2;break;}}assert.ok(end,'Unterminated original inventory delimiter');const body=text.slice(start+2,end-2).replace(/^-|-$/g,'').trim(),name=/^[a-z]+/.exec(body)?.[0];if(kind==='tag'&&['comment','doc','raw','javascript','stylesheet','schema'].includes(name)){const pattern=new RegExp('\\{%-?\\s*end'+name+'\\s*-?%}','g');pattern.lastIndex=end;const ending=pattern.exec(text);assert.ok(ending,'Unterminated original opaque block');end=ending.index+ending[0].length;result.push({kind:name,start,end});}else if(kind==='tag'&&body.startsWith('#'))result.push({kind:'comment',start,end});else result.push({kind,start,end});at=end;}return result;}
const parser=new StructureParser(),temporary=await mkdtemp(path.join(tmpdir(),'codiluce-liquid-audit-')),root=path.join(temporary,'originals');await mkdir(root);
try{
 const results=[];let reviewedRegions=0,matchedRegions=0,extraRegions=0;
 for(const input of inputs){const url=`https://raw.githubusercontent.com/Shopify/dawn/${commit}/${input.file}`,buffer=option('--source')?await readFile(path.join(path.resolve(option('--source')),input.file)):Buffer.from(await(await fetch(url,{signal:AbortSignal.timeout(30000)})).arrayBuffer());assert.equal(buffer.length,input.bytes,input.file);assert.equal(createHash('sha256').update(buffer).digest('hex'),input.sha256,input.file);const content=buffer.toString('utf8'),target=path.join(root,input.file);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,buffer);const facts=await parser.parse('liquid',content,{liquidHost:'html',liquidEngine:'shopify'}),names=facts.declarations.map(d=>[d.name,d.kind,d.range.startLine]),expectedNames=input.file==='sections/header.liquid'?reviewedNames:[];assert.deepEqual(names,expectedNames,input.file);assert.deepEqual(facts.liquid.imports.map(i=>[i.kind,i.specifier??null,i.range.startLine]),reviewedImports[input.file],input.file);
  for(const d of facts.declarations){assert.deepEqual(d.range,new SourceText(content).range(d.start,d.end));assert.equal(d.embeddedSource.language,'javascript');assert.equal(d.embeddedSource.executionContext,'browser');if(d.kind!=='class')assert.equal(d.parent,facts.declarations[0].key);const h=d.embeddedSource.headerRange;assert.ok(h.startLine>=329&&h.endLine<=459);}
  for(const r of facts.liquid.regions){assert.deepEqual(r.range,new SourceText(content).range(r.start,r.end));assert.deepEqual(r.bodyRange,new SourceText(content).range(r.bodyStart,r.bodyEnd));}
  const expected=inventory(content),actual=facts.liquid.regions.filter(r=>['tag','output','comment','doc','raw','javascript','stylesheet','schema'].includes(r.kind)).map(r=>({kind:r.kind,start:r.start,end:r.end})),key=r=>JSON.stringify([r.kind,r.start,r.end]),wanted=new Set(expected.map(key)),found=new Set(actual.map(key)),matched=expected.filter(r=>found.has(key(r))),missed=expected.filter(r=>!found.has(key(r))),extras=actual.filter(r=>!wanted.has(key(r)));reviewedRegions+=expected.length;matchedRegions+=matched.length;extraRegions+=extras.length;
  results.push({...input,url:`https://github.com/Shopify/dawn/blob/${commit}/${input.file}`,names,reviewedNames:expectedNames,imports:facts.liquid.imports,expectedImports:reviewedImports[input.file],regions:{reviewed:expected.length,matched:matched.length,inventory:expected,actual,missed,extras},status:facts.issues.length?'partial':'supported',issues:facts.issues,hostRegions:facts.liquid.host.regions,declarations:facts.declarations});
 }
 const state=path.join(temporary,'cache'),cold=await indexRepository(root,{cache:new AnalysisCache(state)}),cache=new AnalysisCache(state),warm=await indexRepository(root,{cache}),revision=await indexRepository(root,{revision:commit}),shape=g=>canonicalJson({entities:g.entities,relations:g.relations,diagnostics:g.diagnostics.filter(d=>!['git-metrics','indexer'].includes(d.analyzer)&&d.code!=='git-ignore-unavailable')});assert.equal(shape(cold),shape(warm));assert.equal(shape(cold),shape(revision));const cacheHits=cache.events.filter(e=>e.analyzer==='syntax-facts'&&e.hit).length;assert.equal(cacheHits,10);assert.equal(cold.entities.filter(e=>e.type==='component').length,10);assert.equal(cold.entities.filter(e=>e.metadata.embeddedSource).length,12);
 const edges=cold.relations.filter(r=>r.type==='imports');assert.deepEqual(edges.map(e=>[cold.entities.find(f=>f.id===e.from).path,cold.entities.find(f=>f.id===e.to).path]).sort(),[['layout/password.liquid','sections/main-password-header.liquid'],['layout/theme.liquid','snippets/cart-drawer.liquid']]);assert.ok(edges.every(e=>e.evidence.some(p=>p.source==='filesystem')));
 const summary={files:10,reviewedDeclarations:12,matchedDeclarations:12,reviewedImports:Object.values(reviewedImports).reduce((n,x)=>n+x.length,0),reviewedRegions,matchedRegions,missedRegions:reviewedRegions-matchedRegions,extraRegions,syntaxCacheHits:cacheHits,resolvedIndexedDependencies:edges.length};
 if(process.argv.includes('--check-only')){console.log(JSON.stringify(summary));}else{
 const files=execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard','--','src','grammars','package.json','package-lock.json','scripts/process-memory.mjs','scripts/build-liquid-grammar.mjs','scripts/qualify-liquid-source.mjs','scripts/test-package.mjs','tests/liquid-structure.test.ts','tests/indexed-sources.test.ts','tests/fixtures/structure/template.html.liquid','tests/fixtures/structure/liquid-theme'],{cwd:project,encoding:'utf8'}).split('\0').filter(Boolean).sort(),digest=createHash('sha256');for(const file of files)digest.update(file+'\0').update(await readFile(path.join(project,file))).update('\0');
 // Direct fresh processes retain independent runtime/load/native/JS timings.
 const startupCode=`import {processPeakRssKiB} from './scripts/process-memory.mjs';import {Parser,Language,Query} from 'web-tree-sitter';import {performance} from 'node:perf_hooks';import {readFileSync} from 'node:fs';import {extractLiquid,liquidHostProjection,extractLiquidBodyHosts,finishLiquid} from './src/analysis/tree-sitter/liquid-structure.ts';import {extractTemplateHost} from './src/analysis/tree-sitter/embedded-host.ts';import {extractLiteralScripts} from './src/analysis/tree-sitter/erb-script.ts';const content=readFileSync(process.argv[1],'utf8'),begin=performance.now();await Parser.init();const runtimeMs=performance.now()-begin,assets={};for(const name of ['liquid','html']){const begin=performance.now(),language=await Language.load('./grammars/tree-sitter-'+name+'.wasm');const parser=new Parser();parser.setLanguage(language);const query=new Query(language,readFileSync('./grammars/queries/'+name+'/declarations.scm','utf8'));assets[name]={parser,query,loadMs:performance.now()-begin};}const beginParse=performance.now(),tree=assets.liquid.parser.parse(content),facts=extractLiquid(tree.rootNode,assets.liquid.query,content,'html','shopify');let html;if(facts.liquid.nativeComplete&&!facts.truncated){html=assets.html.parser.parse(liquidHostProjection(content,facts));extractTemplateHost(html.rootNode,assets.html.query,content,facts,'liquid');}extractLiquidBodyHosts(content,facts);const nativeExtractionMs=performance.now()-beginParse;let javascriptLoadMs=0,javascriptExtractionMs=0;if(facts.liquid.host.regions.some(r=>r.kind==='script'&&r.supported)){const begin=performance.now(),compiler=(await import('typescript')).default;javascriptLoadMs=performance.now()-begin;const beginParse=performance.now();extractLiteralScripts(compiler,content,facts,'liquid');javascriptExtractionMs=performance.now()-beginParse;}finishLiquid(facts);if(facts.declarations.length!==Number(process.argv[2]))throw Error('Original declaration count differs');console.log(JSON.stringify({runtimeMs,liquidLoadMs:assets.liquid.loadMs,htmlLoadMs:assets.html.loadMs,nativeExtractionMs,javascriptLoadMs,javascriptExtractionMs,firstExtractionMs:nativeExtractionMs+javascriptExtractionMs,peakRssKiB:processPeakRssKiB()}));tree.delete();html?.delete();for(const entry of Object.values(assets)){entry.query.delete();entry.parser.delete();}`;
 const profiles=[];for(const [sourceFile,expected,label]of [[path.join(root,'snippets/price.liquid'),0,'Immutable original Dawn price source regions'],[path.join(root,'sections/header.liquid'),12,'Immutable original Dawn StickyHeader JavaScript body']]){const runs=Array.from({length:3},()=>JSON.parse(execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',startupCode,sourceFile,String(expected)],{cwd:project,encoding:'utf8',timeout:30000}))),median=key=>runs.map(r=>r[key]).sort((a,b)=>a-b)[1];profiles.push({label,repetitions:3,median:Object.fromEntries(Object.keys(runs[0]).map(key=>[key,median(key)])),runs});}
 const data={phase:'P10b4c3',measuredAt:new Date().toISOString(),baseline:'0423d2f',node:process.version,platform:process.platform+'/'+process.arch,memoryMethod:'linux-proc-vmhwm',implementationDigest:digest.digest('hex'),implementationFiles:files.length,...summary,coldWarmEqual:true,revisionModeEqual:true,startup:{profiles},results};
 const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),rows=results.map(r=>`<tr><td><a href="${esc(r.url)}">${esc(r.file)}</a></td><td>${r.names.length}/${r.reviewedNames.length}</td><td>${r.imports.length}/${r.expectedImports.length}</td><td>${r.regions.matched}/${r.regions.reviewed}</td><td>${r.status}</td></tr>`).join('');
 const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Liquid original source qualification</title><style>body{font:16px/1.6 system-ui,sans-serif;background:#101822;color:#e5ecf4;margin:0;padding:clamp(16px,4vw,48px)}main{max-width:1120px;margin:auto}p,code{overflow-wrap:anywhere}h1{font-size:clamp(28px,5vw,42px);line-height:1.2}a,code{color:#8bddd8}table{border-collapse:collapse;width:100%;min-width:720px}th,td{padding:12px;text-align:left;border-bottom:1px solid #344353;overflow-wrap:anywhere}th{overflow-wrap:normal}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}.scroll{overflow:auto}.status{padding:18px;border:1px solid #b69459;border-radius:8px}summary{cursor:pointer;padding:12px 0}</style></head><body><main><h1>Liquid original source qualification</h1><p>P10b4c3 · ${esc(data.measuredAt)} · ${esc(data.node)} · ${esc(data.platform)}. Ten immutable original Shopify Dawn files, byte counts/SHA-256 pinned to one original commit. Reviewed names, kinds, source lines and dependencies are independent of production facts.</p><p class="status"><strong>12/12 original StickyHeader declarations · 0 misses · 0 extras</strong><br>${summary.reviewedImports}/${summary.reviewedImports} reviewed source dependency sites, including two unsupported app-block render sites and two section-group sites. Original delimiter inventory: ${matchedRegions}/${reviewedRegions} matches, ${reviewedRegions-matchedRegions} misses, ${extraRegions} extras. Recovery and engine gaps remain explicit.</p><div class="scroll"><table><thead><tr><th>Immutable original source</th><th>JS binders</th><th>Dependency sites</th><th>Original delimiters</th><th>Structure</th></tr></thead><tbody>${rows}</tbody></table></div><p>One canonical original template identity per file, twelve exact UTF-16 declaration/ownership/header proofs and ten actual syntax-cache hits preserve cold/warm/revision graphs. Only two dependencies have eligible indexed targets in this deliberately partial portfolio; both resolve with original syntax and same-application filesystem evidence. Missing targets do not trigger disk search or dependency installation. Original source text is parsed; no Liquid engine, target app, theme compiler, rendered output or generated bundle executes.</p><p>The supported profile retains native tags, output, controls, comments, raw content, multiline Liquid tags, variable binder metadata and Shopify body regions. Raw bodies use original native delimiter hulls because scanner content offsets can be empty. Shopify JavaScript bodies preserve their literal original text, class/constructor/method/function/binding source, independent of unrelated native recovery. Interpolated style output, app-block render syntax, a multiline loop modifier, custom tags, ambiguous native literal opening markers, recovered owners, nested raw-engine disagreement, doc-body grammar recovery, external/data/typed/control-dependent/interpolated scripts, non-HTML asset processors and unknown engines remain gaps. Assignment variables are metadata; no template functions, generated render helpers or virtual graph files are invented.</p><p><a href="https://shopify.dev/docs/storefronts/themes/architecture">Shopify's original theme directory contract</a> qualifies one indexed/configured <code>shopify-theme</code> boundary. Explicit original quoted <a href="https://shopify.dev/docs/api/liquid/tags/render">render</a>/<a href="https://shopify.dev/docs/api/liquid/tags/include">include</a>/<a href="https://shopify.dev/docs/api/liquid/tags/section">section</a>/<a href="https://shopify.dev/docs/api/liquid/tags/layout">layout</a> dependency sites map to original snippets/sections/layout files. Paths, app blocks, JSON section-group expansion, implicit layouts, dynamic filenames, Jekyll include/include_relative, scope/parameter binding, arbitrary engine lookup and rendered/runtime equivalence remain unqualified. <a href="https://shopify.dev/docs/api/liquid/tags/javascript">Shopify JavaScript</a> is not Liquid-rendered; section/block/snippet location evidence is required. <a href="https://shopify.dev/docs/api/liquid/tags/raw">Raw</a> and <a href="https://shopify.dev/docs/api/liquid/tags/doc">doc</a> body boundaries protect literal/non-rendered source. This narrow single-theme portfolio does not establish broad Liquid or framework accuracy.</p><p><a href="https://github.com/hankthetank27/tree-sitter-liquid/tree/e45dbac8c5fa95b1f0e00e7e0c04bc8855823391">Pinned community Liquid grammar 0.1.0</a>, ABI 14, 136,087-byte WASM, SHA-256 <code>b5c08a0d17c21457141647595ffee1c028dd31179557e6472bd6e20b08ae37a8</code>. Two isolated generated-C/scanner builds reproduce identical bytes with checksum-pinned CLI 0.26.9/WASI SDK 29.0/container tools. The original MIT notice ships. Twenty assets verify offline; ordinary build/index needs neither downloads nor upstream npm hooks/grammar-generation JavaScript.</p><h2>Fresh direct parser observations</h2>${profiles.map(p=>`<p><strong>${esc(p.label)}</strong><br>Three fresh processes: median runtime initialization ${p.median.runtimeMs.toFixed(1)} ms; Liquid/HTML grammar-and-query loads ${p.median.liquidLoadMs.toFixed(1)}/${p.median.htmlLoadMs.toFixed(1)} ms; native extraction ${p.median.nativeExtractionMs.toFixed(1)} ms; JavaScript load/extraction ${p.median.javascriptLoadMs.toFixed(1)}/${p.median.javascriptExtractionMs.toFixed(1)} ms; combined first extraction excluding loads ${p.median.firstExtractionMs.toFixed(1)} ms; Linux process-image peak ${(p.median.peakRssKiB/1024).toFixed(1)} MiB.</p>`).join('')}<p>Linux /proc VmHWM covers one process image since exec; IPC/process-tree, mixed-history and native Windows/macOS remain full P10 release gates. Other project validation is idle during measurement. Existing-stack guardrails use the separate <a href="liquid-compatibility-performance.html">five-repeat comparison against 0423d2f</a>. Conformance and production-package gates are recorded in the <a href="language-framework-compatibility.html#implementation">roadmap</a>.</p><p>Implementation digest (${files.length} source/asset/pin/build/audit/memory/package/conformance files): <code>${data.implementationDigest}</code>. Reproduce <code>node --experimental-sqlite --import tsx scripts/qualify-liquid-source.mjs --output docs/liquid-source-accuracy.html</code>; <code>--source DIRECTORY</code> verifies these immutable paths offline.</p><details><summary>Independent inventories, source proofs, misses/extras, gaps, hashes and startup measurements</summary><pre>${esc(JSON.stringify(data,null,2))}</pre></details></main></body></html>`;
 await writeFile(path.resolve(option('--output')??'docs/liquid-source-accuracy.html'),html);console.log(JSON.stringify({...summary,implementationDigest:data.implementationDigest,implementationFiles:files.length,startup:data.startup},null,2));
 }
}finally{parser.close();await rm(temporary,{recursive:true,force:true});}
