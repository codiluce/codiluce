import assert from 'node:assert/strict';
import {after,mock,test} from 'node:test';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {mkdir,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {StructureParser} from '../src/analysis/tree-sitter/client.js';
import {TemplateScriptParser,literalScriptTemplate} from '../src/analysis/tree-sitter/template-scripts.js';
import type {StructureFacts} from '../src/analysis/facts.js';
import {indexRepository} from '../src/pipeline/index.js';
import {AnalysisCache} from '../src/pipeline/cache.js';
import {canonicalJson} from '../src/history/fingerprint.js';
import {verifyScriptWorkerBundle} from '../scripts/build-script-worker.mjs';

const roots:string[]=[];
after(async()=>{await Promise.all(roots.map(root=>rm(root,{recursive:true,force:true})));});
async function repository(files:Record<string,string>){const root=await mkdtemp(path.join(os.tmpdir(),'codiluce-parser-phases-'));roots.push(root);for(const[file,text]of Object.entries(files)){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),text);}return root;}
type Options=Parameters<StructureParser['parse']>[2];

test('plain JavaScript worker matches its typed service, approved helpers and lazy compiler bootstrap',verifyScriptWorkerBundle);

test('native-only facts and the separate compiler preserve complete ERB/Razor/Liquid facts, limits and original coordinates',async()=>{
 const cases:Array<{language:string;content:string;options:Options}>=[];
 for(const [language,file,options]of [['erb','erb.html.erb',{erbHost:'html'}],['razor','Counter.razor',{razorKind:'component'}],['liquid','template.html.liquid',{liquidHost:'html',liquidEngine:'shopify',liquidBodyTags:true}]]as const){
  cases.push({language,content:await readFile(new URL(`./fixtures/structure/${file}`,import.meta.url),'utf8'),options});
  for(const content of ['<!-- é😀 -->\r\n<script>class Client {get value(){return 1}} const read=(x)=>x;</script>','<script type="module">import x from "unavailable"; export function read(){}</script>','<script src="remote.js">function ignored(){}</script>','<script lang="ts">function ignored(x:number){}</script>','<script>const = ;</script>','<p>literal host with no script</p>'])cases.push({language,content,options});
 }
 cases.push({language:'erb',content:'<%# comment %>'.repeat(4100)+'<script>function boundedScript(){}</script>',options:{erbHost:'html'}});
 const original=new StructureParser(),native=new StructureParser(),compiler=new TemplateScriptParser(),expected:StructureFacts[]=[],staged:StructureFacts[]=[];
 try{
  for(const item of cases)expected.push(await original.parse(item.language,item.content,item.options));await original.closeAndWait();
  for(const item of cases)staged.push(await native.parse(item.language,item.content,{...item.options,nativeOnly:true}));await native.closeAndWait();
  for(const[index,item]of cases.entries()){const facts=await compiler.finish(item.content,staged[index]!);assert.equal(canonicalJson(facts),canonicalJson(expected[index]),`${item.language} ${index}`);}
 }finally{await original.closeAndWait();await native.closeAndWait();await compiler.closeAndWait();}
});

test('the pipeline reaps every native generation before the compiler starts, including failed native jobs',async()=>{
 const root=await repository({'a.html.erb':'<script>function firstClient(){}</script>','b.fs':'let run ()=\n '+'ignore 1\n '.repeat(1000)+'1','c.py':'def healthy(): pass\n','d.razor':'<script>function secondClient(){}</script>'});
 const original=childProcess.fork,native=new Set<number>(),compiler=new Set<number>(),events:string[]=[],children:childProcess.ChildProcess[]=[];
 const observer=mock.method(childProcess,'fork',((file:string,...args:unknown[])=>{
  const script=String(file).includes('script-worker'),result=Reflect.apply(original,childProcess,[file,...args]);children.push(result);
  if(script){events.push('compiler-bootstrap');}else{events.push('native-start');}
  if(result.pid)(script?compiler:native).add(result.pid);result.once('exit',()=>{if(result.pid)(script?compiler:native).delete(result.pid);events.push(script?'compiler-exit':'native-exit');});return result;
 })as typeof childProcess.fork);syncBuiltinESMExports();
 const originalFinish=TemplateScriptParser.prototype.finish;
 const finish=mock.method(TemplateScriptParser.prototype,'finish',async function(this:TemplateScriptParser,content:string,facts:StructureFacts){assert.equal(native.size,0,'Native address spaces must exit before compiler loading/parsing');events.push('compiler-start');return originalFinish.call(this,content,facts);});
 try{
  const graph=await indexRepository(root);assert.ok(graph.entities.some(entity=>entity.name==='firstClient'));assert.ok(graph.entities.some(entity=>entity.name==='secondClient'));assert.ok(graph.entities.some(entity=>entity.name==='healthy'));
  assert.ok(graph.diagnostics.some(diagnostic=>diagnostic.file==='b.fs'&&diagnostic.code==='syntax-analysis-failed'));assert.ok(events.includes('compiler-start'));assert.equal(events.at(-1),'compiler-exit');assert.equal(native.size,0);assert.equal(compiler.size,0);
 }finally{finish.mock.restore();observer.mock.restore();syncBuiltinESMExports();for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
});

test('full syntax cache entries skip both parser phases and never store an incomplete compiler failure',async()=>{
 const root=await repository({'a.html.erb':'<script>function firstClient(){}</script>','b.html.liquid':'<script>function secondClient(){}</script>','c.py':'def healthy(): pass\n'}),cache=new AnalysisCache(path.join(root,'.codiluce/cache'));
 const original=TemplateScriptParser.prototype.finish;let injected=false;
 const fault=mock.method(TemplateScriptParser.prototype,'finish',async function(this:TemplateScriptParser,content:string,facts:StructureFacts){if(content.includes('firstClient')&&!injected){injected=true;throw Error('Injected isolated compiler failure');}return original.call(this,content,facts);});
 try{const graph=await indexRepository(root,{cache});assert.ok(graph.diagnostics.some(diagnostic=>diagnostic.file==='a.html.erb'&&diagnostic.reason.includes('isolated compiler failure')));assert.ok(!graph.entities.some(entity=>entity.name==='firstClient'));assert.ok(graph.entities.some(entity=>entity.name==='secondClient'));assert.ok(graph.entities.some(entity=>entity.name==='healthy'));}
 finally{fault.mock.restore();}
 assert.ok(!(await readdir(cache.directory)).some(file=>file.startsWith('syntax-facts.a_html_erb')));
 const recovered=await indexRepository(root,{cache});assert.ok(recovered.entities.some(entity=>entity.name==='firstClient'));const start=cache.events.length;
 const native=mock.method(StructureParser.prototype,'parse',async()=>{throw Error('Native cache replay must not parse');}),compiler=mock.method(TemplateScriptParser.prototype,'finish',async()=>{throw Error('Full fact replay must not compile');});
 try{const warm=await indexRepository(root,{cache});for(const key of ['entities','relations','diagnostics']as const)assert.equal(canonicalJson(warm[key]),canonicalJson(recovered[key]));assert.ok(cache.events.slice(start).filter(event=>event.analyzer==='syntax-facts').every(event=>event.hit));}
 finally{native.mock.restore();compiler.mock.restore();}
});

test('compiler deadlines reap retired workers and later independent compiler jobs still succeed',async()=>{
 const source='<script>function client(){}</script>',native=new StructureParser();let facts:StructureFacts;
 try{facts=await native.parse('erb',source,{erbHost:'html',nativeOnly:true});assert.equal(literalScriptTemplate(facts),'erb');}finally{await native.closeAndWait();}
 const short=new TemplateScriptParser(1);try{await assert.rejects(short.finish(source,facts!),/exceeded/);}finally{await short.closeAndWait();}
 const healthy=new TemplateScriptParser();try{assert.ok((await healthy.finish(source,facts!)).declarations.some(declaration=>declaration.name==='client'));}finally{await healthy.closeAndWait();}
});

test('repeated compiler prewarming shares one source-free bootstrap and one error observer',async()=>{
 const original=childProcess.fork,children:childProcess.ChildProcess[]=[],jobs:unknown[]=[];
 const observer=mock.method(childProcess,'fork',((...args:unknown[])=>{
  const child=Reflect.apply(original,childProcess,args);children.push(child);
  const send=child.send.bind(child);
  child.send=((message:unknown,...rest:unknown[])=>{jobs.push(message);return Reflect.apply(send,child,[message,...rest]);})as typeof child.send;
  return child;
 })as typeof childProcess.fork);syncBuiltinESMExports();
 const compiler=new TemplateScriptParser();
 try{
  for(let file=0;file<100;file++)compiler.prewarm();
  assert.equal(children.length,1);assert.equal(children[0]!.listenerCount('error'),1);
  assert.deepEqual(jobs,[],'Bootstrap never dispatches source or loads the optional compiler');
  await compiler.closeAndWait();
  assert.ok(children[0]!.exitCode!==null||children[0]!.signalCode!==null);
 }finally{await compiler.closeAndWait();observer.mock.restore();syncBuiltinESMExports();}
});

test('literal-script compiler parsing cannot evaluate target imports or target top-level source',async()=>{
 const root=await repository({}),marker=path.join(root,'executed'),source=`<script type="module">import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)},'executed');export function client(){}</script>`;
 await writeFile(path.join(root,'source.html.erb'),source);const graph=await indexRepository(root);assert.ok(graph.entities.some(entity=>entity.name==='client'));assert.ok(!(await readdir(root)).includes('executed'));
});
