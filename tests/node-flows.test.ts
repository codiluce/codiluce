import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { indexRepository } from '../src/pipeline/index.js';
import { resolveConfig, detectApplications, type ApplicationInput } from '../src/core/config.js';
import { GraphStore } from '../src/storage/sqlite.js';
import { ProjectionService } from '../src/projection/service.js';
import { canonicalJson } from '../src/history/fingerprint.js';

const roots:string[]=[];
after(async()=>{await Promise.all(roots.map(root=>rm(root,{recursive:true,force:true})));});
async function repository(files:Record<string,string>) {
  const root=await mkdtemp(path.join(tmpdir(),'codiluce-node-flows-')); roots.push(root);
  for (const [file,text] of Object.entries(files)) { await mkdir(path.dirname(path.join(root,file)),{recursive:true}); await writeFile(path.join(root,file),text); }
  return root;
}
async function project(files:Record<string,string>, options:Partial<ApplicationInput>={}) {
  const root=await repository({'package.json':JSON.stringify({name:'tool',bin:{tool:'main.ts'},dependencies:{typescript:'^5'}}),...files});
  const config=await resolveConfig(root,{repository:{name:'tool'},applications:[{name:'tool',path:'.',...options}]});
  const graph=await indexRepository(root,{config});
  const store=new GraphStore(path.join(root,'graph.db'));store.save(graph);
  return {root,config,graph,store,projection:new ProjectionService(store,{root})};
}

test('CLI dispatch branches have independent source ownership and preserve selected-command guards',async()=>{
  const p=await project({'main.ts':`import {parseArgs as parse} from 'node:util';
const {positionals:args}=parse({allowPositionals:true}); const command=args[0];
async function main(){
 if(command==='index'){ return build(); }
 if(command==='serve'){ return serve(); }
}
function build(){return 'graph';} function serve(){return 'server';} main();`});
  try {
    const flows=p.projection.flows().items.filter(item=>item.kind==='cli');
    assert.deepEqual(flows.map(item=>item.name).sort(),['tool index','tool serve']);
    const flow=await p.projection.requestFlow(flows.find(item=>item.name==='tool index')!.id,{maxFileBytes:1<<20});
    assert.equal(flow.kind,'operation'); assert.equal(flow.laneLabels?.client,'Trigger');
    assert.ok(flow.nodes.some(node=>node.node?.name==='build'));
    assert.equal(flow.nodes.some(node=>node.node?.name==='serve'),false);
    assert.ok(flow.edges.some(edge=>edge.when.some(guard=>guard.phrase.includes("command==='index'"))));
    assert.equal(flow.evidenceCoverage,'no-known-gaps');
  } finally {p.store.close();}
});

test('Node HTTP imports and exact request identities establish literal routes and response outcomes',async()=>{
  const p=await project({'main.ts':`import {createServer as server} from 'node:http';
server((req,res)=>{const pathname=new URL(req.url ?? '/', 'http://local').pathname;
 if(req.method !== 'GET'){ res.end('bad'); return; }
 if(pathname==='/summary'){return res.end(summary());}
}); function summary(){return 'ok';}`});
  try {
    const endpoint=p.graph.entities.find(entity=>entity.name==='GET /summary'&&entity.type==='api_endpoint'); assert.ok(endpoint);
    const flow=await p.projection.requestFlow(endpoint.id,{maxFileBytes:1<<20});
    assert.ok(flow.nodes.some(node=>node.node?.name==='summary'));
    assert.ok(flow.nodes.some(node=>node.kind==='response'&&node.effect?.operation==='end'));
  } finally {p.store.close();}
});

test('shadowed APIs and unrelated method/path strings do not invent runtime entries',async()=>{
  const p=await project({'main.ts':`function fake(process:any){if(process.argv[2]==='fake'){hidden();}}
const createServer=(fn:any)=>{};createServer((request:any,response:any)=>{if(request.url==='/fake'){hidden();}});
function hidden(){} function arbitrary(command:string){if(command==='not-cli'){hidden();}}
const parentPort={on(event:string,fn:any){}};parentPort.on('message',hidden);`});
  try { assert.equal(p.graph.entities.some(entity=>entity.type==='user_flow'||entity.type==='api_endpoint'),false); }
  finally {p.store.close();}
});

test('MCP and worker registrations bind original callbacks, while unresolved targets retain source gaps',async()=>{
  const p=await project({'main.ts':`import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {parentPort as port} from 'node:worker_threads';
const server=new McpServer({name:'test',version:'1'});server.registerTool('inspect',{},()=>inspect());
port.on('message',message=>{inspect();port.postMessage({type:'result'});});
process.on('message',unknownHandler); function inspect(){return 'ok';}`});
  try {
    const flows=p.projection.flows().items;
    assert.ok(flows.some(flow=>flow.kind==='mcp'&&flow.name==='MCP inspect'));
    assert.equal(flows.filter(flow=>flow.kind==='worker').length,2);
    const broken=flows.find(flow=>flow.kind==='worker'&&p.graph.entities.find(entity=>entity.id===flow.id)?.sourceRange?.startLine===5)!;
    assert.equal(broken.evidenceCoverage,'known-gaps');
    const worker=await p.projection.requestFlow(flows.find(flow=>flow.kind==='worker'&&p.graph.entities.find(entity=>entity.id===flow.id)?.sourceRange?.startLine===4)!.id,{maxFileBytes:1<<20});
    assert.ok(worker.nodes.some(node=>node.node?.name==='inspect'));
    assert.ok(worker.nodes.some(node=>node.gap?.source?.line===4&&node.gap.text.includes('leaves this thread')));
  } finally {p.store.close();}
});

test('configured protocol selectors expose literal operations and functions require explicit opt-in',async()=>{
  const p=await project({'main.ts':`class Session {dispatch(method:string){switch(method){case 'tools/list':return list();case 'tools/call':return run();}}}
function list(){return [];} function run(){return 1;} export function library(){return 2;}`},{flowEntries:[{name:'MCP',path:'main.ts',symbol:'Session.dispatch',kind:'mcp',selector:'method'},{name:'Library task',path:'main.ts',symbol:'library'}]});
  try {
    assert.deepEqual(p.projection.flows().items.map(flow=>flow.name).sort(),['Library task','MCP tools/call','MCP tools/list']);
    const entries=p.graph.entities.filter(entity=>entity.type==='user_flow');
    assert.ok(entries.every(entity=>entity.metadata.registration==='configured'));
  } finally {p.store.close();}
});

test('flow scopes separate fixtures and tests; expected external services are explicit boundaries',async()=>{
  const p=await project({'main.ts':`export function task(){return fetch('https://external.test/items');}`,'tests/check.ts':`process.on('message',()=>{});`,'tests/fixtures/probe.ts':`process.on('message',()=>{});`},{flowEntries:[{name:'External task',path:'main.ts',symbol:'task'}],externalServices:[{name:'Catalog API',origin:'https://external.test'}]});
  try {
    const production=p.projection.flows({scope:'application'}); assert.equal(production.items.length,1);
    assert.equal(p.projection.flows({scope:'fixture'}).items.length,1);
    assert.equal(p.projection.flows({scope:'test'}).items.length,1);
    const flow=await p.projection.requestFlow(production.items[0]!.id,{maxFileBytes:1<<20});
    assert.ok(flow.nodes.some(node=>node.kind==='external'&&node.effect?.boundary?.name==='Catalog API'));
    assert.equal(p.graph.diagnostics.some(diagnostic=>diagnostic.code==='unmatched-http-call'),false);
  } finally {p.store.close();}
});

test('shared-package UI roots are discovered separately from a Node tool and fixture manifests',async()=>{
  const root=await repository({'package.json':JSON.stringify({name:'tool',bin:'cli.ts',devDependencies:{next:'^16',react:'^19'}}),'web/next.config.ts':'export default {};','web/app/page.tsx':'export default function Page(){return null;}','site/package.json':JSON.stringify({dependencies:{next:'^16'}}),'site/app/page.tsx':'export default function Page(){return null;}','tests/fixtures/package.json':JSON.stringify({dependencies:{next:'^16'}})});
  assert.deepEqual((await detectApplications(root)).map(app=>app.path).sort(),['.','site','web']);
});

test('runtime registration cache replay retains branch identities, effects and source gaps',async()=>{
  const root=await repository({'package.json':JSON.stringify({bin:'main.ts'}),'main.ts':`import {parseArgs} from 'node:util';const {positionals}=parseArgs({allowPositionals:true});const command=positionals[0];if(command==='run'){callback();}`});
  const cold=await indexRepository(root,{cache:path.join(root,'.cache')}),warm=await indexRepository(root,{cache:path.join(root,'.cache')});
  const facts=(graph:typeof cold)=>canonicalJson({entities:graph.entities,relations:graph.relations,diagnostics:graph.diagnostics});
  assert.equal(facts(cold),facts(warm));
  await assert.rejects(resolveConfig(root,{applications:[{name:'tool',path:'.',flowEntries:[{name:'bad',path:'../outside.ts',symbol:'run'}]}]}),/escapes application/);
});

test('configured unavailable sources remain visible as gaps instead of silently disappearing',async()=>{
  const p=await project({'main.ts':'export function available(){return 1;}'},{flowEntries:[{name:'Missing source',path:'absent.ts',symbol:'missing'}]});
  try {
    const entry=p.projection.flows().items.find(flow=>flow.name==='Missing source');assert.ok(entry);
    assert.equal(entry.evidenceCoverage,'known-gaps');
    const flow=await p.projection.requestFlow(entry.id,{maxFileBytes:1<<20});
    assert.ok(flow.nodes.some(node=>node.gap?.text.includes('missing, unavailable or ambiguous')));
  } finally {p.store.close();}
});

test('worker payload branches keep separate handlers while the original callback retains all guarded work',async()=>{
  const p=await project({'main.ts':`import {parentPort} from 'node:worker_threads';
parentPort.on('message',message=>{if(message.type==='build'){build();}if(message.type==='stop'){stop();}});
function build(){}function stop(){}`});
  try {
    const flows=p.projection.flows().items;
    const entry=flows.find(flow=>flow.name.startsWith('Worker build'))!;
    const branch=await p.projection.requestFlow(entry.id,{maxFileBytes:1<<20});
    assert.ok(branch.nodes.some(node=>node.node?.name==='build'));
    assert.equal(branch.nodes.some(node=>node.node?.name==='stop'),false);
    const whole=await p.projection.requestFlow(flows.find(flow=>flow.name.startsWith('Worker message'))!.id,{maxFileBytes:1<<20});
    assert.ok(whole.nodes.some(node=>node.node?.name==='build')&&whole.nodes.some(node=>node.node?.name==='stop'));
  } finally {p.store.close();}
});

test('same-line worker registrations keep separate source identities and survive unrelated line shifts',async()=>{
  const root=await repository({'package.json':JSON.stringify({bin:'main.ts'}),'main.ts':`process.on('message',()=>first());process.on('message',()=>second());function first(){}function second(){}`});
  const first=await indexRepository(root);
  const entries=first.entities.filter(entity=>entity.type==='user_flow');assert.equal(entries.length,2);
  assert.equal(new Set(entries.map(entity=>entity.id)).size,2);
  for (const entry of entries) {
    const handler=first.relations.find(relation=>relation.type==='handles'&&relation.from===entry.id)!.to;
    assert.equal(first.relations.filter(relation=>relation.type==='calls'&&relation.from===handler).length,1);
  }
  const text=await readFile(path.join(root,'main.ts'),'utf8');
  await writeFile(path.join(root,'main.ts'),`\n// unrelated comment\n${text}`);
  const shifted=await indexRepository(root);
  assert.deepEqual(shifted.entities.filter(entity=>entity.type==='user_flow').map(entity=>entity.id).sort(),entries.map(entity=>entity.id).sort());
});

test('a Node Worker instance establishes its listener while overwritten factories stay unproved',async()=>{
  const p=await project({'main.ts':`import {Worker} from 'node:worker_threads';import {createServer} from 'node:http';
const worker=new Worker('./worker.js');worker.on('message',()=>{});
let server=createServer;server=other;server((req:any,res:any)=>{if(req.url==='/fake'){res.end('x');}});`});
  try {assert.equal(p.projection.flows().items.filter(flow=>flow.kind==='worker').length,1);assert.equal(p.graph.entities.some(entity=>entity.type==='api_endpoint'),false);}
  finally {p.store.close();}
});

test('unreviewed earlier HTTP gates remain candidates instead of lending an exact request match',async()=>{
  const p=await project({'main.ts':`import {createServer} from 'node:http';createServer((req,res)=>{const path=new URL(req.url,'https://local').pathname;
if(skip(req)){return res.end('skipped');}if(path==='/items'){return res.end('ok');}});
fetch('https://local.test/items');`},{apiOrigins:['https://local.test']});
  try {
    const endpoint=p.graph.entities.find(entity=>entity.type==='api_endpoint'&&entity.name==='ANY /items');assert.ok(endpoint);
    assert.equal(endpoint.metadata.constraintsUnresolved,true);
    assert.equal(p.graph.relations.some(relation=>relation.type==='requests'),false);
    const flow=await p.projection.requestFlow(endpoint.id,{maxFileBytes:1<<20});
    assert.ok(flow.nodes.some(node=>node.gap?.text.includes('routing guard')&&node.gap?.source?.line===2));
  }finally{p.store.close();}
});

test('routers the server hands its request to keep their literal routes; guards proven for a path do not constrain it',async()=>{
  const routes=`import type {ServerResponse} from 'node:http';
export function isApiPath(pathname:string){return pathname.startsWith('/api/');}
export async function handleApi(url:URL,res:ServerResponse){const {pathname}=url;
if(!isApiPath(pathname))return;
let match;
if(pathname==='/api/items')return res.end(items());
else if((match=new RegExp(\`^/api/items/\${ID}$\`).exec(pathname)))return res.end(match[1]);
else if(pathname==='/api/other')return res.end('other');}
const ID='([^/]+)';function items(){return 'ok';}`;
  const server=(guard:string)=>`import {createServer} from 'node:http';import {handleApi,isApiPath} from './routes';
createServer((req,res)=>{let pathname:string;try{pathname=new URL(req.url ?? '/','http://local').pathname;}catch{return;}
if(/^\\/legacy(?:\\/|$)/.test(pathname)){res.end('legacy');return;}
${guard}
if(req.method !== 'GET'){res.end('bad');return;}
if(isApiPath(pathname)){void handleApi(new URL(req.url ?? '/','http://local'),res);return;}
});
fetch('https://local.test/api/items');fetch('https://local.test/api/other');`;
  // A server a test starts with the same router stands in for the real one: it adds no second endpoint.
  const testServer=`import {createServer} from 'node:http';import {handleApi} from '../routes';createServer((req,res)=>{void handleApi(new URL(req.url ?? '/','http://local'),res);});`;
  const proven=await project({'main.ts':server(''),'routes.ts':routes,'tests/server.ts':testServer},{apiOrigins:['https://local.test']});
  try {
    assert.equal(proven.graph.entities.filter(entity=>entity.type==='api_endpoint'&&entity.name==='GET /api/items').length,1);
    for (const name of ['GET /api/items','GET /api/other']) {
      const endpoint=proven.graph.entities.find(entity=>entity.type==='api_endpoint'&&entity.name===name);assert.ok(endpoint,name);
      assert.equal(endpoint.path,'routes.ts');assert.equal(endpoint.metadata.constraintsUnresolved,undefined,name);
    }
    assert.equal(proven.graph.relations.filter(relation=>relation.type==='requests').length,2,JSON.stringify(proven.graph.diagnostics));
  }finally{proven.store.close();}
  // A guard the source cannot decide, before the hand-over, keeps the routes candidates: reported in the router, naming where it is.
  const unproven=await project({'main.ts':server('if(skip(req)){res.end("skipped");return;}'),'routes.ts':routes},{apiOrigins:['https://local.test']});
  try {
    const endpoint=unproven.graph.entities.find(entity=>entity.type==='api_endpoint'&&entity.name==='GET /api/items');assert.ok(endpoint);
    assert.equal(endpoint.metadata.constraintsUnresolved,true);
    assert.equal(unproven.graph.relations.some(relation=>relation.type==='requests'),false);
    const flow=await unproven.projection.requestFlow(endpoint.id,{maxFileBytes:1<<20});
    assert.ok(flow.nodes.some(node=>node.gap?.text.includes('skip(req) (main.ts:4)')),JSON.stringify(flow.nodes.map(node=>node.gap?.text).filter(Boolean)));
  }finally{unproven.store.close();}
});
