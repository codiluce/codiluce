import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PhpParser } from '../src/analysis/php/client.js';
import { SourceText } from '../src/analysis/source-map.js';
import { indexRepository } from '../src/pipeline/index.js';
import { resolveConfig } from '../src/core/config.js';
import { fileAnalysis } from '../src/analysis/facts.js';
import { GraphBuilder, stableId } from '../src/core/graph.js';
import { filesystemAnalyzer } from '../src/analyzers/filesystem.js';
import { phpStructureAnalyzer } from '../src/analysis/languages/php.js';
import type { AnalysisContext } from '../src/core/analyzer.js';
import { AnalysisCache } from '../src/pipeline/cache.js';
import { canonicalJson } from '../src/history/fingerprint.js';

const parser = new PhpParser(), roots: string[] = [];
after(async () => { parser.close(); await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });
const parse = (source: string) => parser.parseSource(source);
async function repository(files: Record<string,string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codiluce-php-')); roots.push(root);
  for (const [file, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); }
  return root;
}
const names = (facts: Awaited<ReturnType<typeof parse>>) => facts.declarations.map(d => [d.name, d.kind]);

test('PHP source structure covers classes, interfaces, traits, backed/pure enums and named functions', async () => {
  const facts = await parse('<?php namespace Demo; class Item {} interface Contract { function read(): string; } trait Shared { function help(){} } enum Status: string { case Active="a"; } enum Flag {case Yes;} function run(){}');
  assert.deepEqual(names(facts), [['Item','class'],['Contract','interface'],['read','method'],['Shared','trait'],['help','method'],['Status','enum'],['Active','enum-case'],['Flag','enum'],['Yes','enum-case'],['run','function']]);
  assert.deepEqual(facts.issues, []); assert.ok(facts.declarations.every(d => d.qualifiedName.startsWith('Demo\\')));
  const contract = facts.declarations.find(d => d.name === 'Contract')!, method = facts.declarations.find(d => d.name === 'read')!;
  assert.equal(method.parent, contract.key); assert.equal(method.declarationForm, 'declaration');
});
test('PHP original constructors/destructors, case-sensitive names and explicit member owners survive', async () => {
  const f = await parse('<?php class A { function __construct(){} function __destruct(){} protected static function Read(){} private function readOther(){} }');
  assert.deepEqual(names(f), [['A','class'],['__construct','constructor'],['__destruct','destructor'],['Read','method'],['readOther','method']]);
  assert.ok(f.declarations.slice(1).every(d => d.parent === f.declarations[0]!.key)); assert.equal(f.declarations[3]!.visibility, 'protected'); assert.deepEqual(f.declarations[3]!.modifiers, ['static']);
});
test('PHP properties, group headers, typed constants and enum cases retain exact declarators', async () => {
  const source = '<?php const TOP=1, OTHER=2; class A {public readonly string $title; protected string $a="x", $b; public const string KIND="A", SECOND="B";}';
  const f = await parse(source); assert.deepEqual(names(f), [['TOP','constant'],['OTHER','constant'],['A','class'],['$title','property'],['$a','property'],['$b','property'],['KIND','class-constant'],['SECOND','class-constant']]);
  for (const name of ['$a','$b']) { const d=f.declarations.find(d=>d.name===name)!, detail=f.php!.declarations.find(p=>p.key===d.key)!; assert.equal(detail.type,'string'); assert.equal(detail.sharedHeader,'protected string'); }
  assert.equal(f.php!.declarations.find(p=>p.key===f.declarations.at(-1)!.key)!.sharedHeader,'public const string');
  assert.equal(f.declarations.find(d=>d.name==='$title')!.modifiers!.includes('readonly'),true);
});
test('PHP original property promotions are class children and parameter binders remain metadata', async () => {
  const f=await parse('<?php class A {function __construct(public readonly string $id, protected int $n=1, $plain=0) {}}');
  assert.deepEqual(names(f),[['A','class'],['__construct','constructor'],['$id','promoted-property'],['$n','promoted-property']]);
  assert.ok(f.declarations.slice(2).every(d=>d.parent===f.declarations[0]!.key)); assert.deepEqual(f.php!.bindings.map(b=>[b.name,b.promoted??false]),[['id',true],['n',true],['plain',false]]); assert.equal(f.declarations[3]!.visibility,'protected');
});
test('PHP 8.4 property hooks and asymmetric visibility retain original property ownership', async () => {
  const f=await parse('<?php class A {public private(set) string $name {get => "A  B"; set(string $value) {$this->name=$value;}}}');
  assert.deepEqual(names(f),[['A','class'],['$name','property'],['get','property-get'],['set','property-set']]);
  const prop=f.declarations[1]!; assert.ok(f.declarations.slice(2).every(d=>d.parent===prop.key)); assert.equal(f.php!.declarations.find(p=>p.key===prop.key)!.visibilitySet,'private'); assert.equal(f.declarations[2]!.signature,'get'); assert.equal(f.declarations[3]!.signature,'set(string $value)');
});
test('PHP promoted property hooks retain original parameters without synthesizing constructor assignments', async () => {
  const f=await parse('<?php class A {function __construct(public private(set) string $name {get => $this->name; set(string $value) {$this->name=$value;}}) {}}');
  assert.deepEqual(names(f),[['A','class'],['__construct','constructor'],['$name','promoted-property'],['get','property-get'],['set','property-set']]);const prop=f.declarations[2]!;assert.ok(f.declarations.slice(3).every(d=>d.parent===prop.key));assert.equal(f.php!.declarations.find(d=>d.key===prop.key)!.visibilitySet,'private');assert.deepEqual(f.php!.bindings.map(b=>b.name),['name','value']);
});
test('PHP attributes and inherited type names are syntax, without generated declarations or edges', async () => {
  const source='<?php #[Marker("{😀}")] final class A extends Base implements One, Two {#[Mark] public function read(): ?Base {return null;}}';
  const f=await parse(source); assert.deepEqual(names(f),[['A','class'],['read','method']]); assert.equal(f.declarations[0]!.signature,'#[Marker("{😀}")] final class A extends Base implements One, Two');
  assert.deepEqual(f.php!.declarations[0]!.bases.map(b=>[b.kind,b.text]),[['extends','Base'],['implements','One'],['implements','Two']]); assert.equal(f.php!.declarations[1]!.attributes[0]!.text,'#[Mark]');
});
test('PHP namespace scopes reset imports, including repeated bracketed and global namespaces', async () => {
  const f=await parse('<?php namespace A {use Vendor\\First as Pick; function run(){}} namespace A {use Vendor\\Second as Pick; function other(){}} namespace {function globalRun(){}}');
  assert.deepEqual(f.php!.namespaces.map(n=>n.name),['A','A','']); assert.notEqual(f.php!.imports[0]!.scope,f.php!.imports[1]!.scope); assert.deepEqual(f.declarations.map(d=>d.qualifiedName),['A\\run','A\\other','globalRun']);
});
test('PHP grouped class/function/constant imports retain independent namespaces and aliases', async () => {
  const f=await parse('<?php namespace A; use Vendor\\{Thing as Pick, function helper as callIt, const FLAG}; use function Tools\\go; use const Tools\\VALUE;');
  assert.deepEqual(f.php!.imports.map(i=>[i.kind,i.specifier,i.alias]),[['class','Vendor\\Thing','Pick'],['function','Vendor\\helper','callIt'],['const','Vendor\\FLAG','FLAG'],['function','Tools\\go','go'],['const','Tools\\VALUE','VALUE']]); assert.deepEqual(f.declarations,[]);
});
test('PHP trait adaptations remain original syntax and do not clone or rename methods', async () => {
  const f=await parse('<?php trait Shared {function read(){}} class A {use Shared, Other {Shared::read insteadof Other; Shared::read as protected renamed;}}');
  assert.deepEqual(names(f),[['Shared','trait'],['read','method'],['A','class']]); assert.deepEqual(f.php!.traits[0]!.names,['Shared','Other']); assert.equal(f.php!.traits[0]!.adaptations.length,2); assert.equal(f.php!.traits[0]!.owner,f.declarations[2]!.key);
});
test('PHP nested functions retain namespace identity and original conditional/deferred activation', async () => {
  const f=await parse('<?php namespace Demo; function outer() {if(true){function nested(){}}} if(false){class Conditional {function read(){}}}');
  const nested=f.declarations.find(d=>d.name==='nested')!, cls=f.declarations.find(d=>d.name==='Conditional')!; assert.equal(nested.qualifiedName,'Demo\\nested'); assert.equal(nested.parent,f.declarations[0]!.key); assert.ok(nested.sourceConditions!.some(s=>s.includes('invoked'))); assert.ok(nested.sourceConditions!.some(s=>s.includes('if'))); assert.ok(cls.sourceConditions!.some(s=>s.includes('if')));
});
test('PHP named closure/arrow variable bindings retain source only and lexical ownership', async () => {
  const f=await parse('<?php namespace Demo; $one=static function &($value) use (&$other) {return $value;}; function outer() {$two=fn($x=["a"=>"A  B"])=>$x;}');
  assert.deepEqual(names(f),[['$one','closure-binding'],['outer','function'],['$two','arrow-binding']]); assert.equal(f.declarations[0]!.declarationForm,'definition'); assert.ok(f.declarations[0]!.modifiers!.includes('static')); assert.ok(f.declarations[0]!.modifiers!.includes('by-reference')); assert.equal(f.declarations[2]!.parent,f.declarations[1]!.key); assert.equal(f.declarations[2]!.signature,'$two=fn($x=["a"=>"A  B"])'); assert.equal(f.php!.bindings.find(b=>b.kind==='closure-capture')!.name,'other');
});
test('PHP anonymous callbacks/class bodies are explicit regions with no invented named owners', async () => {
  const f=await parse('<?php register(function($x){return $x;}); $object=new class {public function hidden(){}}; function visible(){}');
  assert.deepEqual(names(f),[['visible','function']]); assert.deepEqual(f.php!.regions.map(r=>r.kind),['closure','anonymous-class']); assert.ok(f.issues.some(i=>i.code==='php-anonymous-class-gap')); assert.ok(!f.issues.some(i=>i.code==='php-unbound-callable-gap')); assert.equal(f.php!.bindings[0]!.owner,f.php!.regions[0]!.callable!.key);
});
test('PHP anonymous regions retain original headers, bodies, attributes, modifiers and capture binders', async () => {
  const original='😀\r\n<?php namespace Demo; function outer(){register(#[Tag("😀")] static function &($x) use (&$captured): int {function nested(){} return $x;});}';
  const f=await parse(original), region=f.php!.regions.find(region=>region.kind==='closure')!, callable=region.callable!, map=new SourceText(original);
  assert.deepEqual(f.issues,[]);assert.equal(f.php!.complete,true);assert.deepEqual(names(f),[['outer','function'],['nested','function']]);
  assert.equal(callable.signature,'#[Tag("😀")] static function &($x) use (&$captured): int');assert.deepEqual(callable.modifiers,['static','by-reference']);assert.equal(callable.attributes[0]!.text,'#[Tag("😀")]');assert.equal(callable.namespace,'Demo');assert.equal(callable.parent,f.declarations[0]!.key);assert.equal(f.declarations[1]!.parent,callable.key);assert.equal(f.declarations[1]!.qualifiedName,'Demo\\nested');
  const start=original.indexOf('#[Tag'),end=original.indexOf('return $x;')+'return $x;}'.length,keyword=original.indexOf('function &'),body=original.indexOf('{function nested');
  assert.equal(region.start,start);assert.equal(region.end,end);assert.deepEqual(region.range,map.range(start,end));assert.deepEqual(callable.keywordRange,map.range(keyword,keyword+'function'.length));assert.deepEqual(callable.bodyRange,map.range(body,end));assert.deepEqual(callable.headerRange,map.range(start,body));
  assert.deepEqual(f.php!.bindings.map(binding=>[binding.name,binding.kind,binding.owner,binding.byReference]),[['captured','closure-capture',callable.key,true],['x','parameter',callable.key,undefined]]);
});
test('PHP nested arrow regions sharing an end offset keep separate lexical source owners', async () => {
  const original='<?php register(fn($a)=>fn($b)=>$a+$b);';const f=await parse(original),[outer,inner]=f.php!.regions;
  assert.deepEqual(f.issues,[]);assert.equal(outer!.end,inner!.end);assert.notEqual(outer!.callable!.key,inner!.callable!.key);assert.equal(inner!.callable!.parent,outer!.callable!.key);assert.equal(outer!.callable!.signature,'fn($a)');assert.equal(inner!.callable!.signature,'fn($b)');assert.deepEqual(f.php!.bindings.map(binding=>[binding.name,binding.owner]),[['a',outer!.callable!.key],['b',inner!.callable!.key]]);
});
test('PHP anonymous callable extraction retains explicit source budgets and subsequent healthy jobs', async () => {
  const header=await parse('<?php register(function($text="'+'x'.repeat(5000)+'"){return $text;});');assert.ok(header.issues.some(issue=>issue.code==='php-header-budget'));assert.equal(header.php!.complete,false);assert.ok(header.php!.regions[0]!.callable!.signature.length<=4096);
  const many=await parse('<?php '+Array.from({length:4100},()=>`register(function(){});`).join(''));assert.equal(many.truncated,true);assert.ok(many.php!.regions.length<=4096);assert.ok(many.issues.some(issue=>issue.code==='php-structure-budget'));assert.deepEqual((await parse('<?php register(fn()=>1);')).issues,[]);
});
test('PHP anonymous graph identity owns nested declarations and calls while named bindings have one entity', async () => {
  const source='<?php namespace Demo; function target(){} function outer(){register(function($arg) use ($captured){function nested(){} target();}); $bound=fn()=>target(); register(fn()=>fn()=>target());}';
  const root=await repository({'entry.php':source}),cache=new AnalysisCache(path.join(root,'.codiluce/cache'));
  const graphs=[await indexRepository(root,{cache}),await indexRepository(root,{cache}),await indexRepository(root,{revision:'original'})];
  for(const graph of graphs){
    const file=graph.entities.find(entity=>entity.type==='file'&&entity.path==='entry.php')!,outer=graph.entities.find(entity=>entity.name==='outer')!,nested=graph.entities.find(entity=>entity.name==='nested')!,target=graph.entities.find(entity=>entity.name==='target')!,anonymous=graph.entities.filter(entity=>entity.metadata.anonymous===true);
    assert.equal(fileAnalysis(file.metadata.analysis)!.features.structure.status,'supported');assert.equal(anonymous.length,3);assert.ok(anonymous.every(entity=>entity.type==='function'&&['function','fn'].includes(entity.name)&&entity.metadata.qualifiedName===undefined));
    const closure=anonymous.find(entity=>entity.name==='function')!;assert.equal(closure.parentId,outer.id);assert.equal(nested.parentId,closure.id);assert.ok(graph.relations.some(edge=>edge.type==='contains'&&edge.from===closure.id&&edge.to===nested.id));assert.ok(graph.relations.some(edge=>edge.type==='calls'&&edge.from===closure.id&&edge.to===target.id));assert.ok(!graph.relations.some(edge=>edge.type==='calls'&&edge.from===outer.id&&edge.to===target.id));
    assert.equal(graph.entities.filter(entity=>entity.name==='$bound').length,1);const arrows=anonymous.filter(entity=>entity.name==='fn'),inner=arrows.find(entity=>arrows.some(parent=>parent.id===entity.parentId))!;assert.ok(inner);assert.ok(graph.relations.some(edge=>edge.type==='calls'&&edge.from===inner.id&&edge.to===target.id));
    const syntax=file.metadata.phpSyntax as Awaited<ReturnType<typeof parse>>['php'];assert.ok(syntax!.bindings.filter(binding=>binding.name==='arg'||binding.name==='captured').every(binding=>binding.owner===(closure.metadata.phpCallable as {key:string}).key));
  }
  for(const field of ['entities','relations']as const)for(const graph of graphs.slice(1))assert.equal(canonicalJson(graph[field]),canonicalJson(graphs[0]![field]));
  const before=graphs[0]!.entities.filter(entity=>entity.metadata.anonymous===true).map(entity=>entity.id).sort();await writeFile(path.join(root,'entry.php'),source.replace('function nested(){} target();','function nested(){} target(); $extra=1;'));
  const after=await indexRepository(root,{cache});assert.deepEqual(after.entities.filter(entity=>entity.metadata.anonymous===true).map(entity=>entity.id).sort(),before);
});
test('PHP Laravel original callbacks retain source containment without named runtime registrations', async () => {
  const root=await repository({'app/Http/Controllers/IndexController.php':'<?php namespace App\\Http\\Controllers; class IndexController {public function __construct(){ $this->middleware(function($request,$next){return $next($request);}); } }'}),config=await resolveConfig(root,{repository:{name:'fixture'},applications:[{name:'laravel',path:'.',frameworks:['laravel'],ecosystems:['php']}]});
  const graph=await indexRepository(root,{config}),file=graph.entities.find(entity=>entity.type==='file'&&entity.path?.endsWith('IndexController.php'))!,constructor=graph.entities.find(entity=>entity.name==='__construct')!,callback=graph.entities.find(entity=>entity.metadata.anonymous===true)!;
  assert.equal(fileAnalysis(file.metadata.analysis)!.features.structure.status,'supported');assert.ok(constructor);assert.equal(callback.parentId,constructor.id);assert.equal(callback.name,'function');assert.equal(callback.metadata.qualifiedName,undefined);assert.equal(callback.metadata.executionUnverified,true);assert.ok(callback.evidence.every(proof=>proof.analyzer==='php-laravel-structure'));assert.ok(!graph.entities.some(entity=>entity.name.includes('{closure')));
});
test('PHP literal/comment/heredoc/inline HTML contents cannot invent declarations', async () => {
  const f=await parse('<?php /* class Fake {} */ $text="function Fake() {}"; $doc=<<<\'TEXT\'\nclass Pretend {}\nTEXT;\nfunction real() {} ?> <script>function Client(){}</script>');
  assert.deepEqual(names(f),[['real','function']]); assert.equal(f.php!.regions[0]!.kind,'inline-html'); assert.equal(f.php!.regions[0]!.conditions.length,0);
});
test('PHP source headers retain literal whitespace and braces in defaults without including bodies', async () => {
  const f=await parse('<?php function read($x=["}"=>"A  B"], $y="{"): string /* original */ {return "body";}');
  assert.equal(f.declarations[0]!.signature,'function read($x=["}"=>"A  B"], $y="{"): string'); assert.ok(!f.declarations[0]!.signature.includes('body'));
});
test('PHP nullable, union and intersection named types do not duplicate lookahead tokens in original headers', async () => {
  const f=await parse('<?php class A {private ?Response $response=null; function read(Response $response, string|Transition|null $subject, (One&Two)|Three $value): ?Response {}}');
  assert.equal(f.declarations[1]!.signature,'?Response $response');assert.equal(f.declarations[2]!.signature,'function read(Response $response, string|Transition|null $subject, (One&Two)|Three $value): ?Response');assert.deepEqual(f.issues,[]);
});
test('PHP UTF-16 ranges retain emoji, CRLF and Unicode source identifiers', async () => {
  const source='😀\r\n<?php namespace Démo; #[Tag("😀")] class Élément {function lire(){}}';
  const f=await parse(source), map=new SourceText(source); assert.deepEqual(names(f),[['Élément','class'],['lire','method']]);
  for(const d of f.declarations){assert.deepEqual(d.range,map.range(d.start,d.end)); const detail=f.php!.declarations.find(p=>p.key===d.key)!; assert.equal(detail.nameRange.startLine,2);}
});
test('PHP literal and dynamic include expressions are source sites without guessed filesystem targets', async () => {
  const f=await parse('<?php include "a.php"; include_once __DIR__ . "/b.php"; require $dynamic; if($ready){require_once "c.php";}');
  assert.deepEqual(f.php!.loads.map(l=>[l.kind,l.expression]),[['include','"a.php"'],['include_once','__DIR__ . "/b.php"'],['require','$dynamic'],['require_once','"c.php"']]); assert.ok(f.php!.loads[3]!.conditions.some(c=>c.includes('if')));
});
test('PHP parser failures reset the worker and preserve subsequent valid source analysis', async () => {
  await assert.rejects(parse('<?php class Broken {function read( {'),/Parse Error|syntax|unexpected/i); assert.deepEqual(names(await parse('<?php function healthy(){}')),[['healthy','function']]);
});
test('PHP worker deadlines are cancellable and do not poison subsequent parser jobs', async () => {
  const short=new PhpParser(1);try{await assert.rejects(short.parseSource('<?php class A {}'),/exceeded/);}finally{short.close();}assert.equal((await parse('<?php class Healthy {}')).declarations[0]!.name,'Healthy');
});
test('PHP declaration and depth budgets retain bounded partial results without blocking later jobs', async () => {
  for(const source of ['<?php '+Array.from({length:4200},(_,i)=>`function f${i}(){}`).join(''), '<?php '+ 'if(true){'.repeat(140)+'function Deep(){}'+'}'.repeat(140)]) {const f=await parse(source);assert.ok(f.truncated);assert.ok(f.declarations.length<=4096);assert.ok(f.issues.length<=100);assert.ok(f.issues.some(i=>i.code==='php-structure-budget'));}assert.equal((await parse('<?php function Healthy(){}')).declarations[0]!.name,'Healthy');
});
test('PHP headers over the profile budget retain explicit findings instead of unbounded metadata', async () => {
  const f=await parse('<?php function read($text="'+ 'x'.repeat(5000)+'"){}'); assert.ok(f.issues.some(i=>i.code==='php-header-budget')); assert.ok(f.declarations[0]!.signature.length<=4096);
});
test('PHP original facts are deterministic across unrelated jobs', async () => {
  const source='<?php namespace App; class A {function read(){}} $f=fn()=>1;';const a=await parse(source);await parse('<?php trait Other {function other(){}}');assert.deepEqual(await parse(source),a);
});
test('Generic PHP has usable source structure outside configured applications, with honest capability outcomes', async () => {
  const root=await repository({'source.php':'<?php namespace App; class Item {function read(){}} function run(){}','bad.php':'<?php class Broken {','page.php':'<p>HTML</p>'});const graph=await indexRepository(root);const file=graph.entities.find(e=>e.path==='source.php'&&e.type==='file')!, analysis=fileAnalysis(file.metadata.analysis)!;assert.equal(analysis.adapter,'php-original-structure');assert.equal(analysis.parser!.version,'3.7.0');assert.equal(analysis.features.structure.status,'supported');assert.equal(analysis.features.imports.status,'partial');assert.equal(analysis.features.references.status,'partial');for(const key of ['framework','effects','guards']as const)assert.equal(analysis.features[key].status,'unsupported');const cls=graph.entities.find(e=>e.name==='Item')!, method=graph.entities.find(e=>e.name==='read')!;assert.equal(cls.parentId,file.id);assert.equal(method.parentId,cls.id);assert.ok(method.sourceRange);assert.ok(!graph.relations.some(r=>r.type==='calls'||r.type==='imports'||r.type==='extends'));assert.equal(fileAnalysis(graph.entities.find(e=>e.path==='bad.php'&&e.type==='file')!.metadata.analysis)!.features.structure.status,'failed');assert.equal(fileAnalysis(graph.entities.find(e=>e.path==='page.php'&&e.type==='file')!.metadata.analysis)!.features.structure.status,'supported');
});
test('PHP structure respects exclusions, size limits and symlinks', async () => {
  const root=await repository({'good.php':'<?php function good(){}','ignored/poison.php':'<?php function poison(){}','large.php':'<?php '+' '.repeat(200)+'function large(){}'});await symlink(path.join(root,'good.php'),path.join(root,'link.php'));const config={...await resolveConfig(root,{repository:{name:'fixture'},ignore:['ignored/**']}),maxFileBytes:128};const graph=await indexRepository(root,{config});assert.ok(graph.entities.some(e=>e.name==='good'));assert.ok(!graph.entities.some(e=>['poison','large'].includes(e.name)));assert.equal(fileAnalysis(graph.entities.find(e=>e.path==='large.php'&&e.type==='file')!.metadata.analysis)!.features.structure.status,'disabled');assert.ok(!graph.entities.some(e=>e.path==='link.php'&&e.type==='function'));
});
test('PHP cache and revision replay preserve graph identity and body-only edits keep source symbol IDs', async () => {
  const root=await repository({'entry.php':'<?php namespace App; class A {function read(){return 1;}}','other.php':'<?php function other(){}'}), cache=new AnalysisCache(path.join(root,'.codiluce/cache'));await mkdir(path.join(root,'.codiluce'),{recursive:true});const first=await indexRepository(root,{cache}),warm=await indexRepository(root,{cache}),revision=await indexRepository(root,{revision:'recorded'});for(const key of ['entities','relations','diagnostics']as const)assert.equal(canonicalJson(first[key]),canonicalJson(warm[key]));for(const key of ['entities','relations']as const)assert.equal(canonicalJson(first[key]),canonicalJson(revision[key]));assert.equal(canonicalJson(first.diagnostics.filter(d=>d.analyzer==='php-structure')),canonicalJson(revision.diagnostics.filter(d=>d.analyzer==='php-structure')));assert.ok(cache.events.some(e=>e.analyzer==='php-analysis'&&e.hit));assert.ok(!cache.events.some(e=>e.analyzer==='php-syntax-facts'&&e.hit));await writeFile(path.join(root,'entry.php'),'<?php namespace App; class A {function read(){return 1;}}\n');const shifted=await indexRepository(root,{cache});for(const name of ['A','read'])assert.equal(first.entities.find(e=>e.name===name)!.id,shifted.entities.find(e=>e.name===name)!.id);await writeFile(path.join(root,'entry.php'),'<?php namespace App; class A {function read(){return 2;}}');const changed=await indexRepository(root,{cache});for(const name of ['A','read'])assert.equal(first.entities.find(e=>e.name===name)!.id,changed.entities.find(e=>e.name===name)!.id);assert.notEqual(first.entities.find(e=>e.name==='read')!.metadata.contentHash,changed.entities.find(e=>e.name==='read')!.metadata.contentHash);assert.equal(cache.events.filter(e=>e.analyzer==='php-syntax-facts'&&e.unit==='entry.php').at(-1)!.hit,false);
});
test('PHP duplicate conditional declarations remain separate source sites with explicit activation conditions', async () => {
  const root=await repository({'entry.php':'<?php if($a){function read(){}}else{function read(){}}'});const graph=await indexRepository(root);const declarations=graph.entities.filter(e=>e.type==='function');assert.equal(declarations.length,2);assert.notEqual(declarations[0]!.id,declarations[1]!.id);assert.ok(declarations.every(e=>(e.metadata.sourceConditions as string[]).length>0));
});
test('PHP source changes after scanning are rejected before syntax-cache replay', async () => {
  const root=await repository({'entry.php':'<?php function original(){}'}),config=await resolveConfig(root,{repository:{name:'fixture'}}),cache=new AnalysisCache(path.join(root,'.codiluce/cache'));
  await indexRepository(root,{config,cache});const graph=new GraphBuilder('fixture'),context:AnalysisContext={root,config,cache,graph,repositoryId:graph.id('repository'),applicationIds:new Map(),files:new Map(),http:[]};await filesystemAnalyzer.analyze(context);await writeFile(path.join(root,'entry.php'),'<?php function changedAfterScan(){}');await phpStructureAnalyzer.analyze(context);assert.ok([...graph.diagnostics.values()].some(d=>d.code==='php-structure-failed'&&d.reason.includes('changed after the scan')));assert.ok(![...graph.entities.values()].some(e=>e.type==='function'));
});
test('PHP source structure preserves the established Laravel analyzer and original symbol IDs', async () => {
  const root=await repository({'app/Service.php':'<?php namespace App; class Service {function read(){return 1;}}','generic/source.php':'<?php function standalone(){}'});const config=await resolveConfig(root,{repository:{name:'fixture'},applications:[{name:'laravel',path:'app',frameworks:['laravel'],ecosystems:['php']},{name:'generic',path:'generic',ecosystems:['php']}]});const graph=await indexRepository(root,{config});const service=graph.entities.find(e=>e.name==='Service')!;assert.equal(service.id,stableId('symbol','fixture','php','laravel','App\\Service'));assert.ok(service.evidence.every(e=>e.analyzer==='php-laravel'));assert.equal(fileAnalysis(graph.entities.find(e=>e.path==='app/Service.php'&&e.type==='file')!.metadata.analysis)!.adapter,'php');assert.equal(graph.entities.filter(e=>e.name==='Service').length,1);assert.ok(graph.entities.find(e=>e.name==='standalone')!.evidence.some(e=>e.analyzer==='php-structure'));
});
