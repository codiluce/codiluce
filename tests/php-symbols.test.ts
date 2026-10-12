import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {indexRepository} from '../src/pipeline/index.js';
import {resolveConfig} from '../src/core/config.js';
import {AnalysisCache} from '../src/pipeline/cache.js';
import {canonicalJson} from '../src/history/fingerprint.js';
import {stableId,type SoftwareGraph} from '../src/core/graph.js';
import {fileAnalysis} from '../src/analysis/facts.js';
import {PHP_SYMBOL_VERSION} from '../src/analysis/languages/php-symbols.js';

interface Outcome {expression:string;kind:string;scope:string;owner?:string;status:string;target?:string;dispatch?:string;reason?:string;candidates?:string[];range:{startLine:number};proof:{file?:string;line?:number}[]}
const roots:string[]=[];after(async()=>{await Promise.all(roots.map(root=>rm(root,{recursive:true,force:true})));});
async function repository(files:Record<string,string>){const root=await mkdtemp(path.join(os.tmpdir(),'codiluce-php-symbols-'));roots.push(root);for(const[file,content]of Object.entries(files)){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),content);}return root;}
async function scan(source:string,files:Record<string,string>={},laravel=false){const root=await repository({'entry.php':source,...files}),config=await resolveConfig(root,{repository:{name:'php-symbols'},applications:[{name:'app',path:'.',frameworks:laravel?['laravel']:[],ecosystems:['php']}]});return indexRepository(root,{config});}
const outcomes=(graph:SoftwareGraph,file='entry.php')=>(graph.entities.find(entity=>entity.type==='file'&&entity.path===file)!.metadata.phpCallOutcomes??[]) as Outcome[];
const calls=(graph:SoftwareGraph)=>(outcomes(graph)).filter(outcome=>['call','constructor','callable-reference'].includes(outcome.kind));
const by=(graph:SoftwareGraph,expression:string)=>calls(graph).find(outcome=>outcome.expression.startsWith(expression))!;
const target=(graph:SoftwareGraph,outcome:Outcome)=>graph.entities.find(entity=>entity.id===outcome.target);
const owner=(graph:SoftwareGraph,outcome:Outcome)=>graph.entities.find(entity=>entity.id===outcome.owner);

test('Original PHP functions bind through independent function/class/constant namespace tables',async()=>{
  const graph=await scan('<?php namespace Tools {function read(){}class read{}const FLAG=1;} namespace App {use function Tools\\read as fnRead;use Tools\\read as Pick;use const Tools\\FLAG as FLAG;fnRead();new Pick();$x=FLAG;}');
  assert.equal(target(graph,by(graph,'fnRead('))!.metadata.qualifiedName,'Tools\\read');assert.equal(target(graph,by(graph,'new Pick('))!.metadata.declarationKind,'class');const constant=outcomes(graph).find(outcome=>outcome.kind==='constant-reference')!;assert.equal(target(graph,constant)!.metadata.declarationKind,'constant');
});
test('Qualified namespace aliases, relative names and fully qualified names bind at actual use sites',async()=>{
  const graph=await scan('<?php namespace Tools {function read(){}class Service{static function run(){}}} namespace App {use Tools as T;function read(){} T\\read();namespace\\read();\\Tools\\read();T\\Service::run();}');
  assert.deepEqual(calls(graph).map(outcome=>[outcome.status,target(graph,outcome)?.metadata.qualifiedName]),[['resolved','Tools\\read'],['resolved','App\\read'],['resolved','Tools\\read'],['resolved','Tools\\Service::run']]);
});
test('Unqualified PHP function lookup retains namespace priority and reviewed global fallback',async()=>{
  const graph=await scan('<?php namespace {function read(){}function fallback(){}} namespace App {function read(){} read();fallback();}');assert.equal(target(graph,by(graph,'read('))!.metadata.qualifiedName,'App\\read');assert.equal(target(graph,by(graph,'fallback('))!.metadata.qualifiedName,'fallback');
});
test('Conditional namespace declarations cannot hide a competing global function',async()=>{
  const graph=await scan('<?php namespace {function read(){}} namespace App {if($ready){function read(){}} read();}');assert.equal(by(graph,'read(').status,'ambiguous');assert.equal(by(graph,'read(').candidates!.length,2);
});
test('Repeated namespace blocks keep their original import tables independent',async()=>{
  const graph=await scan('<?php namespace One{function read(){}}namespace Two{function read(){}}namespace App{use function One\\read as run;run();}namespace App{use function Two\\read as run;run();}');assert.deepEqual(calls(graph).map(outcome=>target(graph,outcome)!.metadata.qualifiedName),['One\\read','Two\\read']);
});
test('Duplicate namespace aliases remain explicit ambiguous outcomes without guessed calls',async()=>{
  const graph=await scan('<?php namespace App;use function One\\read as run;use function Two\\read as run;run();');assert.equal(by(graph,'run(').status,'ambiguous');assert.ok(!graph.relations.some(edge=>edge.type==='calls'));
});
test('PHP name folding is ASCII-only and constant aliases keep their basename case',async()=>{
  const graph=await scan('<?php namespace Demo;function Å(){}function read(){}const FLAG=1;Å();å();READ();$one=FLAG;$two=flag;');assert.deepEqual(calls(graph).map(outcome=>outcome.status),['resolved','unresolved','resolved']);assert.deepEqual(outcomes(graph).filter(outcome=>outcome.kind==='constant-reference').map(outcome=>outcome.status),['resolved','unresolved']);
});
test('Source functions loaded by original literal require sites retain their load proof',async()=>{
  const graph=await scan('<?php require __DIR__."/loaded.php";loaded();',{'loaded.php':'<?php function loaded(){}'});const outcome=by(graph,'loaded(');assert.equal(target(graph,outcome)!.path,'loaded.php');assert.ok(outcome.proof.some(proof=>proof.file==='entry.php'));assert.ok(outcome.proof.some(proof=>proof.file==='loaded.php'));
});
test('Concrete class namespace uses follow indexed Composer PSR-4 source contracts',async()=>{
  const graph=await scan('<?php namespace App;use Vendor as V;$value=new V\\Service();$value->read();',{'composer.json':JSON.stringify({autoload:{'psr-4':{'Vendor\\':'src'}}}),'src/Service.php':'<?php namespace Vendor;class Service{function read(){}}'});assert.equal(target(graph,by(graph,'$value->read('))!.path,'src/Service.php');assert.ok(by(graph,'$value->read(').proof.some(proof=>proof.file==='composer.json'));
});
test('Named functions have distinct local variable scopes even inside another function',async()=>{
  const graph=await scan('<?php class Service{function read(){}} function outer(){ $obj=new Service();function nested(){$obj->read();}$obj->read();}');const sites=calls(graph).filter(outcome=>outcome.expression.startsWith('$obj->read'));assert.deepEqual(sites.map(outcome=>[owner(graph,outcome)!.name,outcome.status]),[['nested','unresolved'],['outer','resolved']]);
});
test('Nested named function return types cannot borrow their enclosing method lexical class',async()=>{
  const graph=await scan('<?php final class A{function read(){}function run(){function nested():self{}nested()->read();}}');assert.equal(by(graph,'nested()->read(').status,'unsupported');assert.ok(!graph.relations.some(edge=>edge.type==='calls'&&graph.entities.find(entity=>entity.id===edge.to)?.name==='read'));
});
test('PHP blocks share their callable scope but conditional writes retain a flow gap',async()=>{
  const graph=await scan('<?php class Service{function read(){}} function run(){if($yes){$obj=new Service();}$obj->read();}');assert.equal(by(graph,'$obj->read(').status,'unsupported');assert.match(by(graph,'$obj->read(').reason!,/conditional/);
});
test('Closure parameters shadow captured/outer parameters without leaking into their parent',async()=>{
  const graph=await scan('<?php final class A{function read(){}}final class B{function read(){}}function run(A $obj){$cb=function(B $obj){$obj->read();};$obj->read();}');const sites=calls(graph).filter(outcome=>outcome.expression.startsWith('$obj->read'));assert.deepEqual(sites.map(outcome=>[owner(graph,outcome)!.name,target(graph,outcome)!.metadata.qualifiedName]),[['$cb','B::read'],['run','A::read']]);
});
test('Closure assignments cannot contaminate the containing PHP local binding',async()=>{
  const graph=await scan('<?php class A{function read(){}}class B{function read(){}}function run(){$obj=new A();$cb=function(){$obj=new B();$obj->read();};$obj->read();}');const sites=calls(graph).filter(outcome=>outcome.expression.startsWith('$obj->read'));assert.deepEqual(sites.map(outcome=>target(graph,outcome)!.metadata.qualifiedName),['B::read','A::read']);
});
test('Closures only read explicit captures, while arrows capture callable locals automatically',async()=>{
  const graph=await scan('<?php final class A{function read(){}}function run(A $obj){$missing=function(){$obj->read();};$captured=function()use($obj){$obj->read();};$arrow=fn()=>$obj->read();}');assert.deepEqual(calls(graph).map(outcome=>[owner(graph,outcome)?.name,outcome.status]),[['$missing','unresolved'],['$captured','resolved'],['$arrow','resolved']]);
});
test('By-reference captures and aliases cannot certify a stable callable value',async()=>{
  const graph=await scan('<?php function helper(){}function run(){$cb=helper(...);$mutate=function()use(&$cb){};$cb();$other=helper(...);$alias=&$other;$other();}');assert.equal(by(graph,'$cb(').status,'unsupported');assert.equal(by(graph,'$other(').status,'unsupported');
});
test('Original array reference entries cannot certify an unmutated callable local',async()=>{
  const graph=await scan('<?php function helper(){}function run(){$cb=helper(...);$refs=[&$cb];unknown($refs);$cb();}');assert.equal(by(graph,'$cb(').status,'unsupported');
});
test('Static methods and static closures cannot inherit $this',async()=>{
  const graph=await scan('<?php final class A{function read(){}static function run(){$this->read();}function other(){$yes=fn()=>$this->read();$no=static fn()=>$this->read();}}');const sites=calls(graph).filter(outcome=>outcome.expression.startsWith('$this->read'));assert.deepEqual(sites.map(outcome=>outcome.status),['unsupported','resolved','unsupported']);
});
test('Unbound anonymous bodies use original lexical owners without a named callable registration',async()=>{
  const graph=await scan('<?php function helper(){}register(function(){helper();});');const outcome=by(graph,'helper('),callback=owner(graph,outcome)!;assert.equal(callback.metadata.anonymous,true);assert.equal(callback.name,'function');assert.equal(callback.metadata.qualifiedName,undefined);assert.equal(outcome.status,'resolved');assert.equal(target(graph,outcome)!.name,'helper');assert.ok(graph.relations.some(edge=>edge.type==='calls'&&edge.from===callback.id&&edge.to===outcome.target));assert.ok(!graph.entities.some(entity=>entity.name==='<closure>'));
});
test('Original named closures and arrow bindings become concrete invocation targets',async()=>{
  const graph=await scan('<?php function run(){$one=function(){};$one();$two=fn()=>1;$two();}');assert.equal(target(graph,by(graph,'$one('))!.metadata.declarationKind,'closure-binding');assert.equal(target(graph,by(graph,'$two('))!.metadata.declarationKind,'arrow-binding');
});
test('First-class callable captures are references, and their invocation is a direct call',async()=>{
  const graph=await scan('<?php function helper(){}function run(){$cb=helper(...);$cb();}');const reference=by(graph,'helper('),invocation=by(graph,'$cb(');assert.equal(reference.kind,'callable-reference');assert.equal(reference.target,invocation.target);assert.ok(graph.relations.some(edge=>edge.type==='references'&&edge.to===reference.target));assert.ok(graph.relations.some(edge=>edge.type==='calls'&&edge.to===reference.target));
});
test('Literal callable strings ignore compile-time namespace function aliases',async()=>{
  const graph=await scan('<?php namespace {function real(){}}namespace App{use function real as alias;function run(){$good="real";$good();$bad="alias";$bad();}}');assert.equal(by(graph,'$good(').status,'resolved');assert.equal(by(graph,'$bad(').status,'unresolved');
});
test('Concrete original object and static-method callback arrays bind without callback helpers',async()=>{
  const graph=await scan('<?php class A{function read(){}static function staticRead(){}}function run(){$instance=[new A(),"read"];$instance();$static=[A::class,"staticRead"];$static();}');assert.equal(target(graph,by(graph,'$instance('))!.metadata.qualifiedName,'A::read');assert.equal(target(graph,by(graph,'$static('))!.metadata.qualifiedName,'A::staticRead');
});
test('Unknown/by-reference callees invalidate escaped local callable arguments',async()=>{
  const graph=await scan('<?php function helper(){}function change(&$cb){}function run(){$one=helper(...);change($one);$one();$two=helper(...);unknown($two);$two();}');assert.equal(by(graph,'$one(').status,'unsupported');assert.equal(by(graph,'$two(').status,'unsupported');
});
test('Known value-only parameters preserve concrete original callable arguments',async()=>{
  const graph=await scan('<?php function helper(){}function consume($value){}function run(){$cb=helper(...);consume($cb);$cb();}');assert.equal(by(graph,'$cb(').status,'resolved');
});
test('Unknown intervening calls cannot certify stable global PHP variable state',async()=>{
  const graph=await scan('<?php function helper(){}$cb=helper(...);unknown();$cb();');assert.equal(by(graph,'$cb(').status,'unsupported');assert.match(by(graph,'$cb(').reason!,/global/);
});
test('Multiple writes, increments and unset prevent guessed variable call targets',async()=>{
  const graph=await scan('<?php function helper(){}function run(){$one=helper(...);$one=helper(...);$one();$two=helper(...);unset($two);$two();}');assert.equal(by(graph,'$one(').status,'unsupported');assert.equal(by(graph,'$two(').status,'unsupported');
});
test('Aliased extract, eval and global bindings retain explicit callable state gaps',async()=>{
  for(const body of ['use function extract as fill;function run(){$cb=fn()=>1;fill([]);$cb();}','function run(){$cb=fn()=>1;eval("ignored");$cb();}','function run(){global $cb;$cb();}']){const graph=await scan('<?php '+body);assert.equal(by(graph,'$cb(').status,'unsupported');}
});
test('Typed virtual receivers are source references; exact/final receivers have direct calls',async()=>{
  const graph=await scan('<?php class A{function read(){}}final class B{function read(){}}function run(A $one,B $two){$one->read();$two->read();$three=new A();$three->read();}');assert.equal(by(graph,'$one->read(').dispatch,'nominal');assert.equal(by(graph,'$two->read(').dispatch,'direct');assert.equal(by(graph,'$three->read(').dispatch,'direct');const first=by(graph,'$one->read(');assert.ok(graph.relations.some(edge=>edge.type==='references'&&edge.from===first.owner&&edge.to===first.target));
});
test('Original PHP call coverage distinguishes nominal references and first-class captures from calls',async()=>{
  const graph=await scan('<?php class A{function read(){}}function helper(){}function run(A $obj){$cb=helper(...);$cb();$obj->read();unknown();}'),run=graph.entities.find(entity=>entity.name==='run')!;
  assert.deepEqual(run.metadata.callSites,{resolved:1,external:0,unresolved:2,unresolvedNames:{read:1,unknown:1}});assert.deepEqual(run.metadata.phpCallSites,run.metadata.callSites);
});
test('Nullable types require nullsafe syntax and union/intersection types retain gaps',async()=>{
  const graph=await scan('<?php final class A{function read(){}}class B{}function run(?A $one,A|B $two){$one->read();$one?->read();$two->read();}');assert.equal(by(graph,'$one->read(').status,'unsupported');assert.equal(by(graph,'$one?->read(').status,'resolved');assert.equal(by(graph,'$two->read(').status,'unsupported');
});
test('Inherited constructors and methods retain original parent declaration identities',async()=>{
  const graph=await scan('<?php class Base{function __construct(){}function read(){}}class Child extends Base{}function run(){$obj=new Child();$obj->read();}');assert.equal(target(graph,by(graph,'new Child('))!.metadata.qualifiedName,'Base::__construct');assert.equal(target(graph,by(graph,'$obj->read('))!.metadata.qualifiedName,'Base::read');assert.ok(graph.relations.some(edge=>edge.type==='extends'));
});
test('Plain trait methods retain original trait identities, and competing traits stay ambiguous',async()=>{
  const graph=await scan('<?php trait Shared{function read(){}}class A{use Shared;}function run(){$obj=new A();$obj->read();}');assert.equal(target(graph,by(graph,'$obj->read('))!.metadata.qualifiedName,'Shared::read');const competing=await scan('<?php trait One{function read(){}}trait Two{function read(){}}class A{use One,Two;}function run(){$obj=new A();$obj->read();}');assert.equal(by(competing,'$obj->read(').status,'ambiguous');
});
test('Trait aliases and precedence remain explicit gaps without cloned source methods',async()=>{
  const graph=await scan('<?php trait Shared{function read(){}}class A{use Shared{read as renamed;}}function run(){$obj=new A();$obj->renamed();}');assert.equal(by(graph,'$obj->renamed(').status,'unsupported');assert.ok(!graph.entities.some(entity=>entity.name==='renamed'));
});
test('Private, abstract and invalid instance-as-static calls cannot certify direct targets',async()=>{
  const graph=await scan('<?php class A{private function hidden(){}function read(){}}abstract class B{abstract function missing();}function run(){$obj=new A();$obj->hidden();A::read();new B();}');assert.equal(by(graph,'$obj->hidden(').status,'unsupported');assert.equal(by(graph,'A::read(').status,'unsupported');assert.equal(by(graph,'new B(').status,'unsupported');
});
test('self and parent have lexical source targets while late static binding keeps a gap',async()=>{
  const graph=await scan('<?php class Base{static function read(){}}class A extends Base{static function run(){self::read();parent::read();static::read();}}');assert.equal(target(graph,by(graph,'self::read('))!.metadata.qualifiedName,'Base::read');assert.equal(target(graph,by(graph,'parent::read('))!.metadata.qualifiedName,'Base::read');assert.equal(by(graph,'static::read(').status,'unsupported');
});
test('new self and new parent use original lexical classes; new static remains unqualified',async()=>{
  const graph=await scan('<?php class Base{function __construct(){}}class Child extends Base{function run(){new self();new parent();new static();}}');assert.equal(target(graph,by(graph,'new self('))!.metadata.qualifiedName,'Base::__construct');assert.equal(target(graph,by(graph,'new parent('))!.metadata.qualifiedName,'Base::__construct');assert.equal(by(graph,'new static(').status,'unsupported');
});
test('Declared function return and promoted/property types keep source type references',async()=>{
  const graph=await scan('<?php final class A{function read(){}}class Holder{function __construct(public A $value){}function run(){$this->value->read();}}function make():A{return new A();}function run(){make()->read();}');assert.equal(target(graph,by(graph,'$this->value->read('))!.metadata.qualifiedName,'A::read');assert.equal(target(graph,by(graph,'make()->read('))!.metadata.qualifiedName,'A::read');
});
test('Laravel original structure reuses class/method IDs and adds interfaces, traits, functions and properties',async()=>{
  const graph=await scan('<?php namespace App;interface Contract{function read();}trait Shared{function help(){}}class A{public string $value;function read(){}}function helper(){}',{},true),cls=graph.entities.find(entity=>entity.name==='A')!,method=graph.entities.find(entity=>entity.name==='read'&&entity.parentId===cls.id)!;
  assert.equal(cls.id,stableId('symbol','php-symbols','php','app','App\\A'));assert.equal(method.id,stableId('symbol','php-symbols','php','app','App\\A::read','()'));assert.ok(method.evidence.every(proof=>proof.analyzer==='php-laravel'));assert.ok(method.metadata.phpDeclaration);for(const kind of ['interface','trait','function','property'])assert.ok(graph.entities.some(entity=>entity.metadata.declarationKind===kind));assert.equal(graph.entities.filter(entity=>entity.name==='A').length,1);
});
test('Laravel legacy locals cannot inherit closure parameters or descendant assignments',async()=>{
  const graph=await scan('<?php namespace App;class A{function read(){}}class B{function read(){}}class Service{function run(A $obj){$cb=function(B $obj){$obj->read();};$obj->read();}}',{},true),run=graph.entities.find(entity=>entity.name==='run')!,b=graph.entities.find(entity=>entity.metadata.qualifiedName==='App\\B::read')!;
  assert.ok(!graph.relations.some(edge=>edge.type==='calls'&&edge.from===run.id&&edge.to===b.id));const sites=calls(graph).filter(outcome=>outcome.expression.startsWith('$obj->read'));assert.deepEqual(sites.map(outcome=>owner(graph,outcome)!.name),['$cb','run']);
});
test('PHP bindings retain exact original UTF-16 ranges and original source proof locations',async()=>{
  const graph=await scan('😀\r\n<?php function helper(){}\r\nfunction run(){helper();}');const outcome=by(graph,'helper(');assert.equal(outcome.range.startLine,3);assert.ok(outcome.proof.some(proof=>proof.file==='entry.php'&&proof.line===3));assert.equal(target(graph,outcome)!.sourceRange!.startLine,2);
});
test('Native PHP binding metadata and graph identities survive cold/warm/revision analysis',async()=>{
  const root=await repository({'entry.php':'<?php function helper(){}function run(){$cb=helper(...);$cb();}'}),cache=new AnalysisCache(path.join(root,'.codiluce/cache'));
  const cold=await indexRepository(root,{cache}),warm=await indexRepository(root,{cache}),revision=await indexRepository(root,{revision:'original'});for(const key of ['entities','relations']as const){assert.equal(canonicalJson(cold[key]),canonicalJson(warm[key]));assert.equal(canonicalJson(cold[key]),canonicalJson(revision[key]));}assert.equal(cold.run!.analyzerVersions['php-symbols'],PHP_SYMBOL_VERSION);assert.ok(!JSON.stringify(cold).includes('"phpAst"'));const entity=cold.entities.find(entity=>entity.type==='file')!;assert.equal(fileAnalysis(entity.metadata.analysis)!.features.references.status,'partial');
});
test('Destructuring, foreach destructuring and short-circuit writes cannot certify callable values',async()=>{
  for(const body of ['$cb=fn()=>1;[$cb]=$items;','$cb=fn()=>1;foreach($items as [$cb]){}','$ready&&($cb=fn()=>1);']){
    const graph=await scan('<?php function run(){'+body+'$cb();}');assert.equal(by(graph,'$cb(').status,'unsupported');
  }
});
test('Original source includes retain local lifetime gaps without executing their bodies',async()=>{
  const graph=await scan('<?php function run(){$cb=fn()=>1;require __DIR__."/loaded.php";$cb();}',{'loaded.php':'<?php $cb=42;'});assert.equal(by(graph,'$cb(').status,'unsupported');
});
test('Property hooks inherit non-static original class ownership and $this',async()=>{
  const graph=await scan('<?php final class A{public A $value{get=>$this->read();}function read(){}}'),outcome=by(graph,'$this->read(');assert.equal(outcome.status,'resolved');assert.equal(owner(graph,outcome)!.metadata.declarationKind,'property-get');assert.equal(target(graph,outcome)!.name,'read');
});
test('Final typed receivers retain direct dispatch when methods are inherited',async()=>{
  const graph=await scan('<?php class Base{function read(){}}final class A extends Base{}function run(A $obj){$obj->read();}');assert.equal(by(graph,'$obj->read(').dispatch,'direct');assert.equal(target(graph,by(graph,'$obj->read('))!.metadata.qualifiedName,'Base::read');
});
test('Laravel descendant named functions do not attribute calls to their enclosing method',async()=>{
  const graph=await scan('<?php namespace App;class A{function read(){}}class Service{function run(A $obj){function nested(){$obj->read();}}}',{},true),run=graph.entities.find(entity=>entity.name==='run')!,read=graph.entities.find(entity=>entity.name==='read')!;
  assert.ok(!graph.relations.some(edge=>edge.type==='calls'&&edge.from===run.id&&edge.to===read.id));assert.equal(by(graph,'$obj->read(').status,'unresolved');assert.equal(owner(graph,by(graph,'$obj->read('))!.name,'nested');
});
test('Laravel mutable reference aliases cannot reuse an old local receiver type',async()=>{
  const graph=await scan('<?php namespace App;class A{function read(){}}class Service{function run(A $obj){$alias=&$obj;$obj->read();}}',{},true),run=graph.entities.find(entity=>entity.name==='run')!,read=graph.entities.find(entity=>entity.name==='read')!;
  assert.ok(!graph.relations.some(edge=>edge.type==='calls'&&edge.from===run.id&&edge.to===read.id));assert.equal(by(graph,'$obj->read(').status,'unsupported');
});
test('Failed Laravel inputs report failed semantic features and retain healthy neighbors',async()=>{
  const graph=await scan('<?php class Broken{',{'healthy.php':'<?php function helper(){}helper();'},true),file=graph.entities.find(entity=>entity.type==='file'&&entity.path==='entry.php')!;
  for(const feature of ['structure','references','framework','effects','guards']as const)assert.equal(fileAnalysis(file.metadata.analysis)!.features[feature].status,'failed');assert.ok(outcomes(graph,'healthy.php').some(outcome=>outcome.status==='resolved'));
});
