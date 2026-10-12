import assert from 'node:assert/strict';
import {after,mock,test} from 'node:test';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,statSync,writeFileSync} from 'node:fs';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {serialize} from 'node:v8';
import {PhpResidency,PhpInputAdmission,PHP_RESIDENCY_LIMITS} from '../src/analysis/php/residency.js';
import {PhpSources,type PhpSourceBudgets} from '../src/analysis/php/sources.js';
import {PhpParser} from '../src/analysis/php/client.js';
import {filesystemAnalyzer} from '../src/analyzers/filesystem.js';
import {resolveConfig} from '../src/core/config.js';
import {GraphBuilder} from '../src/core/graph.js';
import type {AnalysisContext} from '../src/core/analyzer.js';
import {analyzePhp} from '../src/pipeline/php-analysis.js';
import {canonicalJson} from '../src/history/fingerprint.js';
import {AnalysisCache} from '../src/pipeline/cache.js';
import {laravelAnalyzer} from '../src/analyzers/laravel.js';
import {PhpSymbols} from '../src/analysis/languages/php-symbols.js';

const roots:string[]=[],stores:PhpResidency<unknown>[]=[],providers:PhpSources[]=[];
after(async()=>{for(const store of stores)store.clear();for(const provider of providers)await provider.releaseAndWait();await Promise.all(roots.map(root=>rm(root,{recursive:true,force:true})));});
function store<T>(limits={maxResidentBytes:10,maxResidentUnits:1,maxSpoolBytes:4096,maxSpoolUnits:4}){const value=new PhpResidency<T>(limits);stores.push(value as PhpResidency<unknown>);return value;}
const snapshot=(directory:string,key:string)=>path.join(directory,createHash('sha256').update(key).digest('hex')+'.bin');

test('PHP unit eviction preserves exact Unicode, undefined fields and shared AST nodes in private snapshots',()=>{
  const cache=store<{content:string;ast:{one:object;two:object};missing:undefined}>(),node={kind:'identifier',name:'original'};
  const original={content:'é😀\r\n',ast:{one:node,two:node},missing:undefined};
  cache.put('../../original.php',original,8);cache.put('next.php',{...original,content:'next'},8);
  assert.equal(cache.stats().units,1);assert.equal(cache.stats().bytes,8);assert.equal(cache.stats().evictions,1);
  const directory=cache.directory()!;assert.equal(statSync(directory).mode&0o777,0o700);assert.equal(statSync(snapshot(directory,'../../original.php')).mode&0o777,0o600);
  const loaded=cache.get('../../original.php')!;assert.deepEqual(loaded,original);assert.equal(loaded.ast.one,loaded.ast.two);assert.ok(Object.hasOwn(loaded,'missing'));
  assert.equal(cache.stats().reloads,1);assert.ok(cache.stats().bytes<=10);cache.clear();assert.ok(!existsSync(directory));
});

test('PHP snapshot byte/count limits and oversized unit bypass never fabricate a resident hit',()=>{
  const value={content:'original'},bytes=serialize(value).length;
  const cache=store<typeof value>({maxResidentBytes:0,maxResidentUnits:0,maxSpoolBytes:bytes*2,maxSpoolUnits:1});
  cache.put('first',value,8);cache.put('second',value,8);
  assert.equal(cache.get('first'),undefined);assert.deepEqual(cache.get('second'),value);assert.equal(cache.stats().units,0);
  cache.put('oversized',{content:'x'.repeat(1000)},1000);assert.equal(cache.get('oversized'),undefined);
  assert.ok(cache.stats().spoolBytes<=bytes*2);assert.ok(cache.stats().spoolUnits<=1);
  for(const invalid of [-1,0.5,NaN,Infinity])assert.throws(()=>new PhpResidency({...PHP_RESIDENCY_LIMITS,maxResidentBytes:invalid}),/nonnegative safe integers/);
  const incomplete={...PHP_RESIDENCY_LIMITS};delete (incomplete as Partial<typeof incomplete>).maxResidentUnits;
  assert.throws(()=>new PhpResidency(incomplete),/nonnegative safe integers/);
});

test('corrupt, truncated and symlinked private PHP snapshots become repairable misses',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'codiluce-php-snapshot-test-'));roots.push(root);
  for(const failure of ['corrupt','truncate','symlink',...process.platform==='linux'?['fifo']:[]]){
    const cache=store<{content:string}>({maxResidentBytes:0,maxResidentUnits:0,maxSpoolBytes:4096,maxSpoolUnits:4}),value={content:'original'};
    cache.put('unit',value,8);const file=snapshot(cache.directory()!,'unit');
    if(failure==='corrupt'){const bytes=readFileSync(file);bytes[bytes.length-1]=bytes[bytes.length-1]!^1;writeFileSync(file,bytes);}
    else if(failure==='truncate')writeFileSync(file,'short');
    else if(failure==='symlink'){const outside=path.join(root,'outside.bin');await writeFile(outside,readFileSync(file));await rm(file);await symlink(outside,file);}
    else{await rm(file);execFileSync('mkfifo',[file]);}
    assert.equal(cache.get('unit'),undefined);assert.equal(cache.stats().failures,1);assert.equal(cache.stats().spoolBytes,0);
    cache.put('unit',value,8);assert.deepEqual(cache.get('unit'),value);
  }
});

test('PHP input admission bounds jobs and originals, admits one larger original alone and cancels waiting jobs',async()=>{
  const gate=new PhpInputAdmission({maxJobs:2,maxSourceBytes:10}),first=await gate.acquire(6);
  const second=gate.acquire(6),third=gate.acquire(2);assert.equal(gate.stats().waiting,2);assert.equal(gate.stats().bytes,6);
  first();first();const releaseSecond=await second,releaseThird=await third;assert.equal(gate.stats().jobs,2);assert.equal(gate.stats().bytes,8);
  const larger=gate.acquire(17);releaseSecond();assert.equal(gate.stats().waiting,1);releaseThird();const releaseLarger=await larger;
  assert.equal(gate.stats().jobs,1);assert.equal(gate.stats().bytes,17);assert.equal(gate.stats().oversized,1);
  const canceled=gate.acquire(1);const rejected=assert.rejects(canceled,/released/);gate.close();await rejected;releaseLarger();assert.equal(gate.stats().jobs,0);assert.equal(gate.stats().bytes,0);
  await assert.rejects(gate.acquire(1),/released/);await assert.rejects(new PhpInputAdmission().acquire(-1),/source size/);
});

test('failed PHP snapshot removal stays charged and cannot grow disk residency or replay corrupt data',()=>{
  const value={content:'original'},bytes=serialize(value).length,cache=store<typeof value>({maxResidentBytes:0,maxResidentUnits:0,maxSpoolBytes:bytes*2,maxSpoolUnits:1});
  cache.put('first',value,8);const file=snapshot(cache.directory()!,'first'),unlink=fs.unlinkSync;
  const failure=mock.method(fs,'unlinkSync',((target:Parameters<typeof unlink>[0])=>{if(String(target).endsWith('.bin'))throw Object.assign(Error('Injected denied removal'),{code:'EACCES'});return unlink(target);}) as typeof unlink);syncBuiltinESMExports();
  try{
    cache.put('second',value,8);assert.equal(cache.get('second'),undefined);assert.deepEqual(cache.get('first'),value);
    cache.put('first',{content:'replacement'},8);assert.equal(cache.get('first'),undefined,'An undeletable old snapshot cannot resurrect a replaced unit');
    const buffer=readFileSync(file);buffer[buffer.length-1]=buffer[buffer.length-1]!^1;writeFileSync(file,buffer);
    assert.equal(cache.get('first'),undefined);assert.equal(cache.get('first'),undefined);
    assert.equal(cache.stats().spoolUnits,1);assert.equal(cache.stats().spoolBytes,bytes);
    cache.put('third',value,8);assert.equal(cache.get('third'),undefined);assert.equal(cache.stats().spoolBytes,bytes);
  }finally{failure.mock.restore();syncBuiltinESMExports();}
  cache.clear();assert.equal(cache.stats().spoolBytes,0);
});

test('partial PHP snapshot writes with denied cleanup reserve their complete possible disk payload',()=>{
  const value={content:'original'.repeat(32)},bytes=serialize(value).length,cache=store<typeof value>({maxResidentBytes:0,maxResidentUnits:0,maxSpoolBytes:bytes*2,maxSpoolUnits:1});
  const write=fs.writeFileSync,unlink=fs.unlinkSync;let attempts=0;
  const deniedWrite=mock.method(fs,'writeFileSync',((file:Parameters<typeof write>[0],data:Parameters<typeof write>[1],options:Parameters<typeof write>[2])=>{
    if(String(file).includes('codiluce-php-residency-')&&String(file).endsWith('.bin')){
      attempts++;assert.ok(Buffer.isBuffer(data));write(file,data.subarray(0,Math.floor(data.length/2)),options);
      throw Object.assign(Error('Injected partial snapshot write'),{code:'ENOSPC'});
    }
    return write(file,data,options);
  }) as typeof write);
  const deniedRemoval=mock.method(fs,'unlinkSync',((file:Parameters<typeof unlink>[0])=>{
    if(String(file).includes('codiluce-php-residency-')&&String(file).endsWith('.bin'))throw Object.assign(Error('Injected denied cleanup'),{code:'EACCES'});
    return unlink(file);
  }) as typeof unlink);syncBuiltinESMExports();
  try{
    cache.put('first',value,8);const file=snapshot(cache.directory()!,'first');
    assert.equal(statSync(file).size,Math.floor(bytes/2));assert.equal(cache.stats().spoolBytes,bytes);assert.equal(cache.stats().spoolUnits,1);
    assert.equal(cache.stats().spills,0);assert.equal(cache.get('first'),undefined);
    for(const key of ['second','third','first'])cache.put(key,value,8);
    assert.equal(attempts,1);assert.equal(cache.stats().spoolBytes,bytes);assert.equal(cache.stats().spoolUnits,1);
    assert.equal(cache.get('first'),undefined);assert.equal(cache.get('second'),undefined);
  }finally{deniedWrite.mock.restore();deniedRemoval.mock.restore();syncBuiltinESMExports();}
  cache.put('first',value,8);assert.deepEqual(cache.get('first'),value);cache.clear();
  assert.equal(cache.stats().spoolBytes,0);assert.equal(cache.stats().spoolUnits,0);
});

async function fixture(){
  const root=await mkdtemp(path.join(tmpdir(),'codiluce-php-residency-test-'));roots.push(root);
  const files={
    'backend/composer.json':'{"require":{"laravel/framework":"^12.0"}}',
    'backend/app/Http/Controllers/ItemsController.php':'<?php namespace App\\Http\\Controllers; class ItemsController { public function show(){return helper();} } function helper(){return "é😀";}',
    'backend/routes/web.php':'<?php use Illuminate\\Support\\Facades\\Route; use App\\Http\\Controllers\\ItemsController; Route::get("/items", [ItemsController::class,"show"]);',
    'generic/first.php':'<?php namespace Original; function helper(){return 1;} class Base {static function read(){return helper();}}',
    'generic/second.php':'<?php namespace Original; class Consumer extends Base { function read(){return Base::read();}}',
  };
  for(const [file,content]of Object.entries(files)){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),content);}
  return root;
}
async function context(root:string,budgets:PhpSourceBudgets={},cache?:AnalysisCache):Promise<AnalysisContext>{
  const config=await resolveConfig(root,{repository:{name:'residency'},applications:[{name:'backend',path:'backend',frameworks:['laravel'],ecosystems:['php']},{name:'generic',path:'generic',ecosystems:['php']}]}),graph=new GraphBuilder('residency');
  const result:AnalysisContext={root,config,graph,cache,repositoryId:graph.id('repository'),applicationIds:new Map(),files:new Map(),http:[]};
  await filesystemAnalyzer.analyze(result);result.phpSources=new PhpSources(result,budgets);providers.push(result.phpSources);return result;
}
const shape=(context:AnalysisContext)=>canonicalJson({entities:[...context.graph.entities.values()].sort((a,b)=>a.id.localeCompare(b.id)),relations:[...context.graph.relations.values()].sort((a,b)=>a.id.localeCompare(b.id)),diagnostics:[...context.graph.diagnostics.values()].sort((a,b)=>a.id.localeCompare(b.id))});
const forced:PhpSourceBudgets={residency:{maxResidentBytes:1,maxResidentUnits:1,maxSpoolBytes:32*1024*1024,maxSpoolUnits:32},input:{maxJobs:2,maxSourceBytes:128}};

test('PHP binding retires full originals while detached bounded snippets preserve CRLF, ranges and truncated UTF-16',async()=>{
  const root=await fixture(),expression=`take("${'x'.repeat(2041)}😀tail")`,source=`<?php /* ${'x'.repeat(384*1024)} */\r\nfunction take($value){}\r\nfunction run(){${expression};}`;
  await writeFile(path.join(root,'generic/snippets.php'),source);
  const value=await context(root,forced),emit=PhpSymbols.prototype.emit,observations:ReturnType<PhpSymbols['sourceRetentionStats']>[]=[];
  const observer=mock.method(PhpSymbols.prototype,'emit',async function(this:PhpSymbols){await emit.call(this);observations.push(this.sourceRetentionStats());});
  try{await analyzePhp(value);}finally{observer.mock.restore();}
  assert.equal(observations.length,1);assert.equal(observations[0]!.originalBytes,0);assert.ok(observations[0]!.peakOriginalBytes>=2*384*1024);
  assert.ok(observations[0]!.expressionBytes<=observations[0]!.sites*4096);
  const file=[...value.graph.entities.values()].find(entity=>entity.type==='file'&&entity.path==='generic/snippets.php')!;
  const outcomes=file.metadata.phpCallOutcomes as {expression:string;range:{startLine:number;startColumn:number;endLine:number;endColumn:number};status:string}[];
  const outcome=outcomes.find(item=>item.expression.startsWith('take('))!;
  assert.equal(outcome.status,'resolved');assert.equal(outcome.expression,expression.slice(0,2048));assert.equal(outcome.expression.length,2048);
  assert.equal(outcome.expression.charCodeAt(2047),0xd83d,'A bounded prefix must preserve its final unpaired UTF-16 surrogate exactly');
  // The pinned native call range includes its expression-statement semicolon,
  // matching the independently checked pre-retirement compiled analyzer.
  assert.deepEqual(outcome.range,{startLine:3,startColumn:16,endLine:3,endColumn:17+expression.length});
  const cacheRoot=await mkdtemp(path.join(tmpdir(),'codiluce-php-snippet-cache-'));roots.push(cacheRoot);
  const cache=new AnalysisCache(cacheRoot),cold=await context(root,forced,cache);await analyzePhp(cold);const warm=await context(root,forced,cache);await analyzePhp(warm);
  assert.equal(shape(cold),shape(value));assert.equal(shape(warm),shape(cold));assert.ok(cache.events.some(event=>event.analyzer==='php-analysis'&&event.hit));
});

test('evicted PHP units retain every structure, import, Laravel and binding fact without a second native parse',async()=>{
  const root=await fixture(),baseline=await context(root);await analyzePhp(baseline);
  const bounded=await context(root,forced),parse=PhpParser.prototype.parseUnit;let jobs=0;
  const observer=mock.method(PhpParser.prototype,'parseUnit',async function(this:PhpParser,source:string){jobs++;return parse.call(this,source);});
  try{await analyzePhp(bounded);}finally{observer.mock.restore();}
  assert.equal(shape(bounded),shape(baseline));assert.equal(jobs,[...bounded.files.values()].filter(file=>file.language==='php'&&file.analyzable).length);
  const stats=bounded.phpSources!.residencyStats();assert.equal(stats.units.units,0);assert.ok(stats.units.reloads>0);assert.ok(stats.units.bypasses>0);assert.equal(stats.input.jobs,0);assert.ok(stats.input.peakJobs<=2);
  assert.ok(!shape(bounded).includes('"kind":"program"'));assert.ok([...bounded.graph.entities.values()].some(entity=>entity.type==='api_endpoint'));assert.ok([...bounded.graph.relations.values()].some(edge=>edge.type==='calls'));
});

test('unavailable PHP snapshots reparse original source; bounded residency still permits atomic warm graph replay',async()=>{
  const root=await fixture(),baseline=await context(root);await analyzePhp(baseline);
  const bounded=await context(root,{...forced,residency:{...forced.residency!,maxSpoolBytes:0}});await analyzePhp(bounded);assert.equal(shape(bounded),shape(baseline));
  const cacheRoot=await mkdtemp(path.join(tmpdir(),'codiluce-php-residency-cache-'));roots.push(cacheRoot);
  const cache=new AnalysisCache(cacheRoot),cold=await context(root,forced,cache);await analyzePhp(cold);
  assert.ok(cold.phpSources!.hasQualified('generic/first.php'));const warm=await context(root,forced,cache);await analyzePhp(warm);
  assert.equal(shape(warm),shape(cold));assert.ok(cache.events.some(event=>event.analyzer==='php-analysis'&&event.hit),JSON.stringify({events:cache.events,qualified:[...cold.files.values()].filter(file=>file.language==='php').map(file=>[file.path,cold.phpSources!.hasQualified(file.path)]),failures:[...cold.phpSources!.failures]}));assert.equal(warm.phpSources!.residencyStats().units.spills,0);
});

test('an evicted PHP original changed after scanning cannot resurrect its old tree',async()=>{
  const root=await fixture(),value=await context(root,forced),file=value.files.get('generic/first.php')!;
  await value.phpSources!.read(file);assert.ok(value.phpSources!.hasQualified(file.path));
  await writeFile(file.absolutePath,'<?php function changed(){}');await assert.rejects(value.phpSources!.read(file),/changed after the scan/);
  assert.equal(value.phpSources!.hasQualified(file.path),false);assert.equal(value.phpSources!.get(file.path),undefined);
  await value.phpSources!.releaseAndWait();assert.equal(value.phpSources!.residencyStats().units.bytes,0);assert.equal(value.phpSources!.residencyStats().input.waiting,0);
});

test('PHP snapshot write failure preserves complete graph output by reparsing validated originals',async()=>{
  const root=await fixture(),baseline=await context(root);await analyzePhp(baseline);
  const bounded=await context(root,forced),write=fs.writeFileSync;
  const failure=mock.method(fs,'writeFileSync',((file:Parameters<typeof write>[0],...parameters:unknown[])=>{
    if(String(file).includes('codiluce-php-residency-')&&String(file).endsWith('.bin'))throw Object.assign(Error('Injected full snapshot device'),{code:'ENOSPC'});
    return Reflect.apply(write,fs,[file,...parameters]);
  }) as typeof write);syncBuiltinESMExports();
  try{await analyzePhp(bounded);}finally{failure.mock.restore();syncBuiltinESMExports();}
  assert.equal(shape(bounded),shape(baseline));assert.ok(bounded.phpSources!.residencyStats().units.failures>0);
  assert.equal(bounded.phpSources!.residencyStats().units.spoolBytes,0);
});

test('failed reparse of an evicted PHP unit revokes aggregate cache qualification',async()=>{
  const root=await fixture(),value=await context(root,{...forced,residency:{...forced.residency!,maxSpoolBytes:0}}),file=value.files.get('generic/first.php')!;
  await value.phpSources!.read(file);assert.ok(value.phpSources!.hasQualified(file.path));
  const failure=mock.method(PhpParser.prototype,'parseUnit',async()=>{throw Error('Injected reparse worker failure');});
  try{await assert.rejects(value.phpSources!.read(file),/reparse worker failure/);}finally{failure.mock.restore();}
  assert.equal(value.phpSources!.hasQualified(file.path),false);assert.equal(value.phpSources!.residencyStats().input.jobs,0);
});

test('a source swap during Laravel rehydration cannot cache a transient failure under healthy inputs',async()=>{
  const root=await fixture(),cacheRoot=await mkdtemp(path.join(tmpdir(),'codiluce-php-laravel-residency-cache-'));roots.push(cacheRoot);
  const cache=new AnalysisCache(cacheRoot),raced=await context(root,forced,cache),file=raced.files.get('backend/app/Http/Controllers/ItemsController.php')!,original=readFileSync(file.absolutePath,'utf8');
  const read=PhpSources.prototype.read;let reads=0;
  const swap=mock.method(PhpSources.prototype,'read',async function(this:PhpSources,candidate:Parameters<PhpSources['read']>[0]){
    if(candidate.path===file.path&&++reads===2)await writeFile(file.absolutePath,'<?php class Changed {}');
    return read.call(this,candidate);
  });
  try{await laravelAnalyzer.analyze(raced);}finally{swap.mock.restore();await writeFile(file.absolutePath,original);}
  assert.ok([...raced.graph.diagnostics.values()].some(d=>d.code==='php-parse-error'&&d.file===file.path));
  assert.equal(raced.phpSources!.hasQualified(file.path),false);
  const start=cache.events.length,restored=await context(root,forced,cache);await laravelAnalyzer.analyze(restored);
  assert.deepEqual(cache.events.slice(start).filter(event=>event.analyzer==='php-laravel').map(event=>event.hit),[false]);
  const baseline=await context(root,forced);await laravelAnalyzer.analyze(baseline);assert.equal(shape(restored),shape(baseline));
  const warmStart=cache.events.length,warm=await context(root,forced,cache);await laravelAnalyzer.analyze(warm);
  assert.deepEqual(cache.events.slice(warmStart).filter(event=>event.analyzer==='php-laravel').map(event=>event.hit),[true]);assert.equal(shape(warm),shape(baseline));
});
