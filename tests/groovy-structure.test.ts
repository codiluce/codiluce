import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {StructureParser} from '../src/analysis/tree-sitter/client.js';
import {grammarCatalog,verifiedGrammar} from '../src/analysis/tree-sitter/grammars.js';
import {languageOf,CODE_LANGUAGES} from '../src/core/languages.js';
import {indexRepository} from '../src/pipeline/index.js';
import {AnalysisCache} from '../src/pipeline/cache.js';
import {canonicalJson} from '../src/history/fingerprint.js';
import type {SoftwareGraph} from '../src/core/graph.js';

const roots:string[]=[];after(async()=>{await Promise.all(roots.map(root=>rm(root,{recursive:true,force:true})));});
async function parse(content:string){const p=new StructureParser();try{return await p.parse('groovy',content);}finally{p.close();}}
async function repository(files:Record<string,string>){const root=await mkdtemp(path.join(tmpdir(),'codiluce-groovy-'));roots.push(root);for(const [file,text]of Object.entries(files)){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),text);}return root;}
const shape=(g:SoftwareGraph)=>canonicalJson({entities:g.entities,relations:g.relations,diagnostics:g.diagnostics.filter(d=>!['git-metrics','indexer'].includes(d.analyzer)&&d.code!=='git-ignore-unavailable')});
const symbols=(g:SoftwareGraph)=>g.entities.filter(e=>e.type!=='file'&&e.evidence.some(p=>p.analyzer==='tree-sitter-structure'));

test('Groovy pins generated upstream C, reproducible CLI/SDK/container provenance, WASM ABI and MIT license',async()=>{
 const spec=grammarCatalog.get('groovy')!;assert.equal(spec.artifactVersion,'0.3.0');assert.equal(spec.artifactPackage,'source-build');assert.equal(spec.sourceRevision,'654e4c2d736571dbc512043a1dc26017c7aedc85');assert.equal(spec.abi,15);assert.equal(verifiedGrammar(spec).length,972000);assert.equal(spec.artifactBuild!.cliVersion,'0.26.9');assert.equal(spec.artifactBuild!.sdkVersion,'29.0');assert.ok(spec.artifactBuild!.sourceIntegrity.startsWith('sha512-'));assert.throws(()=>verifiedGrammar({...spec,sha256:'wrong'}),/checksum/);assert.equal(spec.license,'MIT');assert.ok((await readFile(new URL('../grammars/licenses/groovy.txt',import.meta.url),'utf8')).includes('Permission is hereby granted'));
});
test('Groovy source, Gradle, Jenkins and upstream alternative extensions are code',()=>{
 for(const file of ['Main.groovy','build.gradle','Jenkinsfile','script.gvy','script.gy'])assert.equal(languageOf(file),'groovy');assert.ok(CODE_LANGUAGES.has('groovy'));
});
test('Original Groovy package headers establish lexical ownership without extending their ranges',async()=>{
 const f=await parse('package demo.api\nclass Service {def read(){1}}\ntrait Reading {abstract def more()}');assert.deepEqual(f.issues,[]);assert.deepEqual(f.declarations.map(d=>d.qualifiedName),['demo.api','demo.api.Service','demo.api.Service.read','demo.api.Reading','demo.api.Reading.more']);assert.equal(f.declarations[0]!.range.endLine,1);
});
test('Groovy class, trait and interface declarations preserve generics, inheritance, modifiers and original methods',async()=>{
 const f=await parse('sealed class Base<T> permits Child {}\nnon-sealed class Child extends Base<String> {}\ntrait Reading<T> {abstract T read()}\ninterface Other extends Reading<String> {def more()}');assert.deepEqual(f.issues,[]);assert.deepEqual(f.declarations.filter(d=>['class','trait','interface'].includes(d.kind)).map(d=>d.name),['Base','Child','Reading','Other']);assert.ok(f.declarations[0]!.modifiers!.includes('sealed'));assert.ok(f.declarations[1]!.signature.includes('extends Base<String>'));assert.equal(f.declarations.at(-1)!.declarationForm,'declaration');
});
test('Groovy constructors match the original enclosing type and untyped methods stay methods',async()=>{
 const f=await parse('class Box {private Box(int x){}; read(x=1){x}; def typed(int y){y}}\ndef script(x){x}');assert.deepEqual(f.issues,[]);assert.deepEqual(f.declarations.map(d=>[d.name,d.kind]),[['Box','class'],['Box','constructor'],['read','method'],['typed','method'],['script','function']]);assert.equal(f.declarations[1]!.visibility,'private');assert.equal(f.declarations[0]!.visibility,undefined);
});
test('Original overloaded Groovy headers retain default arguments, varargs, generics and throws clauses',async()=>{
 const f=await parse('class Service {def read(x=1){x}; String read(String... xs) throws Exception {"x"}; public <T> T identity(T x){x}}');assert.deepEqual(f.issues,[]);const reads=f.declarations.filter(d=>d.name==='read');assert.equal(reads.length,2);assert.notEqual(reads[0]!.signature,reads[1]!.signature);assert.ok(reads[1]!.signature.includes('String... xs'));assert.ok(reads[1]!.signature.includes('throws Exception'));assert.ok(f.declarations.at(-1)!.signature.includes('<T> T identity'));
});
test('Groovy source properties and explicit-access fields remain distinct without generated getters/setters',async()=>{
 const f=await parse('class Data {String name; private int count=0; public static final String code="a"; def left=1,right=2; def getName(){name}}');assert.deepEqual(f.issues,[]);assert.deepEqual(f.declarations.slice(1).map(d=>[d.name,d.kind]),[['name','property'],['count','field'],['code','field'],['left','property'],['right','property'],['getName','method']]);assert.equal(f.declarations.find(d=>d.name==='name')!.visibility,undefined);assert.ok(f.declarations.find(d=>d.name==='code')!.modifiers!.includes('static'));assert.ok(!f.declarations.some(d=>d.name==='setName'||d.name==='getCount'));
});
test('Groovy records retain explicit components and methods without generated constructors, accessors or helpers',async()=>{
 const f=await parse('record Pair(String left, int right) {def describe(){left}}');assert.deepEqual(f.issues,[]);assert.deepEqual(f.declarations.map(d=>[d.name,d.kind]),[['Pair','record'],['left','record-component'],['right','record-component'],['describe','method']]);assert.ok(!f.declarations.some(d=>['toString','hashCode','equals','getAt','size'].includes(d.name)));
});
test('Original Groovy enum constants and annotation types stay source declarations',async()=>{
 const f=await parse('enum State {Ready(1), Empty; private int code; State(int value){code=value}; def read(){code}}\n@interface Label {String value()}');assert.deepEqual(f.issues,[]);assert.deepEqual(f.declarations.map(d=>[d.name,d.kind]),[['State','enum'],['Ready','enum-member'],['Empty','enum-member'],['code','field'],['State','constructor'],['read','method'],['Label','annotation'],['value','method']]);assert.ok(!f.declarations.some(d=>d.name==='values'||d.name==='valueOf'));
});
test('Script variables and multiple bindings stay original variables, without generated script owners or run methods',async()=>{
 const f=await parse('def count=1\nString title="x"\ndef left=1,right=2\nint first=1,second=2\ndef (a,b)=pair\ndef runTask(){1}');assert.deepEqual(f.issues,[]);assert.deepEqual(f.declarations.map(d=>d.name),['count','title','left','right','first','second','a','b','runTask']);assert.ok(f.declarations.slice(0,-1).every(d=>d.kind==='variable'));assert.ok(!f.declarations.some(d=>d.name==='run'||d.name==='main'));
});
test('Groovy closures retain explicit script bindings without inventing callback methods or parameters',async()=>{
 const f=await parse('def callback = { x -> def hidden=1; x }\n[1].each { value -> def local=2; value }\ndef run(int param){def local=1; try {throw null} catch(Exception e){def hidden=2}}');assert.deepEqual(f.issues,[]);assert.deepEqual(f.declarations.map(d=>d.name),['callback','run']);
});
test('Named Groovy declarations in closures retain an explicit runtime binding condition',async()=>{
 const f=await parse('def callback={ x -> def inner(){1}; class Local {def read(){1}} }');assert.deepEqual(f.issues,[]);assert.deepEqual(f.declarations.map(d=>d.name),['callback','inner','Local','read']);assert.ok(f.declarations.find(d=>d.name==='inner')!.sourceConditions!.some(c=>c.includes('closure')));assert.equal(f.declarations.at(-1)!.qualifiedName,'callback.Local.read');
});
test('Groovy import aliases, stars and static imports are original metadata without resolved bindings',async()=>{
 const root=await repository({'Main.groovy':'package demo\nimport a.Thing as Renamed\nimport b.*\nimport static c.Util.read as load\nimport static d.Util.*\nclass Main {}'}),g=await indexRepository(root),file=g.entities.find(e=>e.type==='file')!;const syntax=file.metadata.groovySyntax as any,analysis=file.metadata.analysis as any;assert.deepEqual(syntax.imports.map((i:any)=>[i.path,i.kind,i.alias]),[['a.Thing','single','Renamed'],['b','star',undefined],['c.Util.read','static','load'],['d.Util','static-star',undefined]]);assert.equal(analysis.features.structure.status,'supported');for(const f of ['imports','references','framework','effects','guards'])assert.equal(analysis.features[f].status,'unsupported');assert.ok(!g.relations.some(r=>['imports','calls','handles','requests'].includes(r.type)));
});
test('Groovy AST transformation and Grape annotations retain source and explicit generation/loading gaps',async()=>{
 const f=await parse('@groovy.transform.Immutable\n@Grab("example:evil:1")\nclass Box {String name}');assert.ok(f.declarations.some(d=>d.name==='Box'));assert.ok(f.declarations.some(d=>d.name==='name'));assert.equal(f.groovy!.annotations.length,2);assert.ok(f.groovy!.annotations.every(a=>a.generationUnverified));assert.equal(f.issues.filter(i=>i.code==='groovy-generation-gap').length,2);assert.ok(!f.declarations.some(d=>['getName','copyWith','equals'].includes(d.name)));assert.equal(f.groovy!.complete,false);
});
test('Groovy ordinary annotations retain native spelling and strings without guessed compiler semantics',async()=>{
 const f=await parse('@Deprecated class Box {@Deprecated def read(String x="a//b"){x}}');assert.deepEqual(f.issues,[]);assert.deepEqual(f.declarations[0]!.annotations,['@Deprecated']);assert.ok(f.declarations[1]!.signature.includes('"a//b"'));assert.ok(f.groovy!.annotations.every(a=>!a.generationUnverified));
});
test('Groovy Gradle and Jenkins DSL calls add no invented functions or execution edges',async()=>{
 const root=await repository({'build.gradle':'plugins {id "example.evil"}\ntasks.register("evil") {doLast {throw new Exception("never execute")}}\ndef helper(){1}','Jenkinsfile':'pipeline {agent any; stages {stage("Build") {steps {sh "never execute"}}}}'}),g=await indexRepository(root);assert.deepEqual(symbols(g).map(s=>s.name),['helper']);for(const file of g.entities.filter(e=>e.type==='file')){assert.equal(file.language,'groovy');assert.equal((file.metadata.analysis as any).features.structure.status,'supported');}assert.ok(!g.relations.some(r=>['calls','handles','requests'].includes(r.type)));
});
test('Groovy comment, GString, slashy and dollar-slashy lookalikes cannot fabricate declarations',async()=>{
 const f=await parse('/* class Fake {} */\ndef plain="def hidden(){1}"\ndef regex=/class Ghost {}/\ndef text=$/trait Imaginary {}/$\ndef interpolated="value ${name}"\nclass Real {def read(){1}}');assert.deepEqual(f.issues,[]);assert.deepEqual(f.declarations.map(d=>d.name),['plain','regex','text','interpolated','Real','read']);
});
test('Groovy quoted original method names retain their source spelling',async()=>{
 const f=await parse('class Box {def "read value"(){1}}');assert.deepEqual(f.issues,[]);assert.deepEqual(f.declarations.slice(1).map(d=>d.name),['"read value"']);
});
test('Unsupported Groovy nested class recovery does not invent fields, methods or ownership',async()=>{
 const f=await parse('class Outer {class Inner {def read(){1}}}');assert.deepEqual(f.declarations.map(d=>d.name),['Outer']);assert.ok(f.issues.some(i=>i.code==='groovy-owner-recovery-gap'));assert.equal(f.groovy!.complete,false);
});
test('Malformed Groovy headers omit guessed names while valid original headers remain',async()=>{
 const f=await parse('def good(){1}\ndef broken(int ){1}\nclass Valid {def read(){1}}');assert.ok(f.issues.some(i=>i.code==='groovy-header-gap'));assert.ok(f.declarations.some(d=>d.name==='good'));assert.ok(!f.declarations.some(d=>d.name==='broken'));assert.ok(f.declarations.some(d=>d.name==='Valid'));
});
test('Groovy errors inside method bodies retain valid original method headers',async()=>{
 const f=await parse('class Box {def read(){ def x = ; return 1 }}');assert.ok(f.issues.length);assert.ok(f.declarations.some(d=>d.name==='Box'));assert.ok(f.declarations.some(d=>d.name==='read'));
});
test('Groovy original shebang, UTF-16, CRLF, emoji and EOF positions remain exact',async()=>{
 const text='#!/usr/bin/env groovy\r\n// é😀\r\npackage demo\r\nclass Box {\r\ndef read(String x="😀"){x}\r\n}',f=await parse(text);assert.deepEqual(f.issues,[]);for(const d of f.declarations){const start=text.slice(0,d.start).split('\n'),end=text.slice(0,d.end).split('\n');assert.deepEqual(d.range,{startLine:start.length,startColumn:start.at(-1)!.length+1,endLine:end.length,endColumn:end.at(-1)!.length+1});assert.equal(text.slice(d.nameEnd-d.name.length,d.nameEnd),d.name);assert.ok(d.end<=text.length);}
});
test('Groovy cold/warm/revision proofs and edit invalidation retain stable overload and property identities',async()=>{
 const root=await repository({'Main.groovy':'package demo\nclass Main {def left=1,right=2; def read(int x){x}; def read(String x){x}}'}),state=path.join(root,'.cache'),cold=await indexRepository(root,{cache:new AnalysisCache(state)}),cache=new AnalysisCache(state),warm=await indexRepository(root,{cache});assert.equal(shape(cold),shape(warm));assert.equal(shape(cold),shape(await indexRepository(root,{revision:'original'})));assert.ok(cache.events.some(e=>e.analyzer==='syntax-facts'&&e.hit));const ids=symbols(cold).map(e=>e.id).sort();assert.equal(new Set(ids).size,ids.length);
 await writeFile(path.join(root,'Main.groovy'),'// 😀 shifted\npackage demo\nclass Main {def left=9,right=10; def read(int x){x+1}; def read(String x){x+"!"}}');const updated=new AnalysisCache(state),edited=await indexRepository(root,{cache:updated});assert.deepEqual(symbols(edited).map(e=>e.id).sort(),ids);assert.ok(updated.events.some(e=>e.analyzer==='syntax-facts'&&!e.hit));assert.equal(shape(edited),shape(await indexRepository(root,{revision:'edited'})));
});
test('Large original Groovy bodies do not consume syntax metadata budgets',async()=>{
 const f=await parse(`package demo\nclass Main {def run(){${'println(1);'.repeat(1000)}1}}`);assert.deepEqual(f.issues,[]);assert.equal(f.groovy!.complete,true);assert.ok(f.declarations.some(d=>d.name==='run'));
});
test('Groovy syntax metadata and deep context limits remain bounded with explicit partial outcomes',async()=>{
 const f=await parse(`${Array.from({length:4100},(_,n)=>`import p${n}.Value`).join('\n')}\nclass Kept {}`);assert.equal(f.groovy!.imports.length,4096);assert.ok(f.truncated);assert.ok(f.issues.some(i=>i.code==='syntax-budget-exceeded'));assert.ok(f.declarations.some(d=>d.name==='Kept'));const deep=await parse(`${'def closure={'.repeat(130)}def read(){1}${'}'.repeat(130)}`);assert.ok(deep.issues.some(i=>i.code==='syntax-budget-exceeded'));
});
test('Unqualified Groovy Unicode identifiers remain partial without invented source names',async()=>{
 const f=await parse('class Box {def λ(){1}}');assert.ok(f.issues.some(i=>i.code==='syntax-parse-error'));assert.deepEqual(f.declarations.map(d=>d.name),['Box']);assert.equal(f.groovy!.complete,false);
});
test('Groovy annotated-parameter recovery cannot spill class members into script functions',async()=>{
 const f=await parse('class Box {def read(@DelegatesTo(X) Closure x){1}; def after(){2}}');assert.ok(f.issues.some(i=>i.code==='groovy-owner-recovery-gap'));assert.deepEqual(f.declarations.map(d=>d.name),['Box']);assert.equal(f.declarations[0]!.declarationForm,'declaration');assert.ok(f.declarations[0]!.sourceConditions!.some(c=>c.includes('type header only')));assert.equal(f.declarations[0]!.range.endColumn,11);
});
test('Unqualified Gradle command-style named arguments report original syntax damage',async()=>{
 const f=await parse('dependencies {testImplementation group: "org.example", name: "demo", version: "1"}');assert.ok(f.issues.some(i=>i.code==='syntax-parse-error'));assert.equal(f.declarations.length,0);assert.equal(f.groovy!.complete,false);
});
test('Interpolated Groovy quoted callable names retain a dynamic-name gap without guessed fixed declarations',async()=>{
 const f=await parse('class Box {def "${name}"(){1}; def "fixed name"(){2}}');assert.deepEqual(f.declarations.map(d=>d.name),['Box','"fixed name"']);assert.ok(f.issues.some(i=>i.code==='groovy-dynamic-name-gap'));assert.equal(f.groovy!.complete,false);
});
