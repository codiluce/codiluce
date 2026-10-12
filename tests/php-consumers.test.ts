import assert from 'node:assert/strict';
import {afterEach, mock, test} from 'node:test';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {AnalysisContext} from '../src/core/analyzer.js';
import {resolveConfig} from '../src/core/config.js';
import {GraphBuilder} from '../src/core/graph.js';
import {filesystemAnalyzer} from '../src/analyzers/filesystem.js';
import {ast,walk,type Ast} from '../src/analyzers/php-ast.js';
import {PhpSources} from '../src/analysis/php/sources.js';
import {bindingNode} from '../src/analysis/php/binding-node.js';
import {LaravelFiles,laravelClassHeader} from '../src/analysis/php/laravel-files.js';
import {PhpSymbols,phpSymbolsAnalyzer} from '../src/analysis/languages/php-symbols.js';
import {PhpResolver} from '../src/analysis/resolution/php.js';
import {analyzePhp,phpAnalysisServices} from '../src/pipeline/php-analysis.js';
import {AnalysisCache} from '../src/pipeline/cache.js';
import {canonicalJson} from '../src/history/fingerprint.js';

const roots:string[]=[],providers:PhpSources[]=[];
afterEach(async()=>{mock.restoreAll();for(const provider of providers.splice(0))await provider.releaseAndWait();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(files:Record<string,string>){const root=await mkdtemp(path.join(tmpdir(),'codiluce-php-consumers-'));roots.push(root);await mkdir(path.join(root,'backend'));await mkdir(path.join(root,'generic'));for(const [file,content]of Object.entries(files)){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),content);}return root;}
async function context(root:string,cache?:AnalysisCache){
  const config=await resolveConfig(root,{repository:{name:'consumer'},applications:[{name:'backend',path:'backend',frameworks:['laravel'],ecosystems:['php']},{name:'generic',path:'generic',ecosystems:['php']}]}),graph=new GraphBuilder('consumer');
  const value:AnalysisContext={root,config,graph,cache,repositoryId:graph.id('repository'),applicationIds:new Map(),files:new Map(),http:[]};await filesystemAnalyzer.analyze(value);
  value.phpSources=new PhpSources(value,{residency:{maxResidentBytes:1,maxResidentUnits:1,maxSpoolBytes:32*1024*1024,maxSpoolUnits:128}});providers.push(value.phpSources);return value;
}
function shape(value:AnalysisContext){return canonicalJson({entities:[...value.graph.entities.values()].sort((a,b)=>a.id.localeCompare(b.id)),relations:[...value.graph.relations.values()].sort((a,b)=>a.id.localeCompare(b.id)),diagnostics:[...value.graph.diagnostics.values()].sort((a,b)=>a.id.localeCompare(b.id))});}
function inspect(roots:unknown[],visit:(value:Record<string,unknown>)=>void){
  const seen=new Set<object>(),pending=[...roots];while(pending.length){const value=pending.pop();if(!value||typeof value!=='object'||seen.has(value))continue;seen.add(value);
    if(value instanceof Map){for(const [key,item]of value)pending.push(key,item);}else if(value instanceof Set)pending.push(...value);else{visit(value as Record<string,unknown>);pending.push(...Object.values(value));}}
}

test('PHP cross-file catalog and active IR cannot reach native bodies, comments or parser-owned nodes',async()=>{
  const files:Record<string,string>={'generic/composer.json':'{"autoload":{"files":["a.php","b.php"]}}',
    'generic/a.php':'<?php namespace Demo; final class A {public static function take(A $a): A {return $a;}} function helper(){}',
    'generic/b.php':'<?php namespace Demo; function run(){ $a=new A(); A::take($a); $fn=function()use($a){A::take($a);}; $fn(); $arrow=fn()=>helper(); $arrow(); }'};
  const root=await fixture(files),value=await context(root);for(const service of phpAnalysisServices.slice(0,-1))await service.analyze(value);
  const resolver=new PhpResolver(value);resolver.prepare([...value.files.values()].filter(file=>file.language==='php'));
  const symbols=new PhpSymbols(value,resolver),raw=new WeakSet<object>(),read=value.phpSources!.read.bind(value.phpSources);
  mock.method(value.phpSources!,'read',async(...args:Parameters<PhpSources['read']>)=>{const source=await read(...args);if(source.ast)walk(source.ast,node=>raw.add(node));return source;});
  const owned=()=>Object.entries(symbols).filter(([key])=>!['context','resolver','files'].includes(key)).map(([,value])=>value);
  const detached=()=>inspect(owned(),node=>{assert.ok(!raw.has(node),'Consumer must not retain a native node');if(ast(node))for(const field of ['body','children','tokens','comments','leadingComments','trailingComments'])assert.ok(!(field in node),`Retained ${node.kind}.${field}`);});
  await symbols.prepare();detached();assert.equal(symbols.sourceRetentionStats().peakUnits,0);
  const internal=symbols as unknown as {emitUnit(unit:unknown):void},emit=internal.emitUnit.bind(symbols);let observed=0;
  mock.method(internal,'emitUnit',(unit:unknown)=>{observed++;detached();assert.equal(symbols.sourceRetentionStats().activeUnits,1);emit(unit);});
  await symbols.emit();detached();assert.equal(observed,2);assert.equal(symbols.sourceRetentionStats().activeUnits,0);assert.equal(symbols.sourceRetentionStats().peakUnits,1);
  const calls=[...value.graph.relations.values()].filter(edge=>edge.type==='calls');assert.ok(calls.some(edge=>value.graph.entities.get(edge.to)?.name==='take'));assert.ok(calls.some(edge=>value.graph.entities.get(edge.to)?.name==='helper'));
  const ordinary=await context(root);await analyzePhp(ordinary);assert.equal(shape(value),shape(ordinary));
});

test('PHP compact signatures preserve reference parameters and unknown kinds without recursively retaining bodies',()=>{
  const location={start:{line:1,column:0,offset:0},end:{line:1,column:5,offset:5}},native:Ast={kind:'method',loc:location,name:{kind:'identifier',name:'take'},arguments:[{kind:'parameter',name:'x',type:{kind:'name',name:'A'},byref:true,variadic:true}],type:{kind:'name',name:'A'},body:{kind:'block',children:[{kind:'call',what:{kind:'name',name:'hidden'}}]},leadingComments:[{kind:'commentblock',value:'large original'}]};
  const header=bindingNode(native);assert.notEqual(header.loc,location);assert.equal(ast((header.arguments as Ast[])[0]?.type)?.name,'A');assert.equal((header.arguments as Ast[])[0]?.byref,true);assert.ok(!('body'in header));
  const unknown=bindingNode({kind:'eval',loc:location,source:{kind:'string',value:'large original'}});assert.equal(unknown.kind,'eval');assert.ok(!('source'in unknown));
  const prototypeName=bindingNode({kind:'constructor',loc:location,body:{kind:'block'}});assert.equal(prototypeName.kind,'constructor');assert.ok(!('body'in prototypeName),'Unknown kinds cannot inherit object-prototype field lists');
  let chain:Ast={kind:'name',name:'run'};for(let i=0;i<20_000;i++)chain={kind:'call',what:chain,arguments:[]};assert.equal(bindingNode(chain).kind,'call','Detachment must not use the JavaScript call stack');
});

test('emission shares detached signatures while keeping lexical frames and validated bodies independent',async()=>{
  const root=await fixture({'generic/composer.json':'{"autoload":{"files":["headers.php"]}}','generic/headers.php':'<?php namespace Demo; class A {public static function take(A &$value): A {return $value;}} function run(){ $value=new A(); A::take($value); }'}),value=await context(root);
  for(const service of phpAnalysisServices.slice(0,-1))await service.analyze(value);
  const resolver=new PhpResolver(value);resolver.prepare([...value.files.values()].filter(file=>file.language==='php'));const symbols=new PhpSymbols(value,resolver);await symbols.prepare();
  type Def={id:string;node:Ast;frame:unknown;unit:unknown};
  const internals=symbols as unknown as {definitions:Map<string,Def>;emitUnit(unit:{definitions:Def[]}):void},catalog=internals.definitions,emit=internals.emitUnit.bind(symbols);let shared=0;
  const before=canonicalJson([...catalog.values()].map(({node})=>node));
  mock.method(internals,'emitUnit',(unit:{definitions:Def[]})=>{
    for(const definition of unit.definitions){const original=catalog.get(definition.id)!;assert.equal(definition.node,original.node);assert.notEqual(definition.frame,original.frame);assert.notEqual(definition.unit,original.unit);shared++;}
    emit(unit);
  });
  await symbols.emit();assert.ok(shared>=3);assert.equal(canonicalJson([...catalog.values()].map(({node})=>node)),before,'Emission cannot mutate shared signature inputs');
  const ordinary=await context(root);await analyzePhp(ordinary);assert.equal(shape(value),shape(ordinary));
});

test('one catalog read replaces redundant availability work while emission still rejects a late changed body',async()=>{
  const original='<?php function changed(){ changed(); }',root=await fixture({'generic/a.php':original,'generic/b.php':'<?php function healthy(){}'}),value=await context(root);
  for(const service of phpAnalysisServices.slice(0,-1))await service.analyze(value);
  const counts=new Map<string,number>(),read=value.phpSources!.read.bind(value.phpSources);
  mock.method(value.phpSources!,'read',async(...args:Parameters<PhpSources['read']>)=>{counts.set(args[0].path,(counts.get(args[0].path)??0)+1);return read(...args);});
  const prepare=PhpSymbols.prototype.prepare;
  mock.method(PhpSymbols.prototype,'prepare',async function(this:PhpSymbols){await prepare.call(this);await writeFile(path.join(root,'generic/a.php'),original.replace('changed();','healthy();'));});
  await phpSymbolsAnalyzer.analyze(value);
  assert.deepEqual([...counts], [['generic/a.php',2],['generic/b.php',2]],'Each source has one validated catalog read and a separate body-emission read');
  const failed=value.graph.entities.get(value.files.get('generic/a.php')!.id)!;
  assert.equal((failed.metadata.analysis as {features:{references:{status:string}}}).features.references.status,'failed');
  assert.ok([...value.graph.diagnostics.values()].some(diagnostic=>diagnostic.file==='generic/a.php'&&diagnostic.reason.includes('changed after the scan')));
  assert.ok(![...value.graph.relations.values()].some(edge=>edge.type==='calls'&&value.graph.entities.get(edge.from)?.name==='changed'));
  assert.ok([...value.graph.entities.values()].some(entity=>entity.name==='healthy'));
});

test('Laravel class catalog retains properties, promoted types and command attributes without any method body',()=>{
  const header=laravelClassHeader({kind:'class',name:{kind:'identifier',name:'Command'},attrGroups:[{kind:'attrgroup',attrs:[{kind:'attribute',name:{kind:'name',name:'AsCommand'},arguments:[{kind:'namedargument',name:{kind:'identifier',name:'name'},value:{kind:'string',value:'demo:run'}}]}]}],body:[{kind:'propertystatement',type:{kind:'name',name:'A'},properties:[{kind:'property',name:{kind:'identifier',name:'table'},value:{kind:'string',value:'examples'}}]},{kind:'method',name:{kind:'identifier',name:'__construct'},arguments:[{kind:'parameter',name:'a',type:{kind:'name',name:'A'},flags:1}],body:{kind:'block',children:[]}}]});
  const body=header.body as Ast[];assert.equal(ast((body[0]!.properties as Ast[])[0]!.value)?.value,'examples');assert.equal((body[1]!.arguments as Ast[])[0]!.flags,1);assert.ok(!('body'in body[1]!));
  const attribute=((header.attrGroups as Ast[])[0]!.attrs as Ast[])[0]!;assert.equal(ast((attribute.arguments as Ast[])[0]!.value)?.value,'demo:run');
});

test('Laravel identity registry validates late source replacement and owns no original or tree',async()=>{
  const root=await fixture({'backend/a.php':'<?php class A {function run(){}}'}),value=await context(root),file=value.files.get('backend/a.php')!,registry=new LaravelFiles(value);registry.register(file);
  assert.ok((await registry.get(file.path))?.ast);assert.equal(registry.retentionStats().trees,0);assert.equal(registry.retentionStats().originalBytes,0);
  inspect(Object.values(registry).filter(item=>item!==value),node=>assert.ok(!ast(node)));
  await writeFile(file.absolutePath,'<?php class A {function changed(){}}');assert.equal(await registry.get(file.path),undefined);assert.ok(value.phpSources!.failures.has(file.path));assert.ok([...value.graph.diagnostics.values()].some(item=>item.code==='php-parse-error'));
});

test('Laravel streamed include operations keep depth-first duplicate ownership, cycles and cold/warm graph identity',async()=>{
  const files:Record<string,string>={'backend/bootstrap/app.php':"<?php use Illuminate\\Foundation\\Application; return Application::configure()->withRouting(web: __DIR__.'/../routes/web.php');",'backend/routes/web.php':"<?php use Illuminate\\Support\\Facades\\Route; include __DIR__.'/part.php'; Route::get('/same',[\\App\\Http\\Controllers\\Demo::class,'second']); Route::get('/after',[\\App\\Http\\Controllers\\Demo::class,'second']);",'backend/routes/part.php':"<?php use Illuminate\\Support\\Facades\\Route; Route::get('/same',[\\App\\Http\\Controllers\\Demo::class,'first']); include __DIR__.'/web.php';",'backend/app/Http/Controllers/Demo.php':'<?php namespace App\\Http\\Controllers; class Demo {public function first(){} public function second(){}}'};
  const root=await fixture(files),cold=await context(root);await analyzePhp(cold);
  const same=[...cold.graph.entities.values()].filter(entity=>entity.type==='api_endpoint'&&entity.name==='GET /same');assert.equal(same.length,2,'Legacy route identities include file and handler; preserve both registrations');
  const after=[...cold.graph.entities.values()].find(entity=>entity.type==='api_endpoint'&&entity.name==='GET /after')!;assert.ok([...cold.graph.relations.values()].some(edge=>edge.from===after.id&&cold.graph.entities.get(edge.to)?.name==='second'));
  assert.ok([...cold.graph.diagnostics.values()].some(item=>item.code==='cyclic-route-include'));
  const cacheRoot=await fixture({}),cache=new AnalysisCache(cacheRoot),population=await context(root,cache);await analyzePhp(population);const warm=await context(root,cache);await analyzePhp(warm);assert.equal(shape(cold),shape(population));assert.equal(shape(warm),shape(cold));assert.ok(cache.events.some(event=>event.analyzer==='php-analysis'&&event.hit));
});


test('PHP catalog prunes arithmetic bodies while preserving nested declaration identity and lexical type context',async()=>{
  const arithmetic=Array.from({length:1500},(_,i)=>`$v${i}=1+2;`).join('');
  const root=await fixture({'generic/a.php':`<?php namespace Demo; class A {public function __construct(public A $next){} public function run(){${arithmetic} if(false){function nested(A $a):A{return $a;}} $fn=function(A $a):A{class B{public function go(A $a):A{return $a;}} return $a;}; $arrow=fn(A $a):A=>$a; }}`}),value=await context(root);
  for(const service of phpAnalysisServices.slice(0,-1))await service.analyze(value);
  const resolver=new PhpResolver(value);resolver.prepare([...value.files.values()].filter(file=>file.language==='php'));
  const symbols=new PhpSymbols(value,resolver),file=value.files.get('generic/a.php')!,source=await value.phpSources!.read(file);
  type Catalog={work:number;definitions:{id:string;fact:{kind:string;name:string};frame:{kind:string;namespace:string;importScope:string;cls?:{id:string};thisClass?:{id:string}}}[]};
  const internal=symbols as unknown as {unit(file:Parameters<PhpSources['read']>[0],source:Awaited<ReturnType<PhpSources['read']>>,catalog:boolean):Catalog};
  const selected=internal.unit(file,source,true),full=internal.unit(file,source,false);
  const identity=(unit:Catalog)=>unit.definitions.map(item=>({id:item.id,kind:item.fact.kind,name:item.fact.name,frame:item.frame.kind,namespace:item.frame.namespace,importScope:item.frame.importScope,cls:item.frame.cls?.id,thisClass:item.frame.thisClass?.id}));
  assert.deepEqual(identity(selected),identity(full));assert.ok(selected.work<full.work/10,`${selected.work} catalog nodes versus ${full.work} original nodes`);
  for(const kind of ['class','method','promoted-property','function','closure-binding','arrow-binding'])assert.ok(selected.definitions.some(item=>item.fact.kind===kind),`Missing original ${kind}`);
});

test('Laravel Fortify candidates use only explicit negative original checks and revalidate every positive source',async()=>{
  const root=await fixture({'backend/ordinary.php':'<?php class Ordinary {function run(){}}','backend/provider.php':'<?php use Laravel\\Fortify\\Fortify; Fortify::loginView(fn()=>inertia("login"));'}),value=await context(root),ordinary=value.files.get('backend/ordinary.php')!,provider=value.files.get('backend/provider.php')!,registry=new LaravelFiles(value);
  registry.register(ordinary);registry.register(provider,{mentionsFortify:true});assert.deepEqual([...registry.fortifyFiles()].map(file=>file.path),[ordinary.path,provider.path],'Unknown input remains eligible');
  registry.register(ordinary,{mentionsFortify:false});assert.deepEqual([...registry.fortifyFiles()].map(file=>file.path),[provider.path]);
  assert.equal(registry.retentionStats().reads,0,'Candidate selection must not hydrate native trees');
  assert.ok(await registry.get(provider.path));await writeFile(provider.absolutePath,'<?php changed();');assert.equal(await registry.get(provider.path),undefined);assert.ok([...value.graph.diagnostics.values()].some(item=>item.code==='php-parse-error'));
  registry.register(ordinary);assert.ok([...registry.fortifyFiles()].some(file=>file.path===ordinary.path),'Replacing a registration with unknown must clear an earlier negative check');
});
