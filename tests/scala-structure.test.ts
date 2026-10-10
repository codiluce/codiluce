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
async function parse(content:string){const p=new StructureParser();try{return await p.parse('scala',content);}finally{p.close();}}
async function repository(files:Record<string,string>){const root=await mkdtemp(path.join(tmpdir(),'codiluce-scala-'));roots.push(root);for(const [file,text]of Object.entries(files)){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),text);}return root;}
const shape=(g:SoftwareGraph)=>canonicalJson({entities:g.entities,relations:g.relations,diagnostics:g.diagnostics.filter(d=>!['git-metrics','indexer'].includes(d.analyzer)&&d.code!=='git-ignore-unavailable')});
const symbols=(g:SoftwareGraph)=>g.entities.filter(e=>e.type!=='file'&&e.evidence.some(p=>p.analyzer==='tree-sitter-structure'));

test('Scala pins the original upstream v0.26.2 release WASM, ABI 15, revision, checksum and MIT license',async()=>{
 const spec=grammarCatalog.get('scala')!;assert.equal(spec.artifactVersion,'0.26.2');assert.equal(spec.artifactPackage,'upstream-release');assert.equal(spec.sourceRevision,'b931fcc338390925eb893d70ad070033f5856ccf');assert.equal(spec.abi,15);assert.equal(verifiedGrammar(spec).length,3973559);assert.ok(spec.artifactUrl!.endsWith('/v0.26.2/tree-sitter-scala.wasm'));assert.throws(()=>verifiedGrammar({...spec,sha256:'wrong'}),/checksum/);assert.equal(spec.license,'MIT');assert.ok((await readFile(new URL('../grammars/licenses/scala.txt',import.meta.url),'utf8')).includes('Permission is hereby granted'));
});

test('Consecutive Scala package clauses establish original namespace ownership without invented source ranges',async()=>{
 const text='package outer\npackage inner\nclass Box {def read = 1}\nobject Box {}',f=await parse(text);assert.deepEqual(f.issues,[]);assert.deepEqual(f.declarations.map(d=>d.qualifiedName),['outer','outer.inner','outer.inner.Box','outer.inner.Box.read','outer.inner.Box']);assert.equal(f.declarations[0]!.range.endLine,1);assert.equal(f.declarations[1]!.range.endLine,2);assert.equal(f.scala!.packages[1]!.name,'inner');assert.notEqual(f.declarations[2]!.key,f.declarations[4]!.key);
});

test('Braced and indented Scala packages remain separate original owners with correct sibling resets',async()=>{
 const f=await parse('package a { class One {} }\npackage b { trait Two {} }\nclass Outside {}\npackage c:\n  object Three\nend c');assert.deepEqual(f.issues,[]);assert.deepEqual(f.declarations.map(d=>d.qualifiedName),['a','a.One','b','b.Two','Outside','c','c.Three']);assert.ok(f.scala!.packages.every(p=>p.explicitBody));
});

test('Scala package objects, traits, classes and explicit companions are original declarations only',async()=>{
 const f=await parse('package demo\npackage object helpers {def run = 1}\nsealed trait Base {def read(x:Int): Int}\nfinal case class Box[A](value:A) extends Base {def read(x:Int)=x}\nobject Box {def apply(x:Int)=x}');assert.deepEqual(f.issues,[]);assert.deepEqual(f.declarations.filter(d=>['class','trait','object','package-object'].includes(d.kind)).map(d=>[d.name,d.kind]),[['helpers','package-object'],['Base','trait'],['Box','class'],['Box','object']]);assert.equal(f.declarations.filter(d=>d.name==='apply').length,1);assert.ok(!f.declarations.some(d=>['value','copy','unapply','productElement','this'].includes(d.name)));
});

test('Only explicit Scala val/var class parameters become original properties',async()=>{
 const f=await parse('case class Box[A](value:A, val named:A, private var count:Int=0) {def this()=this(null,null,0)}');assert.deepEqual(f.issues,[]);assert.deepEqual(f.declarations.map(d=>[d.name,d.kind]),[['Box','class'],['named','property'],['count','property'],['this','constructor']]);assert.equal(f.declarations.find(d=>d.name==='count')!.visibility,'private');assert.ok(f.declarations[0]!.signature.includes('value:A'));
});

test('Original Scala class visibility stays separate from primary-constructor access and native modifier tokens',async()=>{
 const f=await parse('private[demo] sealed abstract class Hidden private(val value:Int) {protected final def read:Int=value}\nfinal class Public private()\ncase class Tagged(value:Int)');assert.deepEqual(f.issues,[]);const hidden=f.declarations.find(d=>d.name==='Hidden')!,pub=f.declarations.find(d=>d.name==='Public')!,read=f.declarations.find(d=>d.name==='read')!;assert.equal(hidden.visibility,'private[demo]');assert.ok(hidden.modifiers!.includes('sealed'));assert.ok(hidden.modifiers!.includes('abstract'));assert.equal(pub.visibility,undefined);assert.deepEqual(pub.modifiers,['final']);assert.ok(pub.signature.includes('private()'));assert.equal(read.visibility,'protected');assert.ok(read.modifiers!.includes('final'));assert.ok(f.declarations.find(d=>d.name==='Tagged')!.modifiers!.includes('case'));
});

test('Original overloaded, curried, by-name, repeated, implicit and using method signatures stay distinct',async()=>{
 const f=await parse('class Service {def read[A](x: => A)(implicit ctx:Ctx): A = x; def read(x: Int*):Int=x.size; def read(x:String)(using Ctx):String=x}');assert.deepEqual(f.issues,[]);const reads=f.declarations.filter(d=>d.name==='read');assert.equal(reads.length,3);assert.equal(new Set(reads.map(d=>d.signature)).size,3);assert.ok(reads.every(d=>d.kind==='method'));assert.ok(reads.some(d=>d.signature.includes('=> A')));assert.ok(reads.some(d=>d.signature.includes('using Ctx')));
});

test('Native symbolic/backticked/Unicode Scala names and annotations retain original spelling',async()=>{
 const f=await parse('@deprecated("a//b", "1") private[demo] class Box {def +(x:Int)=x; def `type`(x:Int)=x; def λ(x:Int)=x}');assert.deepEqual(f.issues,[]);assert.equal(f.declarations[0]!.visibility,'private[demo]');assert.ok(f.declarations[0]!.annotations![0]!.includes('a//b'));assert.deepEqual(f.declarations.slice(1).map(d=>d.name),['+','`type`','λ']);
});

test('Original abstract members, properties and aliases preserve declaration/definition forms',async()=>{
 const f=await parse('trait Reading {def read(x:Int): Int; val size:Int; var count:Int; type Out <: Any; type Alias=String; lazy val ready:Int=1}');assert.deepEqual(f.issues,[]);for(const name of ['read','size','count','Out'])assert.equal(f.declarations.find(d=>d.name===name)!.declarationForm,'declaration');for(const name of ['Alias','ready'])assert.equal(f.declarations.find(d=>d.name===name)!.declarationForm,'definition');assert.ok(!f.declarations.some(d=>['size_=','count_=','get','set'].includes(d.name)));
});

test('Scala tuple/capture/extractor/infix binding patterns retain explicit binding names without extractor lookalikes',async()=>{
 const f=await parse('object Data {val (left, right)=pair; val Pair(x,y @ _)=source; val head :: tail = list; val a,b:Int=1}');assert.deepEqual(f.issues,[]);assert.deepEqual(f.declarations.slice(1).map(d=>d.name),['left','right','x','y','head','tail','a','b']);assert.ok(f.declarations.slice(1).every(d=>d.kind==='property'));assert.ok(!f.declarations.some(d=>d.name==='Pair'||d.name==='::'));
});

test('Scala 3 enum cases retain original payload headers without generated factories or values methods',async()=>{
 const f=await parse('enum State[A]:\n  case Ready, Empty\n  case Failed(code:Int) extends State[A]\n  def read(using Ctx):Int=1\nend State');assert.deepEqual(f.issues,[]);assert.deepEqual(f.declarations.map(d=>[d.name,d.kind]),[['State','enum'],['Ready','enum-member'],['Empty','enum-member'],['Failed','enum-member'],['read','method']]);assert.ok(f.declarations.find(d=>d.name==='Failed')!.signature.includes('code:Int'));assert.ok(!f.declarations.some(d=>['values','valueOf','ordinal','code'].includes(d.name)));
});

test('Named Scala givens and context bounds retain lexical owners; anonymous givens have no invented names',async()=>{
 const f=await parse('given ordering: Ordering[Int] with {def compare(x:Int,y:Int):Int=x-y}\ngiven Ordering[String] = other\ngiven named[A: Show](using X[A]): Y[A] = impl\ngiven deferred: Service');assert.deepEqual(f.issues,[]);assert.equal(f.scala!.givens.length,4);assert.deepEqual(f.declarations.map(d=>d.name),['ordering','compare','named','deferred']);assert.equal(f.declarations.find(d=>d.name==='compare')!.qualifiedName,'ordering.compare');assert.equal(f.declarations.find(d=>d.name==='deferred')!.declarationForm,'declaration');assert.ok(f.declarations.find(d=>d.name==='named')!.signature.includes('[A: Show]'));
});

test('Anonymous Scala given members retain original names with an explicit missing-owner gap',async()=>{
 const f=await parse('given Ordering[Int] with {def compare(x:Int,y:Int):Int=x-y}');assert.equal(f.declarations.length,1);assert.equal(f.declarations[0]!.name,'compare');assert.ok(f.declarations[0]!.sourceConditions!.some(c=>c.includes('anonymous Scala given')));assert.ok(f.issues.some(i=>i.code==='scala-anonymous-owner-gap'));assert.equal(f.scala!.complete,false);
});

test('Scala 3.6 conditional given headers retain named type/context syntax without implicit search',async()=>{
 const f=await parse('given listOrder: [A] => Ordering[A] => Ordering[List[A]] = implementation');assert.deepEqual(f.issues,[]);assert.equal(f.declarations.length,1);assert.equal(f.declarations[0]!.name,'listOrder');assert.equal(f.declarations[0]!.kind,'given');assert.ok(f.declarations[0]!.signature.includes('[A] => Ordering[A] => Ordering[List[A]]'));assert.equal(f.scala!.givens[0]!.name,'listOrder');
});

test('Original anonymous Scala instance methods stay methods, retain nested functions and mark missing owner names',async()=>{
 const f=await parse('object Main {def create = new Reading {def read(x:Int)={def nested(y:Int)=y; nested(x)}}}');assert.deepEqual(f.declarations.map(d=>[d.name,d.kind]),[['Main','object'],['create','method'],['read','method'],['nested','function']]);assert.ok(f.issues.some(i=>i.code==='scala-anonymous-owner-gap'));assert.ok(f.declarations.find(d=>d.name==='read')!.sourceConditions!.some(c=>c.includes('anonymous Scala instance')));assert.ok(!f.declarations.some(d=>d.name==='Reading'));
});

test('Scala 3 extension methods preserve receiver/context headers and exact original method ranges',async()=>{
 const text='package demo\nextension [A](xs:List[A])(using Ctx)\n  def first:A=xs.head\n  def last:A=xs.last\nextension (x:Int) {def first:Int=x}\n',f=await parse(text);assert.deepEqual(f.issues,[]);const methods=f.declarations.filter(d=>d.kind==='extension-method');assert.equal(methods.length,3);assert.equal(methods[0]!.range.startLine,3);assert.equal(methods[0]!.scalaExtension!.range.startLine,2);assert.ok(methods[0]!.signature.includes('extension [A](xs:List[A])(using Ctx)'));assert.notEqual(methods[0]!.signature,methods[2]!.signature);assert.equal(f.scala!.extensions.length,2);assert.ok(methods.every(d=>d.qualifiedName.startsWith('demo.')));
});

test('Opaque, higher-kinded, match and bounded original Scala types stay source declarations',async()=>{
 const f=await parse('opaque type Id = Long\ntype Pair[X] = (X,X)\ntype F = [X] =>> List[X]\ntype Elem[X] = X match {case List[t] => t}\ntrait Abstract {type Out >: Nothing <: Any}');assert.deepEqual(f.issues,[]);assert.equal(f.declarations[0]!.kind,'opaque-type');assert.ok(f.declarations.some(d=>d.signature.includes('= [X] =>> List[X]')));assert.ok(!f.declarations.some(d=>d.name==='t'||d.name==='X'));
});

test('Scala derives retains source syntax and marks generated instances unverified',async()=>{
 const f=await parse('enum State derives CanEqual {case Ready}');assert.ok(f.declarations[0]!.signature.includes('derives CanEqual'));assert.ok(f.issues.some(i=>i.code==='scala-derivation-gap'));assert.ok(!f.declarations.some(d=>d.name.includes('CanEqual')));assert.equal(f.scala!.complete,false);
});

test('Scala 2 macro bodies and Scala 3 quotes/splices retain gaps without quoted/generated declarations',async()=>{
 const f=await parse("def old = macro implementation\ninline def code(using Quotes) = '{ def phantom:Int=1; ${ body }; phantom }");assert.deepEqual(f.declarations.map(d=>d.name),['old','code']);assert.ok(f.scala!.staged.some(s=>s.kind==='macro_body'));assert.ok(f.scala!.staged.some(s=>s.kind==='quote_expression'));assert.ok(f.scala!.staged.some(s=>s.kind==='splice_expression'));assert.ok(f.issues.some(i=>i.code==='scala-staged-code-gap'));
});

test('Scala named local functions/types remain lexical, while local bindings/lambda parameters stay excluded',async()=>{
 const f=await parse('object Main {def run(x:Int)={val local=1; def nested(y:Int)=y; class Inner {def read=1}; val cb=(v:Int)=>{val hidden=v; v}; nested(x)}}');assert.deepEqual(f.issues,[]);assert.deepEqual(f.declarations.map(d=>d.name),['Main','run','nested','Inner','read']);assert.equal(f.declarations.find(d=>d.name==='nested')!.qualifiedName,'Main.run.nested');assert.equal(f.declarations.find(d=>d.name==='read')!.qualifiedName,'Main.run.Inner.read');
});

test('Scala imports, aliases/wildcards/given selectors and exports are source metadata without semantic edges',async()=>{
 const root=await repository({'Source.scala':'package demo\nimport a.{Thing => Renamed, _}\nimport b.{Item as Alias, given}\nexport source.{read, given}\nclass Main {}','build.sbt':'sys.error("must never execute")'}),g=await indexRepository(root),file=g.entities.find(e=>e.type==='file'&&e.path==='Source.scala')!;assert.equal((file.metadata.analysis as any).features.structure.status,'supported');for(const feature of ['imports','references','framework','effects','guards'])assert.equal((file.metadata.analysis as any).features[feature].status,'unsupported');assert.deepEqual((file.metadata.scalaSyntax as any).imports.map((i:any)=>i.path),['a','b']);assert.equal((file.metadata.scalaSyntax as any).exports[0].path,'source');assert.ok(!g.relations.some(r=>['imports','calls','handles','requests'].includes(r.type)));
});

test('Scala CLI directives and scripts are parsed without executing dependency or target instructions',async()=>{
 const root=await repository({'main.sc':'//> using scala 3.6.4\n//> using dep org.test::evil:1.0\nobject Main {def run=sideEffect()}'}),g=await indexRepository(root),file=g.entities.find(e=>e.type==='file')!;assert.equal((file.metadata.scalaSyntax as any).directives.length,2);assert.ok(symbols(g).some(e=>e.name==='run'));assert.ok(!g.relations.some(r=>r.type==='calls'));
});

test('Scala strings, XML literals, comments and end markers cannot fabricate declarations',async()=>{
 const f=await parse('/* class Fake {} */\nval text="def imaginary=1"\nval xml = <p>class Hidden</p>\nobject Real:\n  def read=1\nend Real');assert.deepEqual(f.issues,[]);assert.deepEqual(f.declarations.map(d=>d.name),['text','xml','Real','read']);
});

test('Malformed Scala headers omit guessed declarations and retain valid original headers',async()=>{
 const f=await parse('def good=1\ndef broken(x: ) = 1\nclass Valid {def read:Int = 1}');assert.ok(f.issues.some(i=>i.code==='syntax-parse-error'));assert.ok(f.declarations.some(d=>d.name==='good'));assert.ok(!f.declarations.some(d=>d.name==='broken'));assert.ok(f.declarations.some(d=>d.name==='Valid'));
});

test('Scala original UTF-16/CRLF/emoji/EOF name and declaration positions stay exact',async()=>{
 const text='// é😀\r\npackage demo\r\nclass Box {\r\ndef λ(x:String):String="😀"\r\n}\r\nobject Eof',f=await parse(text);assert.deepEqual(f.issues,[]);for(const d of f.declarations){const start=text.slice(0,d.start).split('\n'),end=text.slice(0,d.end).split('\n');assert.deepEqual(d.range,{startLine:start.length,startColumn:start.at(-1)!.length+1,endLine:end.length,endColumn:end.at(-1)!.length+1});assert.equal(text.slice(d.nameEnd-d.name.length,d.nameEnd),d.name);assert.ok(d.end<=text.length);}
});

test('Scala cold/warm/revision proofs, signature identities and edit invalidation preserve original evidence',async()=>{
 const root=await repository({'Main.scala':'package demo\nobject Main {val count:Int=0; def read(x:Int):Int=x; def read(x:String):String=x}\nextension (x:Int) {def twice:Int=x+x}'}),state=path.join(root,'.cache'),cold=await indexRepository(root,{cache:new AnalysisCache(state)}),cache=new AnalysisCache(state),warm=await indexRepository(root,{cache});assert.equal(shape(cold),shape(warm));assert.equal(shape(cold),shape(await indexRepository(root,{revision:'original'})));assert.ok(cache.events.some(e=>e.analyzer==='syntax-facts'&&e.hit));const ids=symbols(cold).map(e=>e.id).sort();assert.equal(new Set(ids).size,ids.length);
 await writeFile(path.join(root,'Main.scala'),'// 😀 docs shifted\npackage demo\nobject Main {val count:Int=2; def read(x:Int):Int=x+1; def read(x:String):String=x+"!"}\nextension (x:Int) {def twice:Int=x+x+1}');const updated=new AnalysisCache(state),edited=await indexRepository(root,{cache:updated});assert.deepEqual(symbols(edited).map(e=>e.id).sort(),ids);assert.ok(updated.events.some(e=>e.analyzer==='syntax-facts'&&!e.hit));assert.equal(shape(edited),shape(await indexRepository(root,{revision:'edited'})));
});

test('Large original Scala bodies do not consume the syntax metadata budget',async()=>{
 const f=await parse(`package demo {object Main {def run={${'println(1);'.repeat(1000)}1}}}`);assert.deepEqual(f.issues,[]);assert.equal(f.scala!.complete,true);assert.ok(f.declarations.some(d=>d.name==='run'));
});

test('Scala metadata and deep context caps retain bounded facts with explicit partial outcomes',async()=>{
 const f=await parse(`${Array.from({length:4100},(_,n)=>`import p${n}.Value`).join('\n')}\nclass Kept`);assert.equal(f.scala!.imports.length,4096);assert.ok(f.truncated);assert.ok(f.issues.some(i=>i.code==='syntax-budget-exceeded'));assert.ok(f.declarations.some(d=>d.name==='Kept'));const deep=await parse(`${'object Deep {'.repeat(130)}def read=1${'}'.repeat(130)}`);assert.ok(deep.issues.some(i=>i.code==='syntax-budget-exceeded'));
});
