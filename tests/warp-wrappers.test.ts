import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {indexRepository} from '../src/pipeline/index.js';
import {resolveConfig} from '../src/core/config.js';
import {AnalysisCache} from '../src/pipeline/cache.js';
import {canonicalJson} from '../src/history/fingerprint.js';
import type {SoftwareGraph} from '../src/core/graph.js';

const roots:string[]=[];
after(async()=>{await Promise.all(roots.map(root=>rm(root,{recursive:true,force:true})));});
async function put(root:string,file:string,text:string){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),text);}
const registry='registry+https://github.com/rust-lang/crates.io-index';
const entry=(name:string,version:string,dependencies:string[]=[],source?:string)=>`[[package]]\nname="${name}"\nversion="${version}"\n${source?`source="${source}"\n`:''}dependencies=${JSON.stringify(dependencies)}\n`;
const lock=(provider='0.1.31',runtime='0.1.44')=>'version=4\n'+entry('api','1.0.0',['tracing'])+entry('tracing',runtime,['tracing-attributes'],registry)+entry('tracing-attributes',provider,[],registry);
const main=(body:string)=>`#[tokio::main]async fn main(){${body}}`;
const source=(attribute='#[tracing::instrument]',filter='warp::path!("x").and(warp::get()).map(handler)',delegation='start().await;')=>`use warp::Filter;fn handler()->&'static str{"ok"}${attribute}async fn start(){let route=${filter};warp::serve(route).run(([0,0,0,0,0,0,0,1],8080)).await;}${main(delegation)}`;
async function repo(text=source(),files:Record<string,string>={},warp='warp={version="0.4.2",features=["server"]}'){
 const root=await mkdtemp(path.join(tmpdir(),'codiluce-warp-wrappers-'));roots.push(root);
 for(const [file,contents] of Object.entries({'Cargo.toml':`[package]\nname="api"\nversion="1.0.0"\nedition="2021"\n[features]\ntrace=[]\n[dependencies]\n${warp}\ntokio={version="1",features=["full"]}\ntracing="0.1"`,'Cargo.lock':lock(),'src/main.rs':text,'client.ts':'export function load(){return fetch("https://api.test/x")}',...files}))await put(root,file,contents);
 return root;
}
async function index(root:string,cache?:AnalysisCache,revision?:string,features:string[]=[],ignore?:string[]){return indexRepository(root,{config:await resolveConfig(root,{applications:[{name:'api',path:'.',apiOrigins:['https://api.test'],rust:{features,defaultFeatures:false}}],...ignore?{ignore}:{} }),cache,revision});}
const routes=(g:SoftwareGraph)=>g.entities.filter(entity=>entity.type==='api_endpoint'&&entity.metadata.framework==='warp');
const gaps=(g:SoftwareGraph)=>routes(g)[0]?.metadata.constraints as string[]|undefined;
const shape=(g:SoftwareGraph)=>canonicalJson({entities:g.entities,relations:g.relations,diagnostics:g.diagnostics.filter(item=>!['git-metrics','indexer'].includes(item.analyzer)&&item.code!=='git-ignore-unavailable')});

test('Recorded native tracing wrappers project awaited parameter-free source helpers while general calls remain opaque',async()=>{
 for(const warp of ['warp="0.3.7"','warp={version="0.4.2",features=["server"]}']){
  const g=await index(await repo(source(),{},warp));assert.equal(routes(g).length,1,JSON.stringify(g.diagnostics));
  assert.ok(gaps(g)?.some(gap=>gap.includes('Generated tracing instrument')));assert.ok(routes(g)[0]!.evidence.some(fact=>fact.file==='Cargo.lock'&&fact.explanation?.includes('tracing-attributes 0.1.31')));
  assert.ok(routes(g)[0]!.evidence.some(fact=>fact.file==='src/main.rs'&&fact.explanation?.includes('instrument on start')));
  const callback=g.entities.find(entity=>g.relations.some(edge=>edge.type==='handles'&&edge.from===routes(g)[0]!.id&&edge.to===entity.id));assert.equal(callback?.name,'handler');
  const calls=(g.entities.find(entity=>entity.type==='file'&&entity.path==='src/main.rs')!.metadata.rustCallOutcomes??[]) as any[];
  assert.ok(calls.some(call=>call.name==='start'&&call.status!=='resolved'));assert.ok(!g.entities.some(entity=>entity.name.startsWith('__tracing_attr')));assert.ok(!g.relations.some(edge=>edge.type==='requests'&&edge.to===routes(g)[0]!.id));
  assert.equal(routes(await index(await repo(source(undefined,undefined,'let future=start();'),{},warp))).length,0);
 }
});

test('Instrument aliases and selected cfg retain original sites; missing, old, stale and denied providers cannot lend proof',async()=>{
 const aliased=await index(await repo(source('#[measured]').replace('use warp::Filter;','use warp::Filter;use tracing::instrument as measured;')));assert.equal(routes(aliased).length,1);
 const cfg=await repo(source('#[cfg_attr(feature="trace",tracing::instrument)]'));assert.equal(routes(await index(cfg,undefined,undefined,['trace'])).length,1);assert.ok(gaps(await index(cfg,undefined,undefined,['trace']))?.some(gap=>gap.includes('Generated tracing instrument')));assert.equal(routes(await index(cfg))[0]?.metadata.constraintsUnresolved,undefined);
 for(const recorded of ['',lock('0.1.30'),lock('0.1.31','0.1.43'),lock().replace('dependencies=["tracing-attributes"]','dependencies=[]'),lock().replace('name="api"','name="other"'),lock().replaceAll(registry,'git+https://example.test/fork#abc')])assert.equal(routes(await index(await repo(source(),{'Cargo.lock':recorded}))).length,0);
 assert.equal(routes(await index(await repo(),undefined,undefined,[],['Cargo.lock'])).length,0);
});

test('Fields, parameters, const functions, duplicate/composed attributes and renamed-only runtimes stay outside instrumentation projection',async()=>{
 for(const text of [source('#[tracing::instrument(fields(value=setup()))]'),source('#[tracing::instrument]\n#[tracing::instrument]'),source('#[tracing::instrument]\n#[unknown]'),source().replace('async fn start()','async fn start(value:u8)').replace('start().await','start(1).await'),source().replace('async fn start()','const fn start()')])assert.equal(routes(await index(await repo(text))).length,0);
 const renamed=await repo(source().replace('tracing::instrument','trace::instrument'));await put(renamed,'Cargo.toml','[package]\nname="api"\nversion="1.0.0"\nedition="2021"\n[dependencies]\nwarp={version="0.4.2",features=["server"]}\ntokio={version="1",features=["full"]}\ntrace={package="tracing",version="0.1"}');assert.equal(routes(await index(renamed)).length,0);
});

test('Default native log/trace wrappers retain original handler ownership, one wrapped reply and uncertainty across both Warp families',async()=>{
 for(const warp of ['warp="0.3.7"','warp={version="0.4.2",features=["server"]}']){
  const g=await index(await repo(source('', 'warp::path!("x").and(warp::get()).map(handler).with(warp::log("request")).with(warp::trace::request())'),{},warp));assert.equal(routes(g).length,1);assert.ok(gaps(g)?.some(gap=>gap.includes('subscriber effects')));assert.ok(!gaps(g)?.some(gap=>gap.includes('Filter with wrapper')||gap.includes('single reviewed reply extraction')));
  assert.equal(g.relations.filter(edge=>edge.type==='handles'&&edge.from===routes(g)[0]!.id).length,1);assert.ok(routes(g)[0]!.evidence.some(fact=>fact.explanation?.includes('input Error is retained')));assert.ok(!g.relations.some(edge=>edge.type==='requests'&&edge.to===routes(g)[0]!.id));
 }
 for(const wrapper of ['warp::log::custom(handler)','warp::trace::trace(handler)','unknown()','warp::log()']){const g=await index(await repo(source('',`warp::path!("x").map(handler).with(${wrapper})`)));assert.ok(gaps(g)?.some(gap=>gap.includes('wrapper/recovery')));}
});

test('Literal include_str provides namespace proof without reading included contents; shadows and nested tokens remain opaque',async()=>{
 const text='use warp::Filter;fn build()->impl warp::Filter{let body=include_str!("missing.html");warp::path!("x").map(move||body).boxed()}'+main('warp::serve(build()).run(([127,0,0,1],8080)).await;');
 for(const native of ['include_str!','std::include_str!']){const g=await index(await repo(text.replace('include_str!',native)));assert.equal(routes(g).length,1);assert.ok(routes(g)[0]!.evidence.some(fact=>fact.explanation?.includes('no included file is read')));assert.ok(gaps(g)?.some(gap=>gap.includes('captured values')));}
 for(const changed of [text.replace('"missing.html"','concat!("missing",".html")'),text.replace('fn build()','macro_rules! include_str{($x:expr)=>{create!()}}fn build()')]){const g=await index(await repo(changed));assert.ok(!routes(g).some(route=>route.evidence.some(fact=>fact.explanation?.includes('no included file is read'))));}
});

test('Instrument provider/source edits invalidate router replay without changing original declaration identities',async()=>{
 const text=source(undefined,'warp::path!("x").map(handler).with(warp::log("request"))'),root=await repo(text),state=await repo(''),cold=await index(root,new AnalysisCache(state)),cache=new AnalysisCache(state),warm=await index(root,cache);
 assert.equal(shape(cold),shape(warm));assert.equal(shape(cold),shape(await index(root,undefined,'recorded')));assert.ok(cache.events.some(event=>event.analyzer==='rust-routers'&&event.hit));
 await put(root,'Cargo.lock',lock('0.1.30'));const editedCache=new AnalysisCache(state),changed=await index(root,editedCache);
 assert.deepEqual(cold.entities.filter(entity=>entity.language==='rust'&&entity.metadata.declarationKind).map(entity=>entity.id),changed.entities.filter(entity=>entity.language==='rust'&&entity.metadata.declarationKind).map(entity=>entity.id));assert.equal(routes(changed).length,0);assert.ok(editedCache.events.some(event=>event.analyzer==='rust-routers'&&!event.hit));assert.equal(shape(changed),shape(await index(root,undefined,'edited')));
});

test('Recorded Tokio test functions are excluded only from non-test builds and retain provider/source proof',async()=>{
 const nativeLock=lock().replace('dependencies=["tracing"]','dependencies=["tracing","tokio"]')+entry('tokio','1.53.1',['tokio-macros'],registry)+entry('tokio-macros','2.7.0',[],registry);
 const text=source()+`#[tokio::test]async fn check(){panic!("never executed");warp::serve(warp::path!("from-test").map(handler)).run(([127,0,0,1],8081)).await;}`;
 const root=await repo(text,{'Cargo.lock':nativeLock}),g=await index(root);
 assert.equal(routes(g).length,1);assert.ok(routes(g)[0]!.evidence.some(fact=>fact.explanation?.includes('test on check')&&fact.explanation.includes('recorded test=false')));assert.ok(routes(g)[0]!.evidence.some(fact=>fact.file==='Cargo.lock'&&fact.explanation?.includes('tokio-macros 2.7.0')));
 for(const recorded of [nativeLock.replace('version="2.7.0"','version="2.6.1"'),nativeLock.replace('dependencies=["tokio-macros"]','dependencies=[]')])assert.equal(routes(await index(await repo(text,{'Cargo.lock':recorded}))).length,0);
 await put(root,'Cargo.toml',(await readFile(path.join(root,'Cargo.toml'),'utf8'))+'\n[[test]]\nname="recorded"\npath="src/main.rs"');
 const testConfig=await resolveConfig(root,{applications:[{name:'api',path:'.',rust:{features:[],defaultFeatures:false,target:{kind:'test',name:'recorded'}}}]});const inTest=await indexRepository(root,{config:testConfig});assert.ok(!routes(inTest).some(route=>route.metadata.routePath==='/from-test'));assert.ok(!routes(inTest).some(route=>route.evidence.some(fact=>fact.explanation?.includes('recorded test=false'))));
 const repeated=source()+'#[tracing::instrument]const fn bad(){panic!("invalid instrument input")}';assert.equal(routes(await index(await repo(repeated))).length,0,'identical attribute text on another function cannot borrow the first source position');
});
