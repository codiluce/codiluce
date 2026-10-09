import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { indexRepository } from '../src/pipeline/index.js';
import { resolveConfig, type RustConfig } from '../src/core/config.js';
import { AnalysisCache } from '../src/pipeline/cache.js';
import { canonicalJson } from '../src/history/fingerprint.js';
import { compileWarpPath, matchWarpPath, evaluateWarp, warpParamMatches, type WarpNode } from '../src/analysis/routes/warp-patterns.js';
import { warpPathSyntax } from '../src/analysis/frameworks/warp-syntax.js';
import { routingContract } from '../src/analysis/routes/contracts.js';
import { StructureParser } from '../src/analysis/tree-sitter/client.js';
import type { SoftwareGraph, Entity } from '../src/core/graph.js';
const roots: string[] = [];
after(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });
async function put(root: string, file: string, text: string) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); }
const selected: RustConfig = { features: [], defaultFeatures: false };
async function repo(source: string, dependencies = 'warp={version="0.4.3",features=["server"]}', files: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'codiluce-warp-')); roots.push(root);
  for (const [file,text] of Object.entries({'Cargo.toml':'[package]\nname="api"\nversion="1.0.0"\nedition="2021"\n[dependencies]\n'+dependencies+'\ntokio={version="1",features=["full"]}', 'src/main.rs':source,...files})) await put(root,file,text);
  return root;
}
async function index(root: string, cache?: AnalysisCache, rust = selected, revision?: string) { return indexRepository(root, {config:await resolveConfig(root,{applications:[{name:'api',path:'.',apiOrigins:['https://api.test'],rust}]}),cache,revision}); }
const endpoints = (graph: SoftwareGraph) => graph.entities.filter(entity => entity.type === 'api_endpoint' && entity.metadata.framework === 'warp');
const contract = (entity: Entity) => routingContract(entity.metadata.routing)!;
const handler = (graph: SoftwareGraph, endpoint: Entity) => graph.entities.find(entity => graph.relations.some(relation => relation.type === 'handles' && relation.from === endpoint.id && relation.to === entity.id));
const requestedHandler = (graph: SoftwareGraph, caller: string) => { const source = graph.entities.find(entity => entity.type === 'function' && entity.name === caller && entity.path === 'client.ts')!, relation = graph.relations.find(relation => relation.type === 'requests' && relation.from === source.id); return relation && handler(graph,graph.entities.find(entity=>entity.id===relation.to)!)?.name; };
const shape = (graph: SoftwareGraph) => canonicalJson({entities:graph.entities,relations:graph.relations,diagnostics:graph.diagnostics.filter(d=>!['git-metrics','indexer'].includes(d.analyzer)&&d.code!=='git-ignore-unavailable')});
const original = 'fn leaf(){}fn handler()->&\'static str{leaf();"ok"}';
const main = (body: string) => '#[tokio::main]async fn main(){'+body+'}';
const serve = (filter: string, source = original) => 'use warp::Filter;'+source+main('let route='+filter+';warp::serve(route).run(([127,0,0,1],8080)).await;');
const and = (left: WarpNode,right: WarpNode): WarpNode => ({kind:'and',left,right});
const mapped = (input: WarpNode,id: string,fallible = false): WarpNode => ({kind:'handler',input,id,fallible});
test('Warp path filters preserve raw escapes, empty segments, native prefixes and one trailing slash',()=>{
  const branch = and({kind:'literal',value:'hello'},{kind:'end'}), pattern = compileWarpPath(branch,'warp-0.4');
  for (const input of ['/hello','/hello/']) assert.ok(matchWarpPath(pattern,input),input);
  for (const input of ['//hello','/hello//','/Hello','/hello/extra','/%68ello']) assert.ok(!matchWarpPath(pattern,input),input);
  assert.ok(matchWarpPath(compileWarpPath({kind:'literal',value:'hello'},'warp-0.3'),'/hello/extra'));
  assert.ok(matchWarpPath(compileWarpPath(and({kind:'literal',value:'%68ello'},{kind:'end'}),'warp-0.4'),'/%68ello'));
  const numeric=compileWarpPath(and({kind:'param',guard:'u8'},{kind:'end'}),'warp-0.4');
  assert.ok(!matchWarpPath(numeric,'/%31')); assert.ok(matchWarpPath(numeric,'/+1'));
});
test('Warp typed raw captures retain fixed-width FromStr bounds and zero-segment tails',()=>{
  assert.equal(warpParamMatches('u128',String((1n<<128n)-1n)),true);
  assert.equal(warpParamMatches('u128',String(1n<<128n)),false);
  for(const input of ['-0','256','1\n','1%0A',' 1','1e2']) assert.equal(warpParamMatches('u8',input),false,input);
  assert.equal(warpParamMatches('bool','true'),true); assert.equal(warpParamMatches('bool','TRUE'),false);
  assert.equal(warpParamMatches('String','%2F'),true); assert.equal(warpParamMatches('String',''),false);
  assert.equal(warpParamMatches('Custom','x'),undefined);
  const tail=compileWarpPath(and({kind:'literal',value:'files'},{kind:'tail'}),'warp-0.4');
  for(const input of ['/files','/files/','/files//a/b']) assert.ok(matchWarpPath(tail,input));
});
test('Warp ordered or resets its cursor but never retries an inner choice after a later and rejection',()=>{
  const choice: WarpNode = {kind:'or',left:{kind:'literal',value:'a'},right:and({kind:'literal',value:'a'},{kind:'literal',value:'b'})};
  assert.equal(evaluateWarp(mapped(and(choice,{kind:'end'}),'handler'),'/a/b','GET').success.length,0);
  const reset: WarpNode={kind:'or',left:mapped(and({kind:'literal',value:'a'},{kind:'literal',value:'wrong'}),'first'),right:mapped(and({kind:'literal',value:'a'},{kind:'literal',value:'b'}),'second')};
  assert.deepEqual(evaluateWarp(reset,'/a/b','GET').success.map(state=>state.handler),['second']);
  const fallible: WarpNode={kind:'or',left:mapped({kind:'any'},'fallible',true),right:mapped({kind:'any'},'later')};
  assert.deepEqual(evaluateWarp(fallible,'/a','GET').success.map(state=>state.handler),['fallible','later']);
});
test('Warp path! reads original literal/type token trees, comments, raw strings and terminal prefix syntax',()=>{
  assert.deepEqual(warpPathSyntax('( "api" /* outer /* nested */ comment */ / u8 / r#"raw"# / .. )'),{segments:[{kind:'literal',value:'api'},{kind:'type',text:'u8'},{kind:'literal',value:'raw'}],end:false});
  assert.deepEqual(warpPathSyntax('[]'),{segments:[],end:true});
  for(const input of ['(..)','("a" / .. / "b")','("a/b")','("")','("a" /)','(u /*c*/ 8)','(std::string::String)','(String,)','(b"a")']) assert.equal(warpPathSyntax(input),undefined,input);
});
test('Original Warp 0.3/0.4 literal filters retain native serving, source handlers and original leaves',async()=>{
  for(const dependencies of ['warp="0.3.7"','warp={version="0.4.3",features=["server"]}']){
    const root=await repo(serve('warp::path("hello").and(warp::path::end()).and(warp::get()).map(handler)'),dependencies,{'client.ts':'export function get(){return fetch("https://api.test/hello")}export function head(){return fetch("https://api.test/hello",{method:"HEAD"})}'}), graph=await index(root), endpoint=endpoints(graph)[0]!;
    assert.equal(endpoints(graph).length,1); assert.equal(endpoint.name,'GET /hello'); assert.ok(!endpoint.metadata.constraintsUnresolved,JSON.stringify(contract(endpoint).conditions));
    assert.equal(handler(graph,endpoint)?.name,'handler'); assert.equal(requestedHandler(graph,'get'),'handler'); assert.equal(requestedHandler(graph,'head'),undefined);
    const leaf=graph.entities.find(entity=>entity.name==='leaf'&&entity.path==='src/main.rs')!;
    assert.ok(graph.relations.some(relation=>relation.type==='calls'&&relation.from===handler(graph,endpoint)!.id&&relation.to===leaf.id&&relation.metadata?.adapter==='rust-routers'));
    assert.ok(endpoint.evidence.some(fact=>fact.file==='Cargo.toml')); assert.ok(endpoint.evidence.some(fact=>fact.explanation?.includes('serving future')));
    assert.ok(contract(endpoint).warp?.program); assert.equal(contract(endpoint).dispatch?.dialect,'warp');
  }
});
test('Renamed Cargo dependencies, original macro aliases and fully-qualified combinators keep identity',async()=>{
  const source='use web::{Filter as NativeFilter,path as route};'+original+main('let routes=route!("hello").and(web::get()).map(handler);web::serve(routes).run(([127,0,0,1],8080)).await;');
  const graph=await index(await repo(source,'web={package="warp",version="0.4.3",features=["server"]}'));
  assert.equal(endpoints(graph).length,1); assert.ok(!endpoints(graph)[0]!.metadata.constraintsUnresolved,JSON.stringify(contract(endpoints(graph)[0]!).conditions));
  const qualified=await index(await repo(original+main('let route=warp::Filter::map(warp::path!("hello"),handler);warp::serve(route).run(([127,0,0,1],8080)).await;')));
  assert.equal(endpoints(qualified).length,1); assert.ok(!endpoints(qualified)[0]!.metadata.constraintsUnresolved,JSON.stringify(contract(endpoints(qualified)[0]!).conditions));
});
test('Original Warp prefix mounts, helper factories and nested ordered or preserve handler selection',async()=>{
  const source='use warp::Filter;mod routes;'+main('let routes=warp::path("api").and(routes::routes());warp::serve(routes).run(([127,0,0,1],8080)).await;');
  const graph=await index(await repo(source,undefined,{'src/routes.rs':'use warp::Filter;pub fn first()->&\'static str{"one"}pub fn second()->&\'static str{"two"}pub fn routes()->impl warp::Filter<Extract=(impl warp::Reply,),Error=warp::Rejection>+Clone {warp::path("hello").map(first).or(warp::path!("hello"/"again").map(second))}','client.ts':'export function shorter(){return fetch("https://api.test/api/hello")}export function longer(){return fetch("https://api.test/api/hello/again")}'}));
  assert.equal(endpoints(graph).length,2); assert.ok(endpoints(graph).every(endpoint=>!endpoint.metadata.constraintsUnresolved),JSON.stringify(endpoints(graph).map(endpoint=>contract(endpoint).conditions)));
  assert.equal(requestedHandler(graph,'shorter'),'first'); assert.equal(requestedHandler(graph,'longer'),'first');
  assert.ok(endpoints(graph).every(endpoint=>endpoint.path==='src/routes.rs'));
  assert.ok(endpoints(graph).every(endpoint=>contract(endpoint).mounts.some(mount=>mount.prefix==='/api'&&mount.file==='src/main.rs')));
});
test('Warp native dispatch resets rejected prefixes and respects non-retrying nested choices',async()=>{
  const source=serve('warp::path("a").and(warp::path("wrong")).map(first).or(warp::path!("a"/"b").map(second))','fn first()->&\'static str{"one"}fn second()->&\'static str{"two"}');
  const graph=await index(await repo(source,undefined,{'client.ts':'export function call(){return fetch("https://api.test/a/b")}'}));
  assert.equal(requestedHandler(graph,'call'),'second');
  const nested=serve('warp::path("a").or(warp::path("a").and(warp::path("b"))).and(warp::path::end()).map(|_| "reply")');
  const rejected=await index(await repo(nested,undefined,{'client.ts':'export function call(){return fetch("https://api.test/a/b")}'}));
  assert.equal(requestedHandler(rejected,'call'),undefined); assert.equal(rejected.relations.filter(relation=>relation.type==='requests').length,0);
});
test('Typed path! and explicit/inferred param filters keep raw primitive guard conditions',async()=>{
  for(const filter of ['warp::path!("number"/u8).and(warp::get()).map(number)','warp::path("number").and(warp::path::param::<u8>()).and(warp::path::end()).and(warp::get()).map(number)','warp::path("number").and(warp::path::param()).and(warp::path::end()).and(warp::get()).map(number)']){
    const graph=await index(await repo(serve(filter,'fn number(id:u8)->&\'static str{"ok"}'),undefined,{'client.ts':'export function valid(){return fetch("https://api.test/number/255")}export function tooBig(){return fetch("https://api.test/number/256")}export function encoded(){return fetch("https://api.test/number/%31")}'}));
    assert.equal(endpoints(graph).length,1); assert.ok(!endpoints(graph)[0]!.metadata.constraintsUnresolved,JSON.stringify(contract(endpoints(graph)[0]!).conditions));
    assert.equal(requestedHandler(graph,'valid'),'number'); assert.equal(requestedHandler(graph,'tooBig'),undefined); assert.equal(requestedHandler(graph,'encoded'),undefined);
  }
});
test('Unreviewed custom, machine-word, reference and shadowed path parameter types remain gaps',async()=>{
  for(const [type,definition] of [['usize','fn number(id:usize)->&\'static str{"ok"}'],['Custom','struct Custom;fn number(id:Custom)->&\'static str{"ok"}'],['String','struct String;fn number(id:String)->&\'static str{"ok"}'],['u8','fn number(id:&u8)->&\'static str{"ok"}'],['u8','fn number(id:String)->&\'static str{"ok"}']] as const){
    const graph=await index(await repo(serve(`warp::path!("number"/${type}).map(number)`,definition),undefined,{'client.ts':'export function call(){return fetch("https://api.test/number/1")}'}));
    assert.equal(endpoints(graph).length,1); assert.ok(endpoints(graph)[0]!.metadata.constraintsUnresolved); assert.equal(requestedHandler(graph,'call'),undefined);
  }
  const incompatible=await index(await repo(serve('warp::path("number").and(warp::path::param::<u8,u16>()).map(number)','fn number(id:u8)->&\'static str{"ok"}')));assert.ok(endpoints(incompatible).every(endpoint=>endpoint.metadata.constraintsUnresolved));
});
test('Native map/then callbacks retain source identities while and_then preserves possible rejection',async()=>{
  const graph=await index(await repo(serve('warp::path!("hello").then(handler)','fn leaf(){}async fn handler()->&\'static str{leaf();"ok"}'),undefined,{'client.ts':'export function call(){return fetch("https://api.test/hello")}'}));
  assert.ok(!endpoints(graph)[0]!.metadata.constraintsUnresolved,JSON.stringify(contract(endpoints(graph)[0]!).conditions)); assert.equal(requestedHandler(graph,'call'),'handler');
  const fallible=await index(await repo(serve('warp::path!("hello").and_then(first).or(warp::path!("hello").map(handler))','async fn first()->Result<&\'static str,warp::Rejection>{Ok("first")}'+original),undefined,{'client.ts':'export function call(){return fetch("https://api.test/hello")}'}));
  assert.equal(endpoints(fallible).length,2); assert.ok(endpoints(fallible).some(endpoint=>handler(fallible,endpoint)?.name==='first'&&endpoint.metadata.constraintsUnresolved)); assert.equal(requestedHandler(fallible,'call'),undefined);
});
test('Unknown extraction filters and source recovery/wrappers cannot certify later competitors',async()=>{
  for(const filter of ['warp::path!("hello").and(warp::query::<String>()).map(handler)','warp::path!("hello").map(handler).recover(recover)','warp::fs::dir("static").or(warp::path!("hello").map(handler))','warp::path!("hello").map(handler).with(warp::cors())']){
    const graph=await index(await repo(serve(filter,original+'async fn recover(reason:warp::Rejection)->Result<&\'static str,std::convert::Infallible>{Ok("recovery")}'),undefined,{'client.ts':'export function call(){return fetch("https://api.test/hello")}'}));
    assert.ok(endpoints(graph).length>0); assert.equal(requestedHandler(graph,'call'),undefined,filter);
  }
});
test('Warp 0.3 bind serves on await while 0.4 bind only returns a bound server',async()=>{
  const base='use warp::Filter;'+original;
  for(const [dependencies,body,count] of [
    ['warp="0.3.7"','warp::serve(warp::path!("hello").map(handler)).bind(([127,0,0,1],8080)).await;',1],
    ['warp={version="0.4.3",features=["server"]}','warp::serve(warp::path!("hello").map(handler)).bind(([127,0,0,1],8080)).await;',0],
    ['warp={version="0.4.3",features=["server"]}','warp::serve(warp::path!("hello").map(handler)).bind(([127,0,0,1],8080)).await.run().await;',1],
    ['warp="0.3.7"','let (_,future)=warp::serve(warp::path!("hello").map(handler)).bind_ephemeral(([127,0,0,1],8080));future.await;',1],
    ['warp="0.3.7"','let tuple=warp::serve(warp::path!("hello").map(handler)).bind_ephemeral(([127,0,0,1],8080));tuple.1.await;',1],
  ] as const){const graph=await index(await repo(base+main(body),dependencies));assert.equal(endpoints(graph).length,count,body);assert.ok(endpoints(graph).every(endpoint=>!endpoint.metadata.constraintsUnresolved),JSON.stringify(endpoints(graph).map(endpoint=>contract(endpoint).conditions)));}
});
test('Stored serving futures, original Tokio listeners and graceful shutdown preserve awaited source reachability',async()=>{
  for(const body of ['let future=warp::serve(warp::path!("hello").map(handler)).run(([127,0,0,1],8080));future.await;','let listener=tokio::net::TcpListener::bind(([127,0,0,1],8080)).await.unwrap();warp::serve(warp::path!("hello").map(handler)).incoming(listener).graceful(async {}).run().await;']){
    const graph=await index(await repo('use warp::Filter;'+original+main(body)));assert.equal(endpoints(graph).length,1);assert.ok(!endpoints(graph)[0]!.metadata.constraintsUnresolved,JSON.stringify(contract(endpoints(graph)[0]!).conditions));
  }
});
test('Unserved and unawaited Warp filters and futures never expose endpoints',async()=>{
  for(const body of ['let filter=warp::path!("hello").map(handler);','let server=warp::serve(warp::path!("hello").map(handler));','let future=warp::serve(warp::path!("hello").map(handler)).run(([127,0,0,1],8080));']) assert.equal(endpoints(await index(await repo('use warp::Filter;'+original+main(body)))).length,0);
});
test('Canonical trait/runtime/feature selections and closed source versions constrain serving',async()=>{
  for(const [source,dependencies] of [
    [serve('warp::path!("hello").map(handler)').replace('use warp::Filter;',''),'warp={version="0.4.3",features=["server"]}'],
    [serve('warp::path!("hello").map(handler)'),'warp="0.4.3"'],
    [serve('warp::path!("hello").map(handler)'),'warp=">=0.3,<0.5"'],
    [serve('warp::path!("hello").map(handler)'),'warp={package="other",version="0.4.3"}'],
    [serve('warp::path!("hello").map(handler)').replace('#[tokio::main]',''),'warp={version="0.4.3",features=["server"]}'],
  ] as const){const graph=await index(await repo(source,dependencies,{'client.ts':'export function call(){return fetch("https://api.test/hello")}'}));assert.ok(endpoints(graph).every(endpoint=>endpoint.metadata.constraintsUnresolved));assert.equal(requestedHandler(graph,'call'),undefined);}
  const mixed=await index(await repo('use old::Filter;'+original+main('new::serve(new::path!("hello").map(handler)).run(([127,0,0,1],8080)).await;'),'old={package="warp",version="0.3.7"}\nnew={package="warp",version="0.4.3",features=["server"]}'));assert.ok(endpoints(mixed).every(endpoint=>endpoint.metadata.constraintsUnresolved));
});
test('Native macro_use, absolute paths and imported source aliases preserve Warp macro identity',async()=>{
  for(const prefix of ['#[macro_use]extern crate warp;use warp::Filter;','#[macro_use(path)]extern crate warp;use warp::Filter;']){
    const graph=await index(await repo(prefix+original+main('warp::serve(path!("hello").map(handler)).run(([127,0,0,1],8080)).await;')));
    assert.equal(endpoints(graph).length,1);assert.ok(!endpoints(graph)[0]!.metadata.constraintsUnresolved,JSON.stringify(contract(endpoints(graph)[0]!).conditions));
  }
  const graph=await index(await repo('use ::warp::Filter;mod warp{}'+original+main('::warp::serve(::warp::path!("hello").map(handler)).run(([127,0,0,1],8080)).await;')));
  assert.equal(endpoints(graph).length,1);assert.ok(!endpoints(graph)[0]!.metadata.constraintsUnresolved,JSON.stringify(contract(endpoints(graph)[0]!).conditions));
});
test('Native or followed by a mapper preserves Either extraction, original wildcard closures and source leaves',async()=>{
  const graph=await index(await repo(serve('warp::path!("a").or(warp::path!("b")).map(|_| {leaf();"ok"})'),undefined,{'client.ts':'export function first(){return fetch("https://api.test/a")}export function second(){return fetch("https://api.test/b")}'}));
  assert.equal(endpoints(graph).length,2);assert.ok(endpoints(graph).every(endpoint=>!endpoint.metadata.constraintsUnresolved),JSON.stringify(endpoints(graph).map(endpoint=>contract(endpoint).conditions)));
  assert.equal(graph.relations.filter(relation=>relation.type==='requests').length,2);assert.equal(handler(graph,endpoints(graph)[0]!)?.id,handler(graph,endpoints(graph)[1]!)?.id);
  assert.equal(handler(graph,endpoints(graph)[0]!)?.metadata.declarationKind,'closure');
});
test('Explicit native clones, boxed filters and equal extraction unify preserve native ordering',async()=>{
  const source='use warp::Filter;'+original+main('let prefix=warp::path("api");let first=prefix.and(warp::path!("a")).map(handler);let second=prefix.and(warp::path!("b")).map(handler);let routes=first.clone().or(second).unify().boxed();warp::serve(routes).run(([127,0,0,1],8080)).await;');
  const graph=await index(await repo(source,undefined,{'client.ts':'export function call(){return fetch("https://api.test/api/b")}'}));
  assert.equal(endpoints(graph).length,2);assert.ok(endpoints(graph).every(endpoint=>!endpoint.metadata.constraintsUnresolved),JSON.stringify(endpoints(graph).map(endpoint=>contract(endpoint).conditions)));assert.equal(requestedHandler(graph,'call'),'handler');
});
test('Consumed source filters and server reuse retain move gaps while native primitive Copy filters can repeat',async()=>{
  for(const body of ['let route=warp::path!("hello").map(|| "ok").boxed();let first=route.and(warp::get());let second=route.and(warp::get());warp::serve(first.or(second)).run(([127,0,0,1],8080)).await;','let server=warp::serve(warp::path!("hello").map(handler));server.run(([127,0,0,1],8080)).await;server.run(([127,0,0,1],8080)).await;']){
    const graph=await index(await repo('use warp::Filter;'+original+main(body),undefined,{'client.ts':'export function call(){return fetch("https://api.test/hello")}'}));assert.ok(endpoints(graph).length>0,body+JSON.stringify(graph.diagnostics.filter(d=>d.analyzer==='rust-routers')));assert.ok(endpoints(graph).every(endpoint=>endpoint.metadata.constraintsUnresolved),body+JSON.stringify(endpoints(graph).map(endpoint=>contract(endpoint).conditions)));assert.equal(requestedHandler(graph,'call'),undefined);
  }
});
test('Native literal method alternatives retain exact HEAD and all-method predicates',async()=>{
  const graph=await index(await repo(serve('warp::path!("hello").and(warp::get().or(warp::head()).unify()).map(handler)'),undefined,{'client.ts':'export function get(){return fetch("https://api.test/hello")}export function head(){return fetch("https://api.test/hello",{method:"HEAD"})}export function post(){return fetch("https://api.test/hello",{method:"POST"})}'}));
  assert.equal(endpoints(graph).length,2);assert.equal(requestedHandler(graph,'get'),'handler');assert.equal(requestedHandler(graph,'head'),'handler');assert.equal(requestedHandler(graph,'post'),undefined);
  const all=await index(await repo(serve('warp::path!("hello").map(handler)'),undefined,{'client.ts':'export function post(){return fetch("https://api.test/hello",{method:"POST"})}'}));assert.equal(requestedHandler(all,'post'),'handler');
});
test('Opaque cursor changes and recovering wrappers block a later apparently matching branch',async()=>{
  for(const filter of ['warp::path("hello").and(warp::fs::dir("static")).and(warp::path::end()).map(first).or(warp::path!("hello"/"a").map(handler))','warp::path!("wrong").recover(recover).and(warp::path::end()).map(|_| "first").or(warp::path!("hello"/"a").map(handler))']){
    const graph=await index(await repo(serve(filter,original+'fn first(_reply:impl warp::Reply)->&\'static str{"one"}async fn recover(_reason:warp::Rejection)->Result<&\'static str,std::convert::Infallible>{Ok("recovery")}'),undefined,{'client.ts':'export function call(){return fetch("https://api.test/hello/a")}'}));assert.equal(requestedHandler(graph,'call'),undefined);
  }
});
test('Native tail, full and method extraction retain source callback arity without decoded path inference',async()=>{
  for(const [filter,definition] of [['warp::path("files").and(warp::path::tail()).map(handler)','fn handler(tail:warp::path::Tail)->&\'static str{"ok"}'],['warp::path!("hello").and(warp::path::full()).map(handler)','fn handler(path:warp::path::FullPath)->&\'static str{"ok"}'],['warp::path!("hello").and(warp::method()).map(handler)','fn handler(method:warp::http::Method)->&\'static str{"ok"}']] as const){
    const graph=await index(await repo(serve(filter,definition)));assert.equal(endpoints(graph).length,1);assert.ok(!endpoints(graph)[0]!.metadata.constraintsUnresolved,JSON.stringify(contract(endpoints(graph)[0]!).conditions));
  }
});
test('Async closure then callbacks, tuple projections and their original source ranges remain explicit syntax facts',async()=>{
  const parser=new StructureParser();
  try{
    const source='// 😀\r\nfn main(){let (_, /* original */ (x,future))=factory();let cb=|_| "ok";}',facts=await parser.parse('rust',source), bindings=facts.rust!.semantic!.bindings;
    assert.deepEqual(bindings.find(binding=>binding.name==='future')!.projection!.indices,[1,1]);assert.equal(bindings.find(binding=>binding.name==='future')!.value,undefined,'general Rust never borrows a framework tuple result');
    const projection=bindings.find(binding=>binding.name==='future')!.projection!;assert.equal(source.slice(projection.value.start,projection.value.end),'factory()');assert.equal(projection.value.range.startLine,2);
    assert.equal(facts.rust!.semantic!.definitions.find(definition=>definition.kind==='closure')!.parameters.length,1);
  }finally{await parser.close();}
  const graph=await index(await repo(serve('warp::path!("hello").then(|| async {leaf();"ok"})'),undefined,{'client.ts':'export function call(){return fetch("https://api.test/hello")}'}));assert.ok(!endpoints(graph)[0]!.metadata.constraintsUnresolved,JSON.stringify(contract(endpoints(graph)[0]!).conditions));assert.equal(graph.relations.filter(relation=>relation.type==='requests').length,1);
  const callback=handler(graph,endpoints(graph)[0]!)!,future=graph.relations.find(relation=>relation.from===callback.id&&relation.type==='calls'&&relation.metadata?.execution==='awaited-future-body');assert.ok(future);const body=graph.entities.find(entity=>entity.id===future.to)!;assert.equal(body.metadata.declarationKind,'async');assert.equal(body.path,callback.path);assert.ok(graph.relations.some(relation=>relation.from===body.id&&relation.type==='calls'&&graph.entities.find(entity=>entity.id===relation.to)?.name==='leaf'));
  const constructed=await index(await repo(serve('warp::path!("hello").then(async {leaf();"ok"})')));assert.ok(endpoints(constructed).every(endpoint=>endpoint.metadata.constraintsUnresolved));
});
test('Rust tuple-rest patterns cannot borrow the first serving future as the last tuple value',async()=>{
  const source='use warp::Filter;'+original+'fn pair()->(impl std::future::Future<Output=()>,impl std::future::Future<Output=()>){(warp::serve(warp::path!("first").map(handler)).run(([127,0,0,1],8080)),warp::serve(warp::path!("last").map(handler)).run(([127,0,0,1],8081)))}'+main('let (..,future)=pair();future.await;');
  assert.equal(endpoints(await index(await repo(source))).length,0);
});
test('Original std String imports qualify guards while no-prelude implicit String retains a gap',async()=>{
  const source='use std::string::String as Text;'+serve('warp::path("hello").and(warp::path::param::<Text>()).and(warp::path::end()).map(handler)','fn handler(value:Text)->&\'static str{"ok"}');
  const graph=await index(await repo(source));assert.ok(!endpoints(graph)[0]!.metadata.constraintsUnresolved,JSON.stringify(contract(endpoints(graph)[0]!).conditions));
  const missing=await index(await repo('#![no_implicit_prelude]'+serve('warp::path!("hello"/String).map(handler)','fn handler(value:String)->&\'static str{"ok"}')));assert.ok(endpoints(missing).every(endpoint=>endpoint.metadata.constraintsUnresolved));
});
test('Malformed or unsupported path macros and source macro shadows cannot neutralize native gaps',async()=>{
  for(const source of [serve('warp::path!("hello"/.. /"a").map(handler)'),serve('path!("hello").map(handler)'),serve('warp::path!(std::string::String).map(handler)'),serve('warp::path!("hello").map(handler)').replace('use warp::Filter;','use warp::Filter;macro_rules! path{($x:literal)=>{warp::any()}}').replace('warp::path!','path!')]){
    const graph=await index(await repo(source,undefined,{'client.ts':'export function call(){return fetch("https://api.test/hello")}'}));assert.ok(endpoints(graph).every(endpoint=>endpoint.metadata.constraintsUnresolved));assert.equal(requestedHandler(graph,'call'),undefined);
  }
});
test('Source conditional filter composition and late opaque escapes retain runtime registration gaps',async()=>{
  for(const body of ['let route=warp::path!("hello").map(handler);if configured(){warp::serve(route).run(([127,0,0,1],8080)).await;};','let route=warp::path!("hello").map(handler);warp::serve(route.clone()).run(([127,0,0,1],8080)).await;unknown(route);']){
    const graph=await index(await repo('use warp::Filter;'+original+main(body),undefined,{'client.ts':'export function call(){return fetch("https://api.test/hello")}'}));assert.ok(endpoints(graph).length>0,body+JSON.stringify(graph.diagnostics.filter(d=>d.analyzer==='rust-routers')));assert.ok(endpoints(graph).every(endpoint=>endpoint.metadata.constraintsUnresolved),body+JSON.stringify(endpoints(graph).map(endpoint=>contract(endpoint).conditions)));assert.equal(requestedHandler(graph,'call'),undefined);
  }
});
test('Tail control returns leave a visible registration gap without certifying conditional Warp serving',async()=>{
  const graph=await index(await repo('use warp::Filter;'+original+main('let route=warp::path!("hello").map(handler);if configured(){warp::serve(route).run(([127,0,0,1],8080)).await;}')));assert.equal(endpoints(graph).length,0);assert.ok(graph.diagnostics.some(d=>d.analyzer==='rust-routers'&&d.reason.includes('return/control')));
});
test('Macro operand/handler coordinates retain CRLF/emoji and stable original handler IDs across source shifts',async()=>{
  const source='use warp::Filter;\r\n// 😀 original\r\nfn leaf(){}\r\nfn handler()->&\'static str{leaf();"ok"}\r\n'+main('warp::serve(warp::path!("hello").map(handler)).run(([127,0,0,1],8080)).await;'),root=await repo(source),before=await index(root),callback=handler(before,endpoints(before)[0]!)!;
  assert.equal(callback.sourceRange?.startLine,4);assert.equal(source.split('\r\n')[callback.sourceRange!.startLine-1]!.slice(callback.sourceRange!.startColumn!-1).startsWith('fn handler'),true);
  await put(root,'src/main.rs','\r\n'+source);const after=await index(root),next=handler(after,endpoints(after)[0]!)!;assert.equal(next.id,callback.id);assert.equal(next.sourceRange?.startLine,5);assert.deepEqual(endpoints(after).map(endpoint=>endpoint.id),endpoints(before).map(endpoint=>endpoint.id));
});
test('Warp program, handlers, native source calls and frontend requests replay exactly through cache and revision',async()=>{
  const root=await repo(serve('warp::path!("hello").and(warp::get()).map(handler)'),undefined,{'client.ts':'export function call(){return fetch("https://api.test/hello")}'}),state=await mkdtemp(path.join(tmpdir(),'codiluce-warp-cache-'));roots.push(state);
  const cold=await index(root,new AnalysisCache(state)),cache=new AnalysisCache(state),warm=await index(root,cache),revision=await index(root,undefined,selected,'recorded-revision');assert.equal(shape(cold),shape(warm));assert.equal(shape(cold),shape(revision));assert.ok(cache.events.some(event=>event.analyzer==='rust-routers'&&event.hit));assert.equal(requestedHandler(warm,'call'),'handler');
  await put(root,'src/main.rs',serve('warp::path!("changed").and(warp::get()).map(handler)'));const changed=await index(root,new AnalysisCache(state));assert.equal(shape(changed),shape(await index(root)));assert.equal(requestedHandler(changed,'call'),undefined);
});
test('Original manifest feature/source/version selections and handler denial invalidate cached Warp routes',async()=>{
  const root=await repo('use warp::Filter;mod handlers;'+main('warp::serve(warp::path!("hello").map(handlers::handler)).run(([127,0,0,1],8080)).await;'),undefined,{'src/handlers.rs':'pub fn handler()->&\'static str{"ok"}','client.ts':'export function call(){return fetch("https://api.test/hello")}'}),state=await mkdtemp(path.join(tmpdir(),'codiluce-warp-input-cache-'));roots.push(state);
  const good=await index(root,new AnalysisCache(state));assert.equal(requestedHandler(good,'call'),'handler');
  await put(root,'Cargo.toml','[package]\nname="api"\nversion="1.0.0"\nedition="2021"\n[dependencies]\nwarp="0.4.3"\ntokio={version="1",features=["full"]}');const changed=await index(root,new AnalysisCache(state));assert.equal(shape(changed),shape(await index(root)));assert.equal(requestedHandler(changed,'call'),undefined);
  const denied=await indexRepository(root,{config:await resolveConfig(root,{ignore:['src/handlers.rs'],applications:[{name:'api',path:'.',apiOrigins:['https://api.test'],rust:selected}]}),cache:new AnalysisCache(state)});assert.ok(endpoints(denied).every(endpoint=>endpoint.metadata.constraintsUnresolved));assert.equal(requestedHandler(denied,'call'),undefined);
});
test('Source filter algebra and request matching budgets never certify partial program winners',async()=>{
  const chain=Array.from({length:70},()=>'.and(warp::any())').join(''),graph=await index(await repo(serve('warp::path!("hello")'+chain+'.map(handler)'),undefined,{'client.ts':'export function call(){return fetch("https://api.test/hello")}'}));assert.ok(endpoints(graph).every(endpoint=>endpoint.metadata.constraintsUnresolved));assert.equal(requestedHandler(graph,'call'),undefined);
  let node:WarpNode={kind:'any'};for(let index=0;index<70;index++)node=and(node,{kind:'any'});assert.ok(evaluateWarp(mapped(node,'handler'),'/hello','GET').exhausted);
});
