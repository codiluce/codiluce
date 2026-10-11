// Immutable originals, reviewed declaration sites, and the prior Laravel graph.
// Runs Codiluce's JS parser/indexer only; never PHP, Composer or application code.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PHP_SOURCE_PROVIDER_VERSION } from '../src/analysis/php/version.ts';
import { canonicalJson } from '../src/history/fingerprint.ts';

const project=fileURLToPath(new URL('../',import.meta.url));
const option=name=>{const at=process.argv.indexOf(name);return at<0?undefined:process.argv[at+1];};
const config={repository:{name:'php-provider-original-audit'},applications:[{name:'laravel',path:'.',frameworks:['laravel'],ecosystems:['php']}],ignore:['**/.codiluce/**'],maxFileBytes:2*1024*1024};
if(option('--worker')) {
  const {indexRepository}=await import(pathToFileURL(path.join(option('--implementation'),'src/pipeline/index.ts')).href);
  const {AnalysisCache}=await import(pathToFileURL(path.join(option('--implementation'),'src/pipeline/cache.ts')).href);
  const cache=new AnalysisCache(option('--cache'));
  const cold=await indexRepository(option('--worker'),{config,cache}),warm=await indexRepository(option('--worker'),{config,cache}),revision=await indexRepository(option('--worker'),{config,revision:'original'});
  console.log(JSON.stringify({cold,warm,revision,events:cache.events}));
}else {
  const revision='fd51890716808d984eb467cc668b5b3a247161da';
  const inputs=[
    ['composer.json',2381,'2c2ee477271a0dcdf9ae5830b75da13049f5236e556d9e086d8f0cbb5e645bf5'],
    ['bootstrap/app.php',513,'bba9ff06394e0df3dc993a33d0dacc60fcbfc169266abf6a4b230aa33892571a'],
    ['routes/web.php',108,'248c7eeeb43bb61ee4fb6603e52b44843c64f72a841d671bcd41871aab23f970'],
    ['routes/console.php',210,'9adccc33e7dd400683e434774077c7fdb2f299c5712cedf16a43fdf56f2850fa'],
    ['app/Models/User.php',1009,'e0f171d54e3f65fdca8442e730ee7f75a1ed8985ad8f1585682b28d60ee99467'],
    ['app/Http/Controllers/Controller.php',77,'25d1c1ef8e6cc8a376553faacfba2b07d9dfaee9bdbb84f14f77517580e9deb1'],
    ['app/Providers/AppServiceProvider.php',361,'caf306ef6a25a547bbb7edd5508a39b51c365083eb6dd58378cf2242018e94c7'],
  ];
  // Reviewed from the pinned source, independently of parser/indexer output.
  const reviewed=[
    {file:'app/Models/User.php',name:'User',line:10},
    {file:'app/Models/User.php',name:'casts',line:41},
    {file:'app/Http/Controllers/Controller.php',name:'Controller',line:5},
    {file:'app/Providers/AppServiceProvider.php',name:'AppServiceProvider',line:7},
    {file:'app/Providers/AppServiceProvider.php',name:'register',line:12},
    {file:'app/Providers/AppServiceProvider.php',name:'boot',line:20},
    {file:'routes/web.php',name:'GET /',line:5},
  ];
  const temporary=await mkdtemp(path.join(os.tmpdir(),'codiluce-php-provider-audit-'));
  try {
    const root=path.join(temporary,'originals'),baseline=path.join(temporary,'baseline');await mkdir(root);await mkdir(baseline);
    const pins=[];
    for(const [file,bytes,sha256]of inputs){
      const url=`https://raw.githubusercontent.com/laravel/laravel/${revision}/${file}`;let buffer;
      if(option('--source'))buffer=await readFile(path.join(path.resolve(option('--source')),file));
      else{const response=await fetch(url,{signal:AbortSignal.timeout(30_000)});assert.ok(response.ok,url);buffer=Buffer.from(await response.arrayBuffer());}
      assert.equal(buffer.length,bytes,file);assert.equal(createHash('sha256').update(buffer).digest('hex'),sha256,file);pins.push({file,bytes,sha256,url});
      await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),buffer);
    }
    const baselineRef=option('--baseline-ref')??'50b54e6';
    const baselineRevision=execFileSync('git',['rev-parse',`${baselineRef}^{commit}`],{cwd:project,encoding:'utf8'}).trim();
    const archive=path.join(temporary,'baseline.tar');
    execFileSync('git',['archive','--output',archive,baselineRevision],{cwd:project});execFileSync('tar',['-xf',archive,'-C',baseline]);
    await symlink(path.join(project,'node_modules'),path.join(baseline,'node_modules'));
    const run=implementation=>JSON.parse(execFileSync(process.execPath,['--experimental-sqlite','--import','tsx',fileURLToPath(import.meta.url),'--worker',root,'--implementation',implementation,'--cache',path.join(temporary,implementation===project?'current-cache':'baseline-cache')],{cwd:project,encoding:'utf8',maxBuffer:32*1024*1024,timeout:60_000}));
    const previous=run(baseline),current=run(project),graphShape=graph=>({entities:graph.entities,relations:graph.relations,diagnostics:graph.diagnostics});
    assert.equal(canonicalJson(graphShape(current.cold)),canonicalJson(graphShape(current.warm)));
    for(const key of ['entities','relations'])assert.equal(canonicalJson(current.cold[key]),canonicalJson(current.revision[key]));
    const semantic=graph=>{const shape=structuredClone(graphShape(graph));for(const entity of shape.entities)delete entity.metadata.phpSourceProvider;return shape;};
    assert.equal(canonicalJson(semantic(current.cold)),canonicalJson(semantic(previous.cold)),'Every existing entity, edge, source/effect/guard proof and diagnostic must survive provider replacement');
    const results=reviewed.map(expected=>{const entity=current.cold.entities.find(entity=>entity.path===expected.file&&entity.name===expected.name&&entity.sourceRange?.startLine===expected.line);assert.ok(entity,JSON.stringify(expected));assert.ok(entity.evidence.some(proof=>proof.file===expected.file&&proof.line===expected.line&&proof.analyzer==='php-laravel'));return {expected,actual:entity};});
    const qualified=current.cold.entities.filter(entity=>entity.type==='file'&&entity.language==='php');assert.equal(qualified.length,6);assert.ok(qualified.every(entity=>entity.metadata.phpSourceProvider?.available));
    assert.equal(current.events.filter(event=>event.analyzer==='php-syntax-facts'&&event.hit).length,6);
    assert.ok(!JSON.stringify(current.cold).includes('"phpAst"'));assert.ok(!JSON.stringify(current.cold).includes('"kind":"program"'));
    const paths=execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard','--','src','grammars','package.json','package-lock.json','scripts/build-cli.mjs','scripts/qualify-php-provider.mjs','scripts/test-package.mjs','scripts/benchmark-compatibility.mjs','scripts/process-memory.mjs','tests/php-provider.test.ts','tests/php-structure.test.ts','tests/php-imports.test.ts','tests/indexed-sources.test.ts','tests/cache.test.ts'],{cwd:project,encoding:'utf8'}).split('\0').filter(Boolean).filter(file=>file!=='src/analysis/php/worker.ts').sort();
    const digest=createHash('sha256');for(const file of paths)digest.update(file+'\0').update(await readFile(path.join(project,file))).update('\0');
    const data={phase:'P10c3a',measuredAt:new Date().toISOString(),provider:PHP_SOURCE_PROVIDER_VERSION,node:process.version,platform:`${process.platform}/${process.arch}`,revision,pins,reviewed:reviewed.length,matched:results.length,qualifiedFiles:qualified.length,syntaxCacheHits:6,coldWarmEqual:true,revisionEqual:true,priorSemanticGraphEqual:true,baselineRevision,authoredConfig:config,results,diagnostics:current.cold.diagnostics,implementationFiles:paths.length,implementationDigest:digest.digest('hex')};
    const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shared PHP source provider qualification</title><style>body{font:16px/1.6 system-ui,sans-serif;background:#101822;color:#e5ecf4;margin:0;padding:clamp(16px,4vw,48px)}main{max-width:1100px;margin:auto}h1{font-size:clamp(28px,5vw,42px);line-height:1.2}p,code{overflow-wrap:anywhere}a,code{color:#8bddd8}.status{padding:18px;border:1px solid #5b8f88;border-radius:8px}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;min-width:660px}th,td{padding:12px;text-align:left;border-bottom:1px solid #344353}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}summary{cursor:pointer;padding:12px 0}</style></head><body><main><h1>Shared PHP source provider qualification</h1><p>P10c3a · ${esc(data.measuredAt)} · ${esc(data.node)} · ${esc(data.platform)}. Seven byte-pinned Laravel 12.0.0 originals at <code>${revision}</code>.</p><p class="status"><strong>7/7 reviewed original sites · six qualified PHP files · prior Laravel semantic graph preserved</strong><br>All existing entity and relation identities, evidence, effects, guards and diagnostics match ${baselineRevision}, after removing the new provider metadata. Cold/warm and revision graph identities match; all six original native syntax units replay from cache.</p><div class="scroll"><table><thead><tr><th>Original source</th><th>Original name</th><th>Reviewed line</th><th>Retained identity</th></tr></thead><tbody>${results.map(result=>`<tr><td><a href="https://github.com/laravel/laravel/blob/${revision}/${result.expected.file}#L${result.expected.line}">${esc(result.expected.file)}</a></td><td>${esc(result.expected.name)}</td><td>${result.expected.line}</td><td><code>${esc(result.actual.id)}</code></td></tr>`).join('')}</tbody></table></div><p>Original bytes and manifest remain unchanged. The explicit audit configuration selects Laravel static analysis and is recorded below; the target app, framework, dependencies, PHP runtime, Composer and autoloaders never execute. General PHP and Laravel now share a parse-only source-unit service, indexed unchanged-source validation, actual provider-version cache keys, cancellable 10-second worker jobs, a 256 MiB worker heap and a 16 MiB native payload cap. Original extraction remains bounded at 200,000 nodes/tokens, depth 128 and 4,096 sites. Partial or failed bounded trees cannot authorize Laravel semantic replay. Native comments and tokens are stripped from retained trees, and native ASTs never enter graph metadata. A six-job queue overlaps provider work with other language services, and pipeline completion releases retained trees and closes the worker.</p><p>This audit covers one starter repository subset. Source-race, symlink, token/declaration budgets, worker recovery, pending-queue cancellation, original UTF-16 spans and cache checks use separate conformance fixtures. General PHP scoped binding and wider Laravel original structure integration remain P10c3b. Full process-tree/history memory, broader repository accuracy and native OS qualification remain open. Parent-memory performance measurements exclude concurrent worker RSS.</p><p>Implementation digest (${data.implementationFiles} files): <code>${data.implementationDigest}</code>. Reproduce <code>node --experimental-sqlite --import tsx scripts/qualify-php-provider.mjs --output docs/php-provider-source-accuracy.html</code>; <code>--source DIRECTORY</code> verifies immutable inputs offline. <a href="php-provider-compatibility-performance.html">Performance measurements</a> · <a href="language-framework-compatibility.html#implementation">Roadmap</a></p><details><summary>Raw original proofs, pins, configuration and replay qualification</summary><pre>${esc(JSON.stringify(data,null,2))}</pre></details></main></body></html>`;
    await writeFile(path.resolve(option('--output')??'docs/php-provider-source-accuracy.html'),html);console.log(JSON.stringify({reviewed:data.reviewed,matched:data.matched,qualifiedFiles:data.qualifiedFiles,priorSemanticGraphEqual:true,implementationFiles:data.implementationFiles,implementationDigest:data.implementationDigest},null,2));
  }finally{await rm(temporary,{recursive:true,force:true});}
}
