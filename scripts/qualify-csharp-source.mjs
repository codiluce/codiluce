// Only Codiluce's parsers/indexer run. MSBuild, .NET, target packages and
// generators never execute. Tracked regular blobs are copied at a pinned SHA.
// node --experimental-sqlite --import tsx scripts/qualify-csharp-source.mjs
//   --source /path/to/checkout --commit PIN --prefix source/subtree --output /tmp/csharp.json
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {indexRepository} from '../src/pipeline/index.ts';
import {resolveConfig} from '../src/core/config.ts';
import {AnalysisCache} from '../src/pipeline/cache.ts';
import {canonicalJson} from '../src/history/fingerprint.ts';
const args=process.argv.slice(2),option=name=>args.includes(name)?args[args.indexOf(name)+1]:undefined;
assert.ok(option('--source')&&option('--commit'),'--source and --commit are required');
const source=path.resolve(option('--source')),git=params=>execFileSync('git',params,{cwd:source,maxBuffer:16<<20});
const commit=git(['rev-parse','--verify',`${option('--commit')}^{commit}`]).toString().trim();assert.equal(git(['rev-parse','HEAD']).toString().trim(),commit,'checkout must match the pin');
const prefix=option('--prefix')??'.';assert.ok(!path.posix.isAbsolute(prefix)&&!prefix.split('/').includes('..'),'prefix must stay within the repository');
const entries=git(['ls-tree','-r','-z',commit]).toString().split('\0').filter(Boolean).map(value=>{const [header,file]=value.split('\t');return {mode:header.split(' ')[0],file};});
const ancestors=new Set();let directory=prefix;while(true){for(const name of ['Directory.Build.props','Directory.Build.targets','Directory.Packages.props','global.json','NuGet.config'])ancestors.add(path.posix.join(directory,name));if(directory==='.')break;directory=path.posix.dirname(directory);}
const files=entries.filter(entry=>(prefix==='.'||entry.file.startsWith(prefix+'/')||ancestors.has(entry.file))&&/\.(?:cs|csproj|props|targets|sln|slnx|json|config)$/.test(entry.file));assert.ok(files.some(entry=>entry.file.endsWith('.cs')),'tracked C# inputs required');
git(['diff','--exit-code',commit,'--',...files.map(entry=>entry.file)]);
const temporary=await mkdtemp(path.join(tmpdir(),'codiluce-csharp-source-'));
try{
  const root=path.join(temporary,'source'),state=path.join(temporary,'cache');for(const entry of files){assert.ok(['100644','100755'].includes(entry.mode),'regular tracked source only');assert.ok(!entry.file.split('/').includes('..'));const target=path.join(root,entry.file);assert.ok(target.startsWith(root+path.sep));await mkdir(path.dirname(target),{recursive:true});await writeFile(target,git(['cat-file','blob',`${commit}:${entry.file}`]));}
  const inputs=JSON.parse(option('--inputs')??'{}'),config=await resolveConfig(root,{...inputs,repository:{name:'csharp-source-qualification'}}),cold=await indexRepository(root,{config,cache:new AnalysisCache(state)}),warm=await indexRepository(root,{config,cache:new AnalysisCache(state)}),revision=await indexRepository(root,{config,revision:commit});
  const shape=graph=>canonicalJson({entities:graph.entities,relations:graph.relations,diagnostics:graph.diagnostics.filter(item=>!['git-metrics','indexer'].includes(item.analyzer)&&item.code!=='git-ignore-unavailable')});assert.equal(shape(cold),shape(warm));assert.equal(shape(cold),shape(revision));
  const originals=new Set(files.map(entry=>entry.file)),units=cold.entities.filter(entity=>entity.type==='file'&&entity.language==='csharp'),identities=new Map(cold.entities.map(entity=>[entity.id,entity])),outcomes=units.flatMap(unit=>(unit.metadata.importOutcomes??[]).map(item=>({file:unit.path,...item}))),imports=cold.relations.filter(edge=>edge.type==='imports'&&edge.metadata?.adapter==='csharp');
  for(const edge of imports){assert.ok(originals.has(identities.get(edge.from)?.path));assert.ok(originals.has(identities.get(edge.to)?.path));assert.ok(edge.evidence.some(fact=>originals.has(fact.file)&&fact.line>0));for(const id of edge.metadata.declarations){const declaration=identities.get(id);assert.equal(declaration.path,identities.get(edge.to).path);assert.ok(declaration.sourceRange.startLine>0);}}
  const count=values=>values.reduce((counts,value)=>({...counts,[value]:(counts[value]??0)+1}),{}),result={source,commit,prefix,copiedFiles:files.length,qualificationInputs:inputs,files:units.length,declarations:cold.entities.filter(entity=>entity.language==='csharp'&&entity.type!=='file').length,structure:count(units.map(unit=>unit.metadata.analysis.features.structure.status)),imports:count(outcomes.map(item=>item.outcome.status)),importEdges:imports.length,references:count(units.map(unit=>unit.metadata.analysis.features.references.status)),projects:cold.entities.find(entity=>entity.type==='repository').metadata.dotnetProjects,diagnostics:count(cold.diagnostics.filter(item=>item.analyzer==='csharp-imports').map(item=>item.reason)),samples:outcomes.slice(0,40).map(item=>({file:item.file,line:item.range.startLine,specifier:item.specifier,status:item.outcome.status,reason:item.outcome.reason})),cacheEqual:true,revisionEqual:true,boundary:'Unchanged original tracked source compilation/import integration; no compiler/build/binary/runtime/call or framework accuracy claim. Target .NET/MSBuild/packages/configuration/generators never execute.'};
  const json=JSON.stringify(result,null,2);if(option('--output'))await writeFile(path.resolve(option('--output')),json+'\n');console.log(json);
}finally{await rm(temporary,{recursive:true,force:true});}
