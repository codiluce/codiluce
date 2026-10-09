import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { analyzers, indexRepository } from '../src/pipeline/index.js';
import { resolveConfig, type ApplicationInput } from '../src/core/config.js';
import { AnalysisCache } from '../src/pipeline/cache.js';
import { canonicalJson } from '../src/history/fingerprint.js';
import type { SoftwareGraph } from '../src/core/graph.js';
import type { AnalysisContext } from '../src/core/analyzer.js';
const roots: string[] = [];
after(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });
async function put(root: string, name: string, text: string) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), text); }
async function repository(files: Record<string, string>) { const root = await mkdtemp(path.join(tmpdir(), 'codiluce-csharp-references-')); roots.push(root); for (const [name, text] of Object.entries(files)) await put(root, name, text); return root; }
const sdk = (extra = '') => `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>${extra}</Project>`;
async function index(root: string, cache?: AnalysisCache, revision?: string, applications?: ApplicationInput[]) { return indexRepository(root, { config: await resolveConfig(root, { repository: { name: 'csharp-references' }, applications }), cache, revision }); }
const symbol = (graph: SoftwareGraph, name: string, file?: string) => graph.entities.find(entity => entity.name === name && entity.type !== 'file' && (!file || entity.path === file))!;
const calls = (graph: SoftwareGraph) => graph.relations.filter(edge => edge.type === 'calls' && edge.metadata?.adapter === 'csharp');
const links = (graph: SoftwareGraph) => calls(graph).map(edge => `${graph.entities.find(entity => entity.id === edge.from)?.name}->${graph.entities.find(entity => entity.id === edge.to)?.name}`);
const outcomes = (graph: SoftwareGraph, file: string) => graph.entities.find(entity => entity.path === file && entity.type === 'file')!.metadata.csharpCallOutcomes as {status:string;name:string;reason?:string;range:{startLine:number};target?:string}[];
const shape = (graph: SoftwareGraph) => canonicalJson({ entities: graph.entities, relations: graph.relations, diagnostics: graph.diagnostics.filter(item => !['git-metrics', 'indexer'].includes(item.analyzer) && item.code !== 'git-ignore-unavailable') });
async function inspect(root: string, action: (context: AnalysisContext) => void) {
  const probe = {name:'csharp-test-probe',version:'1',async analyze(context:AnalysisContext){action(context);}};
  analyzers.splice(analyzers.findIndex(item => item.name === 'csharp-imports') + 1, 0, probe);
  try { return await index(root); } finally { analyzers.splice(analyzers.indexOf(probe), 1); }
}

test('C# typed source receivers, exact overloads, static aliases and explicit constructors retain original direct targets', async () => {
  const root = await repository({
    'App.csproj':sdk(),
    'Service.cs':'namespace Demo; public class Service { public Service(){} public string Read(string id)=>id; public static void Pick(int n){} public static void Pick(string s){} private void Hidden(){} public void Self(){Hidden();} }',
    'Use.cs':'// 😀\r\nusing Imported=global::Demo.Service;\r\nusing static Demo.Service;\r\npublic class Use {\r\n public string Run(Imported typed){ var created=new Imported(); Pick(n:1); Pick("ok"); created.Read("a"); return typed.Read("b"); }\r\n}'
  }), graph=await index(root);
  for(const link of ['Run->Service','Run->Pick','Run->Read','Self->Hidden']) assert.ok(links(graph).includes(link), JSON.stringify(outcomes(graph,'Use.cs')));
  assert.equal(outcomes(graph,'Use.cs').length,5); assert.ok(outcomes(graph,'Use.cs').every(item=>item.status==='resolved'));
  assert.equal(calls(graph).filter(edge=>edge.to===symbol(graph,'Read').id).length,2);
  const edge=calls(graph).find(edge=>edge.to===symbol(graph,'Read').id)!;
  assert.ok(edge.evidence.some(item=>item.file==='Use.cs'&&item.line===5)); assert.ok(edge.evidence.some(item=>item.file==='Service.cs'));
  assert.deepEqual(symbol(graph,'Run').metadata.callSites,{resolved:5,external:0,unresolved:0,unresolvedNames:{}});
});

test('C# compatible partial fragments merge accessibility and private members without fabricating a type declaration',async()=>{
  const root=await repository({'App.csproj':sdk(),'First.cs':'namespace Demo; public partial class Service { private int Hidden()=>1; public int First()=>Second(); }','Second.cs':'namespace Demo; sealed partial class Service { private int Second()=>Hidden(); public virtual int Read()=>1; }','Use.cs':'using Demo; public class Use {public int Run(Service value)=>value.Read();}' }),graph=await index(root);
  assert.ok(links(graph).includes('First->Second')); assert.ok(links(graph).includes('Second->Hidden')); assert.ok(links(graph).includes('Run->Read'),JSON.stringify(outcomes(graph,'Use.cs')));
  const fragments=graph.entities.filter(entity=>entity.name==='Service'&&entity.type==='class'); assert.equal(fragments.length,2);
  const metadata=fragments.map(entity=>entity.metadata.csharpType as any); assert.equal(metadata[0].id,metadata[1].id); assert.equal(metadata[0].parts.length,2); assert.equal(metadata[0].visibility,'public'); assert.ok(metadata[0].modifiers.includes('sealed'));
  assert.ok(!graph.entities.some(entity=>entity.id===metadata[0].id)); assert.ok(graph.relations.some(edge=>edge.type==='references'&&metadata[0].parts.includes(edge.to)));
});

test('Conflicting partial kinds, access, modifiers, bases and nonpartial duplicates never become source calls',async()=>{
  for(const [first,second] of [
    ['public partial class Tools','internal partial class Tools'],['public partial class Tools','public partial struct Tools'],['public abstract partial class Tools','public sealed partial class Tools'],['public partial class Tools:Base','public partial class Tools:Other'],['public class Tools','public class Tools']
  ]) {
    const root=await repository({'App.csproj':sdk(),'One.cs':`namespace Demo; ${first}{ public static void Run(){} } class Base{}`,'Two.cs':`namespace Demo; ${second}{} class Other{}`,'Use.cs':'using Demo; public class Use {void Start(){Tools.Run();}}'}),graph=await index(root);
    assert.equal(calls(graph).length,0,JSON.stringify(outcomes(graph,'Use.cs'))); assert.ok((graph.entities.find(entity=>entity.type==='repository')!.metadata.csharpTypes as any[]).some(type=>type.gaps.length));
  }
});

test('Dispatch is checked after exact overload selection; uncertain virtual/interface/inherited/generic calls retain gaps',async()=>{
  const root=await repository({'App.csproj':sdk(),'Types.cs':`namespace Demo;
public class Open {public void Pick(int n){} public virtual void Pick(string s){} public virtual void Virtual(){} }
public interface Contract {void Work();} public class Base{public void Work(){}} public class Child:Base{} public class Generic<T>{public void Work(){}}
public class Use {void Run(Open typed,Contract face,Generic<int> generic,Child child){typed.Pick(1);typed.Pick("a");typed.Virtual();new Open().Virtual();face.Work();generic.Work();child.Work();} }`}),graph=await index(root),result=outcomes(graph,'Types.cs');
  assert.equal(result.filter(item=>item.status==='resolved').length,2,JSON.stringify(result)); assert.ok(links(graph).includes('Run->Pick')); assert.ok(links(graph).includes('Run->Virtual'));
  for(const name of ['typed.Pick','typed.Virtual','face.Work','generic.Work','child.Work']) assert.ok(result.some(item=>item.name===name&&item.status==='unresolved'),name);
});

test('Namespace aliases, XML global usings and block scopes bind only visible original source types',async()=>{
  const root=await repository({'App.csproj':sdk('<ItemGroup><Using Include="Demo.Tools" Alias="GlobalTools"/></ItemGroup>'),'Types.cs':'namespace Demo {public class Tools{public static void Log(){}}} namespace Other {public class Tools{public static void Log(){}}}', 'Use.cs':'namespace A {using N=Demo; using T=Demo.Tools; public class Use {void Run(){N::Tools.Log();T.Log();GlobalTools.Log();global::Other.Tools.Log();}}} namespace B { public class Else {void Run(){T.Log();}}}'}),graph=await index(root),result=outcomes(graph,'Use.cs');
  assert.deepEqual(result.map(item=>item.status),['resolved','resolved','resolved','resolved','unresolved'],JSON.stringify(result));
  assert.ok(calls(graph).find(edge=>edge.evidence.some(item=>item.file==='App.csproj')));
});

test('C# future locals, pattern/out/catch/deconstruction bindings and static captures cannot borrow imported names',async()=>{
  const root=await repository({'App.csproj':sdk(),'Tools.cs':'namespace Demo; public class Tools{public static void Run(){}}','Use.cs':`using Alias=Demo.Tools; using Demo;
public class Use {
 void Future(){Tools.Run();object Tools=null;}
 void Pattern(object value){if(value is var Tools){Tools.Run();} Tools.Run();}
 void Out(){Other(out var Tools);Tools.Run();}
 void Tuple(){var (Tools,x)=Other();Tools.Run();}
 void TypedTuple(){(object Tools,int x)=Other();Tools.Run();}
 void Catch(){try{}catch(System.Exception Tools){Tools.Run();}}
 void Loop(){foreach(var (Tools,x) in values)Tools.Run();}
 void Captured(){var Tools=Other();var f=static()=>Tools.Run();}
 void Local(){void Alias(){}var f=static()=>Alias();}
}`}),graph=await index(root),result=outcomes(graph,'Use.cs');
  assert.equal(calls(graph).length,0,JSON.stringify(result)); assert.ok(result.every(item=>item.status!=='resolved'));
});

test('Inferred receiver mutation, ref escapes and readonly field annotations retain conservative binding',async()=>{
  const root=await repository({'App.csproj':sdk(),'Types.cs':`namespace Demo;
public class Open{public virtual void Work(){}} public class Other{public void Work(){}}
public partial class Use {private readonly Open value=new Other();void Field(){value.Work();} void Mutable(){var value=new Open();var f=()=>value.Work();value=Unknown();} void Escape(){var value=new Open();Other(ref value);value.Work();}}
public partial class Use {private readonly Open changed=new Open();public Use(){changed=Unknown();} void Changed(){changed.Work();}}
`}),graph=await index(root);
  assert.equal(calls(graph).filter(edge=>graph.entities.find(entity=>entity.id===edge.to)?.name==='Work').length,0,JSON.stringify(outcomes(graph,'Types.cs')));
});

test('C# original local functions, typed lambdas and top-level statements own their calls and source ranges',async()=>{
  const root=await repository({'App.csproj':sdk(),'Tools.cs':'namespace Demo; public class Tools{public static string Read(int n)=>"ok";}','Program.cs':'// 😀\r\nusing Demo;\r\nstring Local(int x)=>Tools.Read(x);\r\nvar f=(int x)=>Tools.Read(x);\r\nLocal(1);\r\nf(2);\r\n'}),graph=await index(root);
  for(const link of ['Local->Read','<lambda>->Read','<top-level>->Local','<top-level>-><lambda>'])assert.ok(links(graph).includes(link),JSON.stringify(outcomes(graph,'Program.cs')));
  const lambda=symbol(graph,'<lambda>'),top=symbol(graph,'<top-level>');assert.equal(lambda.parentId,top.id);assert.equal(lambda.sourceRange?.startLine,4);assert.equal(top.sourceRange?.startLine,3);assert.ok(!graph.entities.some(entity=>['Main','Program'].includes(entity.name)&&entity.type!=='file'));
});

test('Exact signatures reject conversions, optional/params/ref/dynamic/generic calls and classify predefined operators correctly',async()=>{
  const root=await repository({'App.csproj':sdk(),'Use.cs':`public class Use {
 void Int(int n){} void Bool(bool x){} void Long(long n){} void Optional(int n=1){} void Params(params int[] values){} void Ref(ref int n){} void Generic<T>(T x){}
 void Run(dynamic d){Int(1<2);Bool(1<2);Int(1+2);Long(1);Optional();Params(1);int x=1;Ref(ref x);Generic(1);d.Run();}
}`}),graph=await index(root),result=outcomes(graph,'Use.cs');
  assert.deepEqual(result.map(item=>item.status),['unresolved','resolved','resolved','unresolved','unresolved','unresolved','unresolved','unresolved','unresolved'],JSON.stringify(result));
});

test('C# direct handlers select original overloads and validate typed/untyped lambda parameter and return contracts',async()=>{
  const root=await repository({'App.csproj':sdk(),'Use.cs':'public class Use { public static string Read(int n)=>"ok";public static string Read(string s)=>s; void Run(){Register(Read);Register((int x)=>Read(x));Register(x=>Read(x));Register((int x)=>x);} }'});
  const graph=await inspect(root,context=>{
    const symbols=context.csharpSymbols!,registrations=symbols.facts('Use.cs')!.calls.filter(call=>call.expression.kind==='call'&&call.expression.callee.kind==='name'&&call.expression.callee.name==='Register');
    assert.equal(registrations.length,4);
    const selections=registrations.map(call=>symbols.handler('Use.cs',call.scope,(call.expression as Extract<typeof call.expression,{kind:'call'}>).args[0]!.value,{parameters:['int'],returnType:'string',allowUntyped:true}));
    assert.deepEqual(selections.map(result=>result.status),['resolved','resolved','resolved','unresolved']);
    const selected=selections[0]!;assert.equal(selected.status==='resolved'&&selected.definition.fact.parameters[0]?.type,'int');
    symbols.analyze([...context.files.values()].filter(file=>file.language==='csharp'));
  });
  assert.equal(links(graph).filter(link=>link==='<lambda>->Read').length,2);
});

test('Original attribute types and immutable const chains retain proof; cycles and mutable values remain gaps',async()=>{
  const root=await repository({'App.csproj':sdk(),'Use.cs':'class RouteAttribute:System.Attribute{} [Route("/")] public class Use { public const string Root="/api";public const string Path=Root+"/items";public const string Cycle=Cycle;public static string Mutable="/other";void Run(){Register(Path);Register(Cycle);Register(Mutable);} }'});
  const graph=await inspect(root,context=>{
    const symbols=context.csharpSymbols!,sites=symbols.facts('Use.cs')!.calls.filter(call=>call.expression.kind==='call'&&call.expression.callee.kind==='name'&&call.expression.callee.name==='Register');
    const constants=sites.map(call=>symbols.constant('Use.cs',call.scope,(call.expression as Extract<typeof call.expression,{kind:'call'}>).args[0]!.value));
    assert.deepEqual(constants.map(result=>result.status),['resolved','unresolved','unresolved']);const constant=constants[0]!;assert.equal(constant.status==='resolved'&&constant.value,'/api/items');
    assert.ok(constant.proof.every(item=>item.file==='Use.cs'));
  });
  assert.ok(graph.relations.some(edge=>edge.type==='references'&&edge.to===symbol(graph,'RouteAttribute').id&&edge.metadata?.role==='attribute'));
});

test('Warm/revision replay preserves partial, call and lambda identities and invalidates cross-fragment signatures and global scopes',async()=>{
  const root=await repository({'App.csproj':sdk(),'One.cs':'namespace Demo;public partial class Tools {public static void Read(int n){}}','Two.cs':'namespace Demo;partial class Tools {}','Global.cs':'global using Demo;','Use.cs':'public class Use{void Run(){var f=(int x)=>Tools.Read(x);f(1);}}'}),cache=new AnalysisCache(path.join(root,'.codiluce/cache'));
  const cold=await index(root,cache),warm=await index(root,cache),revision=await index(root,undefined,'fixture-revision');assert.equal(shape(cold),shape(warm));assert.equal(shape(cold),shape(revision));assert.ok(links(cold).includes('<lambda>->Read'));
  await put(root,'One.cs','// shifted\nnamespace Demo;public partial class Tools {public static void Read(int n){}}');
  const shifted=await index(root,cache);assert.equal(symbol(cold,'Read').id,symbol(shifted,'Read').id);assert.equal(symbol(cold,'<lambda>').id,symbol(shifted,'<lambda>').id);
  await put(root,'One.cs','namespace Demo;public partial class Tools {public static void Read(string n){}}');
  const changed=await index(root,cache);assert.ok(!links(changed).includes('<lambda>->Read'));assert.equal(shape(changed),shape(await index(root)));
  await put(root,'Global.cs','global using Other;');const global=await index(root,cache);assert.equal(shape(global),shape(await index(root)));assert.ok(!links(global).includes('<lambda>->Read'));
});

test('Unselected, conditional, removed and competing compilation inputs do not acquire C# semantic edges',async()=>{
  for(const project of [undefined,sdk('<ItemGroup Condition="Unknown()"><Compile Remove="Use.cs"/></ItemGroup>'),sdk('<ItemGroup><Compile Remove="Use.cs"/></ItemGroup>')]){
    const root=await repository({...project?{'App.csproj':project}:{},'Use.cs':'public class Use{public static void Read(){}void Run(){Read();}}'}),graph=await index(root);assert.equal(calls(graph).length,0,JSON.stringify(outcomes(graph,'Use.cs')));
  }
});

test('Exact C# overload selection checks the selected receiver and retains gaps for compiler priority attributes',async()=>{
 const root=await repository({'App.csproj':sdk(),'Use.cs':`public class Use {
 public static void Pick(int n){} public void Pick(string s){} void Run(){Use.Pick(1);Pick("ok");Use.Pick("wrong");this.Pick(2);}
 public static void Priority(int n){} [System.Runtime.CompilerServices.OverloadResolutionPriority(1)] public static void Priority(long n){} void Gap(){Priority(1);}
}`}),graph=await index(root);
 assert.deepEqual(outcomes(graph,'Use.cs').map(site=>site.status),['resolved','resolved','unresolved','unresolved','unresolved'],JSON.stringify(outcomes(graph,'Use.cs')));
});

test('C# namespace qualifiers select the nearest alias while declared factory returns retain original proof',async()=>{
 const root=await repository({'App.csproj':sdk(),'Types.cs':'namespace Demo {public class Tools { public void Read(){} public static Tools Create()=>new Tools();}} namespace Other {public class Tools {public static void Read(){}}}', 'Use.cs':'using N=Other; namespace Api {using N=Demo;public class Use{void Run(){N::Tools.Create().Read();}}}'}),graph=await index(root),result=outcomes(graph,'Use.cs');
 assert.ok(result.every(site=>site.status==='resolved'),JSON.stringify(result));assert.ok(links(graph).includes('Run->Read'));const edge=calls(graph).find(edge=>edge.to===symbol(graph,'Read','Types.cs').id)!;
 assert.ok(edge.evidence.some(item=>item.explanation?.includes('return signature')));
});

test('Bodyless and paired partial methods, primary/implicit constructors, cast and accessor behavior stay explicit',async()=>{
 const root=await repository({'App.csproj':sdk(),'One.cs':'public partial class Use{partial void Hook();public int Value=>1;void Run(){Hook();new Use();Value.ToString();((Use)other).Run();}}','Two.cs':'partial class Use{partial void Hook(){}}'}),graph=await index(root);
 assert.ok(outcomes(graph,'One.cs').every(site=>site.status!=='resolved'),JSON.stringify(outcomes(graph,'One.cs')));
});

test('Linked original C# fragments retain every logical compilation identity and never choose an unselected one',async()=>{
 const reference='<ItemGroup><Compile Include="../shared/Tools.cs"/></ItemGroup>';
 const root=await repository({'a/App.csproj':sdk(reference),'b/App.csproj':sdk(reference),'shared/Tools.cs':'namespace Demo;public class Tools{public static void Read(){}}','a/Use.cs':'using Demo;class Use{void Run(){Tools.Read();}}','b/Use.cs':'using Demo;class Use{void Run(){Tools.Read();}}'}),graph=await index(root),original=symbol(graph,'Tools','shared/Tools.cs');
 assert.equal((original.metadata.csharpTypes as any[]).length,2);assert.equal(original.metadata.csharpType,undefined);assert.equal(links(graph).filter(link=>link==='Run->Read').length,2);
});

test('Async lambda result wrapping cannot satisfy an unwrapped source handler signature',async()=>{
 const root=await repository({'App.csproj':sdk(),'Use.cs':'class Use{void Run(){Register(async (int x)=>"ok");}}'});
 await inspect(root,context=>{const symbols=context.csharpSymbols!,call=symbols.facts('Use.cs')!.calls[0]!;assert.equal(call.expression.kind,'call');if(call.expression.kind==='call')assert.equal(symbols.handler('Use.cs',call.scope,call.expression.args[0]!.value,{parameters:['int'],returnType:'string'}).status,'unresolved');});
});

test('Inferred C# values bind at their original initializer scope and cannot borrow a later inner function',async()=>{
 const root=await repository({'App.csproj':sdk(),'Use.cs':'class Tools{public void Read(){}} class Use{void Run(){var value=Create();{Tools Create()=>new Tools();value.Read();}}}'}),graph=await index(root);
 assert.ok(outcomes(graph,'Use.cs').some(site=>site.name==='value.Read'&&site.status==='unresolved'));assert.ok(!links(graph).includes('Run->Read'));
});

test('C# original field initializers do not borrow instance members or this before construction',async()=>{
 const root=await repository({'App.csproj':sdk(),'Use.cs':'class Use{static int Static()=>1;int Instance()=>1;int first=Instance();System.Func<int> second=()=>this.Instance();int third=Static();}'}),graph=await index(root);
 assert.deepEqual(outcomes(graph,'Use.cs').map(site=>site.status),['unresolved','unresolved','resolved'],JSON.stringify(outcomes(graph,'Use.cs')));
});
