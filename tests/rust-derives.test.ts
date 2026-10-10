import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { indexRepository } from '../src/pipeline/index.js';
import { resolveConfig } from '../src/core/config.js';
import { AnalysisCache } from '../src/pipeline/cache.js';
import { canonicalJson } from '../src/history/fingerprint.js';
import type { SoftwareGraph } from '../src/core/graph.js';

const roots: string[] = [];
after(async () => { await Promise.all(roots.map(root => rm(root,{recursive:true,force:true}))); });
async function put(root:string,file:string,text:string) { await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),text); }
const cargo = (dependencies='serde={version="1",features=["derive"]}') => `[package]\nname="api"\nversion="1.0.0"\nedition="2021"\n[dependencies]\n${dependencies}`;
const registry='registry+https://github.com/rust-lang/crates.io-index';
const entry=(name:string,version:string,dependencies:string[]=[],source?:string)=>`[[package]]\nname="${name}"\nversion="${version}"\n${source?`source="${source}"\n`:''}dependencies=${JSON.stringify(dependencies)}\n`;
const lock=(version='1.0.228')=>'version=4\n'+entry('api','1.0.0',['serde'])+entry('serde',version,['serde_derive'],registry)+entry('serde_derive',version,[],registry);
const source='use serde::{Deserialize,Serialize};\n#[derive(Deserialize,Serialize,Debug,Clone)]\npub struct Data{pub name:String}\npub fn handler(){}';
async function repo(files:Record<string,string>={}) { const root=await mkdtemp(path.join(tmpdir(),'codiluce-rust-derive-'));roots.push(root);for(const [file,text] of Object.entries({'Cargo.toml':cargo(),'Cargo.lock':lock(),'src/lib.rs':'mod models;use crate::models::{handler,Data};','src/models.rs':source,...files}))await put(root,file,text);return root; }
async function index(root:string,cache?:AnalysisCache,revision?:string,ignore?:string[]) { return indexRepository(root,{config:await resolveConfig(root,{repository:{name:'derive'},applications:[{name:'api',path:'.',rust:{features:[],defaultFeatures:false},apiOrigins:['https://api.test']}],ignore}),cache,revision}); }
const outcomes=(g:SoftwareGraph,file='src/lib.rs')=>(g.entities.find(entity=>entity.type==='file'&&entity.path===file)!.metadata.importOutcomes??[]) as any[];
const selected=(g:SoftwareGraph,name:string)=>outcomes(g).find(item=>item.specifier.endsWith(name))!.outcome;
const shape=(g:SoftwareGraph)=>canonicalJson({entities:g.entities,relations:g.relations,diagnostics:g.diagnostics.filter(d=>!['git-metrics','indexer'].includes(d.analyzer)&&d.code!=='git-ignore-unavailable')});

test('Recorded modern Serde providers preserve original module/handler imports without certifying derived traits',async()=>{
    for(const version of ['1.0.169','1.0.203','1.0.219','1.0.228']){
        const g=await index(await repo({'Cargo.lock':lock(version)}));
        assert.equal(selected(g,'models').status,'resolved');assert.equal(selected(g,'handler').status,'resolved');assert.equal(selected(g,'Data').status,'unsupported');
        const edge=g.relations.find(edge=>edge.type==='imports'&&edge.metadata?.adapter==='rust'&&(edge.metadata.declarations as string[]|undefined)?.some(id=>g.entities.find(entity=>entity.id===id)?.name==='handler'))!;
        assert.ok(edge.evidence.some(fact=>fact.file==='Cargo.lock'&&fact.explanation?.includes('serde_derive '+version)));
        assert.ok(edge.evidence.some(fact=>fact.file==='src/models.rs'&&fact.line===2&&fact.explanation?.includes('serde::Deserialize derive')));
        assert.ok(!g.entities.some(entity=>entity.name.startsWith('_IMPL_')));
    }
});

test('Missing, old, unrelated, ambiguous, stale and noncanonical provider locks cannot lend namespace proof',async()=>{
    const cases=[
        '',lock('1.0.152'),lock('1.0.156'),lock('1.0.170'),lock().replace('version=4','version=2'),lock().replace('version=4','version="4"'),lock().replace('version=4','version=[4]'),
        lock().replace('dependencies=["serde_derive"]','dependencies=[]'),
        lock().replace('dependencies=["serde"]','dependencies=[]'),
        lock().replace('dependencies=["serde"]','source=""\ndependencies=["serde"]'),
        lock().replace('dependencies=["serde"]','dependencies=["serde","serde invalid"]'),
        lock()+entry('serde_derive','1.0.203',[],registry),
        lock().replace('name="api"','name="unrelated"'),
        lock().replace('version="1.0.0"','version="9.0.0"'),
        lock().replaceAll(registry,'git+https://example.test/fork#abc'),
        lock()+entry('serde_derive','1.0.228',[],registry),
        lock().replace('name="serde_derive"\nversion="1.0.228"','name="serde_derive"\nversion="1.0.219"'),
        `version=4\npackage=[{name="api",version="1.0.0",dependencies=["serde"]},{name="serde",version="1.0.228",source="${registry}",dependencies=["serde_derive"]},{name="serde_derive",version="1.0.228",source="${registry}"}]\nnote="""\n[[package]]\n[[package]]\n[[package]]\n"""`,
    ];
    for(const recorded of cases){const g=await index(await repo({'Cargo.lock':recorded}));assert.equal(selected(g,'handler').status,'unsupported',recorded);assert.ok(!selected(g,'handler').declarations);}
    const stale=await index(await repo({'Cargo.toml':cargo('serde={version="=1.0.219",features=["derive"]}')}));assert.equal(selected(stale,'handler').status,'unsupported');
    const scoped=lock().replace('dependencies=["serde_derive"]','dependencies=["serde_derive 1.0.228"]')+entry('serde_derive','1.0.152',[],registry);
    assert.equal(selected(await index(await repo({'Cargo.lock':scoped})),'handler').status,'resolved','exact owning dependency selector tolerates unrelated old provider');
});

test('Canonical macro aliases and explicit Serde delegation keep the original type opaque even with a builtin alias',async()=>{
    const alias='use serde::Deserialize as Clone;\n#[derive(Clone)]\npub struct Data;pub fn handler(){}';
    const g=await index(await repo({'src/models.rs':alias}));assert.equal(selected(g,'handler').status,'resolved');assert.equal(selected(g,'Data').status,'unsupported');assert.ok(selected(g,'Data').conditions.some((gap:string)=>gap.includes('traits/conversions')));
    const deps='ser={package="serde",version="1"}\nsd={package="serde_derive",version="1"}', recorded='version=4\n'+entry('api','1.0.0',['serde','serde_derive'])+entry('serde','1.0.228',[],registry)+entry('serde_derive','1.0.228',[],registry);
    const direct='#[derive(sd::Deserialize)]\n#[serde(crate="ser")]\npub struct Data;pub fn handler(){}';
    assert.equal(selected(await index(await repo({'Cargo.toml':cargo(deps),'Cargo.lock':recorded,'src/models.rs':direct})),'handler').status,'resolved');
    for(const altered of [direct.replace('crate="ser"','crate="missing"'),direct.replace('crate="ser"','crate="ser",crate="ser"'),direct.replace('crate="ser"','crate="ser::Other"'),direct.replace('crate="ser"','crate="serde_core"')])assert.equal(selected(await index(await repo({'Cargo.toml':cargo(deps),'Cargo.lock':recorded,'src/models.rs':altered})),'handler').status,'unsupported');
    assert.equal(selected(await index(await repo({'Cargo.toml':cargo(deps),'Cargo.lock':recorded,'src/models.rs':direct.replace('#[serde(crate="ser")]','')})),'handler').status,'unsupported','renamed-only Serde cannot supply default extern crate delegate');
});

test('Builtin derive spellings require native macro identity and retained custom attributes stay opaque',async()=>{
    for(const attrs of ['#[derive(Debug,Clone)]','#[derive(std::fmt::Debug,core::clone::Clone)]','use std::fmt::Debug as D;#[derive(D)]','fn Debug(){}#[derive(Debug)]','#![no_std]\n#[derive(Clone)]']){
        assert.equal(selected(await index(await repo({'Cargo.toml':cargo(''),'src/models.rs':attrs+'pub struct Data;pub fn handler(){}'})),'handler').status,'resolved');
    }
    for(const attrs of ['use unknown::Debug;#[derive(Debug)]','#![no_implicit_prelude]\n#[derive(Debug)]','macro_rules! Debug{()=>{}}#[derive(Debug)]','#[derive(Debug,custom::Generate)]','#[custom::generate]#[derive(Debug)]','use unknown::*;#[derive(Debug)]','#[derive(Debug)]pub struct Other{field:custom!()};',`#[derive(${Array(33).fill('Clone').join(',')})]`]){
        assert.equal(selected(await index(await repo({'Cargo.toml':cargo('unknown="1"'),'src/models.rs':attrs+'pub struct Data;pub fn handler(){}'})),'handler').status,'unsupported',attrs);
    }
    for(const extra of ['#[serde(crate="::serde",crate="::serde")]','#[serde(bound="T: custom!(Opaque)")]','#[custom::generate]']){
        assert.equal(selected(await index(await repo({'src/models.rs':source.replace('#[derive',extra+'\n#[derive')})),'handler').status,'unsupported',extra);
    }
    assert.equal(selected(await index(await repo({'Cargo.toml':cargo('serde="1"')})),'handler').status,'unsupported','Serde re-export needs recorded derive feature');
});

test('Conditional derives, provider forks, disabled preludes and nested items retain native identity boundaries',async()=>{
    const root=await repo({'src/models.rs':source.replace('#[derive(Deserialize,Serialize,Debug,Clone)]','#[cfg_attr(feature="derive",derive(Deserialize,Serialize,Debug,Clone))]'),'Cargo.toml':cargo()+'\n[features]\nderive=[]'});
    const config=await resolveConfig(root,{applications:[{name:'api',path:'.',rust:{features:['derive'],defaultFeatures:false}}]}),g=await indexRepository(root,{config});
    assert.equal(selected(g,'handler').status,'resolved');assert.ok(g.relations.some(edge=>edge.type==='imports'&&edge.evidence.some(fact=>fact.file==='src/models.rs'&&fact.line===2&&fact.explanation?.includes('serde::Deserialize derive'))));
    await put(root,'src/models.rs',source.replace('#[derive(Deserialize,Serialize,Debug,Clone)]','#[cfg_attr(unix,derive(Deserialize))]'));assert.equal(selected(await index(root),'handler').status,'unsupported','unknown cfg cannot choose derive identity');
    for(const dep of ['serde={version="1",git="https://example.test/fork",features=["derive"]}','serde={version="1",path="local",features=["derive"]}','serde={version="1",registry="private",features=["derive"]}']){
        assert.equal(selected(await index(await repo({'Cargo.toml':cargo(dep),'local/Cargo.toml':cargo().replace('name="api"','name="serde"'),'local/src/lib.rs':'pub struct Deserialize;'})),'handler').status,'unsupported');
    }
    const shadow=await index(await repo({'Cargo.toml':cargo('std="1"'),'src/models.rs':'#[derive(Debug)]pub struct Data;pub fn handler(){}'}));assert.equal(selected(shadow,'handler').status,'unsupported','dependency called std cannot borrow the standard library identity');
    const nested=await index(await repo({'src/models.rs':'pub fn handler(){use unknown::Debug;#[derive(Debug)]struct Nested;}pub struct Data;'}));
    assert.ok(nested.diagnostics.some(diagnostic=>diagnostic.file==='src/models.rs'&&diagnostic.reason.includes('builtin spelling lacks a canonical macro identity')),'nested original items retain a namespace gap');
});

test('Derive lock edits, source denial and workspace selections invalidate caches and preserve original declaration IDs',async()=>{
    const root=await repo(),state=await repo({}),cold=await index(root,new AnalysisCache(state)),warmCache=new AnalysisCache(state),warm=await index(root,warmCache),revision=await index(root,undefined,'recorded');
    assert.equal(shape(cold),shape(warm));assert.equal(shape(cold),shape(revision));assert.ok(warmCache.events.some(event=>event.analyzer==='rust-imports'&&event.hit));
    const declarations=(g:SoftwareGraph)=>g.entities.filter(entity=>entity.language==='rust'&&entity.metadata.declarationKind).map(entity=>[entity.id,entity.sourceRange]);
    await put(root,'Cargo.lock',lock('1.0.152'));const changedCache=new AnalysisCache(state),changed=await index(root,changedCache);
    assert.equal(selected(changed,'handler').status,'unsupported');assert.ok(changedCache.events.some(event=>event.analyzer==='rust-imports'&&!event.hit));assert.deepEqual(declarations(cold),declarations(changed));assert.equal(shape(changed),shape(await index(root,undefined,'old-provider')));
    await put(root,'Cargo.lock',lock());const deniedCache=new AnalysisCache(state),denied=await index(root,deniedCache,undefined,['Cargo.lock']);assert.equal(selected(denied,'handler').status,'unsupported');assert.ok(deniedCache.events.some(event=>event.analyzer==='rust-imports'&&!event.hit));
    const workspace=await repo({'Cargo.toml':'[workspace]\nmembers=["app"]\nresolver="2"','app/Cargo.toml':cargo(),'app/src/lib.rs':'mod models;use crate::models::handler;','app/src/models.rs':source,'app/Cargo.lock':lock('1.0.152')});
    const graph=await indexRepository(workspace,{config:await resolveConfig(workspace,{applications:[{name:'app',path:'app',rust:{features:[],defaultFeatures:false}}],ignore:['src/**']})});
    assert.equal(outcomes(graph,'app/src/lib.rs').find(item=>item.specifier.endsWith('handler'))!.outcome.status,'resolved','workspace root lock governs member, not its stale sibling lock');
});

test('Native Axum serving receives recorded derive namespace proof while JSON conversion and generated traits remain gaps',async()=>{
    const main=`use axum::{Router,routing::get};use serde::Deserialize;#[derive(Deserialize)]struct Data;async fn handler(){}#[tokio::main]async fn main(){let app=Router::new().route("/x",get(handler));let listener=tokio::net::TcpListener::bind("127.0.0.1:3000").await.unwrap();axum::serve(listener,app).await.unwrap();}`;
    const root=await repo({'Cargo.toml':cargo('serde={version="1",features=["derive"]}\naxum="0.7.9"\ntokio={version="1",features=["full"]}'),'src/lib.rs':'','src/main.rs':main,'client.ts':'export async function load(){await fetch("https://api.test/x")}'}),state=await repo({}),cold=await index(root,new AnalysisCache(state)),warmCache=new AnalysisCache(state),warm=await index(root,warmCache);
    assert.equal(shape(cold),shape(warm));assert.ok(warmCache.events.some(event=>event.analyzer==='rust-routers'&&event.hit));
    const endpoint=(g:SoftwareGraph)=>g.entities.find(entity=>entity.type==='api_endpoint'&&entity.metadata.routePath==='/x'&&entity.metadata.registration==='explicit')!;
    const route=endpoint(cold);assert.ok(route);assert.equal(route.metadata.constraintsUnresolved,undefined);assert.ok(route.evidence.some(fact=>fact.file==='Cargo.lock'&&fact.explanation?.includes('serde_derive')));assert.ok(cold.relations.some(edge=>edge.type==='requests'&&edge.to===route.id));
    await put(root,'src/main.rs',main.replace('fn handler()','fn handler(_:axum::extract::Json<Data>)'));const body=await index(root);assert.ok(endpoint(body).metadata.constraintsUnresolved);assert.ok(!body.relations.some(edge=>edge.type==='requests'&&edge.to===endpoint(body).id));
    await put(root,'src/main.rs',main);await put(root,'Cargo.lock',lock('1.0.152'));const altered=new AnalysisCache(state),old=await index(root,altered);assert.ok(endpoint(old).metadata.constraintsUnresolved);assert.ok(altered.events.some(event=>event.analyzer==='rust-routers'&&!event.hit));
});
