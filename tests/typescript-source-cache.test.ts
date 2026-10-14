import assert from 'node:assert/strict';
import {mock,test} from 'node:test';
import {mkdir,mkdtemp,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import {createApplicationProgram,TypeScriptSourceCache,type TypeScriptCacheLimits} from '../src/analyzers/ts-program.js';
import {indexRepository} from '../src/pipeline/index.js';
import { isolatedTypescriptAnalyzer } from '../src/analyzers/typescript-isolated.js';
import { typescriptAnalyzer } from '../src/analyzers/typescript.js';
import {resolveConfig} from '../src/core/config.js';
import {AnalysisCache} from '../src/pipeline/cache.js';
import {canonicalJson} from '../src/history/fingerprint.js';
import type {SoftwareGraph} from '../src/core/graph.js';

const source=(name:string,text='export function original(){return 1;}')=>ts.createSourceFile(name,text,ts.ScriptTarget.Latest,true);
const profile=(change:Partial<TypeScriptCacheLimits>={}):TypeScriptCacheLimits=>({maxBytes:100000,maxNodes:1000,maxEntries:3,...change});

test('compiler source cache keeps exact source and parse identity with LRU entry admission',()=>{
 const cache=new TypeScriptSourceCache(profile({maxEntries:2})),first=source('first.ts'),second=source('second.ts'),third=source('third.ts');cache.put('first','parse',first);cache.put('second','parse',second);assert.equal(cache.get('first',first.text,'parse'),first);cache.put('third','parse',third);
 assert.equal(cache.get('second',second.text,'parse'),undefined);assert.equal(cache.get('first',first.text,'parse'),first);assert.equal(cache.get('third',third.text,'parse'),third);assert.equal(cache.stats().evictions,1);assert.equal(cache.stats().entries,2);
 assert.equal(cache.get('first','changed original','parse'),undefined);assert.equal(cache.stats().entries,1);assert.equal(cache.get('third',third.text,'changed parse'),undefined);assert.equal(cache.stats().entries,0);assert.equal(cache.stats().bytes,0);assert.equal(cache.stats().nodes,0);assert.equal(cache.stats().invalidations,2);
});
test('compiler source and key UTF-16 payload admission has exact independent bounds',()=>{
 const original=source('original.ts','// é😀\r\nexport const original="é😀";'),key='original-cache-key',parse='parse',bytes=2*(key.length+parse.length+original.fileName.length+original.text.length),accepted=new TypeScriptSourceCache(profile({maxBytes:bytes})),bypassed=new TypeScriptSourceCache(profile({maxBytes:bytes-1}));accepted.put(key,parse,original);bypassed.put(key,parse,original);
 assert.equal(accepted.stats().bytes,bytes);assert.equal(accepted.get(key,original.text,parse),original);assert.equal(bypassed.get(key,original.text,parse),undefined);assert.equal(bypassed.stats().bypasses,1);assert.equal(original.getFullText(),original.text);
 accepted.put(key,parse,source('original.ts','// original '.repeat(1000)));assert.equal(accepted.stats().entries,0,'An oversized replacement cannot retain the stale original');assert.equal(accepted.stats().bytes,0);
});
test('compiler child-visitor node admission evicts independently of source bytes and oversized trees remain usable',()=>{
 const first=source('first.ts'),count=(root:ts.Node):number=>{let nodes=0;const visit=(node:ts.Node)=>{nodes++;ts.forEachChild(node,visit);};visit(root);return nodes;},nodes=count(first),cache=new TypeScriptSourceCache(profile({maxNodes:nodes}));cache.put('first','parse',first);assert.equal(cache.stats().nodes,nodes);cache.put('second','parse',source('second.ts'));assert.equal(cache.stats().evictions,1);assert.equal(cache.get('first',first.text,'parse'),undefined);assert.equal(cache.stats().nodes,nodes);
 const large=source('large.ts','export const original=['+'1,'.repeat(2000)+'];');cache.put('large','parse',large);assert.equal(cache.stats().bypasses,1);assert.equal(cache.stats().nodes,nodes);assert.ok(large.statements.length);assert.equal(cache.get('large',large.text,'parse'),undefined);cache.clear();assert.equal(cache.stats().entries,0);assert.equal(cache.stats().nodes,0);assert.equal(cache.stats().bytes,0);
});
test('disabled and invalid compiler cache profiles cannot silently authorize unlimited ownership',()=>{
 for(const limits of [profile({maxBytes:-1}),profile({maxNodes:Infinity}),profile({maxEntries:0.5}),{maxBytes:1,maxEntries:1}as TypeScriptCacheLimits])assert.throws(()=>new TypeScriptSourceCache(limits),/nonnegative safe integers/);
 for(const limits of [profile({maxBytes:0}),profile({maxNodes:0}),profile({maxEntries:0})]){const cache=new TypeScriptSourceCache(limits);cache.put('source','parse',source('original.ts'));assert.equal(cache.stats().entries,0);assert.equal(cache.stats().bypasses,1);}
});
test('actual compiler programs preserve imports, exact source, direct bindings and target nonexecution when AST cache admission churns',()=>{
 const root=path.resolve('owned-typescript-source-cache-fixture'),entry=path.join(root,'entry.ts'),leaf=path.join(root,'leaf.ts'),texts=new Map([[entry,'import { leaf } from "./leaf"; export const original=leaf(1); throw new Error("target must never execute");'],[leaf,'export function leaf(value:number):number{return value+1;}']]),cache=new TypeScriptSourceCache(profile({maxEntries:1})),disabled=new TypeScriptSourceCache(profile({maxEntries:0}));
 const run=(sourceCache:TypeScriptSourceCache)=>{
  const program=createApplicationProgram(texts,{noLib:true,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler},root,{sourceCache}),checker=program.getTypeChecker(),file=program.getSourceFile(entry)!;let call:ts.CallExpression|undefined;
  const visit=(node:ts.Node)=>{if(ts.isCallExpression(node)&&node.expression.getText(file)==='leaf')call=node;ts.forEachChild(node,visit);};visit(file);assert.ok(call);const alias=checker.getSymbolAtLocation(call.expression)!;assert.ok(alias.flags&ts.SymbolFlags.Alias);const symbol=checker.getAliasedSymbol(alias);assert.equal(symbol.name,'leaf');assert.equal(symbol.declarations![0]!.getSourceFile().fileName,leaf);assert.equal(checker.typeToString(checker.getTypeAtLocation(call)),'number');
  return {files:program.getSourceFiles().map(f=>({file:f.fileName,text:f.text})),diagnostics:program.getSemanticDiagnostics().map(d=>({code:d.code,file:d.file?.fileName,start:d.start,length:d.length,message:ts.flattenDiagnosticMessageText(d.messageText,'\n')}))};
 };
 const expected=run(disabled);for(let repetition=0;repetition<3;repetition++)assert.deepEqual(run(cache),expected);assert.equal(cache.stats().peakEntries,1);assert.ok(cache.stats().evictions>=5);
 texts.set(leaf,'export function leaf(value:number):string{return "changed original"+value;}');const changed=createApplicationProgram(texts,{noLib:true,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler},root,{sourceCache:cache});assert.equal(changed.getSourceFile(leaf)!.text,texts.get(leaf));assert.ok(cache.stats().entries<=1);
});
test('actual compiler AST reuse distinguishes parser options and owning project roots',()=>{
 const root=path.resolve('owned-typescript-project-cache'),file=path.join(root,'original.ts'),text='export const original=1;',cache=new TypeScriptSourceCache(profile());
 const program=(directory=root,target=ts.ScriptTarget.ESNext)=>createApplicationProgram(new Map([[file,text]]),{noLib:true,target},directory,{sourceCache:cache}),first=program();assert.equal(program().getSourceFile(file),first.getSourceFile(file));assert.notEqual(program(root,ts.ScriptTarget.ES5).getSourceFile(file),first.getSourceFile(file));assert.notEqual(program(root+'-other').getSourceFile(file),first.getSourceFile(file));assert.equal(cache.stats().invalidations,1);assert.equal(cache.stats().entries,2);
});
test('compiler-owned declaration libraries preserve actual standard types while independent library admission churns',()=>{
 const root=path.resolve('owned-typescript-library-cache'),file=path.join(root,'original.ts'),text='export function original(value:string):number{return value.length;}',cache=new TypeScriptSourceCache(profile({maxBytes:1_000_000,maxNodes:100_000,maxEntries:1})),disabled=new TypeScriptSourceCache(profile({maxEntries:0}));
 const run=(libraryCache:TypeScriptSourceCache)=>{
  const program=createApplicationProgram(new Map([[file,text]]),{target:ts.ScriptTarget.ESNext,lib:['lib.es5.d.ts']},root,{sourceCache:disabled,libraryCache}),checker=program.getTypeChecker(),source=program.getSourceFile(file)!,fn=source.statements[0]as ts.FunctionDeclaration;assert.equal(checker.typeToString(checker.getTypeAtLocation(fn.parameters[0]!)),'string');assert.equal(checker.typeToString(checker.getTypeAtLocation(fn)),'(value: string) => number');
  return {files:program.getSourceFiles().map(f=>({file:f.fileName,text:f.text})),diagnostics:program.getSemanticDiagnostics().map(d=>({code:d.code,start:d.start,length:d.length,message:ts.flattenDiagnosticMessageText(d.messageText,'\n')}))};
 };
 const expected=run(disabled);assert.deepEqual(expected.diagnostics,[]);assert.deepEqual(run(cache),expected);assert.deepEqual(run(cache),expected);assert.ok(cache.stats().evictions>0);assert.equal(cache.stats().peakEntries,1);assert.ok(cache.stats().peakBytes<=cache.limits.maxBytes);assert.ok(cache.stats().peakNodes<=cache.limits.maxNodes);
});
test('actual cold/warm/revision graphs preserve complete Express imports, handlers, calls, original ranges and cache replay under AST eviction',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'codiluce-typescript-cache-graph-'));let passed=false;
 try{
  const files={'package.json':JSON.stringify({dependencies:{express:'5.1.0'}}),'main.ts':'// é😀 original\r\nimport express from "express";import router from "./router";const app=express();app.use("/v1",router);app.listen(3000);','router.ts':'import {Router} from "express";import {original} from "./barrel";const router=Router();router.get("/:id",original);export default router;','barrel.ts':'export {original} from "./handlers";','handlers.ts':'// é😀 original\r\nexport function original(req,res){return leaf(req.params.id)}\r\nfunction leaf(value){return value;}\r\nthrow new Error("target must never execute");'};
  for(const [file,text]of Object.entries(files)){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),text);}
  const config=await resolveConfig(root,{repository:{name:'Owned compiler graph cache'}}),cache=new AnalysisCache(path.join(root,'.codiluce/cache')),compare=(graph:SoftwareGraph)=>canonicalJson({...graph,run:{...graph.run,id:'owned-run',analyzedAt:'owned-time'}}),reference=await indexRepository(root,{config}),revision='c'.repeat(40),referenceRevision=await indexRepository(root,{config,revision});
  const endpoint=reference.entities.find(e=>e.type==='api_endpoint'&&e.name==='GET /v1/:id'),handler=reference.entities.find(e=>e.name==='original'&&e.path==='handlers.ts'),leaf=reference.entities.find(e=>e.name==='leaf'&&e.path==='handlers.ts');assert.ok(endpoint&&handler&&leaf);assert.ok(reference.relations.some(r=>r.type==='handles'&&r.from===endpoint.id&&r.to===handler.id));assert.ok(reference.relations.some(r=>r.type==='calls'&&r.from===handler.id&&r.to===leaf.id));assert.equal(handler.sourceRange!.startLine,2);
  const originalGet=TypeScriptSourceCache.prototype.get,originalPut=TypeScriptSourceCache.prototype.put,replacements=new Map<TypeScriptSourceCache,TypeScriptSourceCache>(),replacement=(cache:TypeScriptSourceCache)=>{let value=replacements.get(cache);if(!value){value=new TypeScriptSourceCache(profile({maxBytes:50_000,maxNodes:100_000,maxEntries:1}));replacements.set(cache,value);}return value;};
  const get=mock.method(TypeScriptSourceCache.prototype,'get',function(this:TypeScriptSourceCache,key:string,text:string|undefined,parseKey:string){return originalGet.call(replacement(this),key,text,parseKey);}),put=mock.method(TypeScriptSourceCache.prototype,'put',function(this:TypeScriptSourceCache,key:string,parseKey:string,source:ts.SourceFile){originalPut.call(replacement(this),key,parseKey,source);});
  const execution=mock.method(isolatedTypescriptAnalyzer,'analyze',typescriptAnalyzer.analyze);
  try{
   const cold=await indexRepository(root,{config,cache});assert.equal(compare(cold),compare(reference));const beginning=cache.events.length,warm=await indexRepository(root,{config,cache});assert.equal(compare(warm),compare(reference));assert.ok(cache.events.slice(beginning).some(event=>event.analyzer==='typescript-nextjs'&&event.hit));assert.equal(compare(await indexRepository(root,{config,revision})),compare(referenceRevision));
   assert.ok([...replacements.values()].some(cache=>cache.stats().evictions>0));for(const cache of replacements.values()){assert.ok(cache.stats().peakEntries<=1);assert.ok(cache.stats().peakBytes<=50_000);assert.ok(cache.stats().peakNodes<=100_000);}
  }finally{execution.mock.restore();get.mock.restore();put.mock.restore();}
  assert.deepEqual((await readdir(root)).sort(),['.codiluce',...Object.keys(files)].sort());passed=true;
 }finally{if(passed)await rm(root,{recursive:true,force:true});else console.error('Retained compiler graph cache fixture:',root);}
});
