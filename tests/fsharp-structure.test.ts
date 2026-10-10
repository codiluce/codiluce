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
async function parse(content:string,signature=false){const parser=new StructureParser();try{return await parser.parse(signature?'fsharp-signature':'fsharp',content);}finally{parser.close();}}
async function repository(files:Record<string,string>){const root=await mkdtemp(path.join(tmpdir(),'codiluce-fsharp-'));roots.push(root);for(const [file,text]of Object.entries(files)){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),text);}return root;}
const shape=(g:SoftwareGraph)=>canonicalJson({entities:g.entities,relations:g.relations,diagnostics:g.diagnostics.filter(d=>!['git-metrics','indexer'].includes(d.analyzer)&&d.code!=='git-ignore-unavailable')});
const symbols=(g:SoftwareGraph)=>g.entities.filter(e=>e.type!=='file'&&e.evidence.some(p=>p.analyzer==='tree-sitter-structure'));

test('F# source and signature profiles pin distinct upstream release bytes, ABI, revision and MIT license',async()=>{
 for(const [profile,length]of [['fsharp',11430318],['fsharp-signature',2695892]] as const){const spec=grammarCatalog.get(profile)!;assert.equal(spec.artifactVersion,'0.3.12');assert.equal(spec.artifactPackage,'upstream-release');assert.equal(spec.sourceRevision,'aefd0c8741bdf3aeb827a228aa4a996a6536697e');assert.equal(spec.abi,15);assert.equal(verifiedGrammar(spec).length,length);assert.throws(()=>verifiedGrammar({...spec,sha256:'wrong'}),/checksum/);assert.equal(spec.license,'MIT');}
 assert.notEqual(grammarCatalog.get('fsharp')!.sha256,grammarCatalog.get('fsharp-signature')!.sha256);assert.ok((await readFile(new URL('../grammars/licenses/fsharp.txt',import.meta.url),'utf8')).includes('Nikolaj Sidorenco'));
});
test('F# original namespaces and nested modules establish lexical owners without implicit filename modules',async()=>{
 const f=await parse('namespace Demo\nmodule Tools =\n let read x=x\n module Nested =\n  let write x=x\nmodule Other =\n let run ()=1');assert.deepEqual(f.issues,[]);assert.deepEqual(f.declarations.map(d=>d.qualifiedName),['Demo','Demo.Tools','Demo.Tools.read','Demo.Tools.Nested','Demo.Tools.Nested.write','Demo.Other','Demo.Other.run']);
 const implicit=await parse('let read x=x');assert.deepEqual(implicit.declarations.map(d=>d.qualifiedName),['read']);
});
test('F# mutually recursive functions retain separate bodies, signatures and local function owners',async()=>{
 const f=await parse('module Demo\nlet rec read (x:int) : int =\n let inner y=y\n inner x\nand write y=y');assert.deepEqual(f.issues,[]);assert.deepEqual(f.declarations.map(d=>d.qualifiedName),['Demo','Demo.read','Demo.write','Demo.read.inner']);const read=f.declarations.find(d=>d.name==='read')!,write=f.declarations.find(d=>d.name==='write')!;assert.ok(read.end<write.start);assert.ok(read.signature.includes('rec'));assert.ok(read.signature.includes('(x:int) : int'));assert.ok(!write.signature.includes('inner'));
});
test('F# parameters, local values, lambda parameters and primary-constructor bindings do not become declarations',async()=>{
 const f=await parse('module Demo\nlet read (parameter:int) =\n let local=parameter\n local\nlet callback=fun x->let hidden=1 in x\ntype Box(seed:int)=\n let local=seed\n member _.Read(x:int)=x');assert.deepEqual(f.declarations.map(d=>d.name),['Demo','read','callback','Box','Read']);assert.ok(!f.declarations.some(d=>['parameter','seed','local','hidden','x','_'].includes(d.name)));
});
test('F# tuple bindings and typed values retain explicit original names',async()=>{
 const f=await parse('module Demo\nlet (left,right)=(1,2)\nlet typed:int=1\nlet mutable count=0');assert.deepEqual(f.issues,[]);assert.deepEqual(f.declarations.slice(1).map(d=>[d.name,d.kind]),[['left','variable'],['right','variable'],['typed','variable'],['count','variable']]);assert.ok(f.declarations.at(-1)!.modifiers!.includes('mutable'));
});
test('F# constructor/constant patterns and capitalized binding ambiguities omit guessed declarations',async()=>{
 const f=await parse('let Some value = Some 1\nlet (Some nested)=Some 2\nlet Capitalized x=x\nlet clear x=x');assert.deepEqual(f.declarations.map(d=>d.name),['clear']);assert.ok(f.issues.some(i=>i.code==='fsharp-pattern-gap'));assert.equal(f.fsharp!.complete,false);
});
test('F# operators, lowercase escaped identifiers and active patterns remain original callable spellings',async()=>{
 const f=await parse('let (+>) a b = a+b\nlet ``read value`` x=x\nlet (|Even|Odd|) n=if n%2=0 then Even else Odd');assert.deepEqual(f.issues,[]);assert.deepEqual(f.declarations.map(d=>d.name),['(+>)','``read value``','(|Even|Odd|)']);assert.ok(!f.declarations.some(d=>['Even','Odd'].includes(d.name)));
});
test('F# records, enums, unions, explicit payload labels and exceptions exclude generated helpers',async()=>{
 const f=await parse('type Pair = {Left:string; mutable Right:int}\ntype State = | Ready | Failed of code:int * string\ntype Flag = | Off=0 | On=1\nexception Problem of message:string');assert.deepEqual(f.issues,[]);assert.deepEqual(f.declarations.map(d=>[d.name,d.kind]),[['Pair','record'],['Left','field'],['Right','field'],['State','union'],['Ready','union-case'],['Failed','union-case'],['code','union-field'],['Flag','enum'],['Off','enum-member'],['On','enum-member'],['Problem','exception'],['message','union-field']]);assert.equal(f.declarations.find(d=>d.name==='code')!.qualifiedName,'State.Failed.code');assert.ok(!f.declarations.some(d=>['NewPair','Tag','IsReady','get_Left','string','Equals','CompareTo'].includes(d.name)));
});
test('F# single bare union/type-alias ambiguity retains only the original type with an explicit gap',async()=>{
 const f=await parse('type Alias = string\ntype Other = Existing\ntype One = | Ready\ntype Qualified = System.String');assert.deepEqual(f.declarations.map(d=>[d.name,d.kind]),[['Alias','type'],['Other','type'],['One','union'],['Ready','union-case'],['Qualified','type-alias']]);assert.equal(f.issues.filter(i=>i.code==='fsharp-type-shape-gap').length,2);
});
test('F# explicit methods, properties, source accessors and secondary new constructors remain distinct',async()=>{
 const f=await parse('type Service(seed:int)=\n member _.Read(x:int):int=x\n member _.Name with get()="a" and set(v)=()\n static member val Count=0 with get,set\n new()=Service(0)');assert.deepEqual(f.issues,[]);assert.deepEqual(f.declarations.map(d=>[d.name,d.kind]),[['Service','class'],['Read','method'],['Name','property'],['Count','property'],['new','constructor']]);assert.ok(f.declarations.find(d=>d.name==='Name')!.signature.includes('get() and set(v)'));assert.ok(f.declarations.find(d=>d.name==='Count')!.modifiers!.includes('static'));assert.equal(f.declarations.filter(d=>d.name==='Service').length,1);assert.ok(!f.declarations.some(d=>d.name==='get_Name'||d.name==='set_Name'||d.name==='seed'));
});
test('F# interface declarations retain original method/property signatures without CLR synthesis',async()=>{
 const f=await parse('type Reader = interface abstract Read:x:int -> int\n                          abstract Name:string end');assert.ok(f.declarations.some(d=>d.name==='Reader'&&d.kind==='interface'));for(const name of ['Read','Name'])assert.equal(f.declarations.find(d=>d.name===name)!.declarationForm,'declaration');assert.equal(f.declarations.find(d=>d.name==='Name')!.kind,'property');
});
test('F# signature values/functions use the dedicated profile and retain declaration forms',async()=>{
 const f=await parse('module Demo\nval value:int\nval Read: x:int -> int\ntype Pair={Name:string}',true);assert.deepEqual(f.issues,[]);assert.equal(f.fsharp!.sourceKind,'signature');assert.deepEqual(f.declarations.map(d=>d.name),['Demo','value','Read','Pair','Name']);assert.ok(f.declarations.every(d=>d.declarationForm==='declaration'&&d.sourceConditions!.some(c=>c.includes('compile order'))));
});
test('F# implementation bindings never masquerade as signature declarations',async()=>{
 const f=await parse('module Demo\nlet read x=x',true);assert.ok(!f.declarations.some(d=>d.name==='read'));assert.ok(f.issues.some(i=>i.code==='fsharp-signature-shape-gap'||i.code==='syntax-parse-error'));
});
test('Unsupported valid F# class signatures retain parser gaps without invented class/member names',async()=>{
 const f=await parse('namespace Demo\ntype Service =\n new: int -> Service\n member Read: int -> int',true);assert.ok(f.issues.length);assert.ok(!f.declarations.some(d=>['Service','Read','new'].includes(d.name)));assert.equal(f.fsharp!.complete,false);
});
test('F# source attributes and open directives do not create compiler names or semantic import edges',async()=>{
 const root=await repository({'Main.fs':'namespace Demo\nopen System\nopen type System.Math\n[<CompiledName("ClrRun")>]\nlet run x=x\n[<Struct>]\ntype Pair={Name:string}'}),g=await indexRepository(root),file=g.entities.find(e=>e.type==='file')!;const syntax=file.metadata.fsharpSyntax as any,analysis=file.metadata.analysis as any;assert.equal(syntax.attributes.length,2);assert.equal(syntax.imports.length,2);assert.ok(symbols(g).some(e=>e.name==='run'));assert.ok(!symbols(g).some(e=>e.name==='ClrRun'));for(const feature of ['imports','references','framework','effects','guards'])assert.equal(analysis.features[feature].status,'unsupported');assert.ok(!g.relations.some(e=>['imports','calls','handles','requests'].includes(e.type)));
});
test('F# load/reference/search path directives preserve source without reading or running targets',async()=>{
 const f=await parse('#load "missing.fsx"\n#r "nuget:Example,1.0"\n#I "missing-directory"\nlet run ()=1');assert.equal(f.fsharp!.directives.length,3);assert.deepEqual(f.declarations.map(d=>d.name),['run']);assert.equal(f.issues.filter(i=>i.code==='fsharp-loading-gap').length,3);
});
test('F# conditional alternatives retain native original context without selecting a build branch',async()=>{
 const f=await parse('#if DEBUG\nlet debug x=x\n#else\nlet release x=x\n#endif');assert.deepEqual(f.issues,[]);assert.deepEqual(f.declarations.map(d=>d.name),['debug','release']);assert.ok(f.declarations[0]!.sourceConditions!.some(c=>c.includes('#if DEBUG')));assert.ok(f.declarations[1]!.sourceConditions!.some(c=>c.includes('#else')));assert.equal(f.fsharp!.conditions.length,2);
});
test('F# quotations exclude quoted named declarations and preserve a generation gap',async()=>{
 const f=await parse('let quoted=<@ let hidden x=x in hidden 1 @>\nlet original x=x');assert.deepEqual(f.declarations.map(d=>d.name),['quoted','original']);assert.equal(f.fsharp!.quotations.length,1);assert.ok(f.issues.some(i=>i.code==='fsharp-quotation-gap'));
});
test('F# comments and ordinary/verbatim/triple strings cannot fabricate declarations',async()=>{
 const f=await parse('(* type Fake = {Name:string} *)\nlet text="let ghost x=x"\nlet verbatim=@"type Imaginary = int"\nlet triple="""module Hidden = let nothing x=x"""\nlet original x=x');assert.deepEqual(f.issues,[]);assert.deepEqual(f.declarations.map(d=>d.name),['text','verbatim','triple','original']);
});
test('F# body edits preserve declaration identities and accessor signatures',async()=>{
 const root=await repository({'Main.fs':'module Demo\nlet read x=1\ntype S()=\n member _.Name with get()="a" and set(v)=()\n member val Count=0 with get,set'}),first=await indexRepository(root);await writeFile(path.join(root,'Main.fs'),'module Demo\nlet read x=2\ntype S()=\n member _.Name with get()="b" and set(v)=ignore v\n member val Count=99 with get,set');const second=await indexRepository(root);assert.deepEqual(symbols(first).map(e=>e.id).sort(),symbols(second).map(e=>e.id).sort());assert.notEqual(symbols(first).find(e=>e.name==='read')!.metadata.bodyHash,symbols(second).find(e=>e.name==='read')!.metadata.bodyHash);
});
test('F# CRLF, emoji prefixes and EOF ranges map to exact original UTF-16 positions',async()=>{
 const content='// 😀\r\nmodule Demo\r\nlet read x="é😀"',f=await parse(content),d=f.declarations.find(d=>d.name==='read')!;assert.equal(d.range.startLine,3);assert.equal(d.range.startColumn,5);assert.equal(d.range.endColumn,content.split('\r\n')[2]!.length+1);assert.equal(content.slice(d.start,d.end),'read x="é😀"');assert.equal(d.end,content.length);
});
test('Malformed F# headers retain gaps and never invent names from type references',async()=>{
 const f=await parse('let good x=x\nlet broken (x: )=x\ntype Broken = {Name:}\nlet later x=x');assert.ok(f.issues.length);assert.ok(f.declarations.some(d=>d.name==='good'));assert.ok(!f.declarations.some(d=>['broken','Name'].includes(d.name)));
});
test('F# failed type-body recovery quarantines member ownership',async()=>{
 const f=await parse('type Broken()=\n member _.Read(x: )=x\n member _.Other()=1\nlet outside x=x');assert.ok(f.issues.length);assert.ok(!f.declarations.some(d=>['Read','Other'].includes(d.name)));assert.ok(f.declarations.some(d=>d.name==='outside'));
});
test('F# extraction bounds diagnostic floods and reports incomplete syntax',async()=>{
 const f=await parse(Array.from({length:128},(_,i)=>`type Alias${i}=string`).join('\n'));assert.ok(f.truncated);assert.ok(f.issues.length<=100);assert.ok(f.issues.some(i=>i.code==='syntax-budget-exceeded'));assert.equal(f.fsharp!.complete,false);
});
test('F# mixed .fs/.fsx/.fsi indexing selects separate grammar caches and exact source profiles',async()=>{
 const root=await repository({'Main.fs':'module Demo\nlet read x=x','Script.fsx':'let script x=x','Main.fsi':'module Demo\nval read:x:int -> int'}),directory=path.join(root,'.codiluce/cache'),cache=new AnalysisCache(directory),options={cache};const cold=await indexRepository(root,{cache:new AnalysisCache(directory)}),warm=await indexRepository(root,options);assert.equal(shape(cold),shape(warm));const revision=await indexRepository(root,{...options,revision:'immutable-original'});assert.equal(shape(cold),shape(revision));const files=cold.entities.filter(e=>e.type==='file'),source=files.find(e=>e.path==='Main.fs')!,signature=files.find(e=>e.path==='Main.fsi')!;assert.equal(source.language,'fsharp');assert.equal(signature.language,'fsharp');assert.notEqual((source.metadata.analysis as any).parser.grammarHash,(signature.metadata.analysis as any).parser.grammarHash);assert.equal((signature.metadata.fsharpSyntax as any).sourceKind,'signature');assert.equal(symbols(cold).filter(e=>e.name==='read').length,2);assert.notEqual(symbols(cold).filter(e=>e.name==='read')[0]!.id,symbols(cold).filter(e=>e.name==='read')[1]!.id);
 assert.equal(cache.events.filter(e=>e.analyzer==='syntax-facts'&&e.hit).length,3);
});
test('F# private source types/bindings retain native attributes without generated CLR names',async()=>{
 const f=await parse('[<Struct>]\ntype private Pair = {Name:string}\nlet private read x=x');assert.deepEqual(f.issues,[]);assert.equal(f.declarations[0]!.visibility,'private');assert.deepEqual(f.declarations[0]!.annotations,['[<Struct>]']);assert.equal(f.declarations.at(-1)!.visibility,'private');assert.equal(f.declarations.filter(d=>d.name==='Pair').length,1);
});
test('F# type extensions and explicit interface implementations retain source owners and unresolved binding context',async()=>{
 const f=await parse('type Service with\n member _.Read(x:int)=x\ntype S()=\n interface System.IDisposable with\n  member _.Dispose()=()');assert.deepEqual(f.issues,[]);assert.deepEqual(f.declarations.map(d=>[d.name,d.kind]),[['Service','type-extension'],['Read','method'],['S','class'],['Dispose','method']]);assert.ok(f.declarations.find(d=>d.name==='Read')!.sourceConditions!.some(c=>c.includes('extension')));assert.ok(f.declarations.find(d=>d.name==='Dispose')!.sourceConditions!.some(c=>c.includes('interface implementation')));assert.ok(!f.declarations.some(d=>d.name==='System.IDisposable'));
});
test('Mutually recursive F# types and delegates retain original names without constructor/type references',async()=>{
 const f=await parse('type A = | One of B\nand B = | Two of A\ntype D = delegate of int -> int');assert.deepEqual(f.issues,[]);assert.deepEqual(f.declarations.map(d=>[d.name,d.kind]),[['A','union'],['B','union'],['One','union-case'],['Two','union-case'],['D','delegate']]);assert.equal(f.declarations.find(d=>d.name==='One')!.qualifiedName,'A.One');assert.equal(f.declarations.find(d=>d.name==='Two')!.qualifiedName,'B.Two');
});
test('F# metadata is bounded while large original function bodies retain complete declarations',async()=>{
 const imports=await parse(`${Array.from({length:4100},(_,n)=>`open P${n}.Value`).join('\n')}\nlet kept x=x`);assert.equal(imports.fsharp!.imports.length,4096);assert.ok(imports.truncated);assert.ok(imports.issues.some(i=>i.code==='syntax-budget-exceeded'));assert.ok(imports.declarations.some(d=>d.name==='kept'));
 const large=await parse(`let run ()=\n ${'ignore 1\n '.repeat(100)}1`);assert.deepEqual(large.issues,[]);assert.equal(large.fsharp!.complete,true);assert.equal(large.declarations[0]!.name,'run');
});

test('An upstream F# WASM trap fails its own job and a fresh process preserves later files',async()=>{
 const large=`let run ()=\n ${'ignore 1\n '.repeat(1000)}1`,parser=new StructureParser();try{await assert.rejects(parser.parse('fsharp',large),/memory access out of bounds/);const valid=await parser.parse('fsharp','let later x=x');assert.deepEqual(valid.issues,[]);assert.deepEqual(valid.declarations.map(d=>d.name),['later']);}finally{parser.close();}
 const root=await repository({'A.fs':large,'B.fs':'let valid x=x','C.fsi':'val read:x:int ->int','D.py':'def unaffected():\n return 1'}),graph=await indexRepository(root);assert.equal((graph.entities.find(e=>e.path==='A.fs'&&e.type==='file')!.metadata.analysis as any).features.structure.status,'failed');assert.ok(graph.diagnostics.some(d=>d.file==='A.fs'&&d.code==='syntax-analysis-failed'));assert.ok(!symbols(graph).some(e=>e.path==='A.fs'));assert.ok(symbols(graph).some(e=>e.path==='B.fs'&&e.name==='valid'));assert.ok(symbols(graph).some(e=>e.path==='C.fsi'&&e.name==='read'));assert.ok(symbols(graph).some(e=>e.path==='D.py'&&e.name==='unaffected'));
});

test('Named F# bindings inside anonymous lambdas cannot become fictitious module functions',async()=>{
 const f=await parse('module Demo\nlet callback=fun x->let inner y=y in inner x');assert.deepEqual(f.declarations.map(d=>d.name),['Demo','callback']);assert.ok(f.issues.some(i=>i.code==='fsharp-closure-owner-gap'));assert.equal(f.fsharp!.complete,false);
});
test('Original F# external declarations retain an explicit qualification gap',async()=>{
 const f=await parse('extern int puts(string value)\nlet clear x=x');assert.deepEqual(f.declarations.map(d=>d.name),['clear']);assert.ok(f.issues.some(i=>i.code==='fsharp-extern-gap'));
});
test('Explicit F# class/struct headers retain native kinds and stable signatures without synthetic constructors',async()=>{
 const empty=await parse('type C = class end\ntype S = struct end'),withMembers=await parse('type C = class member _.Read()=1 end\ntype S = struct member _.Read()=1 end');assert.deepEqual(empty.declarations.map(d=>[d.name,d.kind]),[['C','class'],['S','struct']]);for(const name of ['C','S'])assert.equal(empty.declarations.find(d=>d.name===name)!.signature,withMembers.declarations.find(d=>d.name===name)!.signature);assert.ok(!withMembers.declarations.some(d=>d.name==='new'));
});
