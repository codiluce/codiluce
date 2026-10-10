import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {StructureParser} from '../src/analysis/tree-sitter/client.js';
import {grammarCatalog,verifiedGrammar} from '../src/analysis/tree-sitter/grammars.js';
import {indexRepository} from '../src/pipeline/index.js';
import {AnalysisCache} from '../src/pipeline/cache.js';
import {canonicalJson} from '../src/history/fingerprint.js';
import type {SoftwareGraph} from '../src/core/graph.js';

const roots:string[]=[];after(async()=>{await Promise.all(roots.map(root=>rm(root,{recursive:true,force:true})));});
async function parse(content:string){const p=new StructureParser();try{return await p.parse('swift',content);}finally{p.close();}}
async function repository(files:Record<string,string>){const root=await mkdtemp(path.join(tmpdir(),'codiluce-swift-'));roots.push(root);for(const [file,text]of Object.entries(files)){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),text);}return root;}
const shape=(g:SoftwareGraph)=>canonicalJson({entities:g.entities,relations:g.relations,diagnostics:g.diagnostics.filter(d=>!['git-metrics','indexer'].includes(d.analyzer)&&d.code!=='git-ignore-unavailable')});
const symbols=(g:SoftwareGraph)=>g.entities.filter(e=>e.type!=='file'&&e.evidence.some(p=>p.analyzer==='tree-sitter-structure'));

test('Swift ships the exact upstream 0.7.3 release WASM, ABI, revision, checksum and MIT license',async()=>{
 const spec=grammarCatalog.get('swift')!;assert.equal(spec.artifactVersion,'0.7.3');assert.equal(spec.artifactPackage,'upstream-release');assert.equal(spec.sourceRevision,'b8b22bffbb3441780e6471665bacfb263741c86a');assert.equal(spec.abi,15);assert.equal(verifiedGrammar(spec).length,3825025);assert.ok(spec.artifactUrl!.endsWith('/0.7.3/tree-sitter-swift.wasm'));assert.equal(spec.license,'MIT');assert.throws(()=>verifiedGrammar({...spec,sha256:'wrong'}),/checksum/);assert.ok((await readFile(new URL('../grammars/licenses/swift.txt',import.meta.url),'utf8')).includes('Permission is hereby granted'));
});

test('Classes, structs, actors, protocols, enums and constrained extensions retain separate lexical source owners',async()=>{
 const f=await parse('public class Base {}\nstruct Value<T> {func read(_ x:T)->T{x}}\nactor Worker {func run() async{}}\nprotocol Reading {func read()->Int}\nenum State {case ready}\nextension Value: Reading where T == Int {func read()->Int{0}}');
 assert.deepEqual(f.issues,[]);assert.deepEqual(f.declarations.filter(d=>['class','struct','actor','protocol','enum','extension'].includes(d.kind)).map(d=>[d.name,d.kind]),[['Base','class'],['Value','struct'],['Worker','actor'],['Reading','protocol'],['State','enum'],['Value','extension']]);
 const owners=f.declarations.filter(d=>d.name==='Value');assert.equal(owners.length,2);assert.notEqual(owners[0]!.key,owners[1]!.key);assert.ok(owners[1]!.signature.includes('where T == Int'));assert.equal(f.declarations.find(d=>d.name==='run')!.qualifiedName,'Worker.run');
});

test('Native function argument labels, async/typed throws, generics, default expressions and escaped identifiers remain original syntax',async()=>{
 const f=await parse('public func send<T>(_ value:T, to destination:String = "a//b") async throws(MyError) -> T where T: Sendable {value}\nfunc `repeat`(value:Int){}');
 assert.deepEqual(f.issues,[]);const send=f.declarations.find(d=>d.name==='send')!;assert.equal(send.swiftName,'send(_:to:)');assert.equal(send.visibility,'public');assert.ok(send.signature.includes('throws(MyError)'));assert.ok(send.signature.includes('"a//b"'));assert.ok(send.signature.includes('where T: Sendable'));assert.equal(send.declarationForm,'definition');assert.ok(f.declarations.some(d=>d.name==='`repeat`'));
});

test('Original overloaded functions use labels/signatures for identity without guessed overload or type binding',async()=>{
 const g=await indexRepository(await repository({'Types.swift':'struct Reader {\nfunc read(_ value:Int)->Int{value}\nfunc read(from value:Int)->Int{value}\nfunc read(_ value:String)->String{value}\n}'}));
 const methods=symbols(g).filter(e=>e.name==='read');assert.equal(methods.length,3);assert.equal(new Set(methods.map(e=>e.id)).size,3);assert.deepEqual(methods.map(e=>e.metadata.swiftName).sort(),['read(_:)','read(_:)','read(from:)']);assert.ok(!g.relations.some(r=>r.type==='calls'));
});

test('Initializers, failable forms, deinitializers and subscript labels retain native keywords and original callable forms',async()=>{
 const f=await parse('class Box {\ninit(value:Int){}\ninit?(text:String){}\ninit!(raw:Int){}\ndeinit {}\nsubscript(index:Int)->Int {get{0} set{}}\nsubscript(at index:Int)->Int {0}\n}');assert.deepEqual(f.issues,[]);
 assert.deepEqual(f.declarations.filter(d=>d.kind==='constructor').map(d=>d.name),['init','init','init']);assert.ok(f.declarations.some(d=>d.signature.startsWith('init?')));assert.ok(f.declarations.some(d=>d.signature.startsWith('init!')));assert.equal(f.declarations.find(d=>d.kind==='destructor')!.name,'deinit');assert.deepEqual(f.declarations.filter(d=>d.kind==='subscript').map(d=>d.swiftName),['subscript(_:)','subscript(at:)']);assert.ok(!f.declarations.some(d=>d.name==='Int'));
});

test('Multi-case enum declarations retain payload/raw-value spelling, per-case ranges and no generated constructors',async()=>{
 const text='enum Result<T> {case pending, value(T), failed(code:Int)\ncase number=1\n}';const f=await parse(text);assert.deepEqual(f.issues,[]);
 const entries=f.declarations.filter(d=>d.kind==='enum-member');assert.deepEqual(entries.map(d=>d.name),['pending','value','failed','number']);assert.equal(entries[1]!.signature,'value(T)');assert.equal(entries[2]!.signature,'failed(code:Int)');assert.equal(entries[3]!.signature,'case number=1');assert.equal(entries[1]!.start,text.indexOf('value(T)'));assert.ok(entries.every(d=>d.parent===f.declarations[0]!.key));assert.ok(!f.declarations.some(d=>d.kind==='constructor'));
});

test('Stored/computed/observed properties retain original declarations without accessor, wrapper-storage or local-variable synthesis',async()=>{
 const f=await parse('struct Value {\nlet constant:Int=1\nvar count:Int=0 {willSet{} didSet{}}\nvar computed:Int {get{1} set{}}\nfunc run(){let local=1; let callback={(arg:Int) in arg}}\n}');assert.deepEqual(f.issues,[]);assert.deepEqual(f.declarations.filter(d=>d.kind==='property').map(d=>d.name),['constant','count','computed']);assert.ok(!f.declarations.some(d=>['get','set','willSet','didSet','local','callback','arg'].includes(d.name)));assert.equal(f.declarations.find(d=>d.name==='constant')!.signature,'let constant:Int');
});

test('Multiple data bindings and global tuple patterns preserve original names and independent header signatures',async()=>{
 const f=await parse('let (left,right):(Int,Int)=(1,2)\nstruct Value {var first:Int=1, second:String="two"}');assert.deepEqual(f.issues,[]);assert.deepEqual(f.declarations.map(d=>d.name),['left','right','Value','first','second']);assert.equal(f.declarations.find(d=>d.name==='second')!.signature,'var second:String');
});

test('Associated types/typealiases retain constraints and defaults without materializing generic specializations',async()=>{
 const f=await parse('protocol Source {associatedtype Item: Hashable = Int\nassociatedtype Other where Other: Sendable\ntypealias Pair=(Item,Item)\n}\ntypealias Callback<T> = (T)->Void');assert.deepEqual(f.issues,[]);assert.deepEqual(f.declarations.filter(d=>['associatedtype','type'].includes(d.kind)).map(d=>[d.name,d.kind]),[['Item','associatedtype'],['Other','associatedtype'],['Pair','type'],['Callback','type']]);assert.ok(f.declarations.find(d=>d.name==='Item')!.signature.includes('= Int'));assert.ok(!f.declarations.some(d=>d.name==='Hashable'));
});

test('Operators and precedence groups retain original definitions and native operator function labels',async()=>{
 const f=await parse('infix operator <+>: AdditionPrecedence\nprecedencegroup Custom {associativity:left}\nfunc <+>(lhs:Int,rhs:Int)->Int {lhs+rhs}');assert.deepEqual(f.issues,[]);assert.deepEqual(f.declarations.map(d=>[d.name,d.kind]),[['<+>','operator'],['Custom','precedencegroup'],['<+>','function']]);assert.equal(f.declarations[2]!.swiftName,'<+>(_:_:)');
 const native=await parse('struct Index {\nstatic func ==(lhs:Index,rhs:Index)->Bool {true}\nstatic func <(lhs:Index,rhs:Index)->Bool {false}\n}');assert.deepEqual(native.issues,[]);assert.deepEqual(native.declarations.filter(d=>d.kind==='method').map(d=>d.swiftName),['==(_:_:)', '<(_:_:)']);
});

test('Original nested named functions/types retain owners while anonymous closures and local bindings add no fake entities',async()=>{
 const f=await parse('func outer(){\nfunc inner(){}\nstruct Local {var value=1}\nlet local=1\nlet closure={(arg:Int) in arg}\n}');assert.deepEqual(f.issues,[]);assert.deepEqual(f.declarations.map(d=>d.name),['outer','inner','Local','value']);const outer=f.declarations[0]!;assert.equal(f.declarations.find(d=>d.name==='inner')!.parent,outer.key);assert.equal(f.declarations.find(d=>d.name==='Local')!.parent,outer.key);assert.equal(f.declarations.find(d=>d.name==='value')!.qualifiedName,'outer.Local.value');
});

test('Built-in attributes retain syntax and custom attributes/macros leave explicit unexpanded gaps without generated members',async()=>{
 const f=await parse('@available(macOS 13, *) @MainActor public struct Builtin {}\n@Observable class Model {var count=0}\n@freestanding(expression) macro stringify<T>(_ value:T)->(T,String) = #externalMacro(module:"Macros",type:"Stringify")\n#stringify(1)');
 assert.ok(f.declarations.find(d=>d.name==='Builtin')!.annotations!.some(a=>a.startsWith('@available')));assert.ok(f.declarations.some(d=>d.name==='stringify'&&d.kind==='macro'));assert.ok(f.issues.some(i=>i.code==='swift-attribute-expansion-gap'));assert.ok(f.issues.some(i=>i.code==='swift-macro-expansion-gap'));assert.equal(f.swift!.macroInvocations[0]!.name,'stringify');assert.ok(!f.declarations.some(d=>['Stringify','Macros','_count','get','set'].includes(d.name)));assert.equal(f.swift!.complete,false);
});

test('Imports and selective/testable import syntax are metadata with unsupported resolution and no semantic graph edges',async()=>{
 const root=await repository({'Source.swift':'import Foundation\n@testable import Helpers\nimport struct Foundation.Date\nstruct Value {}','Helpers.swift':'struct Helper {}'}),g=await indexRepository(root);const file=g.entities.find(e=>e.type==='file'&&e.path==='Source.swift')!;
 assert.deepEqual((file.metadata.swiftSyntax as any).imports.map((i:any)=>[i.path,i.kind]),[['Foundation',undefined],['Helpers',undefined],['Foundation.Date','struct']]);for(const feature of ['imports','references','framework','effects','guards'])assert.equal((file.metadata.analysis as any).features[feature].status,'unsupported');assert.ok(!g.relations.some(r=>['calls','imports','handles','requests'].includes(r.type)));
});

test('Nested Swift compilation directives retain unevaluated branch alternatives inside original type bodies',async()=>{
 const f=await parse('struct Platform {\n#if os(Linux)\nfunc linux(){}\n#if DEBUG\nfunc debug(){}\n#elseif compiler(>=6)\nfunc modern(){}\n#else\nfunc old(){}\n#endif\n#else\nfunc other(){}\n#endif\nfunc always(){}\n}');assert.ok(f.issues.every(i=>i.code==='syntax-parse-error'));assert.equal(f.swift!.complete,false);assert.ok(f.declarations.find(d=>d.name==='linux')!.sourceConditions!.includes('#if os(Linux)'));assert.ok(f.declarations.find(d=>d.name==='modern')!.sourceConditions!.some(c=>c.includes('#elseif')));assert.ok(f.declarations.find(d=>d.name==='other')!.sourceConditions!.some(c=>c.includes('#else')));assert.ok(!f.declarations.find(d=>d.name==='always')!.sourceConditions?.length);
});

test('Comment/string/raw-string declaration lookalikes never fabricate original Swift symbols',async()=>{
 const f=await parse('// func phantom() {}\n/* struct Fake {} */\nlet text="func imaginary() {}"\nlet raw=#"actor Hidden {}"#\nfunc real(){}');assert.deepEqual(f.issues,[]);assert.deepEqual(f.declarations.map(d=>d.name),['text','raw','real']);
});

test('Malformed headers omit guessed symbols and body recovery retains valid original callable headers',async()=>{
 const f=await parse('func good(){}\nfunc broken( -> Int {}\nfunc retained(value:Int)->Int {return }');assert.ok(f.issues.some(i=>i.code==='syntax-parse-error'));assert.ok(f.declarations.some(d=>d.name==='good'));assert.ok(!f.declarations.some(d=>d.name==='broken'));
});

test('UTF-16/CRLF/EOF source proof maps exact original names and declaration ranges',async()=>{
 const text='// é😀 original\r\nstruct Value {\r\nfunc read(_ value:String)->String {"😀"}\r\n}\r\nfunc eof() {}',f=await parse(text);assert.deepEqual(f.issues,[]);
 for(const d of f.declarations){const start=text.slice(0,d.start).split('\n'),end=text.slice(0,d.end).split('\n');assert.deepEqual(d.range,{startLine:start.length,startColumn:start.at(-1)!.length+1,endLine:end.length,endColumn:end.at(-1)!.length+1});assert.ok(d.end<=text.length);assert.ok(text.slice(d.start,d.end).includes(d.name));}
});

test('Cold/warm/revision Swift graphs preserve identities and evidence; doc/body/line edits leave original IDs stable',async()=>{
 const root=await repository({'Value.swift':'struct Value {\nvar count:Int=0\nfunc read(_ value:Int)->Int {value}\n}'}),state=path.join(root,'.cache'),cold=await indexRepository(root,{cache:new AnalysisCache(state)}),cache=new AnalysisCache(state),warm=await indexRepository(root,{cache});assert.equal(shape(cold),shape(warm));assert.equal(shape(cold),shape(await indexRepository(root,{revision:'original'})));assert.ok(cache.events.some(e=>e.analyzer==='syntax-facts'&&e.hit));const ids=symbols(cold).map(e=>e.id).sort();
 await writeFile(path.join(root,'Value.swift'),'// 😀 shifted\nstruct Value {\n// changed docs\nvar count:Int=2\nfunc read(_ value:Int)->Int {value+1}\n}');const updated=new AnalysisCache(state),edited=await indexRepository(root,{cache:updated});assert.deepEqual(symbols(edited).map(e=>e.id).sort(),ids);assert.ok(updated.events.some(e=>e.analyzer==='syntax-facts'&&!e.hit));assert.equal(shape(edited),shape(await indexRepository(root,{revision:'edited'})));
});

test('Package.swift is parsed as original source without executing manifest or target build code',async()=>{
 const root=await repository({'Package.swift':'// swift-tools-version:6.0\nimport PackageDescription\nlet package=Package(name:"Unsafe", targets: sideEffect())\nfunc sideEffect()->[Target]{fatalError("must not execute")}'}),g=await indexRepository(root);assert.ok(symbols(g).some(e=>e.name==='package'));assert.ok(symbols(g).some(e=>e.name==='sideEffect'));assert.ok(!g.relations.some(r=>r.type==='calls'));assert.equal((g.entities.find(e=>e.type==='file')!.metadata.analysis as any).features.imports.status,'unsupported');
});

test('Large Swift syntax metadata and deep compilation contexts stay bounded with explicit partial outcomes',async()=>{
 const f=await parse(Array.from({length:4100},(_,i)=>`import Module${i}`).join('\n'));assert.equal(f.swift!.imports.length,4096);assert.equal(f.truncated,true);assert.equal(f.swift!.complete,false);assert.ok(f.issues.some(i=>i.code==='syntax-budget-exceeded'));assert.ok(f.issues.length<=100);
 const deep=await parse(Array.from({length:130},()=> '#if DEBUG').join('\n')+'\nfunc original(){}\n'+Array.from({length:130},()=> '#endif').join('\n'));assert.equal(deep.truncated,true);assert.ok(deep.issues.some(i=>i.code==='syntax-budget-exceeded'));
});
