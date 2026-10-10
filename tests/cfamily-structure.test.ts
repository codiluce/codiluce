import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {StructureParser} from '../src/analysis/tree-sitter/client.js';
import {grammarCatalog,verifiedGrammar} from '../src/analysis/tree-sitter/grammars.js';
import {indexRepository} from '../src/pipeline/index.js';
import {AnalysisCache} from '../src/pipeline/cache.js';
import {canonicalJson} from '../src/history/fingerprint.js';
import {fileAnalysis} from '../src/analysis/facts.js';
import type {DeclarationFact,StructureFacts} from '../src/analysis/facts.js';
import type {SoftwareGraph} from '../src/core/graph.js';

const roots:string[]=[];after(async()=>{await Promise.all(roots.map(root=>rm(root,{recursive:true,force:true})));});
async function put(root:string,file:string,text:string){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),text);}
async function repo(files:Record<string,string>){const root=await mkdtemp(path.join(tmpdir(),'codiluce-cfamily-'));roots.push(root);for(const [file,text]of Object.entries(files))await put(root,file,text);return root;}
async function parse(language:'c'|'cpp',source:string){const parser=new StructureParser();try{return await parser.parse(language,source);}finally{parser.close();}}
const select=(facts:StructureFacts,name:string,kind?:string)=>facts.declarations.filter(fact=>fact.name===name&&(!kind||fact.kind===kind));
const shape=(graph:SoftwareGraph)=>canonicalJson({entities:graph.entities,relations:graph.relations,diagnostics:graph.diagnostics.filter(item=>!['git-metrics','indexer'].includes(item.analyzer)&&item.code!=='git-ignore-unavailable')});
const symbols=(g:SoftwareGraph)=>g.entities.filter(e=>e.evidence.some(fact=>fact.analyzer==='tree-sitter-structure')&&e.type!=='file');

test('Pinned C/C++ source grammars retain independent artifacts and original source/ABI provenance',async()=>{
 for(const [language,version,abi]of [['c','0.24.1',15],['cpp','0.23.4',14]] as const){const spec=grammarCatalog.get(language)!;assert.ok(spec);assert.equal(spec.artifactPackage,`tree-sitter-${language}`);assert.equal(spec.artifactVersion,version);assert.equal(spec.abi,abi);assert.equal(spec.license,'MIT');assert.ok(verifiedGrammar(spec).length>500_000);assert.throws(()=>verifiedGrammar({...spec,sha256:'bad'}),/checksum mismatch/);const notice=await readFile(new URL(`../grammars/${spec.licenseFile}`,import.meta.url),'utf8');assert.ok(notice.includes('Permission is hereby granted'));}
});

test('C retains original types, typedefs, enum values, fields, declarations and definitions without semantic links',async()=>{
 const text='typedef struct User{int id;char *name;} User;union Value{int count;float score;};enum Mode{On=1,Off};struct Forward;struct Forward *original;extern int version;int initialized=1;int find(int id);int find(int id){return id;}';
 const facts=await parse('c',text);assert.deepEqual(facts.issues,[]);assert.equal(select(facts,'User','type').length,1);assert.equal(select(facts,'User','struct').length,1);assert.equal(select(facts,'Value','union').length,1);assert.equal(select(facts,'Mode','enum').length,1);assert.equal(select(facts,'On','enum-member').length,1);assert.deepEqual(select(facts,'find').map(f=>f.declarationForm),['declaration','definition']);
 const id=select(facts,'id','property')[0]!;assert.equal(id.qualifiedName,'User::id');assert.equal(id.parent,select(facts,'User','struct')[0]!.key);assert.equal(select(facts,'Forward','struct').length,1);assert.equal(select(facts,'Forward','struct')[0]!.declarationForm,'declaration');assert.equal(select(facts,'version')[0]!.declarationForm,'declaration');assert.equal(select(facts,'initialized')[0]!.declarationForm,'definition');assert.equal(id.declarationForm,'declaration');
 const g=await indexRepository(await repo({'src/api.c':text,'src/page.ts':'export function load(){return fetch("/api")}'}));assert.ok(symbols(g).some(e=>e.name==='find'));assert.ok(!g.relations.some(edge=>['calls','imports','handles','requests'].includes(edge.type)&&symbols(g).some(e=>e.id===edge.to)));
 const file=g.entities.find(e=>e.path==='src/api.c'&&e.type==='file')!;assert.equal(fileAnalysis(file.metadata.analysis)!.features.structure.status,'supported');for(const feature of ['imports','references','framework','effects','guards'] as const)assert.equal(fileAnalysis(file.metadata.analysis)!.features[feature].status,'unsupported');
});

test('C declarator operator order distinguishes functions, function-returning pointers and function-pointer data',async()=>{
 const facts=await parse('c','int *factory(void);int (*callback)(int), plain(int), data;int (*array[3])(int);typedef int (*Callback)(int);int (*return_callback(void))(int){return 0;}');assert.deepEqual(facts.issues,[]);
 assert.deepEqual(facts.declarations.filter(f=>f.kind==='function').map(f=>f.name),['factory','plain','return_callback']);for(const name of ['callback','array','data'])assert.equal(select(facts,name)[0]!.kind,'variable');assert.equal(select(facts,'Callback')[0]!.kind,'type');
 assert.equal(select(facts,'plain')[0]!.signature,'int plain(int)');assert.ok(!select(facts,'plain')[0]!.signature.includes('data'));
 const cpp=await parse('cpp','struct Worker{int (*callback)(int);int invoke(int);const Worker& operator=(const Worker&);};int& reference();int (&reference_callback)(int);');assert.deepEqual(cpp.issues,[]);assert.equal(select(cpp,'callback')[0]!.kind,'property');assert.equal(select(cpp,'invoke')[0]!.kind,'method');assert.equal(select(cpp,'operator=')[0]!.kind,'method');assert.equal(select(cpp,'reference')[0]!.kind,'function');assert.equal(select(cpp,'reference_callback')[0]!.kind,'variable');
});

test('C++ source namespaces, constructors, destructors, methods, access and friends retain exact syntax ownership',async()=>{
 const text='namespace api{class Worker{int secret;public:Worker();~Worker();int get(int)const;static int call();friend int helper(Worker);};int Worker::get(int x)const{return x;}int free(int x){return x;}}';
 const facts=await parse('cpp',text);assert.deepEqual(facts.issues,[]);const worker=select(facts,'Worker','class')[0]!;assert.equal(select(facts,'Worker','constructor')[0]!.parent,worker.key);assert.equal(select(facts,'~Worker')[0]!.kind,'destructor');assert.equal(select(facts,'secret')[0]!.visibility,'private');assert.equal(select(facts,'get')[0]!.visibility,'public');assert.ok(select(facts,'call')[0]!.modifiers?.includes('static'));
 for(const get of select(facts,'get')){assert.equal(get.qualifiedName,'api::Worker::get');assert.equal(get.parent,worker.key);assert.equal(get.kind,'method');}
 const friend=select(facts,'helper')[0]!;assert.equal(friend.qualifiedName,'api::helper');assert.equal(friend.kind,'function');assert.ok(friend.modifiers?.includes('friend'));
});

test('C++ overloads, operators and conversion functions preserve original signatures and names',async()=>{
 const facts=await parse('cpp','struct Number{int get(int) const;int get(double) const;Number operator+(const Number&)const;explicit operator bool()const{return true;}};');assert.deepEqual(facts.issues,[]);assert.equal(select(facts,'get').length,2);assert.notEqual(select(facts,'get')[0]!.signature,select(facts,'get')[1]!.signature);assert.equal(select(facts,'operator+')[0]!.kind,'method');assert.equal(select(facts,'operator bool')[0]!.kind,'method');assert.ok(select(facts,'operator bool')[0]!.modifiers?.includes('explicit'));
 const external=await parse('cpp','struct Number{operator bool()const;};Number::operator bool()const{return true;}int imported::value(){return 1;}');assert.equal(select(external,'operator bool').length,2);assert.equal(select(external,'operator bool')[1]!.kind,'method');assert.equal(select(external,'value')[0]!.kind,'qualified-function');assert.ok(select(external,'value')[0]!.sourceConditions?.some(gap=>gap.includes('translation-unit/type')));
});

test('Large original directive sets retain bounded facts and explicit incomplete outcomes',async()=>{
 const facts=await parse('c',Array.from({length:4200},(_,i)=>`#define ORIGINAL_${i} ${i}`).join('\n'));assert.equal(facts.truncated,true);assert.equal(facts.cfamily!.complete,false);assert.equal(facts.cfamily!.preprocessor.length,4096);assert.ok(facts.issues.some(issue=>issue.code==='syntax-budget-exceeded'));assert.ok(facts.declarations.length<=20_000);assert.ok(facts.issues.length<=100);
});

test('C++ templates, aliases, concepts and anonymous original scopes preserve source structure without instantiation',async()=>{
 const text='namespace api::detail{template<class T>class Box{public:T get(T value){return value;}};template<class T>using Alias=Box<T>;template<class T>concept Sized=requires(T value){sizeof(value);};namespace{int local(){return 1;}}}';
 const facts=await parse('cpp',text);assert.deepEqual(facts.issues,[]);const box=select(facts,'Box')[0]!;assert.equal(box.qualifiedName,'api::detail::Box');assert.ok(box.signature.startsWith('template<class T>class Box'));assert.ok(!box.signature.includes('return value'));assert.equal(select(facts,'Alias')[0]!.kind,'type');assert.equal(select(facts,'Sized')[0]!.kind,'concept');assert.ok(facts.declarations.some(f=>f.kind==='namespace'&&f.modifiers?.includes('anonymous')));assert.ok(select(facts,'local')[0]!.qualifiedName.includes('<anonymous namespace>'));
 const instantiated=await parse('cpp','template<class T>class Box{T get(T);};int Box<int>::get(int x){return x;}');const get=select(instantiated,'get').find(f=>f.declarationForm==='definition')!;assert.equal(get.qualifiedName,'Box<int>::get');assert.equal(get.parent,undefined,'a specialization spelling cannot borrow a generic source type owner');
});

test('Original preprocessor alternatives remain separate source contexts; macro bodies and includes never execute',async()=>{
 const text='#include "missing.h"\n#define GENERATE(name) int name(){return 1;}\n#if FLAG\nint chosen(){return 1;}\n#elif OTHER\nint chosen(){return 2;}\n#else\nint chosen(){return 3;}\n#endif\nGENERATE(generated)';
 const facts=await parse('c',text);assert.equal(select(facts,'chosen').length,3);assert.deepEqual(select(facts,'chosen').map(f=>f.sourceConditions),[['#if FLAG'],['#if FLAG','#elif OTHER'],['#if FLAG','#elif OTHER','#else']]);assert.equal(select(facts,'GENERATE')[0]!.kind,'macro');assert.equal(select(facts,'generated').length,0);assert.ok(facts.cfamily!.preprocessor.some(d=>d.kind==='preproc_include'&&d.text==='#include "missing.h"'));
});

test('C/C++ EOF directives, CRLF and emoji retain original UTF-16 source coordinates',async()=>{
 for(const language of ['c','cpp'] as const){const text='// 😀 original\r\nint original(int x){return x;}\r\n#define VALUE 1';const facts=await parse(language,text);assert.deepEqual(facts.issues,[]);const original=select(facts,'original')[0]!;assert.equal(original.start,text.indexOf('int original'));assert.equal(original.end,text.indexOf('\r\n#define'));assert.equal(original.range.startLine,2);assert.equal(original.range.startColumn,1);const macro=select(facts,'VALUE')[0]!;assert.equal(macro.end,text.length);assert.equal(macro.range.endColumn,text.split('\n')[2]!.length+1);assert.equal(facts.cfamily!.preprocessor[0]!.range.endLine,3);}
});

test('Malformed headers do not supply guessed names while independent and damaged-body declarations remain visible',async()=>{
 for(const language of ['c','cpp'] as const){const facts=await parse(language,'int before(){return 1;}\nint broken(???);\nint damaged(){return ; ???}\nint after(){return 2;}');assert.ok(facts.issues.length);assert.ok(select(facts,'before').length);assert.ok(select(facts,'after').length);assert.equal(select(facts,'broken').length,0);assert.ok(select(facts,'damaged').length);}
});

test('Original prototype/definition and overload IDs survive comments, body edits and added declarations',async()=>{
 const root=await repo({'api.c':'int value(int x);\nint value(int x){return x;}\ntypedef struct Payload{int id;} Payload;','api.cpp':'template<class T>class Box{T get(T x){return x;}};'});
 const before=await indexRepository(root),ids=(g:SoftwareGraph)=>symbols(g).map(e=>[e.metadata.qualifiedName,e.metadata.declarationKind,e.metadata.declarationForm,e.id]);
 assert.equal(new Set(symbols(before).filter(e=>e.name==='value').map(e=>e.id)).size,2);
 await put(root,'api.c','// harmless\nint extra(void);\nint value(int x);\nint value(int x){return x+1;}\ntypedef struct Payload{long id;} Payload;');await put(root,'api.cpp','// harmless\ntemplate<class T>class Box{T get(T x){return x+x;}};');
 const after=await indexRepository(root);for(const [qualified,kind,form,id]of ids(before).filter(value=>value[1]!=='property'))assert.ok(ids(after).some(value=>value[0]===qualified&&value[1]===kind&&value[2]===form&&value[3]===id),String(qualified));
 assert.notEqual(symbols(before).find(e=>e.metadata.qualifiedName==='Payload::id')!.id,symbols(after).find(e=>e.metadata.qualifiedName==='Payload::id')!.id,'a changed field type changes that field signature, while the original type/alias identity survives');
});

test('Original C/C++ structure, directive metadata and IDs replay through cold/warm/revision caches',async()=>{
 const root=await repo({'api.c':'#if FLAG\nint selected(){return 1;}\n#endif','api.cpp':'namespace api{struct Item{int get(){return 1;}};}'}),state=await repo({});
 const cold=await indexRepository(root,{cache:new AnalysisCache(state)}),cache=new AnalysisCache(state),warm=await indexRepository(root,{cache});assert.equal(shape(cold),shape(warm));assert.equal(shape(cold),shape(await indexRepository(root,{revision:'recorded'})));assert.ok(cache.events.some(e=>e.analyzer==='syntax-facts'&&e.hit));
 await put(root,'api.c','#if OTHER\nint selected(){return 2;}\n#endif');const changedCache=new AnalysisCache(state),changed=await indexRepository(root,{cache:changedCache});assert.notEqual(shape(cold),shape(changed));assert.equal(shape(changed),shape(await indexRepository(root,{revision:'edited'})));assert.ok(changedCache.events.some(e=>e.analyzer==='syntax-facts'&&!e.hit));
});

test('Header recognition selects the recorded file language while structures remain outside semantic applications',async()=>{
 const c=await indexRepository(await repo({'api.c':'int work(){return 1;}','api.h':'int work(void);'}));assert.equal(c.entities.find(e=>e.path==='api.h'&&e.type==='file')!.language,'c');assert.ok(symbols(c).some(e=>e.path==='api.h'&&e.name==='work'));
 const cpp=await indexRepository(await repo({'api.cpp':'struct Item{int get();};','api.h':'class Forward;','api.hpp':'namespace api{int run();}'}));assert.equal(cpp.entities.find(e=>e.path==='api.h'&&e.type==='file')!.language,'cpp');assert.ok(symbols(cpp).some(e=>e.path==='api.h'&&e.name==='Forward'));assert.equal(cpp.entities.filter(e=>e.type==='application').length,0);
});
