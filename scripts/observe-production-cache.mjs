// Alternating fresh owned processes over complete pinned original head trees.
// Full logical proof digests use a reviewed storage/provenance equivalence.
// The 10% gates are unchanged. Failed observations and caches stay retained.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,readdir,realpath,rm,stat,statfs,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectHeadTree,validateHeadProfiles} from './production-head-graphs.mjs';
import {measureProductionWorker} from './production-cache-measure.mjs';
import {qualifyProductionRuns} from './production-cache-results.mjs';
import {productionGitEnvironment} from './production-cache-git.mjs';

const project=fileURLToPath(new URL('../',import.meta.url)),args=process.argv.slice(2),options={},observations={};
for(let i=0;i<args.length;i++){
 const flag=args[i],value=args[++i];assert.ok(value&&!value.startsWith('--'),'Every option requires a value');
 if(flag==='--source-observation'){const at=value.indexOf('='),id=value.slice(0,at);assert.ok(at>0&&!Object.hasOwn(observations,id));observations[id]=path.resolve(value.slice(at+1));}
 else{assert.ok(['--baseline-engine','--current-engine','--baseline-identity','--current-identity','--git-metadata','--output','--repetitions'].includes(flag)&&!Object.hasOwn(options,flag),'Unknown or duplicate option');options[flag]=value;}
}
if(process.platform!=='linux')throw Error('Native platform readers remain pending; production RSS observation requires Linux /proc');
const repetitions=Number(options['--repetitions']??3);assert.ok(Number.isSafeInteger(repetitions)&&repetitions>=3&&repetitions<=20);
const profiles=JSON.parse(await readFile(path.join(project,'docs/production-head-profiles.json'))),manifest=JSON.parse(await readFile(path.join(project,'docs/production-source-contracts.json'))),corpus=JSON.parse(await readFile(path.join(project,'docs/production-history-corpus.json')));
validateHeadProfiles(profiles,manifest,corpus);assert.deepEqual(Object.keys(observations).sort(),profiles.repositories.map(row=>row.id).sort());
const gitMetadata=JSON.parse(await readFile(options['--git-metadata']));assert.deepEqual(Object.keys(gitMetadata.repositories).sort(),Object.keys(observations).sort());
assert.ok(gitMetadata.completedAt,'Git metadata preparation must be terminal');
for(const profile of profiles.repositories){const metadata=gitMetadata.repositories[profile.id];assert.equal(metadata.commit,profile.commit);assert.ok(metadata.logPreflight?.commits>0,'Original Git metrics preflight required');}
const engines={baseline:await realpath(options['--baseline-engine']),current:await realpath(options['--current-engine']??project)},identities={};
for(const label of Object.keys(engines))identities[label]=JSON.parse(await readFile(options['--'+label+'-identity']));
const destination=path.resolve(options['--output']);await mkdir(path.dirname(destination),{recursive:true});await mkdir(destination);
for(const observation of Object.values(observations)){const relative=path.relative(await realpath(observation),await realpath(destination));assert.ok(relative==='..'||relative.startsWith('../')||path.isAbsolute(relative),'Output must remain outside originals');}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),observerFiles=['production-cache-git.mjs','production-history-blobs.mjs','production-history-inputs.mjs','graph-json-artifact.mjs','production-cache-measure.mjs','production-cache-results.mjs','production-graph-digest.mjs','production-cache-worker.mjs','observe-production-cache.mjs','process-memory.mjs','production-head-graphs.mjs','production-source-contracts.mjs'];
const observer=Object.fromEntries(await Promise.all(observerFiles.map(async name=>[name,sha(await readFile(new URL(name,import.meta.url)))])));
async function verify(){
 for(const [name,digest] of Object.entries(observer))assert.equal(sha(await readFile(new URL(name,import.meta.url))),digest,'Observer changed');
 for(const [label,identity] of Object.entries(identities))for(const row of identity.files){const file=path.resolve(engines[label],row.file);assert.equal(sha(await readFile(file)),row.sha256,'Engine bytes changed: '+label+' '+row.file);}
 for(const metadata of Object.values(gitMetadata.repositories))for(const row of metadata.files)assert.equal(sha(await readFile(path.join(metadata.directory,row.file))),row.sha256,'Isolated Git metadata changed');
}
async function publish(file,value){const pending=path.join(destination,file+'.pending');await writeFile(pending,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n');await rename(pending,path.join(destination,file));}
const receipt={schema:1,startedAt:new Date().toISOString(),completedAt:null,phase:'original-head-cold-cache-warm',repetitions,threshold:1.1,platform:process.platform,architecture:process.arch,node:process.version,execution:'owned TypeScript/Node/WASM and read-only Git metadata; targets never execute',profile:'same six complete byte-verified regular-file trees, pinned configs and 8 MiB source profile; symlinks/gitlinks remain skipped',gitMetadata,modes:'Each cold, population and warm observation is a fresh process using the working-tree API, which includes original Git metrics. Revision mode intentionally disables caching. Population and warm share only their named cache. Index time/RSS end before complete logical digest and source verification.',normalization:'Run UUID/time; reviewed Rust symbol producer 2 to 1; exact ordered proof expansion and storage container only. All other JSON fields/arrays and diagnostics remain.',pollMilliseconds:25,memoryMethod:'all-thread-descendant sampled /proc RSS; shared pages can be counted repeatedly and polling/exits can miss peaks',cacheLimits:{perUnit:2,maxBytes:268435456,maxEntryBytes:67108864},observer,engineIdentities:identities,profiles,manifestSha256:sha(await readFile(path.join(project,'docs/production-source-contracts.json'))),corpusSha256:sha(await readFile(path.join(project,'docs/production-history-corpus.json'))),runs:[],parity:[],comparisons:[],passed:false,productionHistoryQualified:false,nativeWindowsMacOSQualified:false};
await publish('receipt.json',receipt);
async function measure(request,file){
 const log=path.join(destination,path.basename(file)+'.log');
 const env=productionGitEnvironment(gitMetadata.repositories[request.profile.id],request.tree);
 const result=await measureProductionWorker({worker:fileURLToPath(new URL('production-cache-worker.mjs',import.meta.url)),request:file,log,cwd:project,env});
 return {...result,log:path.basename(log)};
}
async function cacheLedger(directory){
 const rows=[];for(const name of (await readdir(directory)).sort()){const file=path.join(directory,name),info=await stat(file);assert.ok(info.isFile());const bytes=await readFile(file);rows.push({name,bytes:bytes.length,sha256:sha(bytes)});}
 assert.ok(rows.reduce((sum,row)=>sum+row.bytes,0)<=receipt.cacheLimits.maxBytes);return rows;
}
let failed=false;
for(const profile of profiles.repositories){
 const original=corpus.repositories.find(row=>row.id===profile.id).revisions.at(-1),observation=observations[profile.id];
 for(let repetition=0;repetition<repetitions;repetition++){
  const labels=repetition%2?['current','baseline']:['baseline','current'],pair={};
  for(const label of labels){
   const unit=profile.id+'-'+label+'-'+repetition,cache=path.join(destination,unit+'-cache');await mkdir(cache);const rows=[];
   for(const mode of ['cold','population','warm']){
    const record={id:profile.id,label,repetition,mode,status:'running',startedAt:new Date().toISOString()};receipt.runs.push(record);await publish('receipt.json',receipt);
    try{
     const space=await statfs(destination);assert.ok(Number(space.bavail)*Number(space.bsize)>=1024*1024*1024,'Less than 1 GiB free; stop without discarding failed evidence');
     await verify();record.originalBefore=await inspectHeadTree(observation,original);
     const request={implementation:engines[label],tree:record.originalBefore.tree,observation,profile,mode,cache,manifest:{...manifest,contracts:manifest.contracts.filter(row=>row.repository===profile.id)},corpus};
     const file=path.join(destination,unit+'-'+mode+'-request.json');await writeFile(file,JSON.stringify(request));
     Object.assign(record,await measure(request,file));record.originalAfter=await inspectHeadTree(observation,original);assert.deepEqual(record.originalAfter,record.originalBefore,'Original inputs changed');await verify();record.status='complete';rows.push(record);
    }catch(error){record.status='failed';record.error=error.message;if(error.worker)record.worker=error.worker;failed=true;}
    record.completedAt=new Date().toISOString();await publish('receipt.json',receipt);
    if(record.status==='failed')break;
   }
   if(rows.length===3){
    try{const ledger=await cacheLedger(cache);await publish(unit+'-cache-ledger.json',ledger);pair[label]={rows,cache};}
    catch(error){receipt.runs.push({id:profile.id,label,repetition,mode:'cache-ledger',status:'failed',error:error.message});failed=true;}
   }else failed=true;
   // A failed unit retains its actual cache. Successful bytes can be
   // regenerated from pinned originals and exact engine identities; retain
   // their complete compressed-byte ledger and graph/event receipts.
  }
  const complete=!!pair.baseline&&!!pair.current,equal=complete&&[...pair.baseline.rows,...pair.current.rows].every(row=>row.logical.sha256===pair.baseline.rows[0].logical.sha256);
  receipt.parity.push({id:profile.id,repetition,complete,equal,reason:equal?'Every complete cold/population/warm graph matches both producers':'Incomplete or unequal complete logical graphs; actual caches remain retained'});
  if(equal)for(const value of Object.values(pair))await rm(value.cache,{recursive:true});
  else failed=true;
  await publish('receipt.json',receipt);
 }
}
Object.assign(receipt,qualifyProductionRuns(receipt.runs,profiles.repositories.map(row=>row.id),repetitions));
receipt.completedAt=new Date().toISOString();receipt.passed=!failed&&receipt.passed;await publish('receipt.json',receipt);
console.log(JSON.stringify({output:destination,passed:receipt.passed,comparisons:receipt.comparisons}));
if(!receipt.passed)process.exitCode=1;
