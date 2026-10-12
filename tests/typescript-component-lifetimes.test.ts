import assert from 'node:assert/strict';
import {mock,test} from 'node:test';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import {DeclarationIndex,type TypeScriptProject} from '../src/analysis/languages/typescript-services.js';
import {typescriptFrameworkPacks} from '../src/analysis/frameworks/index.js';
import type {TypeScriptFrameworkPack,TypeScriptPackScope} from '../src/analysis/frameworks/typescript-pack.js';
import {indexRepository} from '../src/pipeline/index.js';
import {resolveConfig} from '../src/core/config.js';
import {AnalysisCache} from '../src/pipeline/cache.js';
import {canonicalJson} from '../src/history/fingerprint.js';
import {GraphBuilder,type Entity,type SoftwareGraph} from '../src/core/graph.js';
import type {AnalysisContext} from '../src/core/analyzer.js';
import {filesystemAnalyzer} from '../src/analyzers/filesystem.js';
import {projectAnalyzer} from '../src/analysis/project-model.js';
import {typescriptAnalyzer} from '../src/analyzers/typescript.js';

const parsed=(file:string)=>ts.createSourceFile(file,'// é😀\r\nexport function original(){return 1;}',ts.ScriptTarget.Latest,true);
const declaration=(file:ts.SourceFile)=>file.statements[0]as ts.FunctionDeclaration;
const entity=(id:string):Entity=>({id,type:'function',name:'original',path:id,metadata:{},evidence:[]});
test('retired source files release only their AST keys while exact declaration sites stay available to other compiler instances',()=>{
 const index=new DeclarationIndex(),first=parsed('/owned/first.ts'),other=parsed('/owned/other.ts'),a=entity('first'),b=entity('other');index.set(declaration(first),a);index.set(declaration(other),b);index.set(declaration(first),a);assert.deepEqual(index.ownershipStats(),{nodeKeys:2,sourceSites:2});index.releaseSourceFiles([first]);assert.equal(Map.prototype.has.call(index,declaration(first)),false);assert.equal(index.get(declaration(first)),a);assert.equal(index.get(declaration(parsed('/owned/first.ts'))),a);assert.equal(Map.prototype.has.call(index,declaration(other)),true);assert.deepEqual(index.ownershipStats(),{nodeKeys:1,sourceSites:2});index.releaseSourceFiles([first,other]);assert.deepEqual(index.ownershipStats(),{nodeKeys:0,sourceSites:2});index.clear();assert.deepEqual(index.ownershipStats(),{nodeKeys:0,sourceSites:0});
});
test('explicit node deletion, replacement and clear do not leave source ownership sets able to remove unrelated future registrations',()=>{
 const index=new DeclarationIndex(),source=parsed('/owned/source.ts'),node=declaration(source),first=entity('first'),second=entity('second');index.set(node,first);assert.equal(index.delete(node),true);assert.equal(index.delete(node),false);assert.equal(index.get(node),first,'Existing source-site fallback semantics are preserved');index.set(node,second);assert.equal(index.get(node),second);index.releaseSourceFiles([source]);assert.equal(index.size,0);assert.equal(index.get(node),second);index.clear();index.set(node,first);index.releaseSourceFiles([source]);assert.equal(index.size,0);assert.equal(index.get(node),first);
});
async function repository(){
 const root=await mkdtemp(path.join(tmpdir(),'codiluce-component-lifetimes-')),files={'package.json':JSON.stringify({workspaces:['alpha','beta','shared']}),'alpha/package.json':JSON.stringify({name:'alpha',dependencies:{express:'5.1.0',shared:'workspace:*'}}),'alpha/main.ts':'import express from "express";import {original} from "shared";const app=express();app.get("/one",original);','beta/package.json':JSON.stringify({name:'beta',dependencies:{express:'5.1.0'}}),'beta/main.ts':'import express from "express";const app=express();function independent(){return 2}app.get("/two",independent);','shared/package.json':JSON.stringify({name:'shared',main:'source.ts'}),'shared/source.ts':'// é😀 original\r\nexport function original(req,res){return leaf()}\r\nfunction leaf(){return 1;}\r\nthrow new Error("target must never execute");'};
 for(const [file,text]of Object.entries(files)){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),text);}return root;
}
function addPack(pack:TypeScriptFrameworkPack){const observed=typescriptFrameworkPacks as TypeScriptFrameworkPack[];observed.push(pack);return()=>{const index=observed.indexOf(pack);assert.ok(index>=0);observed.splice(index,1);};}
const compare=(graph:SoftwareGraph)=>canonicalJson({...graph,run:{...graph.run,id:'owned-run',analyzedAt:'owned-time'}});
test('dependency components finish all framework/HTTP consumers before retirement and cold/warm/revision graphs match the prior retained-program lifetime',async()=>{
 const root=await repository();let passed=false,retain=false;const releases:ReturnType<typeof mock.method>[]=[],wrapped=new Set<TypeScriptProject>();let priorNodes:Array<{node:ts.Node;entity:Entity}>=[],boundaryChecked=false,lastScope:TypeScriptPackScope|undefined;
 const pack:TypeScriptFrameworkPack={id:'owned-component-lifetime-observer',version:'1',applies:()=>true,declare(scope){
  lastScope=scope;
  if(retain){for(const runtime of scope.services.projects)if(!wrapped.has(runtime)){wrapped.add(runtime);const release=mock.method(runtime,'releaseProgram',()=>{});releases.push(release);}return;}
  if(scope.files.some(frame=>frame.file.path==='shared/source.ts'))assert.ok(scope.files.some(frame=>frame.file.path==='alpha/main.ts'),'Declared shared dependency stays in the same atomic component');
  if(priorNodes.length){for(const prior of priorNodes){assert.equal(Map.prototype.has.call(scope.services.declarations,prior.node),false,'A completed earlier component must release its AST keys');assert.equal(scope.services.declarations.get(prior.node),prior.entity,'Exact source identity survives retirement');}boundaryChecked=true;}
 },finish(scope){const sources=new Set(scope.files.map(frame=>frame.source)),nodes=[...scope.services.declarations.keys()].filter(node=>sources.has(node.getSourceFile()));assert.ok(nodes.length>0,'Framework finish runs while current component declarations are still pinned');if(!retain)priorNodes=nodes.map(node=>({node,entity:scope.services.declarations.get(node)!}));}};
 const remove=addPack(pack),restore=()=>{for(const release of releases.splice(0).reverse())release.mock.restore();wrapped.clear();};
 try{
  const config=await resolveConfig(root,{repository:{name:'Owned component lifecycle'}}),revision='d'.repeat(40),reference=async(revision?:string)=>{retain=true;try{return await indexRepository(root,{config,...revision?{revision}:{},onProgress:name=>{if(name==='typescript-services-release')restore();}});}finally{restore();retain=false;}};
  const started=Date.now(),coldReference=await reference();console.error('Component parity reference working tree ms',Date.now()-started);const revisionReference=await reference(revision),cache=new AnalysisCache(path.join(root,'.codiluce/cache'));priorNodes=[];const cold=await indexRepository(root,{config,cache});console.error('Component parity references and candidate cold ms',Date.now()-started);assert.equal(compare(cold),compare(coldReference));assert.ok(boundaryChecked);assert.equal(lastScope!.services.declarations.size,0);priorNodes=[];assert.equal(compare(await indexRepository(root,{config,cache})),compare(coldReference));assert.ok(cache.events.some(event=>event.analyzer==='typescript-nextjs'&&event.hit));priorNodes=[];assert.equal(compare(await indexRepository(root,{config,revision})),compare(revisionReference));
  const endpoint=cold.entities.find(e=>e.type==='api_endpoint'&&e.name==='GET /one'),handler=cold.entities.find(e=>e.name==='original'&&e.path==='shared/source.ts'),leaf=cold.entities.find(e=>e.name==='leaf'&&e.path==='shared/source.ts');assert.ok(endpoint&&handler&&leaf);assert.ok(cold.relations.some(r=>r.type==='handles'&&r.from===endpoint.id&&r.to===handler.id));assert.ok(cold.relations.some(r=>r.type==='calls'&&r.from===handler.id&&r.to===leaf.id));passed=true;
 }finally{restore();remove();if(passed)await rm(root,{recursive:true,force:true});else console.error('Retained component lifecycle fixture:',root);}
});
test('a framework failure releases every prepared project and declaration-node owner in the failing dependency component',async()=>{
 const root=await repository();let scope:TypeScriptPackScope|undefined,passed=false;const remove=addPack({id:'owned-component-lifetime-failure',version:'1',applies:current=>current.files.some(frame=>frame.file.path==='shared/source.ts'),declare(current){scope=current;throw Error('Injected owned framework failure');}});
 try{await assert.rejects(indexRepository(root),/Injected owned framework failure/);assert.ok(scope);assert.equal(scope.services.declarations.size,0);assert.ok(scope.services.declarations.ownershipStats().sourceSites>0,'Completed original graph identities remain plain source-site facts');passed=true;}finally{remove();if(passed)await rm(root,{recursive:true,force:true});else console.error('Retained component failure fixture:',root);}
});
test('explicit project release clears AST ownership and lazy rebuild recovers exact graph declaration owners without creating duplicate entities',async()=>{
 const root=await repository();let passed=false;
 try{
  const config=await resolveConfig(root,{repository:{name:'Owned lazy owner recovery'}}),graph=new GraphBuilder(config.repository.name),context:AnalysisContext={root,config,graph,repositoryId:graph.id('repository'),files:new Map(),applicationIds:new Map(),http:[]};for(const analyzer of [filesystemAnalyzer,projectAnalyzer,typescriptAnalyzer])await analyzer.analyze(context);const services=context.typescript!,runtime=services.projectFor('shared/source.ts')!;assert.equal(services.declarations.size,0);const before=graph.entities.size,source=runtime.program().getSourceFile(path.join(root,'shared/source.ts'))!,owners=runtime.owners(source);assert.ok([...owners.values()].some(e=>e.name==='original'));assert.ok(services.declarations.size>0);runtime.releaseProgram();assert.equal(services.declarations.size,0);const rebuilt=runtime.program().getSourceFile(path.join(root,'shared/source.ts'))!;assert.deepEqual([...runtime.owners(rebuilt).values()].map(e=>e.id).sort(),[...owners.values()].map(e=>e.id).sort());assert.equal(graph.entities.size,before);services.releasePrograms();assert.deepEqual(services.declarations.ownershipStats(),{nodeKeys:0,sourceSites:0});passed=true;
 }finally{if(passed)await rm(root,{recursive:true,force:true});else console.error('Retained owner recovery fixture:',root);}
});
