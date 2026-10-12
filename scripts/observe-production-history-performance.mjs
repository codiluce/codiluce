// Three or more counterbalanced fresh processes for each implementation and
// full original history. Successful owned states retire only after independent
// complete column and full graph verification; failed evidence stays intact.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {copyFile,lstat,mkdir,readFile,realpath,rename,rm,statfs,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {stringify} from 'yaml';
import {productionGitEnvironment} from './production-cache-git.mjs';
import {measureProductionWorker} from './production-cache-measure.mjs';
import {qualifyHistoryPerformance} from './production-history-performance-results.mjs';
import {readRevision,validateCorpus} from './production-history-inputs.mjs';

const project=fileURLToPath(new URL('../',import.meta.url)),execute=promisify(execFile),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fileHash(file){const digest=createHash('sha256');for await(const bytes of createReadStream(file))digest.update(bytes);return digest.digest('hex');}
const outside=(root,file)=>{const relative=path.relative(root,file);return relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative);};
async function regular(file){assert.equal(await realpath(file),file);assert.equal((await lstat(file)).isFile(),true);}

/** A file ledger omits empty directories. Git still requires refs alongside
 * HEAD and objects to recognize the fresh owned metadata as a repository. */
export async function copyHistoryPerformanceGit(group,directory){
 assert.equal(await realpath(group.directory),group.directory);assert.equal(await realpath(path.dirname(directory)),path.dirname(directory));assert.ok(outside(group.directory,directory));
 await mkdir(directory);await mkdir(path.join(directory,'refs'));
 for(const item of group.files){const source=path.resolve(group.directory,item.file),target=path.resolve(directory,item.file);assert.ok(!outside(group.directory,source)&&!outside(directory,target));await regular(source);assert.equal(await fileHash(source),item.sha256);await mkdir(path.dirname(target),{recursive:true});await copyFile(source,target);assert.equal(await fileHash(target),item.sha256);}
 return {...group,directory};
}

export async function observeHistoryPerformance(options,sources){
 assert.equal(process.platform,'linux');const repetitions=Number(options.repetitions??3);assert.ok(Number.isSafeInteger(repetitions)&&repetitions>=3&&repetitions<=20);
 const frozen=new Map(),load=async file=>{file=path.resolve(file);await regular(file);const bytes=await readFile(file),digest=sha(bytes);if(frozen.has(file))assert.equal(frozen.get(file),digest);frozen.set(file,digest);return {file,bytes,value:JSON.parse(bytes)};};
 const [qualified,baselineInput,corpusInput,profilesInput,metadataInput]=await Promise.all([load(options.qualification),load(options.baseline),load(options.corpus??path.join(project,'docs/production-history-corpus.json')),load(options.profiles??path.join(project,'docs/production-head-profiles.json')),load(options.gitMetadata)]);
 const corpus=validateCorpus(corpusInput.value),baseline=baselineInput.value,profiles=profilesInput.value,qualification=qualified.value,metadata=metadataInput.value;
 assert.equal(qualification.passed,true);assert.ok(qualification.completedAt);assert.equal(qualification.full195RevisionEntrypointQualified,true);assert.equal(qualification.artifacts.find(r=>r.file===baselineInput.file)?.sha256,sha(baselineInput.bytes));
 assert.equal(baseline.passed,true);assert.ok(baseline.completedAt);assert.equal(baseline.corpusSha256,sha(corpusInput.bytes));assert.equal(baseline.profilesSha256,sha(profilesInput.bytes));assert.ok(metadata.completedAt);
 assert.deepEqual(corpus.repositories.map(r=>r.id).sort(),['axum','bookstack','firefly-iii','flask','full-stack-fastapi','memos']);for(const r of corpus.repositories){assert.equal(r.revisions.length,32);assert.equal(r.extraRevisions.length,r.id==='flask'?3:0);}
 assert.deepEqual(Object.keys(sources).sort(),corpus.repositories.map(r=>r.id).sort());
 const freshFile=qualification.artifacts.find(r=>r.file.endsWith('/corpus/receipt.json'));assert.ok(freshFile);const fresh=await load(freshFile.file);assert.equal(sha(fresh.bytes),freshFile.sha256);assert.equal(fresh.value.full195RevisionEntrypointQualified,true);
 assert.equal(qualification.engineSha256,fresh.value.engineIdentity.sha256);assert.equal(qualification.baselineEngineSha256,baseline.engineIdentity.sha256);
 const engines={baseline:await realpath(options.baselineEngine),current:await realpath(options.currentEngine??project)},identities={baseline:baseline.engineIdentity,current:fresh.value.engineIdentity},destination=path.resolve(options.output);
 assert.equal(await realpath(path.dirname(destination)),path.dirname(destination));for(const root of [path.dirname(baselineInput.file),path.dirname(fresh.file),...await Promise.all(Object.values(sources).map(s=>realpath(s)))])assert.ok(outside(root,destination));
 for(const identity of Object.values(identities)){assert.equal(sha(JSON.stringify(identity.files)),identity.sha256);assert.equal(identity.node,process.version);assert.equal(identity.platform,process.platform);assert.equal(identity.architecture,process.arch);}
 const scripts=['observe-production-history-performance.mjs','production-history-performance-worker.mjs','production-history-performance-results.mjs','audit-history-performance-columns.py','audit-history-columns.py','production-cache-measure.mjs','process-memory.mjs','production-cache-git.mjs','production-history-storage.mjs','production-history-storage-ledger.mjs','production-graph-digest.mjs','production-history-inputs.mjs'];
 for(const name of scripts){const file=path.join(project,'scripts',name);await regular(file);frozen.set(file,await fileHash(file));}
 for(const row of qualification.databases){await regular(row.file);assert.equal(await fileHash(row.file),row.sha256);frozen.set(row.file,row.sha256);}
 const verify=async()=>{
  for(const [file,digest] of frozen)assert.equal(await fileHash(file),digest,'Frozen evidence changed');
  for(const [label,identity] of Object.entries(identities))for(const row of identity.files){const file=path.resolve(engines[label],row.file);assert.ok(!outside(engines[label],file));await regular(file);assert.equal(await fileHash(file),row.sha256,'Frozen '+label+' engine changed');}
  for(const group of Object.values(metadata.repositories))for(const row of group.files)assert.equal(await fileHash(path.join(group.directory,row.file)),row.sha256);
 };
 await verify();await mkdir(destination);
 const receipt={schema:1,startedAt:new Date().toISOString(),passed:false,phase:'repeated-full-original-fresh-indexHistory-time-and-tree-RSS',repetitions,threshold:1.1,engineIdentities:identities,qualificationSha256:sha(qualified.bytes),baselineReceiptSha256:sha(baselineInput.bytes),corpusSha256:sha(corpusInput.bytes),profilesSha256:sha(profilesInput.bytes),frozen:Object.fromEntries(frozen),runs:[],comparisons:[],relativeHistoryTimeRssQualified:false,nativeWindowsMacOSQualified:false,method:'Counterbalanced baseline/current fresh Node processes, actual empty-store indexHistory jobs=2 on all original revisions. Time and all-descendant /proc RSS stop before any full graph/column audit. Every saved graph matches the independently qualified original after changing only run UUID/time; every raw snapshot column is independently streamed by Python. Successful owned databases retire after complete verification; failures remain. Operating-system filesystem cache is not flushed; shared RSS pages may be counted more than once and short peaks may be missed. Targets never execute.'};
 const publish=async()=>{const temporary=path.join(destination,'receipt.json.pending');await writeFile(temporary,JSON.stringify(receipt,null,2)+'\n');await rename(temporary,path.join(destination,'receipt.json'));};await publish();
 let failed=false;
 outer:for(const specification of corpus.repositories){
  const record=baseline.repositories.find(r=>r.id===specification.id),group=metadata.repositories[specification.id];assert.ok(record&&group);assert.equal(group.commit,specification.head);assert.deepEqual(record.config,profiles.repositories.find(r=>r.id===specification.id).config);assert.equal(record.config.maxFileBytes,8*1024*1024);assert.deepEqual(record.revisions.map(r=>r.commit),[...specification.revisions,...specification.extraRevisions].map(r=>r.commit));
  for(const revision of [...specification.revisions,...specification.extraRevisions]){const {reason,...expected}=revision;assert.deepEqual(await readRevision(sources[specification.id],revision.commit),expected);}
  for(let repetition=0;repetition<repetitions;repetition++)for(const label of repetition%2?['current','baseline']:['baseline','current']){
   const name=specification.id+'-'+label+'-'+repetition,unit=path.join(destination,name),row={id:specification.id,label,repetition,status:'running',startedAt:new Date().toISOString(),unit:name};receipt.runs.push(row);await publish();
   try{
    await verify();const space=await statfs(destination),database=path.join(path.dirname(baselineInput.file),record.database);assert.ok(Number(space.bavail)*Number(space.bsize)>=(await lstat(database)).size+1024*1024*1024,'Insufficient space for a new history plus 1 GiB reserve');
    const root=path.join(unit,'metadata-root'),state=path.join(unit,'state'),scratch=path.join(unit,'scratch'),git=path.join(unit,'git');for(const directory of [root,state,scratch])await mkdir(directory,{recursive:true});await writeFile(path.join(state,'config.yml'),stringify(record.config));
    const copiedGit=await copyHistoryPerformanceGit(group,git);
    const request={engine:engines[label],root,state,scratch,record,baselineDirectory:path.dirname(baselineInput.file),result:path.join(unit,'worker-result.json')},requestFile=path.join(unit,'request.json');await writeFile(requestFile,JSON.stringify(request,null,2)+'\n',{flag:'wx'});
    Object.assign(row,await measureProductionWorker({worker:path.join(project,'scripts/production-history-performance-worker.mjs'),request:requestFile,log:path.join(unit,'worker.log'),cwd:project,env:{...productionGitEnvironment(copiedGit,root),TMPDIR:scratch}}));assert.equal(row.passed,true);assert.ok(row.processes>=3,'Sampler did not observe the real indexer and both actual history workers');
    row.databaseSha256=await fileHash(row.database);const auditFile=path.join(unit,'columns.json');
    try{await execute('python3',['scripts/audit-history-performance-columns.py','--result',request.result,'--output',auditFile],{cwd:project,maxBuffer:1024*1024});}catch(error){row.auditStdout=error.stdout;row.auditStderr=error.stderr;throw error;}
    row.columns=JSON.parse(await readFile(auditFile));assert.equal(row.columns.passed,true);assert.equal(row.columns.measurementResultSha256,await fileHash(request.result));assert.equal(row.columns.databaseSha256,row.databaseSha256);assert.equal(row.columns.columnAuditorSha256,frozen.get(path.join(project,'scripts/audit-history-columns.py')));assert.equal(row.columns.auditorSha256,frozen.get(path.join(project,'scripts/audit-history-performance-columns.py')));
    for(const item of group.files)assert.equal(await fileHash(path.join(git,item.file)),item.sha256);await verify();assert.equal(await fileHash(row.database),row.databaseSha256);row.status='complete';row.retirement={databaseSha256:row.databaseSha256,afterCompleteGraphAndIndependentColumns:true};await publish();
    await rm(state,{recursive:true});await rm(scratch,{recursive:true});row.retirement.completedAt=new Date().toISOString();
   }catch(error){row.status='failed';row.error=error.message;if(error.worker)row.worker=error.worker;failed=true;}
   row.completedAt=new Date().toISOString();await publish();if(failed)break outer;
  }
 }
 Object.assign(receipt,qualifyHistoryPerformance(receipt.runs,corpus,baseline,repetitions));receipt.passed=!failed&&receipt.passed;receipt.relativeHistoryTimeRssQualified=receipt.passed;receipt.completedAt=new Date().toISOString();await verify();await publish();return receipt;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const options={},sources={},names={'--qualification':'qualification','--baseline':'baseline','--baseline-engine':'baselineEngine','--current-engine':'currentEngine','--git-metadata':'gitMetadata','--output':'output','--repetitions':'repetitions','--corpus':'corpus','--profiles':'profiles'};
 for(let i=2;i<process.argv.length;i+=2){const flag=process.argv[i],value=process.argv[i+1];assert.ok(value&&!value.startsWith('--'));if(flag==='--source'){const at=value.indexOf('=');assert.ok(at>0&&!Object.hasOwn(sources,value.slice(0,at)));sources[value.slice(0,at)]=path.resolve(value.slice(at+1));}else{assert.ok(names[flag]&&!Object.hasOwn(options,names[flag]));options[names[flag]]=value;}}
 const result=await observeHistoryPerformance(options,sources);console.log(JSON.stringify({passed:result.passed,comparisons:result.comparisons}));if(!result.passed)process.exitCode=1;
}
