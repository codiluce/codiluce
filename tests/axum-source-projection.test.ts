import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {indexRepository} from '../src/pipeline/index.js';
import {resolveConfig} from '../src/core/config.js';
import {AnalysisCache} from '../src/pipeline/cache.js';
import {canonicalJson} from '../src/history/fingerprint.js';
import type {SoftwareGraph,Entity} from '../src/core/graph.js';
import type {RoutingContract} from '../src/analysis/routes/contracts.js';

const roots:string[]=[];after(async()=>{await Promise.all(roots.map(root=>rm(root,{recursive:true,force:true})));});
async function put(root:string,file:string,text:string){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),text);}
async function repo(source:string,extra:Record<string,string>={},dependency='axum="0.7.9"'){
 const root=await mkdtemp(path.join(tmpdir(),'codiluce-axum-projection-'));roots.push(root);
 for(const [file,text]of Object.entries({'Cargo.toml':`[package]\nname="api"\nversion="1.0.0"\nedition="2021"\n[dependencies]\n${dependency}\ntokio={version="1",features=["full"]}`,'src/main.rs':source,'client.ts':'export function load(){return fetch("https://api.test/x")}',...extra}))await put(root,file,text);
 return root;
}
async function index(root:string,cache?:AnalysisCache,revision?:string){return indexRepository(root,{config:await resolveConfig(root,{applications:[{name:'api',path:'.',apiOrigins:['https://api.test'],rust:{features:[],defaultFeatures:false}}]}),cache,revision});}
const entry=(body:string)=>`#[tokio::main]async fn main(){${body}}`;
const serve=(router:string,after='')=>entry(`let app=${router};${after}let listener=tokio::net::TcpListener::bind("127.0.0.1:8080").await.unwrap();axum::serve(listener,app).await.unwrap();`);
const prefix='use axum::{Router,routing::{get,post},middleware};';
const typeAttribute='#[vendor::encode]struct Payload;';
const handler='async fn handler()->&\'static str{"ok"}';
const factory='fn routes()->Router{Router::new().route("/x",post(handler).get(handler))}';
const routes=(g:SoftwareGraph)=>g.entities.filter(e=>e.type==='api_endpoint'&&e.metadata.framework==='axum'&&e.metadata.registration==='explicit');
const contract=(e:Entity)=>e.metadata.routing as unknown as RoutingContract;
const target=(g:SoftwareGraph,id:string)=>g.entities.find(e=>e.id===id)!;
const handles=(g:SoftwareGraph)=>g.relations.filter(e=>e.type==='handles'&&routes(g).some(route=>route.id===e.from));
const source=prefix+typeAttribute+handler+factory+serve('Router::new().merge(routes())');
const shape=(g:SoftwareGraph)=>canonicalJson({entities:g.entities,relations:g.relations,diagnostics:g.diagnostics.filter(item=>!['git-metrics','indexer'].includes(item.analyzer)&&item.code!=='git-ignore-unavailable')});

test('Original Axum helpers and chained method handlers retain conditional identities; general Rust binding stays unsupported',async()=>{
 const g=await index(await repo(source));assert.equal(routes(g).length,2);assert.equal(handles(g).length,2);
 for(const edge of handles(g)){assert.equal(target(g,edge.to).name,'handler');assert.equal(edge.metadata?.binding,'conditional-original-source');assert.ok(contract(target(g,edge.from)).conditions.some(gap=>gap.includes('generated type-attribute exports')));}
 assert.ok(!g.relations.some(e=>e.type==='requests'&&routes(g).some(route=>route.id===e.to)));
 const outcomes=g.entities.filter(e=>e.type==='file').flatMap(e=>(e.metadata.rustCallOutcomes??[]) as any[]);
 assert.ok(outcomes.some(call=>call.name==='routes'&&call.status==='unsupported'));assert.ok(!outcomes.some(call=>call.name==='routes'&&call.status==='resolved'));
 assert.ok(!g.relations.some(e=>e.type==='calls'&&e.metadata?.adapter==='rust-routers'&&target(g,e.to).name==='routes'));
});

test('Original module/re-export helpers, nested paths, state and source aliases compose conditionally',async()=>{
 const text=`${prefix}${typeAttribute}mod api;use api::routes as selected;${serve('Router::new().nest("/api",selected()).route("/later",get(api::handler))')}`;
 const g=await index(await repo(text,{'src/api.rs':`${prefix}${typeAttribute}pub async fn handler()->&'static str{"ok"}pub fn routes()->Router{Router::new().route("/x",get(handler)).with_state(unknown_state())}`}));
 assert.deepEqual(routes(g).map(e=>e.metadata.routePath).sort(),['/api/x','/later']);assert.equal(handles(g).length,2);for(const edge of handles(g)){assert.equal(target(g,edge.to).path,'src/api.rs');assert.equal(edge.metadata?.binding,'conditional-original-source');}
});

test('A function own attribute, module attribute, namespace macro, unknown cfg and generic/unsafe signature cannot borrow source projection',async()=>{
 const variants=[
  source.replace(factory,'#[vendor::rewrite]'+factory),
  source.replace(factory,factory.replace('fn routes()','fn routes<T>()')),
  source.replace(factory,factory.replace('fn routes()','unsafe fn routes()')),
  source.replace(factory,'#[cfg(unknown_flag)]'+factory),
  source.replace(factory,'generate_items!();'+factory),
 ];
 for(const text of variants){const g=await index(await repo(text));assert.equal(handles(g).length,0);}
 const g=await index(await repo(`${prefix}${typeAttribute}#[vendor::rewrite]mod api;${serve('Router::new().merge(api::routes())')}`,{'src/api.rs':`${prefix}${handler}${factory}`}));assert.equal(handles(g).length,0);
});

test('Unknown original handler attributes, source/import shadows, ambiguous exports and mutable aliases have no projected winner',async()=>{
 for(const text of [source.replace(handler,'#[vendor::rewrite]'+handler),source.replace('Router::new().merge(routes())','Router::new().merge({let routes=external();routes()})'),source.replace('Router::new().merge(routes())','{let mut chosen=routes;chosen=external();Router::new().merge(chosen())}')]){const g=await index(await repo(text));assert.ok(!handles(g).some(edge=>edge.metadata?.binding==='conditional-original-source'));}
 const g=await index(await repo(`${prefix}${typeAttribute}mod a;mod b;use a::*;use b::*;${serve('Router::new().merge(routes())')}`,{'src/a.rs':`${prefix}pub ${factory}${handler}`,'src/b.rs':`${prefix}pub ${factory}${handler}`}));assert.equal(handles(g).length,0);
});

test('Awaited source factories are projected only as Axum source summaries; unawaited futures and recursion do not register',async()=>{
 const asyncSource=source.replace('fn routes()->Router','async fn routes()->Router');
 const unawaited=await index(await repo(asyncSource));assert.equal(handles(unawaited).length,0);
 const awaited=await index(await repo(asyncSource.replace('.merge(routes())','.merge(routes().await)')));assert.equal(handles(awaited).length,2);
 const recursive=await index(await repo(source.replace(factory,'fn routes()->Router{routes()}')));assert.equal(handles(recursive).length,0);
 const unused=await index(await repo(prefix+typeAttribute+handler+factory+serve('Router::new()','let discarded=routes();')));assert.equal(handles(unused).length,0);
});

test('Conditional Axum source candidates cannot lend handler or helper identity to Warp',async()=>{
 const text=`${prefix}use warp::Filter;${typeAttribute}${handler}fn routes()->impl Filter<Extract=(impl warp::Reply,),Error=warp::Rejection>+Clone{warp::path("x").map(handler)}${entry('warp::serve(routes()).run(([127,0,0,1],8080)).await;')}`;
 const g=await index(await repo(text,{},'axum="0.7.9"\nwarp={version="0.4.3",features=["server"]}'));assert.ok(!g.relations.some(edge=>edge.type==='handles'&&target(g,edge.to).name==='handler'));
});

const middlewareDefinitions=`async fn auth(req:axum::extract::Request,next:axum::middleware::Next)->axum::response::Response{next.run(req).await}
async fn map(res:axum::response::Response)->axum::response::Response{res}
async fn state_auth(_:axum::extract::State<Payload>,req:axum::extract::Request,next:axum::middleware::Next)->axum::response::Response{next.run(req).await}
async fn state_map(_:axum::extract::State<Payload>,res:axum::response::Response)->axum::response::Response{res}`;

test('All four native Axum middleware constructors preserve original deferred callback references across 0.7 and 0.8',async()=>{
 for(const dependency of ['axum="0.7.9"','axum="0.8.9"']){
  const g=await index(await repo(prefix+handler+middlewareDefinitions+serve('Router::new().route("/x",get(handler)).route_layer(middleware::from_fn(auth)).layer(middleware::map_response(map)).layer(middleware::from_fn_with_state(unknown_state(),state_auth)).layer(middleware::map_response_with_state(unknown_state(),state_map))'),{},dependency));
  const endpoint=routes(g)[0]!;assert.ok(endpoint);const stages=contract(endpoint).rust!.middleware!;
  assert.deepEqual(stages.map(stage=>stage.kind),['from_fn','map_response','from_fn_with_state','map_response_with_state']);assert.deepEqual(stages.map(stage=>stage.application!.order),[0,1,2,3]);assert.deepEqual(stages.map(stage=>stage.state),['unit','unit','supplied-unreviewed','supplied-unreviewed']);
  const refs=g.relations.filter(edge=>edge.from===endpoint.id&&edge.metadata?.role==='middleware');assert.equal(refs.length,4);
  for(const ref of refs){assert.equal(ref.type,'references');assert.equal(ref.metadata?.execution,'deferred-native-middleware');assert.ok(!g.relations.some(edge=>edge.from===endpoint.id&&edge.to===ref.to&&['handles','calls'].includes(edge.type)));}
  assert.ok(contract(endpoint).conditions.some(gap=>gap.includes('request-part extractors run before')));assert.ok(contract(endpoint).conditions.some(gap=>gap.includes('supplied state')));assert.ok(!g.relations.some(edge=>edge.type==='requests'&&edge.to===endpoint.id));
  for(const automatic of g.entities.filter(e=>e.type==='api_endpoint'&&e.metadata.framework==='axum'&&e.metadata.registration==='implicit'))assert.ok(contract(automatic).conditions.some(gap=>gap.includes('automatic')&&gap.includes('middleware stack')));
 }
});

test('Middleware projection retains conditional original functions without lending proof to unknown callback attributes',async()=>{
 const text=prefix+typeAttribute+handler+middlewareDefinitions+serve('Router::new().route("/x",get(handler)).layer(middleware::from_fn(auth)).layer(middleware::map_response(map))');
 const g=await index(await repo(text));assert.equal(handles(g).length,1);assert.equal(contract(routes(g)[0]!).rust!.middleware!.length,2);
 for(const stage of contract(routes(g)[0]!).rust!.middleware!){assert.equal(stage.binding,'conditional-original-source');assert.ok(stage.conditions.some(gap=>gap.includes('generated type-attribute exports')));}
 const denied=await index(await repo(text.replace('async fn auth','#[vendor::rewrite]async fn auth')));assert.ok(!denied.relations.some(edge=>edge.metadata?.role==='middleware'&&target(denied,edge.to).name==='auth'));
});

test('Layer snapshots retain builder order, opaque steps, later routes and explicit fallback scope without shared-array mutation',async()=>{
 const g=await index(await repo(prefix+handler+middlewareDefinitions+serve('Router::new().fallback(handler).route("/x",get(handler)).route_layer(middleware::from_fn(auth)).layer(unknown_layer()).layer(middleware::map_response(map)).route("/later",get(handler))')));
 const x=routes(g).find(e=>e.metadata.routePath==='/x')!,later=routes(g).find(e=>e.metadata.routePath==='/later')!,fallback=g.entities.find(e=>e.type==='api_endpoint'&&e.metadata.framework==='axum'&&contract(e).rust?.fallback==='path'&&e.metadata.registration==='explicit')!;
 assert.deepEqual(contract(x).rust!.middleware!.map(stage=>stage.application!.order),[0,2]);assert.equal(contract(later).rust!.middleware,undefined);assert.deepEqual(contract(fallback).rust!.middleware!.map(stage=>stage.kind),['map_response']);assert.ok(contract(x).conditions.some(gap=>gap.includes('Opaque layer')));
 for(const composed of ['Router::new().merge(Router::new().route("/x",get(handler)).layer(middleware::map_response(map)))','Router::new().nest("/api",Router::new().route("/x",get(handler)).layer(middleware::map_response(map)))']){
  const graph=await index(await repo(prefix+handler+middlewareDefinitions+serve(composed)));const automatic=graph.entities.find(e=>e.type==='api_endpoint'&&e.metadata.registration==='implicit'&&e.metadata.framework==='axum'&&contract(e).rust?.fallback==='path')!;assert.ok(automatic);assert.ok(contract(automatic).conditions.some(gap=>gap.includes('automatic fallback middleware selection')));assert.ok(!graph.relations.some(edge=>edge.from===automatic.id&&edge.type==='handles'));
 }
});

test('Multiline CRLF/emoji middleware proof names actual constructor/application tokens and original callback ranges',async()=>{
 const text=`// 😀 original source\r\n${prefix}\r\n${handler}\r\n${middlewareDefinitions}\r\n${serve('Router::new()\r\n.route("/x",get(handler))\r\n.layer(middleware::map_response(\r\nmap\r\n))\r\n.route_layer(middleware::from_fn(auth))')}`;
 const g=await index(await repo(text));const endpoint=routes(g)[0]!;for(const stage of contract(endpoint).rust!.middleware!){for(const site of [stage.source,stage.application!]){assert.ok(text.split('\n')[site.line-1]!.slice(site.column!-1).startsWith(String('method'in site?site.method:stage.kind)));}assert.ok(endpoint.evidence.some(fact=>fact.file==='src/main.rs'&&fact.line===stage.source.line));}
 for(const ref of g.relations.filter(edge=>edge.from===endpoint.id&&edge.metadata?.role==='middleware')){const original=target(g,ref.to);assert.ok(text.split('\n')[original.sourceRange!.startLine-1]!.includes('fn '+original.name));}
});

test('Bounded standard formatting permits namespace projection while preserving runtime dispatch uncertainty',async()=>{
 const g=await index(await repo(prefix+handler+serve('Router::new().route("/x",get(handler))','println!("{:?}", unknown_value());')));assert.equal(handles(g).length,1);assert.ok(contract(routes(g)[0]!).conditions.some(gap=>gap.includes('formatting runtime dispatch')));assert.ok(!g.relations.some(edge=>edge.type==='requests'&&edge.to===routes(g)[0]!.id));
 for(const diagnostics of ['macro_rules! println{($($t:tt)*)=>{}}println!("{:?}", value);','println!("{:?}", {fn generated(){} value});','println!("{:?}", nested!());']){const changed=await index(await repo(prefix+handler+serve('Router::new().route("/x",get(handler))',diagnostics)));assert.ok(changed.diagnostics.some(item=>item.analyzer==='rust-routers'&&item.reason?.includes('macro')));assert.ok(!changed.relations.some(edge=>edge.type==='requests'&&routes(changed).some(route=>route.id===edge.to)));}
});

test('Conditional source and middleware changes invalidate cached graphs with exact cold/warm/revision replay',async()=>{
 const text=prefix+typeAttribute+handler+middlewareDefinitions+serve('Router::new().route("/x",get(handler)).layer(middleware::map_response(map))');const root=await repo(text),state=await repo('');
 const cold=await index(root,new AnalysisCache(state)),cache=new AnalysisCache(state),warm=await index(root,cache);assert.equal(shape(cold),shape(warm));assert.equal(shape(cold),shape(await index(root,undefined,'recorded')));assert.ok(cache.events.some(event=>event.analyzer==='rust-routers'&&event.hit));
 await put(root,'src/main.rs',text.replace('map_response(map)','from_fn(auth)'));const edited=new AnalysisCache(state),changed=await index(root,edited);assert.notEqual(shape(cold),shape(changed));assert.equal(shape(changed),shape(await index(root,undefined,'edited')));assert.ok(edited.events.some(event=>event.analyzer==='rust-routers'&&!event.hit));
 await put(root,'Cargo.toml','[package]\nname="api"\nversion="1.0.0"\nedition="2021"\n[dependencies]\naxum="0.9"\ntokio={version="1",features=["full"]}');const unavailable=await index(root,new AnalysisCache(state));assert.equal(handles(unavailable).length,0);
});
