import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {lstat,readFile,readdir,realpath} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {observeProductionHeads,validateHeadProfiles} from './production-head-graphs.mjs';

const project=fileURLToPath(new URL('../',import.meta.url)),options=Object.create(null),observations=Object.create(null),args=process.argv.slice(2);
for(let index=0;index<args.length;index++){
  const flag=args[index],value=args[++index];
  if(!['--corpus','--manifest','--profiles','--source-observation','--output'].includes(flag)||!value||value.startsWith('--'))throw Error('Expected --corpus FILE, --manifest FILE, --profiles FILE, --source-observation ID=DIRECTORY or --output FRESH_DIRECTORY');
  if(flag==='--source-observation'){const at=value.indexOf('='),id=value.slice(0,at);if(at<1||at===value.length-1||Object.hasOwn(observations,id))throw Error('Original observations require unique ID=DIRECTORY values');observations[id]=path.resolve(value.slice(at+1));}
  else{if(Object.hasOwn(options,flag))throw Error(`Duplicate ${flag}`);options[flag]=path.resolve(value);}
}
if(!options['--output'])throw Error('A fresh --output directory is required');
const inputs={corpus:options['--corpus']??path.join(project,'docs/production-history-corpus.json'),manifest:options['--manifest']??path.join(project,'docs/production-source-contracts.json'),profiles:options['--profiles']??path.join(project,'docs/production-head-profiles.json')};
const values=Object.fromEntries(await Promise.all(Object.entries(inputs).map(async([name,file])=>[name,JSON.parse(await readFile(file,'utf8'))])));validateHeadProfiles(values.profiles,values.manifest,values.corpus);
// Resolve installed own dependency packages without importing or executing any
// target file. Each package's actual files and transitive installed dependency
// identities participate; missing optional platform packages remain explicit.
async function dependencyRoots(){
  const packageFile=path.join(project,'package.json'),manifest=JSON.parse(await readFile(packageFile,'utf8')),queue=Object.keys(manifest.dependencies).map(name=>({name,from:packageFile,optional:false}));queue.push({name:'tsx',from:packageFile,optional:false});
  const found=new Map(),missing=[];
  while(queue.length){
    const {name,from,optional}=queue.shift(),require=createRequire(from);let root,info;
    // Package exports may hide package.json or expose only an ESM import. Node's
    // ordered package search paths identify the same installed package without
    // evaluating exports, loaders or its executable entry point.
    for(const directory of require.resolve.paths(name)??[]){
      const candidate=path.join(directory,name);try{info=JSON.parse(await readFile(path.join(candidate,'package.json'),'utf8'));root=candidate;break;}catch(error){if(error.code!=='ENOENT'&&error.code!=='ENOTDIR')throw error;}
    }
    if(!root){if(!optional)throw Error(`Installed own dependency identity unavailable: ${name}`);missing.push({name,from:path.relative(project,from)});continue;}
    if(info.name!==name)throw Error(`Installed own dependency name differs: ${name}`);
    root=await realpath(root);if(found.has(root))continue;found.set(root,{name,version:info.version,root});
    const optionalNames=new Set(Object.keys(info.optionalDependencies??{}));
    for(const dependency of new Set([...Object.keys(info.dependencies??{}),...optionalNames]))queue.push({name:dependency,from:path.join(root,'package.json'),optional:optionalNames.has(dependency)});
  }
  return {packages:[...found.values()].sort((a,b)=>a.root<b.root?-1:a.root>b.root?1:0),missing:missing.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))};
}
async function identity(){
  const dependencies=await dependencyRoots(),files=[];
  async function collect(file){
    const info=await lstat(file);if(info.isSymbolicLink())throw Error(`Own engine identity crosses an unrecorded alias: ${path.relative(project,file)}`);
    if(info.isDirectory()){for(const entry of (await readdir(file)).sort())if(entry!=='node_modules')await collect(path.join(file,entry));}
    else{if(!info.isFile())throw Error('Own engine identity contains a nonregular file');const bytes=await readFile(file);files.push({file:path.relative(project,file),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
  }
  for(const relative of ['src','grammars','package.json','package-lock.json','scripts/production-head-graphs.mjs','scripts/qualify-production-heads.mjs','scripts/production-source-contracts.mjs','scripts/production-history-blobs.mjs','scripts/production-history-inputs.mjs'])await collect(path.join(project,relative));
  for(const file of new Set(Object.values(inputs)))await collect(file);
  for(const dependency of dependencies.packages)await collect(dependency.root);
  files.sort((a,b)=>a.file<b.file?-1:a.file>b.file?1:0);
  return {node:process.version,platform:process.platform,architecture:process.arch,execution:'owned-typescript-loader; target code and dependencies never execute',packages:dependencies.packages.map(({name,version,root})=>({name,version,root:path.relative(project,root)})),missingOptionalPackages:dependencies.missing,files,sha256:createHash('sha256').update(JSON.stringify(files)).digest('hex')};
}
const beforeImport=await identity();
const {indexRepository}=await import('../src/pipeline/index.ts');
assert.deepEqual(await identity(),beforeImport,'Own engine inputs changed while loading');
const receipt=await observeProductionHeads({...values,observations,output:options['--output'],identity,analyze:indexRepository});
console.log(JSON.stringify({output:options['--output'],reviewedHeadsVerified:receipt.reviewedHeadsVerified,analysisQualified:false,repositories:receipt.repositories.map(({id,status,error,graph,contracts})=>({id,status,error,graph,contracts:contracts?.contracts.map(({id,status,error})=>({id,status,error}))}))},null,2));
if(!receipt.reviewedHeadsVerified)process.exitCode=1;
