import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {StructureParser} from '../src/analysis/tree-sitter/client.js';
import {grammarCatalog,verifiedGrammar} from '../src/analysis/tree-sitter/grammars.js';
import {objcRegions} from '../src/analysis/tree-sitter/objc-regions.js';
import {indexRepository} from '../src/pipeline/index.js';
import {AnalysisCache} from '../src/pipeline/cache.js';
import {canonicalJson} from '../src/history/fingerprint.js';
import type {StructureFacts} from '../src/analysis/facts.js';
import type {SoftwareGraph} from '../src/core/graph.js';

const roots:string[]=[];after(async()=>{await Promise.all(roots.map(root=>rm(root,{recursive:true,force:true})));});
async function put(root:string,file:string,text:string){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),text);}
async function repo(files:Record<string,string>){const root=await mkdtemp(path.join(tmpdir(),'codiluce-objc-'));roots.push(root);for(const [file,text]of Object.entries(files))await put(root,file,text);return root;}
async function parse(source:string){const parser=new StructureParser();try{return await parser.parse('objective-c',source);}finally{parser.close();}}
const select=(facts:StructureFacts,name:string,kind?:string)=>facts.declarations.filter(fact=>fact.name===name&&(!kind||fact.kind===kind));
const shape=(graph:SoftwareGraph)=>canonicalJson({entities:graph.entities,relations:graph.relations,diagnostics:graph.diagnostics.filter(item=>!['git-metrics','indexer'].includes(item.analyzer)&&item.code!=='git-ignore-unavailable')});
const symbols=(graph:SoftwareGraph)=>graph.entities.filter(entity=>entity.type!=='file'&&entity.evidence.some(item=>item.analyzer==='tree-sitter-structure'));

test('Objective-C ships the upstream MIT WASM grammar with exact version, ABI and hash provenance',async()=>{
 const spec=grammarCatalog.get('objective-c')!;assert.equal(spec.artifactPackage,'tree-sitter-objc');assert.equal(spec.artifactVersion,'3.0.2');assert.equal(spec.abi,14);assert.equal(spec.sourceRevision,'18802acf31d0b5c1c1d50bdbc9eb0e1636cab9ed');assert.equal(spec.license,'MIT');assert.equal(verifiedGrammar(spec).length,5317155);assert.throws(()=>verifiedGrammar({...spec,sha256:'bad'}),/checksum mismatch/);assert.ok((await readFile(new URL('../grammars/licenses/objc.txt',import.meta.url),'utf8')).includes('Permission is hereby granted'));
});

test('Original interfaces, implementations and signed selectors preserve separate source owners and declaration forms',async()=>{
 const facts=await parse('@interface Widget : Root { @private int count; } @property(nonatomic) int value; +(id)run:(id)x; -(id)run:(id)x; @end @implementation Widget +(id)run:(id)x{return x;} -(id)run:(id)x{return x;} @end');assert.deepEqual(facts.issues,[]);
 const iface=select(facts,'Widget','class-interface')[0]!,implementation=select(facts,'Widget','class-implementation')[0]!;assert.equal(iface.declarationForm,'declaration');assert.equal(implementation.declarationForm,'definition');assert.notEqual(iface.key,implementation.key);assert.ok(iface.annotations?.includes('Original superclass syntax: Root'));
 const methods=select(facts,'run:');assert.equal(methods.length,4);assert.deepEqual(methods.map(f=>f.dispatch),['class','instance','class','instance']);assert.deepEqual(methods.map(f=>f.declarationForm),['declaration','declaration','definition','definition']);assert.equal(methods[0]!.qualifiedName,'Widget::+run:');assert.equal(methods[1]!.qualifiedName,'Widget::-run:');assert.equal(methods[0]!.parent,iface.key);assert.equal(methods[2]!.parent,implementation.key);assert.equal(select(facts,'count')[0]!.visibility,'private');
});

test('Multi-part, empty-label and variadic selectors retain native spelling without parameter-name synthesis',async()=>{
 const f=await parse('@interface X -(void)load:(id)value with:(int)count; -(void):(int)left add:(int)right; -(void)pair:(id)left :(id)right; -(void)log:(id)first, ...; -(void)reset; @end');assert.deepEqual(f.issues,[]);assert.deepEqual(f.declarations.filter(d=>d.kind==='method').map(d=>d.name),['load:with:',':add:','pair::','log:','reset']);assert.ok(!f.declarations.some(d=>['value','count','left','right','first'].includes(d.name)));
});

test('Categories, class extensions, protocols, forwards and compatibility aliases stay distinct original declarations',async()=>{
 const f=await parse('@class Root,Widget;@protocol Reading;@protocol Reading <NSObject> @optional -(id)read; @required +(void)reset; @end @interface Widget() @property int hidden;@end @interface Widget(Extras) -(void)extra;@end @implementation Widget(Extras) -(void)extra{}@end @compatibility_alias Legacy Widget;');assert.deepEqual(f.issues,[]);assert.equal(select(f,'Root','class-forward').length,1);assert.equal(select(f,'Reading','protocol-forward').length,1);assert.equal(select(f,'Reading','protocol').length,1);assert.ok(select(f,'read')[0]!.modifiers?.includes('optional'));assert.ok(select(f,'reset')[0]!.modifiers?.includes('required'));assert.ok(select(f,'Widget()')[0]!.modifiers?.includes('class-extension'));assert.equal(select(f,'Widget(Extras)').length,2);assert.equal(select(f,'extra')[0]!.qualifiedName,'Widget(Extras)::-extra');assert.equal(select(f,'Legacy','class-alias').length,1);assert.ok(select(f,'Legacy')[0]!.annotations?.includes('Original alias target syntax: Widget'));assert.equal(select(f,'Legacy')[0]!.name,'Legacy');
});

test('Properties, atomic and bitfield ivars, multiple data declarators and block-pointer types preserve original data',async()=>{
 const f=await parse('@interface X {_Atomic(int) count; unsigned flags:3; unsigned:1;int left,right;} @property(copy,getter=custom,setter=setCustom:) NSString *title; @property(copy) void (^callback)(id value); @property _Atomic(int) atomic; @end typedef void (^Completion)(id value);');assert.deepEqual(f.issues,[]);for(const name of ['count','flags','left','right','title','callback','atomic'])assert.equal(select(f,name)[0]!.kind,'property');assert.equal(select(f,'right')[0]!.signature,'int right');assert.equal(select(f,'Completion')[0]!.kind,'type');assert.ok(select(f,'title')[0]!.annotations?.includes('setter=setCustom:'));assert.ok(!f.declarations.some(d=>['custom','setCustom:','value'].includes(d.name)));
});

test('Synthesize and dynamic syntax never create generated accessors or ivars',async()=>{
 const f=await parse('@interface X @property int property;@end @implementation X @synthesize property=_property; @dynamic other; -(void)touch{} @end');assert.deepEqual(f.issues,[]);assert.deepEqual(f.objc!.propertyImplementations.map(item=>item.kind),['synthesize','dynamic']);assert.deepEqual(f.objc!.propertyImplementations[0]!.names,['property','_property']);assert.ok(!f.declarations.some(d=>['_property','other','setProperty:'].includes(d.name)));assert.equal(select(f,'property').length,1);
});

test('Original C helpers and typedefs coexist with Objective-C methods without leaking local variables or block callbacks',async()=>{
 const f=await parse('struct Value {int count;};int helper(int x);int helper(int x){return x;}@implementation X -(int)run{int local=2;typedef int Local;void (^callback)(void)=^{ };return helper(local);}@end');assert.deepEqual(f.issues,[]);assert.equal(select(f,'helper').length,2);assert.ok(!f.declarations.some(d=>['local','callback'].includes(d.name)));assert.equal(select(f,'Local')[0]!.parent,select(f,'run')[0]!.key);
});

test('Import/module directives, conditional source declarations and EOF pragmas retain syntax without resolver edges',async()=>{
 const text='#import <Foundation/Foundation.h>\n@import Foundation.IO;\n#if FLAG\n@interface X -(void)chosen;@end\n#else\n@interface Y -(void)chosen;@end\n#endif\n#undef FLAG';const f=await parse(text);assert.deepEqual(f.issues,[]);assert.deepEqual(f.objc!.moduleImports[0]!.path,['Foundation','IO']);assert.ok(f.cfamily!.preprocessor.some(item=>item.text.startsWith('#import')));assert.ok(f.cfamily!.preprocessor.some(item=>item.text.startsWith('#undef FLAG')));assert.ok(select(f,'chosen')[1]!.sourceConditions?.includes('#else'));
 const g=await indexRepository(await repo({'src/main.m':text})),file=g.entities.find(e=>e.type==='file'&&e.path==='src/main.m')!;assert.equal((file.metadata.analysis as any).features.structure.status,'supported');for(const feature of ['imports','references','framework','effects','guards'])assert.equal((file.metadata.analysis as any).features[feature].status,'unsupported');assert.ok(!g.relations.some(r=>['calls','imports','handles','requests'].includes(r.type)));
});

test('Malformed selector headers never produce guessed methods while valid sibling/body declarations survive',async()=>{
 const f=await parse('@implementation X -(void)broken:( { } -(void)good{} @end');assert.ok(f.issues.length);assert.equal(select(f,'broken:').length,0);assert.equal(select(f,'good','method').length,1);
 const body=await parse('@implementation X -(void)good { int value = ; }@end');assert.ok(body.issues.length);assert.equal(select(body,'good','method')[0]!.declarationForm,'definition');
});

test('CRLF, Unicode comments and original EOF ranges do not expose synthetic positions',async()=>{
 const text='// 😀 original\r\n@interface X\r\n-(void)load:(id)value with:(int)count;\r\n@end\r\n#define ORIGINAL 1';const f=await parse(text);assert.deepEqual(f.issues,[]);assert.equal(select(f,'load:with:')[0]!.range.startLine,3);for(const d of f.declarations){assert.ok(d.end<=text.length);const lines=text.slice(0,d.start).split('\n');assert.equal(d.range.startLine,lines.length);assert.equal(d.range.startColumn,lines.at(-1)!.length+1);}assert.equal(select(f,'ORIGINAL')[0]!.end,text.length);
});

test('Original annotation-boundary recovery preserves class members and selectors with explicit source-context gaps',async()=>{
 const text='// 😀 original\r\nNS_ASSUME_NONNULL_BEGIN\r\n@interface X\r\n@property(copy) NSString *title;\r\n-(void)load:(id)value with:(int)count;\r\n@end\r\nNS_ASSUME_NONNULL_END';const f=await parse(text);assert.equal(select(f,'X','class-interface').length,1);assert.equal(select(f,'title','property').length,1);assert.equal(select(f,'title','variable').length,0);assert.equal(select(f,'load:with:')[0]!.range.startLine,5);assert.ok(f.issues.some(issue=>issue.code==='syntax-source-context-gap'));assert.equal(f.objc!.complete,false);assert.equal(f.objc!.isolatedRegions?.length,1);assert.ok(select(f,'title')[0]!.sourceConditions?.some(reason=>reason.includes('unexpanded')));assert.ok(f.declarations.every(d=>d.end<=text.length));
});

test('Original region discovery excludes literals, comments, raw C++ strings and continued/comment-prefixed macro bodies',()=>{
 const text='// @interface Fake @end\nconst char *s="@interface Fake @end";\nR"delim(@interface Fake @end)delim";\n/* prefix */ #define DECL(T) @interface T \\\n@end\n@interface Real -(void)read;@end\n@protocol Forward;\n@protocol RealProtocol -(id)read;@end';const found=objcRegions(text);assert.equal(found.truncated,false);assert.deepEqual(found.regions.map(region=>text.slice(region.start,region.end)),['@interface Real -(void)read;@end','@protocol RealProtocol -(id)read;@end']);
});

test('Objective-C cold/warm/revision graphs and original IDs survive body/line edits while syntax changes invalidate cache',async()=>{
 const root=await repo({'main.m':'@interface X -(int)run;@end @implementation X -(int)run{return 1;}@end'}),state=path.join(root,'.cache'),cold=await indexRepository(root,{cache:new AnalysisCache(state)}),cache=new AnalysisCache(state),warm=await indexRepository(root,{cache});assert.equal(shape(cold),shape(warm));assert.equal(shape(cold),shape(await indexRepository(root,{revision:'original'})));assert.ok(cache.events.some(e=>e.analyzer==='syntax-facts'&&e.hit));const ids=symbols(cold).map(e=>e.id).sort();
 await put(root,'main.m','// 😀 shifted\n@interface X\n// changed interface docs\n-(int)run;@end @implementation X -(int)run{return 2;}@end');const editedCache=new AnalysisCache(state),edited=await indexRepository(root,{cache:editedCache});assert.deepEqual(symbols(edited).map(e=>e.id).sort(),ids);assert.ok(editedCache.events.some(e=>e.analyzer==='syntax-facts'&&!e.hit));assert.equal(shape(edited),shape(await indexRepository(root,{revision:'edited'})));
});

test('Objective-C header recognition and honest Objective-C++ partial status retain source declarations',async()=>{
 const g=await indexRepository(await repo({'ios/X.h':'@interface X -(void)run;@end','ios/X.m':'@implementation X -(void)run{}@end','ios/Cpp.mm':'namespace native { class Value {}; } @interface Bridge -(void)read;@end'}));const header=g.entities.find(e=>e.type==='file'&&e.path==='ios/X.h')!;assert.equal(header.language,'objective-c');assert.equal((header.metadata.analysis as any).features.structure.status,'supported');const cpp=g.entities.find(e=>e.type==='file'&&e.path==='ios/Cpp.mm')!;assert.equal((cpp.metadata.analysis as any).features.structure.status,'partial');assert.equal((cpp.metadata.objcSyntax as any).sourceProfile,'objective-cpp-partial');assert.ok(g.diagnostics.some(d=>d.code==='objc-cpp-structure-gap'&&d.file==='ios/Cpp.mm'));assert.ok(symbols(g).some(e=>e.name==='Bridge'&&e.path==='ios/Cpp.mm'));assert.ok(!g.relations.some(r=>['calls','imports','handles','requests'].includes(r.type)));
});

test('Large module syntax sets stay bounded with explicit incomplete outcomes',async()=>{
 const f=await parse(Array.from({length:4100},(_,i)=>`@import Original${i};`).join('\n'));assert.equal(f.truncated,true);assert.equal(f.objc!.complete,false);assert.equal(f.objc!.moduleImports.length,4096);assert.ok(f.issues.some(issue=>issue.code==='syntax-budget-exceeded'));assert.ok(f.issues.length<=100);
});
