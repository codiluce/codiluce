import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {indexRepository} from '../src/pipeline/index.ts';
import {AnalysisCache} from '../src/pipeline/cache.ts';
import {canonicalJson} from '../src/history/fingerprint.ts';
import {PHP_RESOLVER_VERSION} from '../src/analysis/resolution/php.ts';

const revision='2e913a829cfbbf9cb38b321bdff1806b44b192eb',project=fileURLToPath(new URL('../',import.meta.url));
const option=name=>{const at=process.argv.indexOf(name);return at<0?undefined:process.argv[at+1];};
const inputs=[
 ['composer.json',9032,'6d65f1b3ac16c532939bf3a841a3f4f7c7b5925ce2257f6c6790f60a12b80b55'],
 ['src/Symfony/Component/String/Resources/functions.php',852,'974e6a19bccfc71615061207a08243311152b4759ce416b8f2bc3390790b1644'],
 ['src/Symfony/Contracts/EventDispatcher/Event.php',1479,'fefa2d1a68a006824e21d3baeb8c2b6e0c18d175fa5087148996b664646177ad'],
 ['src/Symfony/Component/HttpKernel/Event/RequestEvent.php',1262,'2594fb6b3b2f2a17c25d7ac6719aee9fc81352218ab59a9c3db5e66537f8efba'],
 ['src/Symfony/Component/Workflow/Metadata/GetMetadataTrait.php',791,'5690dabe901d185e7d7a23ecedbc48b67901633f8a08dbcfce35d6c365a186f8'],
 ['src/Symfony/Component/HttpFoundation/Session/Storage/Handler/AbstractSessionHandler.php',4097,'860aaa606180e1be6c72eff7f4871263b30652ccef0c7e4635c6d03e1a817272'],
 ['src/Symfony/Component/HttpFoundation/Response.php',40303,'5438bdc0483da16ca74766f7b95002524de89749aee00abc0d1bb0670f317905'],
 ['src/Symfony/Component/Workflow/Transition.php',1913,'a0fda35cf0e41f86834470b904e9873d322b67a60465d5b544e368e3ee9f4d10'],
 ['src/Symfony/Component/HttpFoundation/Session/SessionUtils.php',1654,'122be93319ce972b0845a8a9b838d5fd1b5394976db98db79d72fc1907bd8040'],
 ['src/Symfony/Component/Cache/Traits/ValueWrapper.php',2102,'f03ed4b4d0eb8f1b928003bf57f875049e4c395845f7aa0a82facccec86ffc93'],
 ['src/Symfony/Component/HttpKernel/composer.json',2204,'198a276133e5f4fa8d1008942d93f5095a4556351d8b44c16154b64434cd8ecb'],
 ['src/Symfony/Component/HttpFoundation/composer.json',1218,'6ad32a4d69ddc3011b42fea3dea975d76500c3d40ec5491b6c999fd7de62d12c'],
 ['src/Symfony/Component/Workflow/composer.json',1385,'d87007765494c2fc34d2a9811e02575859dbbcb093a0f59293708003128a9979'],
 ['src/Symfony/Contracts/EventDispatcher/composer.json',986,'ed5b8cdc2a6ade1cf7ae9000e642e87064e0a5327481d481d0b9791766a57981'],
];
// Reviewed independently against the pinned original use lines and target
// declaration lines. Expectations never come from resolver/provider output.
const reviewed=[
 {file:inputs[2][0],specifier:'Psr\\EventDispatcher\\StoppableEventInterface',line:14,status:'unresolved'},
 {file:inputs[3][0],specifier:'Symfony\\Component\\HttpFoundation\\Response',line:14,status:'resolved',target:inputs[6][0],name:'Response',targetLine:22},
 {file:inputs[4][0],specifier:'Symfony\\Component\\Workflow\\Transition',line:14,status:'resolved',target:inputs[7][0],name:'Transition',targetLine:18},
 {file:inputs[5][0],specifier:'Symfony\\Component\\HttpFoundation\\Session\\SessionUtils',line:14,status:'resolved',target:inputs[8][0],name:'SessionUtils',targetLine:22},
];
const temporary=await mkdtemp(path.join(os.tmpdir(),'codiluce-original-php-import-'));
try {
 const root=path.join(temporary,'root'),buffers=new Map(),pins=[];
 for(const [file,bytes,sha256] of inputs){const url=`https://raw.githubusercontent.com/symfony/symfony/${revision}/${file}`;let buffer;
  if(option('--source'))buffer=await readFile(path.join(path.resolve(option('--source')),file));
  else {const response=await fetch(url,{signal:AbortSignal.timeout(30000)});assert.ok(response.ok,`${response.status} ${url}`);buffer=Buffer.from(await response.arrayBuffer());}
  assert.equal(buffer.length,bytes,file);assert.equal(createHash('sha256').update(buffer).digest('hex'),sha256,file);buffers.set(file,buffer);pins.push({file,bytes,sha256,url});
  await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),buffer);
 }
 const base={repository:{name:'php-original-import-audit'},applications:[{name:'audit',path:'.',frameworks:[],ecosystems:['php'],php:{composer:'composer.json',autoloadDev:false}}],ignore:[],maxFileBytes:2*1024*1024};
 // The unmodified root Composer classmap contains a byte identifier outside
 // our UTF-8 original-source contract. Keep the whole root case as a gap.
 const rootGraph=await indexRepository(root,{config:base});
 const encodingFile=rootGraph.entities.find(e=>e.type==='file'&&e.path===inputs[9][0]);assert.ok(encodingFile.metadata.analysisSkipped.includes('UTF-8'));assert.ok(!rootGraph.entities.some(e=>e.name.includes('\uFFFD')));
 const rootGaps=reviewed.map(expected=>{const file=rootGraph.entities.find(e=>e.type==='file'&&e.path===expected.file),actual=file.metadata.importOutcomes.find(i=>i.specifier===expected.specifier);assert.equal(actual.outcome.status,'unsupported');return {file:expected.file,specifier:expected.specifier,outcome:actual.outcome};});
 // A clearly authored audit workspace selects unchanged original component
 // manifests as local path dependencies. It is not an upstream root manifest.
 const componentManifests=inputs.filter(([file])=>file.endsWith('/composer.json'));
 const workspace={name:'qualification/php-original-workspace',require:Object.fromEntries(componentManifests.map(([file])=>[JSON.parse(buffers.get(file).toString()).name,'*'])),repositories:componentManifests.map(([file])=>({type:'path',url:path.posix.dirname(file)}))};
 await writeFile(path.join(root,'composer.json'),JSON.stringify(workspace,null,2)+'\n');
 const cache=new AnalysisCache(path.join(temporary,'cache')),cold=await indexRepository(root,{config:base,cache}),warm=await indexRepository(root,{config:base,cache}),revisionGraph=await indexRepository(root,{config:base,revision:'pinned-original-source'});
 for(const key of ['entities','relations']){assert.equal(canonicalJson(cold[key]),canonicalJson(warm[key]));assert.equal(canonicalJson(cold[key]),canonicalJson(revisionGraph[key]));}
 const results=reviewed.map(expected=>{const file=cold.entities.find(e=>e.type==='file'&&e.path===expected.file),actual=file.metadata.importOutcomes.find(i=>i.kind==='use-class'&&i.specifier===expected.specifier);assert.equal(actual.range.startLine,expected.line);assert.equal(actual.outcome.status,expected.status);
  const original=buffers.get(expected.file).toString().split('\n')[expected.line-1];assert.equal(original.trim(),`use ${expected.specifier};`);
  if(expected.target){assert.equal(actual.outcome.targets.length,1);const target=cold.entities.find(e=>e.id===actual.outcome.targets[0]);assert.equal(target.path,expected.target);assert.equal(target.name,expected.name);assert.equal(target.sourceRange.startLine,expected.targetLine);assert.equal(target.metadata.qualifiedName,expected.specifier);assert.equal(target.metadata.declarationKind,'class');assert.ok(buffers.get(expected.target).toString().split('\n')[expected.targetLine-1].includes(`class ${expected.name}`));const edges=cold.relations.filter(r=>r.from===file.id&&r.to===target.id&&r.type==='imports');assert.equal(edges.length,1);assert.ok(edges[0].evidence.some(proof=>proof.analyzer==='php-imports'&&proof.file.endsWith('/composer.json')));assert.deepEqual(edges[0].metadata.range,actual.range);}
  return {expected,originalUseLine:original,actual};
 });
 assert.ok(!cold.relations.some(relation=>relation.type==='calls'));assert.ok(!cold.diagnostics.some(d=>d.code==='php-structure-failed'));
 const paths=execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard','--','src','grammars','package.json','package-lock.json','scripts/qualify-php-import-source.mjs','scripts/test-package.mjs','scripts/benchmark-compatibility.mjs','scripts/process-memory.mjs','tests/php-imports.test.ts','tests/php-structure.test.ts','tests/indexed-sources.test.ts','tests/fixtures/structure/php-imports'],{cwd:project,encoding:'utf8'}).split('\0').filter(Boolean).sort(),digest=createHash('sha256');for(const file of paths)digest.update(file+'\0').update(await readFile(path.join(project,file))).update('\0');
 const data={phase:'P10c2',measuredAt:new Date().toISOString(),resolver:PHP_RESOLVER_VERSION,node:process.version,platform:`${process.platform}/${process.arch}`,revision,pins,authoredWorkspace:workspace,originalRootGaps:rootGaps,results,reviewed:4,matched:4,sourceEdges:3,unavailablePsrTarget:1,syntaxCacheHits:cache.events.filter(e=>e.analyzer==='php-syntax-facts'&&e.hit).length,coldWarmEqual:true,revisionModeEqual:true,implementationFiles:paths.length,implementationDigest:digest.digest('hex')};
 const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PHP import original-source qualification</title><style>body{font:16px/1.6 system-ui,sans-serif;background:#101822;color:#e5ecf4;margin:0;padding:clamp(16px,4vw,48px)}main{max-width:1120px;margin:auto}h1{font-size:clamp(28px,5vw,42px);line-height:1.2}p,code{overflow-wrap:anywhere}a,code{color:#8bddd8}.status{padding:18px;border:1px solid #b69459;border-radius:8px}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;min-width:760px}th,td{padding:12px;text-align:left;border-bottom:1px solid #344353}td{overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}summary{cursor:pointer;padding:12px 0}</style></head><body><main><h1>PHP import original-source qualification</h1><p>P10c2 · ${esc(data.measuredAt)} · ${esc(data.node)} · ${esc(data.platform)}. Four original namespace import sites and their original component Composer maps, pinned to Symfony 8.0.0 revision <code>${revision}</code>.</p><p class="status"><strong>4/4 reviewed outcomes · three original source dependency edges · one explicit unavailable PSR target</strong><br>Original use lines/ranges, exact declaration identity/kind/line and manifest proof hops match an independent inventory. Cold/warm/revision graph identities match. No PHP, Composer, autoloader, target dependency or application executes.</p><div class="scroll"><table><thead><tr><th>Original source</th><th>Imported name</th><th>Expected / actual</th><th>Original target</th></tr></thead><tbody>${results.map(r=>`<tr><td><a href="https://github.com/symfony/symfony/blob/${revision}/${r.expected.file}#L${r.expected.line}">${esc(r.expected.file)}:${r.expected.line}</a></td><td>${esc(r.expected.specifier)}</td><td>${r.expected.status} / ${r.actual.outcome.status}</td><td>${esc(r.expected.target??'Not present in indexed originals')}</td></tr>`).join('')}</tbody></table></div><p>The component case uses a clearly authored qualification workspace to select immutable original component manifests as local path dependencies. Its generated root manifest is recorded below; it is not claimed as upstream configuration. Dependencies and version solving are unexecuted source contracts. The unmodified upstream root case retains four unsupported outcomes because its classmap contains a non-UTF-8 byte identifier. That source is rejected explicitly, without a replacement-character symbol or a guessed classmap winner. All fourteen upstream inputs retain their original bytes and SHA-256 pins.</p><p>This is a reviewed subset from one library family. PSR-0, classmap wildcard/exclusion/ambiguity, Composer files, dev selection, include-path/cwd precedence, source-anchor provenance, literal load cycles, mutation aliases, unavailable targets, cache invalidation and unchanged Laravel IDs are separately exercised by conformance and installed-package fixtures. Scoped PHP references/direct call binding and shared Laravel provider integration remain P10c3 work. Runtime plugins, arbitrary expressions, custom loaders, install solving, non-UTF-8 source profiles, full history/process-tree memory and native OS qualification remain open gates.</p><p><a href="https://getcomposer.org/doc/04-schema.md#autoload">Composer autoload contracts</a> · <a href="https://www.php-fig.org/psr/psr-4/">PSR-4</a> · <a href="https://www.php-fig.org/psr/psr-0/">PSR-0</a> · <a href="https://www.php.net/manual/en/language.namespaces.importing.php">PHP namespace imports</a> · <a href="https://www.php.net/manual/en/function.include.php">PHP loads</a>. Recorded lookup uses indexed POSIX source paths; host defaults are never used. Edges express source dependency with execution unverified.</p><p>Implementation digest (${paths.length} files): <code>${data.implementationDigest}</code>. Reproduce <code>node --experimental-sqlite --import tsx scripts/qualify-php-import-source.mjs --output docs/php-import-source-accuracy.html</code>. <code>--source DIRECTORY</code> verifies all immutable files offline. <a href="php-source-accuracy.html">Earlier original structure audit</a> · <a href="language-framework-compatibility.html#implementation">Roadmap</a></p><details><summary>Raw original proofs, authored workspace, root gaps, pins and replay results</summary><pre>${esc(JSON.stringify(data,null,2))}</pre></details></main></body></html>`;
 await writeFile(path.resolve(option('--output')??'docs/php-import-source-accuracy.html'),html);console.log(JSON.stringify({reviewed:data.reviewed,matched:data.matched,sourceEdges:data.sourceEdges,syntaxCacheHits:data.syntaxCacheHits,implementationFiles:data.implementationFiles,implementationDigest:data.implementationDigest},null,2));
} finally {await rm(temporary,{recursive:true,force:true});}
