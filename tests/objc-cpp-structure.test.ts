import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {StructureParser} from '../src/analysis/tree-sitter/client.js';
import {cfamilySource,sourceConditions} from '../src/analysis/tree-sitter/cfamily-source.js';
import {objectiveCppSource} from '../src/analysis/tree-sitter/objc-cpp.js';
import {indexRepository} from '../src/pipeline/index.js';
import {AnalysisCache} from '../src/pipeline/cache.js';
import {canonicalJson} from '../src/history/fingerprint.js';
import type {SoftwareGraph} from '../src/core/graph.js';

const roots:string[]=[];
after(async()=>{await Promise.all(roots.map(root=>rm(root,{recursive:true,force:true})));});
async function parse(content:string,objectiveCpp=false){const p=new StructureParser();try{return await p.parse('objective-c',content,{objectiveCpp});}finally{p.close();}}
async function repository(files:Record<string,string>){const root=await mkdtemp(path.join(tmpdir(),'codiluce-objc-cpp-'));roots.push(root);for(const [file,content] of Object.entries(files)){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),content);}return root;}
const shape=(g:SoftwareGraph)=>canonicalJson({entities:g.entities,relations:g.relations,diagnostics:g.diagnostics.filter(d=>!['git-metrics','indexer'].includes(d.analyzer)&&d.code!=='git-ignore-unavailable')});
const symbols=(g:SoftwareGraph)=>g.entities.filter(e=>e.type!=='file'&&e.evidence.some(p=>p.analyzer==='tree-sitter-structure'));

test('Six reviewed SDK enum/options spellings retain original explicit types and members without expansion or evaluation',async()=>{
 for(const macro of ['NS_ENUM','NS_CLOSED_ENUM','NS_OPTIONS','CF_ENUM','CF_CLOSED_ENUM','CF_OPTIONS']){
  const text=`typedef ${macro}(unsigned long, Flags) { None, Read=1<<0, Both=(Read | compute(1,2)), };`;
  const f=await parse(text);
  assert.deepEqual(f.declarations.map(d=>[d.name,d.kind]),[['Flags','type'],['None','enum-member'],['Read','enum-member'],['Both','enum-member']]);
  assert.equal(f.objc!.enumProfiles![0]!.underlyingType,'unsigned long');
  for(const member of f.declarations.slice(1)){assert.equal(member.parent,f.declarations[0]!.key);assert.ok(member.sourceConditions!.some(s=>s.includes('numeric values remain unverified')));}
  assert.equal(f.declarations[3]!.signature,'Both=(Read | compute(1,2))');assert.equal(f.objc!.complete,false);
  assert.ok(!f.declarations.some(d=>d.name==='compute'));
 }
});

test('Macro profiles retain enclosing and per-member directive alternatives as original unevaluated source conditions',async()=>{
 const text='#if FEATURE\ntypedef NS_OPTIONS(unsigned, Mask) {\n#if READ\nRead=1,\n#else\nWrite=2,\n#endif\nBoth=3\n};\n#endif';
 const f=await parse(text),read=f.declarations.find(d=>d.name==='Read')!,write=f.declarations.find(d=>d.name==='Write')!,both=f.declarations.find(d=>d.name==='Both')!;
 assert.ok(read.sourceConditions!.includes('#if FEATURE'));assert.ok(read.sourceConditions!.includes('#if READ'));
 assert.ok(write.sourceConditions!.some(s=>s.includes('#else')));assert.ok(!both.sourceConditions!.some(s=>s.includes('READ')));
 assert.equal(both.range.startLine,8);
});

test('Source overrides, including commented/continued macro names, invalidate standard SDK profiles conservatively',async()=>{
 for(const directive of ['#define NS_ENUM(a,b) mystery(a,b)','#undef NS_ENUM','#define /* changed */ NS_ENUM(a,b) mystery(a,b)','#define \\\nNS_ENUM(a,b) mystery(a,b)']){
  const f=await parse(`${directive}\ntypedef NS_ENUM(unsigned, Mode) { One, Two };`);
  assert.ok(!f.declarations.some(d=>['Mode','One','Two'].includes(d.name)));assert.ok(f.issues.some(i=>i.reason.includes('defined/undefined')));
 }
});

test('Comments, Objective-C/C++ literals and physical macro bodies cannot fabricate profiled enum declarations',async()=>{
 const text='// typedef NS_ENUM(int, Fake) { FakeValue };\nconst char *s="typedef NS_ENUM(int, Fake) { FakeValue };";\nR"raw(typedef NS_ENUM(int, Fake) { FakeValue };)raw";\n/* prefix */ #define MAKE() typedef NS_ENUM(int, Fake) { \\\nFakeValue };\ntypedef NS_ENUM(int, Real) { Original };';
 const f=await parse(text);assert.deepEqual(f.objc!.enumProfiles!.map(d=>d.name),['Real']);assert.ok(!f.declarations.some(d=>d.name.startsWith('Fake')));
});

test('Malformed or dynamic enum macro spelling leaves explicit gaps and never guesses missing declaration names',async()=>{
 const f=await parse('typedef NS_ENUM(int, JOIN(Mode,Name)) { One };\ntypedef NS_OPTIONS(unsigned, Flags) { Good, GENERATED(Bad), Empty= };');
 assert.ok(!f.declarations.some(d=>['Mode','Name','One','GENERATED','Bad','Empty'].includes(d.name)));
 assert.ok(f.declarations.some(d=>d.name==='Flags'));assert.ok(f.declarations.some(d=>d.name==='Good'));assert.ok(f.issues.some(i=>i.code==='objc-macro-profile-gap'));
});

test('Original macro and member ranges use UTF-16/CRLF positions and exclude adjacent comments',async()=>{
 const text='// 😀 original\r\ntypedef NS_ENUM(int, Mode) {\r\n First = 1, // value\r\n Second=2\r\n};';const f=await parse(text);
 assert.equal(f.declarations.find(d=>d.name==='First')!.range.startColumn,2);assert.equal(f.declarations.find(d=>d.name==='Second')!.range.startLine,4);
 for(const d of f.declarations){const before=text.slice(0,d.start).split('\n'),after=text.slice(0,d.end).split('\n');assert.deepEqual(d.range,{startLine:before.length,startColumn:before.at(-1)!.length+1,endLine:after.length,endColumn:after.at(-1)!.length+1});assert.ok(d.end<=text.length);}
});

test('Mixed profiles retain real C++ namespaces/templates/classes/methods and Objective-C owners without ghost C functions or locals',async()=>{
 const f=await parse('namespace native {template<class T> class Store {public:T read(){return T{};}}; using Size=unsigned;} @interface Bridge -(void)read;@end @implementation Bridge -(void)read{std::vector<int> values; auto size=values.size();}@end',true);
 assert.deepEqual(f.declarations.map(d=>[d.name,d.kind]),[['native','namespace'],['Store','class'],['read','method'],['Size','type'],['Bridge','class-interface'],['read','method'],['Bridge','class-implementation'],['read','method']]);
 assert.equal(f.declarations[2]!.qualifiedName,'native::Store::read');assert.ok(!f.declarations.some(d=>['values','size'].includes(d.name)));assert.ok(f.objc!.cppProfile!.declarations>=4);assert.ok(f.issues.some(i=>i.code==='objc-cpp-structure-gap'));
});

test('Raw C++ return and parameter types retain native signed/multipart/empty/variadic selectors and original method forms',async()=>{
 const text='@interface Bridge +(id)from:(const std::string&)value with:(std::vector<int>)list; -(std::string)value; -(void):(std::string)left add:(std::string)right; -(void)log:(std::string)first,...;@end @implementation Bridge -(std::string)value{return std::string();}@end';
 const f=await parse(text,true),methods=f.declarations.filter(d=>d.selector);
 assert.deepEqual(methods.map(d=>d.selector),['from:with:','value',':add:','log:','value']);assert.deepEqual(methods.map(d=>d.dispatch),['class','instance','instance','instance','instance']);
 assert.equal(methods[0]!.signature,'+(id)from:(const std::string&)value with:(std::vector<int>)list');assert.equal(methods.at(-1)!.declarationForm,'definition');
 assert.ok(methods.every(d=>d.sourceConditions?.some(c=>c.includes('unverified'))));assert.ok(!f.declarations.some(d=>['first','left','right','list','std'].includes(d.name)));
});

test('Malformed mixed selector headers are omitted and literal/comment/body text cannot fabricate method declarations',async()=>{
 const f=await parse('@implementation Bridge -(std::string)broken:; -(std::string)real{const char *fake="-(int)phantom{}"; /* -(void)ghost{} */ return {};} @end',true);
 assert.equal(f.declarations.filter(d=>d.name==='real').length,1);assert.ok(!f.declarations.some(d=>['broken:','phantom','ghost','fake'].includes(d.name)));
});

test('Objective-C containers inside native namespaces retain lexical ownership without cross-language type binding',async()=>{
 const f=await parse('namespace Native { @interface Bridge -(std::string)read;@end }',true);
 const ns=f.declarations.find(d=>d.kind==='namespace')!,bridge=f.declarations.find(d=>d.kind==='class-interface')!,method=f.declarations.find(d=>d.selector)!;
 assert.equal(bridge.parent,ns.key);assert.equal(bridge.qualifiedName,'Native::Bridge');assert.equal(method.parent,bridge.key);assert.equal(method.qualifiedName,'Native::Bridge::-read');
});

test('Mixed header detection excludes quoted/comment text and ordinary Objective-C labels while recognizing native scope/type syntax',()=>{
 for(const source of ['namespace {int helper();} @interface X @end','using Size=unsigned; @interface X @end','class Native {}; @interface X @end','@interface X -(std::string)read;@end'])assert.equal(objectiveCppSource(source),true);
 for(const source of ['@class Native;@interface X -(void)namespace:(id)using;@end','// namespace Native{}\n@interface X @end','const char *s="std::string";@interface X @end'])assert.equal(objectiveCppSource(source),false);
});

test('Mixed headers and .mm files expose auxiliary parser provenance, original declarations, partial outcomes and no semantic edges',async()=>{
 const g=await indexRepository(await repository({'ios/Bridge.h':'namespace Native {class Value{};} @interface Bridge -(std::string)read;@end','ios/Bridge.mm':'@implementation Bridge -(std::string)read{return {};} @end','ios/Plain.m':'@implementation Plain -(void)read{}@end'}));
 for(const file of ['ios/Bridge.h','ios/Bridge.mm']){const e=g.entities.find(e=>e.type==='file'&&e.path===file)!;assert.equal(e.language,'objective-c');const analysis=e.metadata.analysis as any;assert.equal(analysis.features.structure.status,'partial');assert.equal(analysis.parser.auxiliary[0].language,'cpp');assert.equal((e.metadata.objcSyntax as any).sourceProfile,'objective-cpp-partial');}
 assert.equal((g.entities.find(e=>e.path==='ios/Plain.m'&&e.type==='file')!.metadata.analysis as any).features.structure.status,'supported');assert.ok(symbols(g).some(e=>e.name==='Value'));
 assert.ok(!g.relations.some(r=>['calls','imports','handles','requests'].includes(r.type)));
});

test('Mixed/macro cold and warm fact replay agrees with revision analysis and preserves original IDs after line/body edits',async()=>{
 const root=await repository({'bridge.mm':'typedef NS_ENUM(int, Mode) { One, Two };\nnamespace Native {class Value{};} @implementation Bridge -(std::string)read{return {};}@end'}),state=path.join(root,'.cache');
 const cold=await indexRepository(root,{cache:new AnalysisCache(state)}),cache=new AnalysisCache(state),warm=await indexRepository(root,{cache});assert.equal(shape(cold),shape(warm));assert.equal(shape(cold),shape(await indexRepository(root,{revision:'original'})));assert.ok(cache.events.some(e=>e.analyzer==='syntax-facts'&&e.hit));const ids=symbols(cold).map(e=>e.id).sort();
 await writeFile(path.join(root,'bridge.mm'),'// 😀 moved\n typedef NS_ENUM(int, Mode) { One, Two };\nnamespace Native {class Value{};} @implementation Bridge -(std::string)read{return std::string();}@end');
 const edited=await indexRepository(root,{cache:new AnalysisCache(state)});assert.deepEqual(symbols(edited).map(e=>e.id).sort(),ids);assert.equal(shape(edited),shape(await indexRepository(root,{revision:'edited'})));
});

test('Original-source lexing bounds deep directives and retains ordinary branch contexts without exposing directive bodies as tokens',()=>{
 const lexical=cfamilySource('#if OUTER\n#if INNER\nOne\n#else\nTwo\n#endif\nThree\n#endif');
 assert.deepEqual(sourceConditions(lexical,lexical.tokens.find(t=>t.text==='One')!.start),['#if OUTER','#if INNER']);assert.deepEqual(sourceConditions(lexical,lexical.tokens.find(t=>t.text==='Three')!.start),['#if OUTER']);
 assert.equal(cfamilySource(Array.from({length:130},()=> '#if X').join('\n')+'\nOriginal').truncated,true);assert.equal(cfamilySource('#define HUGE '+ 'x'.repeat(9000)+'\nOriginal').truncated,true);
 assert.equal(cfamilySource(Array.from({length:4097},()=> '#pragma once').join('\n')).truncated,true);
});

test('Macro-driven C++ recovery retains following original native namespaces/types/methods without changing their source ranges',async()=>{
 const text='typedef NS_OPTIONS(unsigned, Flags) { Read=1, Write=2 };\nnamespace Native {class Value {public:int read(){return 1;}};}\n@implementation Bridge -(std::string)value{return {};} @end';
 const f=await parse(text,true);for(const [name,kind]of [['Native','namespace'],['Value','class'],['read','method']])assert.equal(f.declarations.filter(d=>d.name===name&&d.kind===kind).length,1);
 assert.equal(f.declarations.find(d=>d.name==='read')!.qualifiedName,'Native::Value::read');assert.equal(f.declarations.find(d=>d.name==='Value')!.range.startLine,2);
 assert.ok(f.objc!.cppProfile!.recoveredRegions!.length>0);assert.ok(f.declarations.find(d=>d.name==='read')!.sourceConditions!.some(s=>s.includes('subtree')));
});

test('Oversized source directives prevent standard macro profiling when an override could lie beyond the retained directive bound',async()=>{
 const f=await parse('#define /*'+'x'.repeat(9000)+'*/ NS_ENUM(a,b) mystery(a,b)\ntypedef NS_ENUM(int, Mode) { One };');
 assert.equal(f.truncated,true);assert.ok(!f.objc!.enumProfiles?.length);assert.ok(!f.declarations.some(d=>d.name==='One'));assert.ok(f.issues.some(i=>i.code==='syntax-budget-exceeded'));
});
