import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {mkdtemp,mkdir,rm,writeFile,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {resolveConfig,type RawConfig} from '../src/core/config.js';
import {GraphBuilder} from '../src/core/graph.js';
import type {AnalysisContext} from '../src/core/analyzer.js';
import {filesystemAnalyzer} from '../src/analyzers/filesystem.js';
import {phpStructureAnalyzer} from '../src/analysis/languages/php.js';
import {phpImportsAnalyzer} from '../src/analysis/languages/php-imports.js';
import {AnalysisCache} from '../src/pipeline/cache.js';
import {canonicalJson} from '../src/history/fingerprint.js';
import {fileAnalysis} from '../src/analysis/facts.js';

const roots:string[]=[];after(async()=>{await Promise.all(roots.map(root=>rm(root,{recursive:true,force:true})));});
const json=JSON.stringify;
async function repository(files:Record<string,string>) {
  const root=await mkdtemp(path.join(os.tmpdir(),'codiluce-php-import-'));roots.push(root);
  for(const [file,text] of Object.entries(files)){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),text);}return root;
}
async function scan(root:string,raw:RawConfig={},cache?:AnalysisCache) {
  const config=await resolveConfig(root,{repository:{name:'fixture'},...raw}),graph=new GraphBuilder('fixture');
  const context:AnalysisContext={root,config,graph,repositoryId:graph.id('repository'),files:new Map(),applicationIds:new Map(),http:[],cache};
  await filesystemAnalyzer.analyze(context);await phpStructureAnalyzer.analyze(context);await phpImportsAnalyzer.analyze(context);return context;
}
interface Outcome {kind:string;specifier:string;alias?:string;outcome:{status:string;reason?:string;targets?:string[];candidates?:string[];dependency?:string;proof?:unknown[]}}
function outcomes(context:AnalysisContext,file='entry.php'):Outcome[] {return context.graph.entities.get(context.files.get(file)!.id)!.metadata.importOutcomes as Outcome[];}
function target(context:AnalysisContext,item:Outcome):string|undefined{return item.outcome.targets?.map(id=>context.graph.entities.get(id)!.path).join(',');}
const runtime=(php:Record<string,unknown>):RawConfig=>({applications:[{name:'php',path:'.',ecosystems:['php'],php}]});

for(const [label,autoload,source,targetFile] of [
  ['PSR-4',{'psr-4':{'App\\':'src/'}},'<?php use App\\Thing;','src/Thing.php'],
  ['PSR-4 fallback',{'psr-4':{'':'src/'}},'<?php use App\\Thing;','src/App/Thing.php'],
  ['PSR-0 namespaced',{'psr-0':{'App\\':'src/'}},'<?php use App\\Thing;','src/App/Thing.php'],
  ['PSR-0 PEAR underscores',{'psr-0':{'Legacy_':'src/'}},'<?php use Legacy_Thing;','src/Legacy/Thing.php'],
  ['PSR-0 class prefix',{'psr-0':{'App\\Thing':'src/'}},'<?php use App\\Thing;','src/App/Thing.php'],
] as const)test(`PHP ${label} resolves an exact original source declaration`,async()=>{
  const declaration=label.includes('PEAR')?'<?php class Legacy_Thing {}':'<?php namespace App; class Thing {}';
  const context=await scan(await repository({'composer.json':json({autoload}),'entry.php':source,[targetFile]:declaration}));const item=outcomes(context)[0]!;
  assert.equal(item.outcome.status,'resolved');assert.equal(target(context,item),targetFile);assert.ok(item.outcome.proof!.length>=3);
  assert.equal(fileAnalysis(context.graph.entities.get(context.files.get('entry.php')!.id)!.metadata.analysis)!.features.imports.status,'partial');
});
test('PHP PSR-0 translates underscores only in the class basename',async()=>{
  const context=await scan(await repository({'composer.json':json({autoload:{'psr-0':{'Foo_Bar\\':'src'}}}),'entry.php':'<?php use Foo_Bar\\Thing_Name;','src/Foo_Bar/Thing/Name.php':'<?php namespace Foo_Bar; class Thing_Name {}'}));assert.equal(outcomes(context)[0]!.outcome.status,'resolved');
});
test('PHP ordered PSR roots use the first existing file and do not skip wrong declarations',async()=>{
  const root=await repository({'composer.json':json({autoload:{'psr-4':{'App\\':['first','second']}}}),'entry.php':'<?php use App\\Thing;','first/Thing.php':'<?php namespace App; class Other {}','second/Thing.php':'<?php namespace App; class Thing {}'});
  assert.equal(outcomes(await scan(root))[0]!.outcome.status,'unresolved');await rm(path.join(root,'first/Thing.php'));assert.equal(target(await scan(root),outcomes(await scan(root))[0]!),'second/Thing.php');
});
test('PHP nested PSR prefixes precede parent prefixes within a manifest',async()=>{
  const context=await scan(await repository({'composer.json':json({autoload:{'psr-4':{'App\\':'base','App\\Nested\\':'nested'}}}),'entry.php':'<?php use App\\Nested\\Thing;','base/Nested/Thing.php':'<?php namespace App\\Nested; class Thing {}','nested/Thing.php':'<?php namespace App\\Nested; class Thing {}'}));assert.equal(outcomes(context)[0]!.outcome.status,'resolved');assert.equal(target(context,outcomes(context)[0]!),'nested/Thing.php');
});
test('PHP PSR lookup preserves exact path/declaration case',async()=>{
  const context=await scan(await repository({'composer.json':json({autoload:{'psr-4':{'App\\':'src'}}}),'entry.php':'<?php use App\\thing;','src/Thing.php':'<?php namespace App; class Thing {}'}));assert.equal(outcomes(context)[0]!.outcome.status,'unresolved');
});
test('PHP excluded earlier PSR candidates cannot fall through to later roots',async()=>{
  const context=await scan(await repository({'composer.json':json({autoload:{'psr-4':{'App\\':['vendor/local','src']}}}),'entry.php':'<?php use App\\Thing;','vendor/local/Thing.php':'<?php namespace App; class Thing {}','src/Thing.php':'<?php namespace App; class Thing {}'}));assert.equal(outcomes(context)[0]!.outcome.status,'excluded');
});
test('PHP symlink and oversized earlier candidates block ordered lookup',async()=>{
  const root=await repository({'composer.json':json({autoload:{'psr-4':{'App\\':['first','second']}}}),'entry.php':'<?php use App\\Thing;','second/Thing.php':'<?php namespace App; class Thing {}'});await mkdir(path.join(root,'first'));await symlink(path.join(root,'second/Thing.php'),path.join(root,'first/Thing.php'));assert.equal(outcomes(await scan(root))[0]!.outcome.status,'excluded');await rm(path.join(root,'first/Thing.php'));await writeFile(path.join(root,'first/Thing.php'),'<?php '+' '.repeat(300));assert.equal(outcomes(await scan(root,{maxFileBytes:150}))[0]!.outcome.status,'excluded');
});
test('PHP classmaps discover differently named PHP/inc source files and take precedence over PSR',async()=>{
  const context=await scan(await repository({'composer.json':json({autoload:{classmap:['legacy'],'psr-4':{'App\\':'src'}}}),'entry.php':'<?php use App\\Thing;','legacy/many.inc':'<?php namespace App; interface Thing {}','src/Thing.php':'<?php namespace App; class Thing {}'}));assert.equal(target(context,outcomes(context)[0]!),'legacy/many.inc');
});
test('PHP duplicate conditional classmap declarations are ambiguous',async()=>{
  const context=await scan(await repository({'composer.json':json({autoload:{classmap:['legacy']}}),'entry.php':'<?php use App\\Thing;','legacy/many.php':'<?php namespace App; if($a){class Thing{}}else{class Thing{}}'}));assert.equal(outcomes(context)[0]!.outcome.status,'ambiguous');assert.equal(outcomes(context)[0]!.outcome.candidates!.length,2);
});
test('PHP classmap wildcard directories and package-root exclusions preserve Composer semantics',async()=>{
  const context=await scan(await repository({'composer.json':json({autoload:{classmap:['packages/*/src'],'exclude-from-classmap':['/packages/*/src/tests/']}}),'entry.php':'<?php use App\\Thing;','packages/one/src/arbitrary.php':'<?php namespace App; class Thing {}','packages/one/src/tests/other.php':'<?php namespace App; class Thing {}'}));assert.equal(outcomes(context)[0]!.outcome.status,'resolved');assert.equal(target(context,outcomes(context)[0]!),'packages/one/src/arbitrary.php');
});
test('PHP function and constant namespace imports use Composer files, not PSR class guessing',async()=>{
  const context=await scan(await repository({'composer.json':json({autoload:{files:['functions.php']}}),'entry.php':'<?php use function App\\HELPER as invoke; use const App\\FLAG; use const App\\flag;','functions.php':'<?php namespace App; function helper(){} const FLAG=1;'}));const items=outcomes(context);assert.deepEqual(items.slice(0,3).map(item=>item.outcome.status),['resolved','resolved','unresolved']);assert.ok(items.some(item=>item.kind==='composer-files'&&item.outcome.status==='resolved'));assert.ok(![...context.graph.relations.values()].some(relation=>relation.type==='calls'));
});
for(const [selection,status] of [[undefined,'unsupported'],[false,'unresolved'],[true,'resolved']] as const)test(`PHP dev autoload selection ${selection} stays explicit`,async()=>{
  const context=await scan(await repository({'composer.json':json({'autoload-dev':{'psr-4':{'App\\':'tests'}}}),'entry.php':'<?php use App\\Thing;','tests/Thing.php':'<?php namespace App; class Thing {}'}),runtime(selection===undefined?{}:{autoloadDev:selection}));assert.equal(outcomes(context)[0]!.outcome.status,status);
});
test('PHP same-file aliases use PHP kind/case rules and preserve separate tables',async()=>{
  const context=await scan(await repository({'entry.php':'<?php namespace App; use App\\THING as Pick; use function App\\READ as Pick; use const App\\FLAG as Pick; class Thing {} function read(){} const FLAG=1;'}));assert.deepEqual(outcomes(context).map(item=>item.outcome.status),['resolved','resolved','resolved']);
});
test('PHP namespace-only aliases remain qualified-use gaps',async()=>{
  const context=await scan(await repository({'entry.php':'<?php use App\\Library as Lib;','other.php':'<?php namespace App\\Library; class Item {}'}));assert.equal(outcomes(context)[0]!.outcome.status,'unsupported');assert.match(outcomes(context)[0]!.outcome.reason!,/qualified use site/);
});
test('PHP duplicate aliases are ambiguous while repeated namespace blocks stay separate',async()=>{
  const context=await scan(await repository({'entry.php':'<?php namespace App {use App\\A as Pick;use App\\B as Pick;class A{}class B{}} namespace App {use App\\A as Pick;}'}));assert.deepEqual(outcomes(context).map(item=>item.outcome.status),['ambiguous','ambiguous','resolved']);
});
test('PHP source-anchor magic paths and dirname resolve original literal file loads',async()=>{
  const context=await scan(await repository({'entry.php':'<?php include __DIR__."/one.php"; require_once \\dirname(__FILE__)."/two.php";','one.php':'<?php function one(){}','two.php':'<?php function two(){}'}));assert.deepEqual(outcomes(context).map(item=>item.outcome.status),['resolved','resolved']);assert.deepEqual(outcomes(context).map(item=>target(context,item)),['one.php','two.php']);
});
test('PHP unqualified dirname source shadows remain explicit gaps',async()=>{
  const context=await scan(await repository({'entry.php':'<?php namespace App; use function Other\\dirname; include dirname(__FILE__)."/one.php"; include \\dirname(__FILE__)."/one.php";','one.php':'<?php function one(){}'}));assert.equal(outcomes(context).find(item=>item.kind==='include')!.outcome.status,'unsupported');assert.equal(outcomes(context).at(-1)!.outcome.status,'resolved');
});
test('PHP magic path concatenation preserves bytes before normalization',async()=>{
  const context=await scan(await repository({'entry.php':'<?php include __DIR__."one.php";','.one.php':'<?php function fake(){}','one.php':'<?php function real(){}'}));assert.equal(outcomes(context)[0]!.outcome.status,'unsupported');
});
test('PHP bare loads need recorded include paths and explicit relative paths need cwd',async()=>{
  const root=await repository({'entry.php':'<?php include "one.php"; include "./one.php";','one.php':'<?php function one(){}'});assert.deepEqual(outcomes(await scan(root)).map(item=>item.outcome.status),['unsupported','unsupported']);const context=await scan(root,runtime({cwd:'.',includePath:[]}));assert.deepEqual(outcomes(context).map(item=>item.outcome.status),['resolved','resolved']);
});
test('PHP include paths precede caller directory and explicit ./ ignores them',async()=>{
  const context=await scan(await repository({'entry.php':'<?php include "one.php"; include "./one.php";','search/one.php':'<?php function first(){}','one.php':'<?php function second(){}'}),runtime({cwd:'.',includePath:['search']}));assert.deepEqual(outcomes(context).map(item=>target(context,item)),['search/one.php','one.php']);
});
test('PHP literal transitive includes make original function/constant imports reachable and cycles terminate',async()=>{
  const context=await scan(await repository({'entry.php':'<?php include __DIR__."/one.php"; use function App\\helper; use const App\\FLAG;','one.php':'<?php include __DIR__."/two.php";','two.php':'<?php namespace App; include __DIR__."/one.php"; function helper(){} const FLAG=1;'}));assert.deepEqual(outcomes(context).map(item=>item.outcome.status),['resolved','resolved','resolved']);
});
test('PHP unavailable, dynamic and stream loads retain distinct outcomes',async()=>{
  const context=await scan(await repository({'entry.php':'<?php include __DIR__."/missing.php"; include $path; include "https://example.test/a.php"; include "/absolute.php";'}));assert.deepEqual(outcomes(context).map(item=>item.outcome.status),['unresolved','unsupported','unsupported','unsupported']);
});
test('PHP original cwd/include-path mutations prevent relative guesses and retain anchored loads',async()=>{
  const context=await scan(await repository({'entry.php':'<?php chdir("elsewhere"); include "./one.php"; include __DIR__."/one.php";','one.php':'<?php function one(){}'}),runtime({cwd:'.',includePath:[]}));assert.deepEqual(outcomes(context).map(item=>item.outcome.status),['unsupported','resolved']);assert.ok([...context.graph.diagnostics.values()].some(d=>d.code==='php-loader-change-gap'));
});
test('PHP local path-package autoload maps come only from named requirements',async()=>{
  const context=await scan(await repository({'composer.json':json({require:{'local/pkg':'*'},repositories:[{type:'path',url:'packages/*'}]}),'entry.php':'<?php use Local\\Thing; use Unrelated\\Thing as Other;','packages/pkg/composer.json':json({name:'local/pkg',autoload:{'psr-4':{'Local\\':'src'}}}),'packages/pkg/src/Thing.php':'<?php namespace Local; class Thing{}','packages/other/composer.json':json({name:'other/pkg',autoload:{'psr-4':{'Unrelated\\':'src'}}}),'packages/other/src/Thing.php':'<?php namespace Unrelated; class Thing{}'}));assert.deepEqual(outcomes(context).map(item=>item.outcome.status),['resolved','unresolved']);
});
test('PHP external imports require exact indexed lock namespace evidence',async()=>{
  const context=await scan(await repository({'composer.json':json({require:{'vendor/pkg':'*'}}),'composer.lock':json({packages:[{name:'vendor/pkg',autoload:{'psr-4':{'Vendor\\':'src'}}}]}),'entry.php':'<?php use Vendor\\Thing; use Guess\\Thing as Other;'}));assert.deepEqual(outcomes(context).map(item=>item.outcome.status),['external','unresolved']);assert.equal(outcomes(context)[0]!.outcome.dependency,'vendor/pkg');
});
test('PHP invalid/outside Composer paths are gaps and never inspect host files',async()=>{
  const context=await scan(await repository({'composer.json':json({autoload:{'psr-4':{'App\\':'../outside'}}}),'entry.php':'<?php use App\\Thing;'}));assert.equal(outcomes(context)[0]!.outcome.status,'unsupported');
});
test('PHP import resolution recomputes on manifests, dependencies and runtime profile changes despite syntax cache hits',async()=>{
  const root=await repository({'composer.json':json({autoload:{'psr-4':{'App\\':'first'}}}),'entry.php':'<?php use App\\Thing;','first/Thing.php':'<?php namespace App; class Thing{}','second/Thing.php':'<?php namespace App; class Thing{}'}),cache=new AnalysisCache(path.join(root,'.codiluce/cache'));
  const cold=await scan(root,{},cache),warm=await scan(root,{},cache);for(const key of ['entities','relations'] as const)assert.equal(canonicalJson([...cold.graph[key].values()]),canonicalJson([...warm.graph[key].values()]));assert.ok(cache.events.some(event=>event.analyzer==='php-syntax-facts'&&event.hit));await writeFile(path.join(root,'composer.json'),json({autoload:{'psr-4':{'App\\':'second'}}}));const changed=await scan(root,{},cache);assert.equal(target(changed,outcomes(changed)[0]!),'second/Thing.php');await writeFile(path.join(root,'second/Thing.php'),'<?php namespace App; class Other{}');assert.equal(outcomes(await scan(root,{},cache))[0]!.outcome.status,'unresolved');
});
test('PHP runtime config validates bounded repository paths without reading host environment',async()=>{
  const root=await repository({});for(const php of [{cwd:'/tmp'},{cwd:'../outside'},{includePath:['http://x']},{autoloadDev:'yes'},{unknown:true},{includePath:Array(129).fill('.')},{composer:'C:\\other'}])await assert.rejects(resolveConfig(root,runtime(php)),/PHP runtime|outside repository/);assert.equal((await resolveConfig(root,runtime({cwd:'.',includePath:[],autoloadDev:false,composer:'composer.json'}))).applications[0]!.php!.autoloadDev,false);
});
test('PHP classmap excluded source regions do not establish absence or pick a known duplicate',async()=>{
  const context=await scan(await repository({'composer.json':json({autoload:{classmap:['legacy']}}),'entry.php':'<?php use App\\Thing;','legacy/good.php':'<?php namespace App; class Thing{}','legacy/hidden/other.php':'<?php namespace App; class Thing{}'}),{ignore:['legacy/hidden/**']});assert.equal(outcomes(context)[0]!.outcome.status,'unsupported');
});
test('PHP classmap discovery refuses case guesses and unselected dev competitors',async()=>{
  const root=await repository({'composer.json':json({autoload:{classmap:['legacy']},'autoload-dev':{classmap:['dev']}}),'entry.php':'<?php use App\\Thing; use App\\thing as Other;','legacy/one.php':'<?php namespace App; class Thing{}','dev/two.php':'<?php namespace App; class Thing{}'});const unknown=await scan(root);assert.equal(outcomes(unknown)[0]!.outcome.status,'unsupported');const selected=await scan(root,runtime({autoloadDev:false}));assert.deepEqual(outcomes(selected).map(item=>item.outcome.status),['resolved','unresolved']);
});
test('PHP main/dev PSR paths for one prefix preserve ordered fallback',async()=>{
  const context=await scan(await repository({'composer.json':json({autoload:{'psr-4':{'App\\':'main'}},'autoload-dev':{'psr-4':{'App\\':'dev'}}}),'entry.php':'<?php use App\\Thing;','main/Thing.php':'<?php namespace App; class Thing{}','dev/Thing.php':'<?php namespace App; class Thing{}'}),runtime({autoloadDev:true}));assert.equal(target(context,outcomes(context)[0]!),'main/Thing.php');
});
test('PHP root equal-prefix PSR paths precede dependencies and longer dependency prefixes precede root parents',async()=>{
  const root=await repository({'composer.json':json({require:{'local/pkg':'*'},repositories:[{type:'path',url:'pkg'}],autoload:{'psr-4':{'App\\':'root'}}}),'entry.php':'<?php use App\\Thing;use App\\Nested\\Other;','root/Thing.php':'<?php namespace App;class Thing{}','root/Nested/Other.php':'<?php namespace App\\Nested;class Other{}','pkg/composer.json':json({name:'local/pkg',autoload:{'psr-4':{'App\\':'src','App\\Nested\\':'nested'}}}),'pkg/src/Thing.php':'<?php namespace App;class Thing{}','pkg/nested/Other.php':'<?php namespace App\\Nested;class Other{}'});const context=await scan(root);assert.deepEqual(outcomes(context).map(item=>target(context,item)),['root/Thing.php','pkg/nested/Other.php']);
});
test('PHP transitive path dependencies use the root repository catalog and ignore dependency repository injection',async()=>{
  const context=await scan(await repository({'composer.json':json({require:{'local/one':'*'},repositories:[{type:'path',url:'packages/*'}]}),'entry.php':'<?php use Two\\Thing; use Evil\\Thing as Other;','packages/one/composer.json':json({name:'local/one',require:{'local/two':'*','evil/pkg':'*'},repositories:[{type:'path',url:'../../evil'}]}),'packages/two/composer.json':json({name:'local/two',autoload:{'psr-4':{'Two\\':'src'}}}),'packages/two/src/Thing.php':'<?php namespace Two;class Thing{}','evil/composer.json':json({name:'evil/pkg',autoload:{'psr-4':{'Evil\\':'src'}}}),'evil/src/Thing.php':'<?php namespace Evil;class Thing{}'}));assert.deepEqual(outcomes(context).map(item=>item.outcome.status),['resolved','unresolved']);
});
test('PHP native nowdoc/heredoc loads preserve literal path bytes without interpolation guesses',async()=>{
  const context=await scan(await repository({'entry.php':"<?php include <<<'P'\none.php\nP;\ninclude <<<P\none.php\nP;\ninclude <<<P\n$unknown.php\nP;",'one.php':'<?php function one(){}'}),runtime({cwd:'.',includePath:[]}));assert.deepEqual(outcomes(context).map(item=>item.outcome.status),['resolved','resolved','unsupported']);
});
test('PHP literal anchor imitation and dirname escapes cannot manufacture source provenance',async()=>{
  const context=await scan(await repository({'entry.php':'<?php include "/__codiluce_php_repository__/one.php"; include \\dirname(__FILE__,2)."/__codiluce_php_repository__/one.php";','one.php':'<?php function one(){}'}));assert.deepEqual(outcomes(context).map(item=>item.outcome.status),['unsupported','unsupported']);
});
test('PHP aliased original cwd mutations are recognized in the per-file function import table',async()=>{
  const context=await scan(await repository({'entry.php':'<?php use function chdir as move;move("elsewhere");include "./one.php";','one.php':'<?php function one(){}'}),runtime({cwd:'.',includePath:[]}));assert.equal(outcomes(context).find(item=>item.kind==='include')!.outcome.status,'unsupported');assert.ok([...context.graph.diagnostics.values()].some(d=>d.code==='php-loader-change-gap'));
});
test('PHP default/custom manifest scopes and application cwd profiles remain independent',async()=>{
  const root=await repository({'a/custom.json':json({autoload:{'psr-4':{'App\\':'src'}}}),'a/entry.php':'<?php use App\\Thing;include "./one.php";','a/src/Thing.php':'<?php namespace App;class Thing{}','a/one.php':'<?php function one(){}','b/composer.json':json({autoload:{'psr-4':{'App\\':'src'}}}),'b/entry.php':'<?php use App\\Thing;','b/src/Thing.php':'<?php namespace App;class Thing{}'});const context=await scan(root,{applications:[{name:'a',path:'a',php:{composer:'custom.json',cwd:'.'}},{name:'b',path:'b'}]});assert.deepEqual(outcomes(context,'a/entry.php').map(item=>target(context,item)),['a/src/Thing.php','a/one.php']);assert.equal(target(context,outcomes(context,'b/entry.php')[0]!),'b/src/Thing.php');
});
test('PHP parsed sources and manifests changed after the scan are rejected by import proofs',async()=>{
  const root=await repository({'composer.json':json({autoload:{'psr-4':{'App\\':'src'}}}),'entry.php':'<?php use App\\Thing;','src/Thing.php':'<?php namespace App;class Thing{}'}),config=await resolveConfig(root,{repository:{name:'fixture'}}),graph=new GraphBuilder('fixture'),context:AnalysisContext={root,config,graph,repositoryId:graph.id('repository'),files:new Map(),applicationIds:new Map(),http:[]};await filesystemAnalyzer.analyze(context);await phpStructureAnalyzer.analyze(context);await writeFile(path.join(root,'src/Thing.php'),'<?php namespace App;class Other{}');await phpImportsAnalyzer.analyze(context);assert.equal(outcomes(context)[0]!.outcome.status,'unsupported');assert.match(outcomes(context)[0]!.outcome.reason!,/changed after the scan/);
});
test('PHP native source names fold ASCII only, while constant namespace prefixes preserve basename case',async()=>{
  const context=await scan(await repository({'entry.php':'<?php namespace Demo; use function Demo\\Å as Upper; use function Demo\\å as Lower; use const demo\\FLAG; use const Demo\\flag as Other; function Å(){} const FLAG=1;'}));assert.deepEqual(outcomes(context).map(item=>item.outcome.status),['resolved','unresolved','resolved','unresolved']);
});
test('PHP non-UTF-8 source declarations are excluded without inventing replacement-character symbols',async()=>{
  const root=await repository({'composer.json':json({autoload:{classmap:['legacy']}}),'entry.php':'<?php use App\\Thing;','legacy/good.php':'<?php namespace App;class Thing{}'});await writeFile(path.join(root,'legacy/bytes.php'),Buffer.from([0x3c,0x3f,0x70,0x68,0x70,0x20,0x63,0x6c,0x61,0x73,0x73,0x20,0xa9,0x20,0x7b,0x7d]));const context=await scan(root);assert.equal(context.files.get('legacy/bytes.php')!.analyzable,false);assert.equal(outcomes(context)[0]!.outcome.status,'unsupported');assert.ok(![...context.graph.entities.values()].some(entity=>entity.name.includes('\uFFFD')));
});
for(const [selection,status] of [[undefined,'unsupported'],[false,'unresolved'],[true,'resolved']] as const)test(`PHP local dev dependency selection ${selection} remains a recorded contract`,async()=>{
  const context=await scan(await repository({'composer.json':json({'require-dev':{'local/pkg':'*'},repositories:[{type:'path',url:'pkg'}]}),'entry.php':'<?php use Local\\Thing;','pkg/composer.json':json({name:'local/pkg',autoload:{'psr-4':{'Local\\':'src'}}}),'pkg/src/Thing.php':'<?php namespace Local;class Thing{}'}),runtime(selection===undefined?{}:{autoloadDev:selection}));assert.equal(outcomes(context)[0]!.outcome.status,status);
});
test('PHP unknown locked dev packages produce unselected-profile gaps',async()=>{
  const context=await scan(await repository({'composer.json':json({'require-dev':{'vendor/pkg':'*'}}),'composer.lock':json({'packages-dev':[{name:'vendor/pkg',autoload:{'psr-4':{'Vendor\\':'src'}}}]}),'entry.php':'<?php use Vendor\\Thing;'}));assert.equal(outcomes(context)[0]!.outcome.status,'unsupported');
});
test('PHP HH classmap inputs remain language-profile gaps instead of disappearing behind known PHP candidates',async()=>{
  const context=await scan(await repository({'composer.json':json({autoload:{classmap:['legacy']}}),'entry.php':'<?php use App\\Thing;','legacy/good.php':'<?php namespace App;class Thing{}','legacy/other.hh':'<?php namespace App;class Thing{}'}));assert.equal(outcomes(context)[0]!.outcome.status,'unsupported');assert.match(outcomes(context)[0]!.outcome.reason!,/HH classmap/);
});
test('PHP transitive proof-hop budgets retain explicit gaps and never truncate a claimed import proof',async()=>{
  const files:Record<string,string>={'entry.php':'<?php include __DIR__."/f0.php";use function Deep\\helper;'};for(let i=0;i<70;i++)files[`f${i}.php`]=i===69?'<?php namespace Deep;function helper(){}':`<?php include __DIR__."/f${i+1}.php";`;const context=await scan(await repository(files));const imported=outcomes(context).find(item=>item.kind==='use-function')!;assert.equal(imported.outcome.status,'unsupported');assert.match(imported.outcome.reason!,/proof-hop budget/);assert.equal(outcomes(context).find(item=>item.kind==='include')!.outcome.status,'resolved');
});
test('PHP conditional loaded declarations retain activation conditions and their own path proof',async()=>{
  const context=await scan(await repository({'entry.php':'<?php include __DIR__."/one.php";include __DIR__."/other.php";use function App\\helper;','one.php':'<?php namespace App;if($ready){function helper(){}}','other.php':'<?php function unrelated(){}'}));const imported=outcomes(context).find(item=>item.kind==='use-function')!,edge=[...context.graph.relations.values()].find(relation=>relation.from===context.files.get('entry.php')!.id&&relation.to===imported.outcome.targets![0])!;assert.ok(edge.evidence.some(proof=>proof.file==='one.php'));assert.ok(!edge.evidence.some(proof=>proof.file==='other.php'));assert.ok(Object.values(edge.metadata!.targetConditions as Record<string,string[]>).some(conditions=>conditions.some(condition=>condition.includes('if'))));
});
test('PHP unknown dev classmap exclusions cannot certify an unchanged main classmap winner',async()=>{
  const context=await scan(await repository({'composer.json':json({autoload:{classmap:['legacy']},'autoload-dev':{'exclude-from-classmap':['/legacy/']}}),'entry.php':'<?php use App\\Thing;','legacy/good.php':'<?php namespace App;class Thing{}'}));assert.equal(outcomes(context)[0]!.outcome.status,'unsupported');
});
