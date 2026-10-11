import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {mkdir,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {renameSync,symlinkSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
import {indexRepository,analyzers} from '../src/pipeline/index.js';
import {AnalysisCache,type CacheEvent} from '../src/pipeline/cache.js';
import {analyzePhp,phpAnalysisServices} from '../src/pipeline/php-analysis.js';
import {filesystemAnalyzer} from '../src/analyzers/filesystem.js';
import {resolveConfig} from '../src/core/config.js';
import {GraphBuilder,type SoftwareGraph} from '../src/core/graph.js';
import type {AnalysisContext} from '../src/core/analyzer.js';
import {canonicalJson} from '../src/history/fingerprint.js';

const roots:string[]=[];
after(async()=>{await Promise.all(roots.map(root=>rm(root,{recursive:true,force:true})));});
async function directory(){const root=await mkdtemp(path.join(os.tmpdir(),'codiluce-php-replay-'));roots.push(root);return root;}
async function repository(files:Record<string,string>){const root=await directory();for(const[file,text]of Object.entries(files)){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),text);}return root;}
async function fixture(extra:Record<string,string>={}){
 const root=await repository({'backend/composer.json':'{}','backend/Service.php':'<?php namespace App;class Service {function read(){return 1;}}','generic/entry.php':'<?php function original(){}original();',...extra});
 const config=await resolveConfig(root,{repository:{name:'replay'},applications:[{name:'backend',path:'backend',frameworks:['laravel'],ecosystems:['php']},{name:'generic',path:'generic',ecosystems:['php']}]});
 const cache=new AnalysisCache(await directory());return {root,config,cache};
}
function same(actual:SoftwareGraph,expected:SoftwareGraph){for(const key of ['entities','relations','diagnostics']as const)assert.equal(canonicalJson(actual[key]),canonicalJson(expected[key]),key);}
const transaction=(events:CacheEvent[])=>events.filter(event=>event.analyzer==='php-analysis');
async function entry(cache:AnalysisCache){return path.join(cache.directory,(await readdir(cache.directory)).find(file=>file.startsWith('php-analysis.'))!);}

test('qualified PHP graph replay preserves all source output while skipping native hydration and keeping stage names',async()=>{
 const {root,config,cache}=await fixture();const cold=await indexRepository(root,{config,cache});const start=cache.events.length,names:string[]=[];
 const warm=await indexRepository(root,{config,cache,onProgress:name=>names.push(name)});same(warm,cold);same(warm,await indexRepository(root,{config}));
 assert.deepEqual(names,analyzers.map(analyzer=>analyzer.name));assert.deepEqual(transaction(cache.events.slice(start)).map(event=>event.hit),[true]);
 assert.ok(!cache.events.slice(start).some(event=>['php-syntax-facts','php-laravel'].includes(event.analyzer)));
 const record=JSON.parse(gunzipSync(await readFile(await entry(cache))).toString('utf8'));assert.ok(record.inputs.includes('generic/entry.php'));assert.ok(!JSON.stringify(record).includes('phpAst'));
});

for(const stage of ['php-source-units',...phpAnalysisServices.map(service=>service.name)])test(`a source swap at ${stage} rejects the transaction before replay and does not poison the healthy entry`,async()=>{
 const {root,config,cache}=await fixture();const healthy=await indexRepository(root,{config,cache}),start=cache.events.length,names:string[]=[];
 const raced=await indexRepository(root,{config,cache,onProgress:name=>{names.push(name);if(name===stage)writeFileSync(path.join(root,'generic/entry.php'),'<?php function replacement(){}replacement();');}});
 assert.deepEqual(transaction(cache.events.slice(start)).map(event=>event.hit),[false]);assert.ok(!raced.entities.some(entity=>entity.name==='original'||entity.name==='replacement'));
 assert.ok(raced.diagnostics.some(diagnostic=>diagnostic.file==='generic/entry.php'&&diagnostic.reason.includes('changed after the scan')));
 assert.deepEqual(names,analyzers.map(analyzer=>analyzer.name));
 await writeFile(path.join(root,'generic/entry.php'),'<?php function original(){}original();');const restoredStart=cache.events.length;same(await indexRepository(root,{config,cache}),healthy);
 assert.deepEqual(transaction(cache.events.slice(restoredStart)).map(event=>event.hit),[true]);
});

for(const ancestor of [false,true])test(`PHP replay rejects a ${ancestor?'directory ancestor':'source file'} symlink swap even when original bytes match`,async()=>{
 const {root,config,cache}=await fixture();await indexRepository(root,{config,cache});const start=cache.events.length;
 const raced=await indexRepository(root,{config,cache,onProgress:name=>{if(name!=='php-symbols')return;if(ancestor){renameSync(path.join(root,'generic'),path.join(root,'original-directory'));symlinkSync(path.join(root,'original-directory'),path.join(root,'generic'),'dir');}else{renameSync(path.join(root,'generic/entry.php'),path.join(root,'original-file'));symlinkSync(path.join(root,'original-file'),path.join(root,'generic/entry.php'));}}});
 assert.deepEqual(transaction(cache.events.slice(start)).map(event=>event.hit),[false]);assert.ok(!raced.entities.some(entity=>entity.name==='original'));
 assert.ok(raced.diagnostics.some(diagnostic=>diagnostic.file==='generic/entry.php'&&diagnostic.reason.includes('symlink')));
});

for(const dependency of ['custom.json','composer.lock','local/composer.json','loaded.md'])test(`PHP replay freshly validates its recorded ${dependency} dependency`,async()=>{
 const manifest={autoload:{'psr-4':{'App\\':'src/'}},repositories:[{type:'path',url:'local'}],require:{'local/pkg':'*'}};
 const root=await repository({'custom.json':JSON.stringify(manifest),'composer.lock':JSON.stringify({packages:[{name:'remote/pkg',autoload:{'psr-4':{'Remote\\':'src/'}}}]}),'local/composer.json':JSON.stringify({name:'local/pkg',autoload:{'psr-4':{'Local\\':'src/'}}}),'local/src/Missing.php':'<?php namespace Local;class Missing{}','src/A.php':'<?php namespace App;class A{static function read(){}}','entry.php':'<?php use App\\A;use Local\\Missing;use Remote\\Type;A::read();'+(dependency==='loaded.md'?'include __DIR__."/loaded.md";':''),'loaded.md':'original loaded text'});
 const config=await resolveConfig(root,{repository:{name:'dependency'},applications:[{name:'php',path:'.',ecosystems:['php'],php:{composer:'custom.json'}}]}),cache=new AnalysisCache(await directory());
 const cold=await indexRepository(root,{config,cache});const record=JSON.parse(gunzipSync(await readFile(await entry(cache))).toString('utf8'));assert.ok(record.inputs.includes(dependency),`${dependency}: actual read dependency`);
 const healthy=await readFile(path.join(root,dependency)),start=cache.events.length;
 const raced=await indexRepository(root,{config,cache,onProgress:name=>{if(name==='php-symbols')writeFileSync(path.join(root,dependency),dependency==='loaded.md'?'changed loaded text':'{}');}});
 assert.deepEqual(transaction(cache.events.slice(start)).map(event=>event.hit),[false]);assert.notEqual(canonicalJson(raced.entities),canonicalJson(cold.entities));
 await writeFile(path.join(root,dependency),healthy);const restored=cache.events.length;same(await indexRepository(root,{config,cache}),cold);assert.deepEqual(transaction(cache.events.slice(restored)).map(event=>event.hit),[true]);
});

test('PHP transaction keys invalidate source, manifest, configuration and observed excluded-path changes',async()=>{
 const {root,config,cache}=await fixture({'generic/composer.json':'{}'});await indexRepository(root,{config,cache});
 for(const edit of [async()=>writeFile(path.join(root,'generic/entry.php'),'<?php function updated(){}'),async()=>writeFile(path.join(root,'generic/composer.json'),'{"autoload":{"files":["entry.php"]}}'),async()=>{config.maxFileBytes+=1;},async()=>{await mkdir(path.join(root,'vendor'));await writeFile(path.join(root,'vendor/hidden.php'),'<?php function excluded(){}');}]){
  await edit();const start=cache.events.length,changed=await indexRepository(root,{config,cache});assert.deepEqual(transaction(cache.events.slice(start)).map(event=>event.hit),[false]);same(changed,await indexRepository(root,{config}));
 }
});

for(const corruption of ['gzip','shape','dependencies','decoded-budget'])test(`a ${corruption} PHP transaction falls back to original source despite the preparation hint`,async()=>{
 const {root,config,cache}=await fixture();const cold=await indexRepository(root,{config,cache}),file=await entry(cache);
 if(corruption==='gzip')await writeFile(file,'not gzip');else{const record=JSON.parse(gunzipSync(await readFile(file)).toString('utf8'));if(corruption==='shape')record.patches=[{id:'missing'}];if(corruption==='dependencies')record.inputs=[];if(corruption==='decoded-budget')record.padding='x'.repeat(65*1024*1024);await writeFile(file,gzipSync(JSON.stringify(record)));}
 const start=cache.events.length;same(await indexRepository(root,{config,cache}),cold);assert.deepEqual(transaction(cache.events.slice(start)).map(event=>event.hit),[false]);
 assert.ok(cache.events.slice(start).some(event=>event.analyzer==='php-syntax-facts'));
});

for(const source of ['<?php class Broken {','<?php '+Array.from({length:4200},(_,i)=>`function f${i}(){}`).join('')])test('malformed or bounded PHP cannot persist an aggregate result and cannot hide independent healthy sources',async()=>{
 const {root,config,cache}=await fixture({'generic/bad.php':source});for(let pass=0;pass<2;pass++){const start=cache.events.length,graph=await indexRepository(root,{config,cache});assert.deepEqual(transaction(cache.events.slice(start)).map(event=>event.hit),[false]);assert.ok(graph.entities.some(entity=>entity.name==='original'));assert.ok(graph.diagnostics.some(diagnostic=>diagnostic.file==='generic/bad.php'));}
 assert.ok(!(await readdir(cache.directory)).some(file=>file.startsWith('php-analysis.')));
});

test('aggregate PHP reads restore an existing dependency observer and cache policy rejection mutates no prior graph facts',async()=>{
 const {root,config,cache}=await fixture();const previous=new Set(['prior.json']);
 const context=():AnalysisContext=>{const graph=new GraphBuilder('replay');return {root,config,cache,graph,repositoryId:graph.id('repository'),files:new Map(),applicationIds:new Map(),http:[],sourceReads:previous};};
 const first=context();await filesystemAnalyzer.analyze(first);try{await analyzePhp(first);}finally{first.phpSources?.release();}assert.equal(first.sourceReads,previous);assert.ok(previous.has('generic/entry.php'));
 const second=context();await filesystemAnalyzer.analyze(second);await analyzePhp(second);assert.equal(second.phpSources,undefined);assert.equal(second.sourceReads,previous);
 const policyCache=new AnalysisCache(await directory()),empty=context();let calls=0;
 const work=async()=>{calls++;assert.ok(!empty.graph.entities.has('cached'));empty.graph.addEntity({id:'fresh',type:'function',name:'fresh',metadata:{},evidence:[]});};
 await policyCache.unit(empty,'policy','unit',{},async()=>{empty.graph.addEntity({id:'cached',type:'function',name:'cached',metadata:{},evidence:[]});});empty.graph.entities.delete('cached');
 await policyCache.unit(empty,'policy','unit',{},work,{beforeReplay:()=>false,shouldStore:()=>false});assert.equal(calls,1);assert.ok(!empty.graph.entities.has('cached'));assert.ok(empty.graph.entities.has('fresh'));
});
