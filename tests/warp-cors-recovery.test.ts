import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {indexRepository} from '../src/pipeline/index.js';
import {resolveConfig} from '../src/core/config.js';
import {AnalysisCache} from '../src/pipeline/cache.js';
import {canonicalJson} from '../src/history/fingerprint.js';
import type {SoftwareGraph} from '../src/core/graph.js';
import type {RoutingContract} from '../src/analysis/routes/contracts.js';
import {compileWarpPath,evaluateWarp,matchWarpPath,warpBranches,type WarpNode} from '../src/analysis/routes/warp-patterns.js';

const roots:string[]=[];after(async()=>{await Promise.all(roots.map(root=>rm(root,{recursive:true,force:true})));});
async function put(root:string,file:string,text:string){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),text);}
async function repo(source:string,dependency='warp={version="0.4.2",features=["server"]}'){
 const root=await mkdtemp(path.join(tmpdir(),'codiluce-warp-cors-'));roots.push(root);
 for(const [file,text]of Object.entries({'Cargo.toml':`[package]\nname="api"\nversion="1.0.0"\nedition="2021"\n[dependencies]\n${dependency}\ntokio={version="1",features=["full"]}`,'src/main.rs':source,'client.ts':'export function load(){return fetch("https://api.test/x")}'}))await put(root,file,text);
 return root;
}
async function index(root:string,cache?:AnalysisCache,revision?:string){return indexRepository(root,{config:await resolveConfig(root,{applications:[{name:'api',path:'.',apiOrigins:['https://api.test'],rust:{features:[],defaultFeatures:false}}]}),cache,revision});}
const main=(body:string)=>`#[tokio::main]async fn main(){${body}}`;
const source=(filter:string,definitions='fn handler()->&\'static str{"ok"}')=>`use warp::Filter;${definitions}${main(`let routes=${filter};warp::serve(routes).run(([127,0,0,1],8080)).await;`)}`;
const routes=(g:SoftwareGraph)=>g.entities.filter(entity=>entity.type==='api_endpoint'&&entity.metadata.framework==='warp');
const contract=(g:SoftwareGraph)=>routes(g)[0]!.metadata.routing as unknown as RoutingContract;
const program=(g:SoftwareGraph)=>contract(g).warp!.program;
const nodes=(node:WarpNode):WarpNode[]=>[node,...node.kind==='and'||node.kind==='or'?[...nodes(node.left),...nodes(node.right)]:'input'in node&&node.input?nodes(node.input):[]];
const shape=(g:SoftwareGraph)=>canonicalJson({entities:g.entities,relations:g.relations,diagnostics:g.diagnostics.filter(item=>!['git-metrics','indexer'].includes(item.analyzer)&&item.code!=='git-ignore-unavailable')});

test('Canonical CORS builders retain source policy, HTTP constants and original handlers across native Warp families',async()=>{
 for(const dependency of ['warp="0.3.7"','warp={version="0.4.2",features=["server"]}','warp={version="0.4.3",features=["server"]}']){
  const g=await index(await repo(source('warp::path!("x").and(warp::get()).map(handler).with(warp::cors().allow_any_origin().allow_header("Content-Type").allow_methods(&[warp::http::Method::GET,warp::http::Method::POST]).expose_headers(["X-Count"]).allow_credentials(true).max_age(30).build())'),dependency));
  assert.equal(routes(g).length,1);const cors=nodes(program(g)).find(node=>node.kind==='cors');assert.equal(cors?.kind,'cors');if(cors?.kind!=='cors')throw Error('missing native CORS');
  assert.deepEqual(cors.policy,{origins:'any',methods:['GET','POST'],allowedHeaders:['content-type'],exposedHeaders:['x-count'],credentials:true,maxAge:30});assert.equal(contract(g).pattern.status,'exact');
  const handles=g.relations.filter(edge=>edge.type==='handles'&&edge.from===routes(g)[0]!.id);assert.equal(handles.length,1);assert.equal(g.entities.find(entity=>entity.id===handles[0]!.to)?.name,'handler');
  assert.ok(contract(g).conditions.some(gap=>gap.includes('preflight bypass')));assert.ok(routes(g)[0]!.evidence.some(fact=>fact.explanation?.includes('one nested Either extraction')));assert.ok(!contract(g).conditions.some(gap=>gap.includes('wrapper/recovery/extraction transformation')));assert.ok(!g.relations.some(edge=>edge.type==='requests'&&edge.to===routes(g)[0]!.id));
 }
});

test('CORS preflight bypass cannot borrow inner path/handler proof; a later mapper has a partial source path',()=>{
 const inner:WarpNode={kind:'handler',id:'original',fallible:false,input:{kind:'and',left:{kind:'literal',value:'x'},right:{kind:'method',methods:['GET']}}};
 const cors:WarpNode={kind:'cors',input:inner,policy:{origins:'any',methods:['GET'],allowedHeaders:[],exposedHeaders:[],credentials:false},source:{file:'original.rs',line:9},reason:'header-dependent bypass'};
 const preflight=evaluateWarp(cors,'/elsewhere','OPTIONS');assert.ok(preflight.success.some(state=>!state.handler&&state.cursor===1));assert.ok(!preflight.success.some(state=>state.handler==='original'));
 assert.equal(evaluateWarp(cors,'/elsewhere','GET').success.length,0);assert.ok(evaluateWarp(cors,'/x','GET').success.some(state=>state.handler==='original'&&state.uncertain));assert.equal(matchWarpPath(compileWarpPath(cors,'warp-0.4'),'/elsewhere'),false);
 assert.equal(compileWarpPath(cors,'warp-0.4').status,'exact');assert.equal(compileWarpPath({kind:'handler',id:'later',fallible:false,input:cors},'warp-0.4').status,'partial');
 assert.ok(evaluateWarp({kind:'handler',id:'later',fallible:false,input:cors},'/elsewhere','OPTIONS').success.some(state=>state.handler==='later'&&state.uncertain));
});

test('Native recovery retains deferred source callback references, one Either output and original response ownership',async()=>{
 for(const dependency of ['warp="0.3.7"','warp={version="0.4.3",features=["server"]}']){
  const g=await index(await repo(source('warp::path!("x").map(handler).recover(on_error)','fn handler()->&\'static str{"ok"}\nasync fn on_error(_:warp::Rejection)->Result<&\'static str,warp::Rejection>{Ok("error")}'),dependency));
  assert.equal(routes(g).length,1);assert.equal(contract(g).pattern.status,'exact');assert.ok(!contract(g).conditions.some(gap=>gap.includes('single reviewed reply extraction')));
  const recovered=g.relations.filter(edge=>edge.from===routes(g)[0]!.id&&edge.type==='references'&&edge.metadata?.role==='recovery');assert.equal(recovered.length,1);assert.equal(recovered[0]!.metadata?.execution,'deferred-rejection-callback');assert.equal(g.entities.find(entity=>entity.id===recovered[0]!.to)?.name,'on_error');
  assert.ok(routes(g)[0]!.evidence.some(fact=>fact.explanation?.includes('resets the original path cursor')));assert.ok(!g.relations.some(edge=>edge.type==='handles'&&edge.to===recovered[0]!.to));assert.ok(!g.relations.some(edge=>edge.type==='calls'&&edge.from===routes(g)[0]!.id&&edge.to===recovered[0]!.to));assert.ok(!g.relations.some(edge=>edge.type==='requests'&&edge.to===routes(g)[0]!.id));
 }
 for(const definition of ['fn on_error(){}','fn on_error(_:warp::Rejection){}']){const g=await index(await repo(source('warp::path!("x").map(handler).recover(on_error)','fn handler()->&\'static str{"ok"}'+definition)));assert.ok(contract(g).conditions.some(gap=>gap.includes(definition.includes('()')?'one source rejection parameter':'Future contract')));}
});

test('Recovery resets rejection cursors and keeps competing successes separate from original handlers',()=>{
 const inner:WarpNode={kind:'handler',id:'original',fallible:true,input:{kind:'and',left:{kind:'literal',value:'x'},right:{kind:'literal',value:'y'}}};
 const recover:WarpNode={kind:'recover',input:inner,callback:'source_error',source:{file:'original.rs',line:12},reason:'TryFuture outcomes unknown'};
 const missed=evaluateWarp(recover,'/x/no','GET');assert.ok(missed.success.some(state=>!state.handler&&state.cursor===1));assert.ok(!missed.success.some(state=>state.handler==='original'));assert.equal(matchWarpPath(compileWarpPath(recover,'warp-0.4'),'/x/no'),false);
 const matched=evaluateWarp(recover,'/x/y','GET');assert.ok(matched.success.some(state=>state.handler==='original'));assert.ok(matched.success.some(state=>!state.handler));
 assert.equal(warpBranches(recover)?.length,1);assert.equal(warpBranches(recover)?.[0]?.handler,'original');assert.equal(compileWarpPath({kind:'handler',id:'later',fallible:false,input:recover},'warp-0.4').status,'partial');
});

test('Captured derived state keeps original type identity and source references without certifying generated Clone/Send',async()=>{
 const text=`use warp::Filter;\n#[derive(Clone)]struct Store{value:u8}\nimpl Store{fn new()->Self{Store{value:7}}}\nfn handler(_:Store)->&'static str{"ok"}\n${main('let store=Store::new();let state=warp::any().map(move||store.clone());let routes=warp::path!("x").and(state.clone()).map(handler);warp::serve(routes).run(([127,0,0,1],8080)).await;')}`;
 const g=await index(await repo(text)),state=g.relations.find(edge=>edge.from===routes(g)[0]!.id&&edge.metadata?.role==='state-type');assert.ok(state);assert.equal(g.entities.find(entity=>entity.id===state.to)?.name,'Store');assert.equal((state.metadata?.state as any).line,2);assert.equal(state.metadata?.compilation,routes(g)[0]!.metadata.compilation);
 assert.ok(routes(g)[0]!.evidence.some(fact=>fact.explanation?.includes('native Clone::clone return Self shape')));assert.ok(contract(g).conditions.some(gap=>gap.includes('state construction/field values')));assert.ok(contract(g).conditions.some(gap=>gap.includes('Clone/Send')));assert.ok(!contract(g).conditions.some(gap=>gap.includes('output type/Future/trait')));assert.ok(!g.relations.some(edge=>edge.type==='requests'&&edge.to===routes(g)[0]!.id));
 const mismatched=await index(await repo(text.replace('fn handler(_:Store)','struct Other;fn handler(_:Other)')));assert.ok(contract(mismatched).conditions.some(gap=>gap.includes('different original source state type')));
 for(const altered of [text.replace('fn new()->Self','fn clone(&self)->u8{7}fn new()->Self'),text.replace('#[derive(Clone)]','macro_rules! Clone{()=>{}}#[derive(Clone)]')]){const changed=await index(await repo(altered));assert.ok(!changed.relations.some(edge=>edge.metadata?.role==='state-type'));}
});

test('Literal source state constructors/annotations and aliases retain compilation identity; unknown state remains opaque',async()=>{
 const annotated=source('warp::path!("x").and(warp::any().map(state)).map(handler)','mod model{pub struct Store;}use model::Store as State;fn state()->State{State}fn handler(_:State)->&\'static str{"ok"}');
 const g=await index(await repo(annotated));const reference=g.relations.find(edge=>edge.metadata?.role==='state-type');assert.ok(reference);assert.equal(g.entities.find(entity=>entity.id===reference.to)?.name,'Store');assert.ok(!contract(g).conditions.some(gap=>gap.includes('different original source state type')));
 const unknown=await index(await repo(source('warp::path!("x").and(warp::any().map(move||external_state())).map(handler)','struct Store;fn handler(_:Store)->&\'static str{"ok"}')));assert.ok(!unknown.relations.some(edge=>edge.metadata?.role==='state-type'));assert.ok(contract(unknown).conditions.some(gap=>gap.includes('output type/Future/trait')));
});

test('Unknown CORS settings and moved builders retain uncertainty; standard clone preserves original settings',async()=>{
 for(const builder of ['warp::cors().allow_methods(unknown())','warp::cors().allow_header("bad header")','warp::cors().max_age(unknown())']){const g=await index(await repo(source(`warp::path!("x").map(handler).with(${builder})`)));assert.equal(routes(g).length,1);assert.ok(nodes(program(g)).some(node=>node.kind==='cors'));assert.ok(contract(g).conditions.some(gap=>gap.includes('unreviewed')));}
 const text=`use warp::Filter;fn handler()->&'static str{"ok"}${main('let cors=warp::cors().allow_methods(["GET"]);let first=warp::path!("x").map(handler).with(cors);let second=warp::path!("y").map(handler).with(cors);warp::serve(first.or(second)).run(([127,0,0,1],8080)).await;')}`;
 const moved=await index(await repo(text));assert.ok(routes(moved).some(route=>(route.metadata.constraints as string[]).some(gap=>gap.includes('CORS builder/wrapper is reused after move'))));
 const cloned=await index(await repo(text.replace('.with(cors);let second','.with(cors.clone());let second')));assert.ok(!routes(cloned).some(route=>(route.metadata.constraints as string[]).some(gap=>gap.includes('CORS builder/wrapper is reused after move'))));
 const wrong=await index(await repo(source('warp::path!("x").map(handler).with(warp::cors(1))')));assert.ok(!nodes(program(wrong)).some(node=>node.kind==='cors'));
});

test('Imported captured state uses its owning library compilation rather than the serving bin identity',async()=>{
 const root=await repo(`use warp::Filter;${main('let store=model::make();let state=warp::any().map(move||store.clone());let routes=warp::path!("x").and(state).then(model::handler);warp::serve(routes).run(([127,0,0,1],8080)).await;')}`,'warp={version="0.4.2",features=["server"]}\nmodel={path="model"}');
 await put(root,'model/Cargo.toml','[package]\nname="model"\nversion="1.0.0"\nedition="2021"');
 await put(root,'model/src/lib.rs','#[derive(Clone)]pub struct Store;pub fn make()->Store{Store}pub async fn handler(_:Store)->&\'static str{"ok"}');
 const g=await index(root),state=g.relations.find(edge=>edge.from===routes(g)[0]!.id&&edge.metadata?.role==='state-type');assert.ok(state);assert.equal(g.entities.find(entity=>entity.id===state.to)?.path,'model/src/lib.rs');assert.notEqual((state.metadata?.state as any).compilation,state.metadata?.compilation);assert.equal(state.metadata?.compilation,routes(g)[0]!.metadata.compilation);assert.ok(!contract(g).conditions.some(gap=>gap.includes('different original source state type')));
});

test('CORS/recovery/state policy changes invalidate cached source graphs and preserve exact revision replay',async()=>{
 const text=source('warp::path!("x").map(handler).with(warp::cors().allow_methods(["GET"])).recover(on_error)','fn handler()->&\'static str{"ok"}async fn on_error(_:warp::Rejection)->Result<&\'static str,warp::Rejection>{Ok("error")}');
 const root=await repo(text),state=await repo(''),cold=await index(root,new AnalysisCache(state)),cache=new AnalysisCache(state),warm=await index(root,cache);assert.equal(shape(cold),shape(warm));assert.equal(shape(cold),shape(await index(root,undefined,'recorded')));assert.ok(cache.events.some(event=>event.analyzer==='rust-routers'&&event.hit));
 await put(root,'src/main.rs',text.replace('["GET"]','["POST"]'));const changedCache=new AnalysisCache(state),changed=await index(root,changedCache);assert.notEqual(shape(cold),shape(changed));assert.equal(shape(changed),shape(await index(root,undefined,'edited')));assert.ok(changedCache.events.some(event=>event.analyzer==='rust-routers'&&!event.hit));
});

test('Multiline CORS/recovery coordinates identify original method tokens independently of the receiver range',async()=>{
 const text=source('warp::path!("x")\n.map(handler)\n.with(warp::cors().allow_methods(["GET"]))\n.recover(on_error)','fn handler()->&\'static str{"ok"}async fn on_error(_:warp::Rejection)->Result<&\'static str,warp::Rejection>{Ok("error")}');
 const g=await index(await repo(text)),cors=nodes(program(g)).find(node=>node.kind==='cors'),recover=nodes(program(g)).find(node=>node.kind==='recover');assert.equal(cors?.kind,'cors');assert.equal(recover?.kind,'recover');
 if(cors?.kind!=='cors'||recover?.kind!=='recover')throw Error('missing reviewed source operators');assert.equal(cors.source.line,3);assert.equal(recover.source.line,4);
 const reference=g.relations.find(edge=>edge.metadata?.role==='recovery');assert.equal((reference?.metadata?.source as any).line,4);assert.ok(routes(g)[0]!.evidence.some(fact=>fact.line===4&&fact.explanation?.includes('resets the original path cursor')));
});

test('Unify requires equal reviewed output identities and cannot equate unrelated opaque callback returns',async()=>{
 const g=await index(await repo(source('warp::path!("x").map(first).or(warp::path!("y").map(second)).unify()','fn first()->impl warp::Reply{external_one()}fn second()->impl warp::Reply{external_two()}')));assert.ok(contract(g).conditions.some(gap=>gap.includes('reviewed equal extraction types')));
 const same=await index(await repo(source('warp::path!("x").map(handler).or(warp::path!("y").map(handler)).unify()')));assert.ok(!contract(same).conditions.some(gap=>gap.includes('reviewed equal extraction types')));
});
