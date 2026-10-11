import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PhpParser } from '../src/analysis/php/client.js';
import { PhpSources } from '../src/analysis/php/sources.js';
import { PHP_SOURCE_PROVIDER_VERSION } from '../src/analysis/php/version.js';
import { filesystemAnalyzer } from '../src/analyzers/filesystem.js';
import { laravelAnalyzer, LARAVEL_VERSION } from '../src/analyzers/laravel.js';
import { ast, nodes, walk } from '../src/analyzers/php-ast.js';
import type { AnalysisContext } from '../src/core/analyzer.js';
import { resolveConfig } from '../src/core/config.js';
import { GraphBuilder, stableId } from '../src/core/graph.js';
import { canonicalJson } from '../src/history/fingerprint.js';
import { AnalysisCache } from '../src/pipeline/cache.js';
import { indexRepository } from '../src/pipeline/index.js';

const roots:string[] = [], providers:PhpSources[] = [];
after(async()=>{for(const source of providers)source.release();await Promise.all(roots.map(root=>rm(root,{recursive:true,force:true})));});
async function repository(files:Record<string,string>) {
  const root=await mkdtemp(path.join(os.tmpdir(),'codiluce-php-provider-'));roots.push(root);
  for(const [file,content]of Object.entries(files)){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),content);}
  return root;
}
async function scanned(root:string,cache?:AnalysisCache) {
  await mkdir(path.join(root,'backend'),{recursive:true});await mkdir(path.join(root,'generic'),{recursive:true});
  const config=await resolveConfig(root,{repository:{name:'provider'},applications:[{name:'backend',path:'backend',frameworks:['laravel'],ecosystems:['php']},{name:'generic',path:'generic',ecosystems:['php']}]});
  const graph=new GraphBuilder('provider'),context:AnalysisContext={root,config,cache,graph,repositoryId:graph.id('repository'),applicationIds:new Map(),files:new Map(),http:[]};
  await filesystemAnalyzer.analyze(context);return context;
}
function provider(context:AnalysisContext){const sources=context.phpSources??=new PhpSources(context);providers.push(sources);return sources;}

test('Native PHP units share exact original UTF-16 trees and facts without comments or tokens',async()=>{
  const content='😀\r\n<?php namespace App; /** original */ class Service {public function run(?Other $value): void {$callback=fn()=>"😀";}}';
  const parser=new PhpParser();try{
    const unit=await parser.parseUnit(content);assert.equal(unit.phpAst!.kind,'program');assert.ok(unit.phpAstBytes!>0);assert.ok(unit.phpAstBytes!<=16*1024*1024);assert.equal(unit.phpAst!.tokens,undefined);
    walk(unit.phpAst!,node=>{assert.equal(node.leadingComments,undefined);assert.equal(node.trailingComments,undefined);assert.equal(node.comments,undefined);});
    const namespace=nodes(unit.phpAst!.children).find(node=>node.kind==='namespace')!,cls=nodes(namespace.children).find(node=>node.kind==='class')!,method=nodes(cls.body).find(node=>node.kind==='method')!;
    assert.equal(content.slice(method.loc!.start.offset,method.loc!.end.offset),'public function run(?Other $value): void {$callback=fn()=>"😀";}');
    assert.equal(unit.declarations.find(d=>d.name==='run')!.range.startLine,2);assert.equal(ast(method.type)!.name,'void');
  }finally{parser.close();}
});
test('Concurrent consumers reuse one qualified source unit and one syntax-cache entry',async()=>{
  const root=await repository({'backend/Service.php':'<?php namespace App; class Service {function run(){}}'}),cache=new AnalysisCache(path.join(root,'.cache')),context=await scanned(root,cache),sources=provider(context),file=context.files.get('backend/Service.php')!;
  const [first,second]=await Promise.all([sources.read(file),sources.read(file)]);assert.equal(first,second);assert.equal(first,sources.get(file.path));assert.equal(cache.events.length,1);assert.equal(cache.events[0]!.hit,false);
  sources.closeParser();assert.equal(await sources.read(file),first);assert.equal(cache.events.length,1);
  const warm=await scanned(root,cache),replayed=await provider(warm).read(warm.files.get(file.path)!);assert.equal(canonicalJson(replayed),canonicalJson(first));assert.equal(cache.events.at(-1)!.hit,true);
});
test('A source unit is revalidated before reuse and a changed source clears its native tree',async()=>{
  const root=await repository({'backend/Service.php':'<?php class Service {}'}),context=await scanned(root),sources=provider(context),file=context.files.get('backend/Service.php')!;
  await sources.read(file);await writeFile(path.join(root,file.path),'<?php class Replaced {}');await assert.rejects(sources.read(file),/changed after the scan/);assert.equal(sources.get(file.path),undefined);
  await laravelAnalyzer.analyze(context);assert.ok([...context.graph.diagnostics.values()].some(d=>d.code==='php-parse-error'&&d.reason.includes('changed after the scan')));assert.ok(![...context.graph.entities.values()].some(e=>e.type==='class'));
});
test('A source swapped for a symlink is denied before native or application cache replay',async()=>{
  const root=await repository({'backend/Service.php':'<?php class Service {}','generic/Other.php':'<?php class Other {}'}),context=await scanned(root),sources=provider(context),file=context.files.get('backend/Service.php')!;
  await sources.read(file);await rm(path.join(root,file.path));await symlink(path.join(root,'generic/Other.php'),path.join(root,file.path));
  await laravelAnalyzer.analyze(context);assert.match([...context.graph.diagnostics.values()].find(d=>d.code==='php-parse-error')!.reason,/symlink/);assert.ok(![...context.graph.entities.values()].some(e=>e.name==='Service'));
});
test('Laravel application cache revalidation prevents replay of stale framework entities',async()=>{
  const root=await repository({'backend/Service.php':'<?php namespace App; class Service {function run(){}}'}),cache=new AnalysisCache(path.join(root,'.cache'));
  const cold=await scanned(root,cache);provider(cold);await laravelAnalyzer.analyze(cold);assert.ok([...cold.graph.entities.values()].some(e=>e.name==='Service'));
  const race=await scanned(root,cache);provider(race);await writeFile(path.join(root,'backend/Service.php'),'<?php namespace App; class Changed {function run(){}}');await laravelAnalyzer.analyze(race);
  assert.ok(![...race.graph.entities.values()].some(e=>e.name==='Service'||e.name==='Changed'));assert.equal(cache.events.filter(e=>e.analyzer==='php-laravel').at(-1)!.hit,false);assert.ok([...race.graph.diagnostics.values()].some(d=>d.reason.includes('changed after the scan')));
});
test('Laravel receives a gap for partial bounded trees and still analyzes independent healthy files',async()=>{
  const root=await repository({'backend/Budget.php':'<?php class Budget {'+Array.from({length:4200},(_,i)=>`function f${i}(){}`).join('')+'}','backend/Healthy.php':'<?php class Healthy {function run(){}}'}),context=await scanned(root),sources=provider(context);
  await laravelAnalyzer.analyze(context);const bounded=sources.get('backend/Budget.php')!;assert.equal(bounded.facts.truncated,true);assert.equal(bounded.ast,undefined);assert.match(bounded.astGap!,/bounded/);assert.ok(![...context.graph.entities.values()].some(e=>e.name==='Budget'));assert.ok([...context.graph.entities.values()].some(e=>e.name==='Healthy'));assert.ok([...context.graph.diagnostics.values()].some(d=>d.file==='backend/Budget.php'&&d.code==='php-parse-error'));
});
test('Native PHP token-budget failures preserve subsequent independent source jobs',async()=>{
  const parser=new PhpParser();try{await assert.rejects(parser.parseUnit('<?php '+'1;'.repeat(100_001)),/token budget/);assert.equal((await parser.parseUnit('<?php class Healthy {}')).phpAst!.kind,'program');}finally{parser.close();}
});
test('A malformed PHP job cannot cancel neighboring valid jobs in the preparation queue',async()=>{
  const root=await repository({'backend/a.php':'<?php class A {}','backend/b.php':'<?php class Broken {','backend/c.php':'<?php class C {}','backend/d.php':'<?php class D {}'}),context=await scanned(root),sources=provider(context);
  sources.prepare([...context.files.values()].filter(file=>file.language==='php'));await sources.prepared();await laravelAnalyzer.analyze(context);
  assert.deepEqual([...context.graph.entities.values()].filter(e=>e.type==='class').map(e=>e.name).sort(),['A','C','D']);assert.equal([...context.graph.diagnostics.values()].filter(d=>d.code==='php-parse-error').length,1);
});
test('Parser errors cannot prevent later Laravel files from being qualified',async()=>{
  const root=await repository({'backend/Broken.php':'<?php class Broken {','backend/Healthy.php':'<?php class Healthy {function run(){}}'}),context=await scanned(root);provider(context);await laravelAnalyzer.analyze(context);
  assert.ok([...context.graph.entities.values()].some(e=>e.name==='Healthy'));assert.ok(![...context.graph.entities.values()].some(e=>e.name==='Broken'));assert.ok([...context.graph.diagnostics.values()].some(d=>d.file==='backend/Broken.php'&&d.severity==='error'));
});
test('Laravel IDs, calls and inheritance survive native-unit cold/warm/revision analysis without AST metadata',async()=>{
  const root=await repository({'backend/Service.php':'<?php namespace App; class Base {function help(){}} class Service extends Base {function run(){ $this->help(); }}','generic/run.php':'<?php function standalone(){}'}),context=await scanned(root),cache=new AnalysisCache(path.join(root,'.cache'));
  const cold=await indexRepository(root,{config:context.config,cache}),warm=await indexRepository(root,{config:context.config,cache}),revision=await indexRepository(root,{config:context.config,revision:'source'});
  for(const key of ['entities','relations']as const){assert.equal(canonicalJson(cold[key]),canonicalJson(warm[key]));assert.equal(canonicalJson(cold[key]),canonicalJson(revision[key]));}
  const service=cold.entities.find(e=>e.name==='Service')!,run=cold.entities.find(e=>e.name==='run'&&e.type==='method')!,help=cold.entities.find(e=>e.name==='help')!;
  assert.equal(service.id,stableId('symbol','provider','php','backend','App\\Service'));assert.ok(cold.relations.some(r=>r.type==='calls'&&r.from===run.id&&r.to===help.id));assert.ok(cold.relations.some(r=>r.type==='extends'&&r.from===service.id));
  assert.equal(cold.run!.analyzerVersions['php-laravel'],LARAVEL_VERSION);assert.equal((cold.entities.find(e=>e.path==='backend/Service.php'&&e.type==='file')!.metadata.phpSourceProvider as {version:string}).version,PHP_SOURCE_PROVIDER_VERSION);
  assert.ok(!JSON.stringify(cold).includes('"phpAst"'));assert.ok(!JSON.stringify(cold).includes('"tokens"'));assert.ok(!JSON.stringify(cold).includes('"kind":"program"'));
});
test('A released PHP service drops retained source trees and terminates its parser',async()=>{
  const root=await repository({'backend/Service.php':'<?php class Service {}'}),context=await scanned(root),sources=provider(context),file=context.files.get('backend/Service.php')!;
  await sources.read(file);sources.release();assert.equal(sources.get(file.path),undefined);assert.equal(sources.failures.size,0);
  await assert.rejects(sources.read(file),/released/);
});
test('Releasing an in-flight preparation cancels its queue without retaining native trees',async()=>{
  const root=await repository(Object.fromEntries(Array.from({length:15},(_,i)=>[`backend/Unit${i}.php`,`<?php class Unit${i} {}`]))),context=await scanned(root),sources=provider(context);
  sources.prepare([...context.files.values()].filter(file=>file.language==='php'));sources.release();await sources.prepared();assert.equal(sources.failures.size,0);assert.ok([...context.files.values()].every(file=>!sources.get(file.path)));
});
