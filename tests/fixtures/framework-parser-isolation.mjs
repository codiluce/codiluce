import assert from 'node:assert/strict';
import cp from 'node:child_process';
import {syncBuiltinESMExports,createRequire} from 'node:module';
import {mkdtemp,writeFile,access,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
const source=new URL(process.argv[2]),{TemplateFrameworkParser}=await import(new URL('analysis/embedded/framework-parser.js',source)),{indexRepository}=await import(new URL('pipeline/index.js',source));
const original=cp.fork,children=[];cp.fork=(...args)=>{if(!String(args[0]).endsWith('native-framework-worker.mjs')&&!String(args[0]).endsWith('native-ts-worker.mjs'))return original(...args);assert.ok(children.every(child=>child.exitCode!==null||child.signalCode!==null),'A replacement must wait for all old optional parser address spaces');const child=original(...args);children.push(child);return child;};syncBuiltinESMExports();
const root=await mkdtemp(path.join(tmpdir(),'codiluce-owned-framework-isolation-')),marker=path.join(root,'target-executed'),script=`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'target');export function original(){return "é😀";}`;
const svelte=`<script>${script}</script>\r\n<div>é😀</div>`,astro=`---\r\n${script}\r\n---\r\n<div>é😀</div>`,parser=new TemplateFrameworkParser({maxJobs:2,maxSourceBytes:1048576});let passed=false;
try{
  assert.equal((await parser.svelte(svelte,'Original.svelte')).type,'Root');assert.ok((await parser.astro(astro)).ast);assert.equal(children.length,1);assert.ok(children[0].exitCode!==null||children[0].signalCode!==null);assert.equal(parser.stats().jobs,0);
  assert.equal((await parser.svelte(svelte,'Fresh.svelte')).type,'Root');assert.equal(children.length,2);await parser.closeAndWait();
  await writeFile(path.join(root,'package.json'),JSON.stringify({dependencies:{svelte:'5.57.2',astro:'7.0.0'}}));await writeFile(path.join(root,'Original.svelte'),svelte);await writeFile(path.join(root,'Page.astro'),astro);
  const graph=await indexRepository(root);assert.ok(graph.entities.filter(entity=>entity.name==='original').length>=2);assert.equal(graph.diagnostics.filter(item=>item.code==='svelte-parse-error'||item.code==='astro-parse-error').length,0);assert.ok(children.every(child=>child.exitCode!==null||child.signalCode!==null));
  await assert.rejects(access(marker),{code:'ENOENT'});const native=(process.report.getReport().sharedObjects??[]).filter(file=>/astro|compiler-binding/.test(file));assert.deepEqual(native,[]);assert.ok(!Object.keys(createRequire(import.meta.url).cache).some(file=>/svelte[\\/]compiler|@astrojs[\\/]compiler-/.test(file)));
  console.log(JSON.stringify({passed:true,parentPid:process.pid,workers:children.map(child=>({pid:child.pid,exitCode:child.exitCode,signal:child.signalCode})),mainOptionalParserResolutionForbidden:true,mainAstroNativeLibraries:native,targetExecution:false,entities:graph.entities.length,relations:graph.relations.length,diagnostics:graph.diagnostics.length}));passed=true;
}finally{await parser.closeAndWait();cp.fork=original;syncBuiltinESMExports();if(passed)await rm(root,{recursive:true,force:true});else console.error(`Retained failed original fixture: ${root}`);}
