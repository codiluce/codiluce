import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { indexRepository } from '../src/pipeline/index.js';
import { resolveConfig } from '../src/core/config.js';
import { AnalysisCache } from '../src/pipeline/cache.js';
import { canonicalJson } from '../src/history/fingerprint.js';
import { evaluateWarp, warpBranches, type WarpNode } from '../src/analysis/routes/warp-patterns.js';
import type { SoftwareGraph } from '../src/core/graph.js';

const roots:string[]=[];
after(async()=>{await Promise.all(roots.map(root=>rm(root,{recursive:true,force:true})));});
async function put(root:string,file:string,text:string){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),text);}
async function repo(source:string,dependency='warp={version="0.4.2",features=["server"]}'){
    const root=await mkdtemp(path.join(tmpdir(),'codiluce-warp-state-'));roots.push(root);
    for(const [file,text] of Object.entries({'Cargo.toml':`[package]\nname="api"\nversion="1.0.0"\nedition="2021"\n[dependencies]\n${dependency}\ntokio={version="1",features=["full"]}`,'src/main.rs':source,'client.ts':'export function load(){return fetch("https://api.test/x")}'}))await put(root,file,text);
    return root;
}
async function index(root:string,cache?:AnalysisCache,revision?:string){return indexRepository(root,{config:await resolveConfig(root,{applications:[{name:'api',path:'.',apiOrigins:['https://api.test'],rust:{features:[],defaultFeatures:false}}]}),cache,revision});}
const main=(body:string)=>`#[tokio::main]async fn main(){${body}}`;
const serve=(filter:string,definitions='fn state()->u8{7}fn handler(_:u8)->&\'static str{"ok"}',address='[127,0,0,1]')=>`use warp::Filter;${definitions}${main(`let route=${filter};warp::serve(route).run((${address},8080)).await;`)}`;
const endpoints=(g:SoftwareGraph)=>g.entities.filter(entity=>entity.type==='api_endpoint'&&entity.metadata.framework==='warp');
const route=(g:SoftwareGraph)=>endpoints(g).find(entity=>typeof entity.metadata.routePath==='string'&&entity.metadata.routePath.startsWith('/x'))!;
const callback=(g:SoftwareGraph)=>g.entities.find(entity=>g.relations.some(edge=>edge.type==='handles'&&edge.from===route(g).id&&edge.to===entity.id));
const conditions=(g:SoftwareGraph)=>route(g).metadata.constraints as string[]|undefined;
const shape=(g:SoftwareGraph)=>canonicalJson({entities:g.entities,relations:g.relations,diagnostics:g.diagnostics.filter(d=>!['git-metrics','indexer'].includes(d.analyzer)&&d.code!=='git-ignore-unavailable')});

test('Native map extraction pipelines keep only the final response callback and preserve original extraction references',async()=>{
    for(const dependency of ['warp="0.3.7"','warp={version="0.4.2",features=["server"]}']){
        const g=await index(await repo(serve('warp::path!("x").and(warp::get()).and(warp::any().map(state)).map(handler)'),dependency));
        assert.equal(endpoints(g).length,1);assert.equal(callback(g)?.name,'handler');assert.equal(route(g).metadata.constraintsUnresolved,undefined,JSON.stringify(conditions(g)));
        const state=g.entities.find(entity=>entity.name==='state'&&entity.path==='src/main.rs')!;
        const edge=g.relations.find(edge=>edge.type==='references'&&edge.from===route(g).id&&edge.to===state.id)!;
        assert.equal(edge.metadata?.role,'extraction');assert.equal(edge.metadata?.execution,'deferred-filter-callback');assert.ok(edge.evidence.some(fact=>fact.file==='src/main.rs'&&fact.line===1&&fact.explanation?.includes('deferred single extraction')));
        assert.ok(g.relations.some(edge=>edge.type==='requests'&&edge.to===route(g).id));assert.ok(!g.relations.some(edge=>edge.type==='calls'&&edge.from===route(g).id&&edge.to===state.id));
    }
});

test('Mapped output/arity mismatch and a mapped Future cannot become qualified Reply handlers',async()=>{
    for(const definition of ['fn state()->u8{7}fn handler(_:String)->&\'static str{"ok"}','fn state()->u8{7}fn handler()->&\'static str{"ok"}']){
        const g=await index(await repo(serve('warp::path!("x").and(warp::any().map(state)).map(handler)',definition)));assert.ok(route(g).metadata.constraintsUnresolved);assert.ok(!g.relations.some(edge=>edge.type==='requests'&&edge.to===route(g).id));
    }
    for(const definitions of ['fn handler()->u8{7}','async fn handler()->&\'static str{"ok"}']){
        const g=await index(await repo(serve('warp::path!("x").map(handler)',definitions)));assert.ok(conditions(g)?.some(gap=>gap.includes('native Reply')));assert.ok(!g.relations.some(edge=>edge.type==='requests'&&edge.to===route(g).id));
    }
    const future=await index(await repo(serve('warp::path!("x").map(state).then(|_|async{"ok"})','async fn state()->u8{7}')));
    assert.equal(endpoints(future).length,1);assert.ok(conditions(future)?.some(gap=>gap.includes('output type/Future/trait')));assert.ok(!conditions(future)?.some(gap=>gap.includes('unawaited source Future rather than')),'a future consumed by a later mapper is an extraction, not a final Reply');
});

test('Canonical query/json/form filters preserve one ordered slot without certifying Deserialize or request predicates',async()=>{
    for(const extractor of ['warp::query::<String>()','warp::query()','warp::body::json::<String>()','warp::body::form::<String>()']){
        const g=await index(await repo(serve(`warp::path("x").and(${extractor}).and(warp::path::param()).and(warp::path::end()).map(handler)`,'fn handler(_:String,id:u8)->&\'static str{"ok"}')));
        assert.equal(endpoints(g).length,1);assert.ok(!conditions(g)?.some(gap=>gap.includes('extraction arity')));assert.ok(!conditions(g)?.some(gap=>gap.includes('Explicit generic Rust web operands')));
        assert.ok(conditions(g)?.some(gap=>gap.includes('deserialization/predicate')));assert.ok(route(g).evidence.some(fact=>fact.explanation?.includes('exactly one ordered extraction')));
        const routing=route(g).metadata.routing as any;assert.equal(routing.pattern.alternatives[0][1].parts[0].constraint,'u8','the preceding deserializer occupies its own callback slot');
    }
    for(const source of ['warp::query::<u8,u16>()','warp::body::json::<u8,u16>()']){
        const g=await index(await repo(serve(`warp::path!("x").and(${source}).map(handler)`,'fn handler(_:u8)->&\'static str{"ok"}')));assert.ok(conditions(g)?.some(gap=>gap.includes('extraction arity')));
    }
});

test('Unknown state/captures, mutable captures and boxed filters retain Clone/Send and type uncertainty',async()=>{
    const source=`use warp::Filter;struct Store;impl Store{fn new()->Self{Store}fn clone(&self)->Self{Store}}fn handler(_:Store)->&'static str{"ok"}${main('let store=Store::new();let state=warp::any().map(move||store.clone());let route=warp::path!("x").and(state.clone()).map(handler);warp::serve(route).run(([127,0,0,1],8080)).await;')}`;
    const g=await index(await repo(source));assert.equal(callback(g)?.name,'handler');assert.ok(conditions(g)?.some(gap=>gap.includes('Clone')));assert.ok(conditions(g)?.some(gap=>gap.includes('output type/Future/trait')));assert.ok(!conditions(g)?.some(gap=>gap.includes('Multiple Warp mapper stages')));assert.ok(!conditions(g)?.some(gap=>gap.includes('extraction arity')));
    const mutable=await index(await repo(serve('warp::path!("x").map(move||{value+=1;"ok"})','').replace('let route=','let mut value=1;let route=')));assert.ok(conditions(mutable)?.some(gap=>gap.includes('captured values')));
    for(const [binding,mapper] of [['let value=1;','||{let _=value;"ok"}'],['let parent=1;let value=&parent;','move||{let _=value;"ok"}']]){
        const borrow=await index(await repo(serve(`warp::path!("x").map(${mapper})`,'').replace('let route=',binding+'let route=')));assert.ok(conditions(borrow)?.some(gap=>gap.includes('captured values')));
    }
    const boxed=await index(await repo(serve('warp::path!("x").and(warp::any().map(state).boxed().clone()).map(handler)')));assert.equal(route(boxed).metadata.constraintsUnresolved,undefined);assert.ok(route(boxed).evidence.some(fact=>fact.explanation?.includes('Arc-backed Clone')));
    const moved=await index(await repo(serve('warp::path!("x").map(move||{let _=value;"ok"})','').replace('let route=','let value=7u8;let route=')));assert.equal(route(moved).metadata.constraintsUnresolved,undefined,'moved scalar literal captures supply closed native bounds');
    const competitor=await index(await repo(serve('warp::path!("x").and(warp::any().map(state).clone()).map(handler)').replace('use warp::Filter;','use warp::Filter;trait OtherClone{fn clone(&self); }')));assert.ok(conditions(competitor)?.some(gap=>gap.includes('source trait competitor')));
});

test('Fallible mapped extractions preserve rejection, cursor and later-competitor semantics without assigning a handler',()=>{
    const first:WarpNode={kind:'handler',id:'response',fallible:false,input:{kind:'transform',callback:'source-state',fallible:true,input:{kind:'literal',value:'x'}}};
    const program:WarpNode={kind:'or',left:first,right:{kind:'handler',id:'fallback',fallible:false,input:{kind:'literal',value:'x'}}};
    assert.deepEqual(evaluateWarp(program,'/x','GET').success.map(state=>state.handler),['response','fallback']);
    const branches=warpBranches(program)!;assert.deepEqual(branches.map(branch=>branch.handler),['response','fallback']);assert.ok(branches[0]!.conditions.some(gap=>gap.includes('fallible mapped extraction')));
    assert.ok(!branches.some(branch=>branch.handler==='source-state'));
});

test('Literal native IPv6 serving follows awaited source helpers and rejects address bounds or unawaited delegates',async()=>{
    const routeSource='use warp::Filter;fn handler()->&\'static str{"ok"}async fn start(){warp::serve(warp::path!("x").map(handler)).run(([0,0,0,0,0,0,0,65535],65535)).await;}';
    for(const dependency of ['warp="0.3.7"','warp={version="0.4.2",features=["server"]}']){
        const g=await index(await repo(routeSource+main('start().await;'),dependency));assert.equal(route(g).metadata.constraintsUnresolved,undefined);assert.ok(route(g).evidence.some(fact=>fact.explanation?.includes('helper/factory invocation')));
        assert.equal(endpoints(await index(await repo(routeSource+main('let future=start();'),dependency))).length,0);
    }
    for(const address of ['[0,0,0,0,0,0,0,65536]','[0,0,0,0,0,0,0]','[127,0,0,256]','[0,0,0,0,0,0,0,-1]']){
        const g=await index(await repo(serve('warp::path!("x").map(handler)','fn handler()->&\'static str{"ok"}',address)));assert.ok(conditions(g)?.some(gap=>gap.includes('SocketAddr')));
    }
});

test('Mapped extraction replay and source edits retain original declaration IDs and invalidate router contracts',async()=>{
    const source=serve('warp::path!("x").and(warp::any().map(state)).map(handler)'),root=await repo(source),state=await repo(''),cold=await index(root,new AnalysisCache(state)),warmCache=new AnalysisCache(state),warm=await index(root,warmCache);
    assert.equal(shape(cold),shape(warm));assert.equal(shape(cold),shape(await index(root,undefined,'recorded')));assert.ok(warmCache.events.some(event=>event.analyzer==='rust-routers'&&event.hit));
    const declarationIds=(g:SoftwareGraph)=>g.entities.filter(entity=>entity.language==='rust'&&entity.metadata.declarationKind&&entity.name!=='state').map(entity=>entity.id);
    await put(root,'src/main.rs',source.replace('fn state()->u8{7}','fn state()->String{String::new()}'));const changedCache=new AnalysisCache(state),changed=await index(root,changedCache);
    assert.deepEqual(declarationIds(cold),declarationIds(changed));assert.ok(conditions(changed)?.some(gap=>gap.includes('incompatible')));assert.ok(changedCache.events.some(event=>event.analyzer==='rust-routers'&&!event.hit));assert.equal(shape(changed),shape(await index(root,undefined,'changed')));
});
