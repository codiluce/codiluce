// Byte-pinned original sources and independently reviewed source use sites.
// Only Codiluce's JS indexer runs; never PHP, Composer or target application code.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {canonicalJson} from '../src/history/fingerprint.ts';
import {PHP_SYMBOL_VERSION} from '../src/analysis/languages/php-symbols.ts';

const project=fileURLToPath(new URL('../',import.meta.url));
const option=name=>{const at=process.argv.indexOf(name);return at<0?undefined:process.argv[at+1];};
const authoredManifest={autoload:{'psr-4':{'Symfony\\Component\\':'src/Symfony/Component/','Symfony\\Contracts\\':'src/Symfony/Contracts/'}}};
const config={repository:{name:'php-binding-original-audit'},applications:[{name:'generic',path:'generic',frameworks:[],ecosystems:['php'],php:{composer:'qualification-composer.json',autoloadDev:false}},{name:'laravel',path:'laravel',frameworks:['laravel'],ecosystems:['php']}],ignore:['**/.codiluce/**'],maxFileBytes:2*1024*1024};
if(option('--worker')){
  const {indexRepository}=await import(pathToFileURL(path.join(option('--implementation'),'src/pipeline/index.ts')).href);
  const {AnalysisCache}=await import(pathToFileURL(path.join(option('--implementation'),'src/pipeline/cache.ts')).href);
  const cache=new AnalysisCache(option('--cache'));
  const cold=await indexRepository(option('--worker'),{config,cache}),warm=await indexRepository(option('--worker'),{config,cache}),revision=await indexRepository(option('--worker'),{config,revision:'original'});
  console.log(JSON.stringify({cold,warm,revision,events:cache.events}));
}else{
  const portfolios=[
    {directory:'generic',repository:'symfony/symfony',revision:'2e913a829cfbbf9cb38b321bdff1806b44b192eb',source:option('--symfony-source'),inputs:[
      ['src/Symfony/Component/String/Resources/functions.php',852,'974e6a19bccfc71615061207a08243311152b4759ce416b8f2bc3390790b1644'],
      ['src/Symfony/Contracts/Service/ResetInterface.php',1035,'b30147365ddd947981ebe55fa112433e02a53eef25c5f7f9ee4c74f53e29fdfc'],
      ['src/Symfony/Contracts/EventDispatcher/Event.php',1479,'fefa2d1a68a006824e21d3baeb8c2b6e0c18d175fa5087148996b664646177ad'],
      ['src/Symfony/Component/HttpKernel/Event/RequestEvent.php',1262,'2594fb6b3b2f2a17c25d7ac6719aee9fc81352218ab59a9c3db5e66537f8efba'],
      ['src/Symfony/Component/Workflow/Metadata/GetMetadataTrait.php',791,'5690dabe901d185e7d7a23ecedbc48b67901633f8a08dbcfce35d6c365a186f8'],
      ['src/Symfony/Component/HttpFoundation/Session/Storage/Handler/AbstractSessionHandler.php',4097,'860aaa606180e1be6c72eff7f4871263b30652ccef0c7e4635c6d03e1a817272'],
      ['src/Symfony/Component/HttpFoundation/Session/SessionUtils.php',1654,'122be93319ce972b0845a8a9b838d5fd1b5394976db98db79d72fc1907bd8040'],
    ]},
    {directory:'laravel',repository:'laravel/laravel',revision:'fd51890716808d984eb467cc668b5b3a247161da',source:option('--laravel-source'),inputs:[
      ['composer.json',2381,'2c2ee477271a0dcdf9ae5830b75da13049f5236e556d9e086d8f0cbb5e645bf5'],
      ['bootstrap/app.php',513,'bba9ff06394e0df3dc993a33d0dacc60fcbfc169266abf6a4b230aa33892571a'],
      ['routes/web.php',108,'248c7eeeb43bb61ee4fb6603e52b44843c64f72a841d671bcd41871aab23f970'],
      ['routes/console.php',210,'9adccc33e7dd400683e434774077c7fdb2f299c5712cedf16a43fdf56f2850fa'],
      ['app/Models/User.php',1009,'e0f171d54e3f65fdca8442e730ee7f75a1ed8985ad8f1585682b28d60ee99467'],
      ['app/Http/Controllers/Controller.php',77,'25d1c1ef8e6cc8a376553faacfba2b07d9dfaee9bdbb84f14f77517580e9deb1'],
      ['app/Providers/AppServiceProvider.php',361,'caf306ef6a25a547bbb7edd5508a39b51c365083eb6dd58378cf2242018e94c7'],
    ]},
  ];
  const handler='generic/src/Symfony/Component/HttpFoundation/Session/Storage/Handler/AbstractSessionHandler.php',utils='generic/src/Symfony/Component/HttpFoundation/Session/SessionUtils.php';
  // Expectations are reviewed from original text, never generated from ASTs.
  const reviewed=[
    {file:handler,line:49,expression:'$this->read(',status:'resolved',dispatch:'nominal',target:handler,targetLine:55,name:'read'},
    {file:handler,line:80,expression:'$this->destroy(',status:'resolved',dispatch:'nominal',target:handler,targetLine:87,name:'destroy'},
    {file:handler,line:93,expression:'SessionUtils::popSessionCookie(',status:'resolved',dispatch:'direct',target:utils,targetLine:28,name:'popSessionCookie'},
    {file:handler,line:69,expression:'$this->doRead(',status:'unsupported'},
    {file:handler,line:84,expression:'$this->doWrite(',status:'unsupported'},
    {file:handler,line:109,expression:'$this->doDestroy(',status:'unsupported'},
    {file:'generic/src/Symfony/Component/String/Resources/functions.php',line:17,expression:'new UnicodeString(',status:'unresolved'},
    {file:'generic/src/Symfony/Component/String/Resources/functions.php',line:24,expression:'new ByteString(',status:'unresolved'},
    {file:'laravel/routes/console.php',line:7,expression:'$this->comment(',status:'unsupported'},
    {file:'laravel/app/Models/User.php',line:20,name:'$fillable',declarationKind:'property'},
    {file:'laravel/app/Models/User.php',line:31,name:'$hidden',declarationKind:'property'},
  ];
  const temporary=await mkdtemp(path.join(os.tmpdir(),'codiluce-php-binding-audit-'));
  try{
    const root=path.join(temporary,'originals'),baseline=path.join(temporary,'baseline');await mkdir(root);await mkdir(baseline);
    const pins=[],buffers=new Map();
    for(const portfolio of portfolios)for(const[file,bytes,sha256]of portfolio.inputs){
      const url=`https://raw.githubusercontent.com/${portfolio.repository}/${portfolio.revision}/${file}`;let buffer;
      if(portfolio.source)buffer=await readFile(path.join(path.resolve(portfolio.source),file));else{const response=await fetch(url,{signal:AbortSignal.timeout(30_000)});assert.ok(response.ok,url);buffer=Buffer.from(await response.arrayBuffer());}
      assert.equal(buffer.length,bytes,file);assert.equal(createHash('sha256').update(buffer).digest('hex'),sha256,file);
      const indexed=`${portfolio.directory}/${file}`;buffers.set(indexed,buffer);pins.push({indexed,file,repository:portfolio.repository,revision:portfolio.revision,bytes,sha256,url});await mkdir(path.dirname(path.join(root,indexed)),{recursive:true});await writeFile(path.join(root,indexed),buffer);
    }
    await writeFile(path.join(root,'generic/qualification-composer.json'),JSON.stringify(authoredManifest));
    const baselineRevision=execFileSync('git',['rev-parse',`${option('--baseline-ref')??'02be614'}^{commit}`],{cwd:project,encoding:'utf8'}).trim(),archive=path.join(temporary,'baseline.tar');
    execFileSync('git',['archive','--output',archive,baselineRevision],{cwd:project});execFileSync('tar',['-xf',archive,'-C',baseline]);await symlink(path.join(project,'node_modules'),path.join(baseline,'node_modules'));
    const run=implementation=>JSON.parse(execFileSync(process.execPath,['--experimental-sqlite','--import','tsx',fileURLToPath(import.meta.url),'--worker',root,'--implementation',implementation,'--cache',path.join(temporary,implementation===project?'current-cache':'baseline-cache')],{cwd:project,encoding:'utf8',maxBuffer:64*1024*1024,timeout:120_000}));
    const previous=run(baseline),current=run(project);
    for(const key of ['entities','relations']){assert.equal(canonicalJson(current.cold[key]),canonicalJson(current.warm[key]));assert.equal(canonicalJson(current.cold[key]),canonicalJson(current.revision[key]));}
    const results=reviewed.map(expected=>{
      const originalLine=buffers.get(expected.file).toString().split('\n')[expected.line-1];assert.ok(originalLine.includes(expected.expression??expected.name));
      if(expected.declarationKind){const actual=current.cold.entities.find(entity=>entity.path===expected.file&&entity.name===expected.name&&entity.sourceRange?.startLine===expected.line);assert.ok(actual);assert.equal(actual.metadata.declarationKind,expected.declarationKind);assert.ok(actual.evidence.some(proof=>proof.analyzer==='php-laravel-structure'&&proof.line===expected.line));assert.equal(current.cold.entities.find(entity=>entity.id===actual.parentId).name,'User');return {expected,originalLine,actual};}
      const file=current.cold.entities.find(entity=>entity.path===expected.file&&entity.type==='file'),actual=file.metadata.phpCallOutcomes.find(site=>site.expression.startsWith(expected.expression)&&site.range.startLine===expected.line);assert.ok(actual,JSON.stringify(expected));assert.equal(actual.status,expected.status);
      if(expected.target){const target=current.cold.entities.find(entity=>entity.id===actual.target);assert.equal(target.path,expected.target);assert.equal(target.name,expected.name);assert.equal(target.sourceRange.startLine,expected.targetLine);assert.equal(actual.dispatch,expected.dispatch);const edge=current.cold.relations.find(edge=>edge.from===actual.owner&&edge.to===actual.target&&edge.type===(expected.dispatch==='nominal'?'references':'calls'));assert.ok(edge);assert.ok(actual.proof.some(proof=>proof.file===expected.file&&proof.line===expected.line));assert.ok(actual.proof.some(proof=>proof.file===expected.target&&proof.line===expected.targetLine));if(expected.dispatch==='direct')assert.ok(actual.proof.some(proof=>proof.file==='generic/qualification-composer.json'));}
      else assert.equal(actual.target,undefined);
      return {expected,originalLine,actual};
    });
    // Every prior starter entity/edge survives with original fields/evidence.
    // New structure/capability metadata and additional source proofs are allowed.
    const legacyEntities=previous.cold.entities.filter(entity=>entity.path?.startsWith('laravel/'));
    for(const before of legacyEntities){const after=current.cold.entities.find(entity=>entity.id===before.id);assert.ok(after,before.id);for(const key of ['id','type','name','path','language','parentId','sourceRange','metrics','evidence'])assert.equal(canonicalJson(after[key]),canonicalJson(before[key]),`${before.id} ${key}`);for(const[key,value]of Object.entries(before.metadata))if(key!=='analysis')assert.equal(canonicalJson(after.metadata[key]),canonicalJson(value),`${before.id} metadata.${key}`);}
    const legacyIds=new Set(legacyEntities.map(entity=>entity.id)),legacyEdges=previous.cold.relations.filter(edge=>legacyIds.has(edge.from)||legacyIds.has(edge.to));
    for(const before of legacyEdges){const after=current.cold.relations.find(edge=>edge.id===before.id);assert.ok(after,before.id);for(const key of ['id','from','to','type','metadata'])assert.equal(canonicalJson(after[key]),canonicalJson(before[key]));assert.equal(canonicalJson(after.evidence.filter(proof=>!['php-symbols','php-imports'].includes(proof.analyzer))),canonicalJson(before.evidence));}
    assert.equal(current.events.filter(event=>event.analyzer==='php-syntax-facts'&&event.hit).length,13);assert.ok(!JSON.stringify(current.cold).includes('"phpAst"'));
    const paths=execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard','--','src','grammars','package.json','package-lock.json','scripts/build-cli.mjs','scripts/qualify-php-binding.mjs','scripts/test-package.mjs','scripts/benchmark-compatibility.mjs','scripts/process-memory.mjs','tests/php-symbols.test.ts','tests/php-provider.test.ts','tests/php-structure.test.ts','tests/php-imports.test.ts','tests/compatibility-baseline.test.ts','tests/indexed-sources.test.ts','tests/projection.test.ts','tests/fixtures/structure/php-binding.php'],{cwd:project,encoding:'utf8'}).split('\0').filter(Boolean).sort(),digest=createHash('sha256');for(const file of paths)digest.update(file+'\0').update(await readFile(path.join(project,file))).update('\0');
    const data={phase:'P10c3b',measuredAt:new Date().toISOString(),binder:PHP_SYMBOL_VERSION,node:process.version,platform:`${process.platform}/${process.arch}`,pins,reviewed:reviewed.length,matched:results.length,sourceUses:9,resolvedUses:3,nominalReferences:2,directCalls:1,explicitGaps:6,newLaravelProperties:2,legacyEntities:legacyEntities.length,legacyEdges:legacyEdges.length,legacyFieldsAndProofsPreserved:true,baselineRevision,syntaxCacheHits:13,coldWarmEqual:true,revisionEqual:true,authoredManifest,authoredConfig:config,results,implementationFiles:paths.length,implementationDigest:digest.digest('hex')};
    const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PHP scoped source binding qualification</title><style>body{font:16px/1.6 system-ui,sans-serif;background:#101822;color:#e5ecf4;margin:0;padding:clamp(16px,4vw,48px)}main{max-width:1120px;margin:auto}h1{font-size:clamp(28px,5vw,42px);line-height:1.2}p,code{overflow-wrap:anywhere}a,code{color:#8bddd8}.status{padding:18px;border:1px solid #b69459;border-radius:8px}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;min-width:720px}th,td{padding:12px;text-align:left;border-bottom:1px solid #344353}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}summary{cursor:pointer;padding:12px 0}</style></head><body><main><h1>PHP scoped source binding qualification</h1><p>P10c3b · ${esc(data.measuredAt)} · ${esc(data.node)} · ${esc(data.platform)}. Fourteen byte-pinned Symfony 8.0.0 and Laravel 12.0.0 originals.</p><p class="status"><strong>11/11 reviewed outcomes · one direct source call · two nominal method references · six explicit gaps · two original Laravel properties</strong><br>Thirteen native source-unit cache hits preserve cold/warm/revision identities. All ${data.legacyEntities} prior Laravel starter entities and ${data.legacyEdges} touching edges retain their original fields and proofs, allowing new structure/capability metadata and source evidence.</p><div class="scroll"><table><thead><tr><th>Original source</th><th>Original use / declaration</th><th>Reviewed outcome</th><th>Original target</th></tr></thead><tbody>${results.map(({expected})=>{const pin=pins.find(pin=>pin.indexed===expected.file);return `<tr><td><a href="https://github.com/${pin.repository}/blob/${pin.revision}/${pin.file}#L${expected.line}">${esc(pin.file)}:${expected.line}</a></td><td>${esc(expected.expression??expected.name)}</td><td>${esc(expected.status??expected.declarationKind)} ${esc(expected.dispatch??'')}</td><td>${esc(expected.target?`${expected.name}:${expected.targetLine}`:'Explicit gap / original class owner')}</td></tr>`;}).join('')}</tbody></table></div><p>This is a reviewed subset from two source families. Typed virtual receivers produce nominal references; abstract methods, unavailable classes and unbound anonymous owners keep gaps. The authored Symfony qualification manifest selects indexed PSR-4 source paths and is recorded below; it is not an upstream manifest or proof of runtime installation. All upstream bytes remain unchanged. No PHP runtime, Composer, autoloader, dependency or target application executes.</p><p>Conformance separately covers independent class/function/constant namespace tables, repeated blocks, ASCII-only folding, namespace fallback, literal loads, callable scopes, local writes, captures/arrows, static/$this boundaries, reference escapes, callbacks/first-class captures, inherited constructors/methods, plain traits, original promoted/property and return types, exact UTF-16 coordinates, source races and bounded-tree failures. Dynamic values, flow/activation order, by-reference state, trait adaptations, protected inheritance access, union/intersection types, magic dispatch and anonymous callback ownership remain explicit gaps. Existing Laravel framework/effect/guard observations retain their established profile; general PHP framework/effects/guards remain unsupported. Broader source accuracy, full mixed-history/process-tree memory, native OS and documentation release gates remain open.</p><p><a href="https://www.php.net/manual/en/language.namespaces.rules.php">PHP namespace rules</a> · <a href="https://www.php.net/manual/en/functions.anonymous.php">Closure scopes</a> · <a href="https://www.php.net/manual/en/functions.arrow.php">Arrow captures</a> · <a href="php-binding-compatibility-performance.html">Performance evidence</a> · <a href="language-framework-compatibility.html#implementation">Roadmap</a></p><p>Implementation digest (${paths.length} files): <code>${data.implementationDigest}</code>. Reproduce <code>node --experimental-sqlite --import tsx scripts/qualify-php-binding.mjs --output docs/php-binding-source-accuracy.html</code>. Optional <code>--symfony-source</code> and <code>--laravel-source</code> verify originals offline.</p><details><summary>Raw original proofs, pins, configuration, legacy projection and replay results</summary><pre>${esc(JSON.stringify(data,null,2))}</pre></details></main></body></html>`;
    await writeFile(path.resolve(option('--output')??'docs/php-binding-source-accuracy.html'),html);console.log(JSON.stringify({...data,results:undefined,pins:undefined},null,2));
  }finally{await rm(temporary,{recursive:true,force:true});}
}
