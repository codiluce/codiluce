// Independent, read-only audit of completed production-history observations.
// Does not import the observer's digest or snapshot reader. Never executes targets.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {access,lstat,readFile,realpath,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {readGit,validateCorpus} from './production-history-inputs.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const groups={entities:['entity','entity_id'],relations:['relation','relation_id'],diagnostics:['diagnostic','id']};
const symbols=new Set(['class','controller','component','function','method','model','test']);
const compare=(a,b)=>a<b?-1:a>b?1:0;
async function fileHash(file){const digest=createHash('sha256');for await(const bytes of createReadStream(file))digest.update(bytes);return digest.digest('hex');}
async function walIdentity(file){try{const info=await lstat(file+'-wal');assert.ok(info.isFile()&&!info.isSymbolicLink());return {bytes:info.size,sha256:await fileHash(file+'-wal')};}catch(error){if(error.code==='ENOENT')return null;throw error;}}

export async function verifyProductionHistoryRunInputs({receipt,corpusBytes,profilesBytes,engine}){
 assert.equal(receipt.corpusSha256,hash(corpusBytes));assert.equal(receipt.profilesSha256,hash(profilesBytes));
 const profiles=JSON.parse(profilesBytes),corpus=validateCorpus(JSON.parse(corpusBytes));assert.equal(profiles.schema,1);
 const identity=receipt.engineIdentity;assert.ok(Array.isArray(identity.files)&&identity.files.length>0);assert.equal(identity.sha256,hash(JSON.stringify(identity.files)));assert.equal(new Set(identity.files.map(row=>row.file)).size,identity.files.length);
 engine=await realpath(engine);
 for(const row of identity.files){const file=path.resolve(engine,row.file);assert.ok(file.startsWith(engine+path.sep));assert.equal(await realpath(file),file,'Engine input crosses an alias');assert.equal(await fileHash(file),row.sha256,'Qualified engine input changed');}
 for(const required of ['src/history/worker.ts','src/history/git.ts','src/history/indexer.ts','src/history/store.ts'])assert.ok(identity.files.some(row=>row.file===required));
 const expected=['observe-production-history.mjs','production-history-tree.mjs','production-history-storage.mjs','production-graph-digest.mjs','production-cache-git.mjs','production-history-inputs.mjs','production-history-blobs.mjs','graph-json-artifact.mjs','process-memory.mjs'];
 if(Object.hasOwn(receipt.observer,'production-history-recovery.mjs'))expected.push('production-history-recovery.mjs');
 assert.deepEqual(Object.keys(receipt.observer).sort(),expected.sort());
 for(const [name,digest] of Object.entries(receipt.observer))assert.equal(await fileHash(fileURLToPath(new URL(name,import.meta.url))),digest,'Frozen observer input changed');
 for(const record of receipt.repositories){const specification=corpus.repositories.find(row=>row.id===record.id),profile=profiles.repositories.find(row=>row.id===record.id);assert.ok(specification&&profile);assert.equal(profile.commit,specification.head);assert.equal(profile.config.maxFileBytes,8*1024*1024);assert.deepEqual(record.config,profile.config,'Actual worker configuration differs from the pinned profile');}
 return {engineSha256:identity.sha256,engineFiles:identity.files.length,observerFiles:expected.length,corpusSha256:hash(corpusBytes),profilesSha256:hash(profilesBytes)};
}

/** A separate JSON token implementation for JSON.parse data. Object keys sort
 * by JavaScript string order; array order, escapes and every field stay exact.
 * There is no Rust interpretation or normalization in this implementation. */
function* jsonTokens(value,depth=0){
 assert.ok(depth<512,'Independent JSON nesting budget exceeded');
 if(value===null||typeof value!=='object'){const text=JSON.stringify(value);assert.equal(typeof text,'string');yield text;return;}
 if(Array.isArray(value)){
  yield '[';for(let index=0;index<value.length;index++){if(index)yield ',';yield* jsonTokens(value[index],depth+1);}yield ']';return;
 }
 assert.equal(Object.getPrototypeOf(value),Object.prototype,'Only parsed JSON objects are accepted');
 yield '{';const keys=Object.keys(value).sort();for(let index=0;index<keys.length;index++){if(index)yield ',';yield JSON.stringify(keys[index]);yield ':';yield* jsonTokens(value[keys[index]],depth+1);}yield '}';
}

export function independentHistoryJSONDigest(run,records,{maxBytes=1024*1024*1024}={}){
 assert.ok(Number.isSafeInteger(maxBytes)&&maxBytes>0);assert.equal(run.schemaVersion,1);
 assert.deepEqual(Object.keys(records).sort(),Object.keys(groups).sort());
 const digest=createHash('sha256');let bytes=0;const counts={};
 const emit=token=>{bytes+=Buffer.byteLength(token);assert.ok(bytes<=maxBytes,'Independent JSON byte budget exceeded');digest.update(token);};
 emit('{"schemaVersion":1,"run":');for(const token of jsonTokens(run))emit(token);
 for(const group of Object.keys(groups)){
  emit(',"'+group+'":[');let previous,count=0;
  for(const row of records[group]){
   assert.equal(typeof row.id,'string');assert.ok(previous===undefined||previous<row.id,'Independent records have duplicate or unsorted identities');previous=row.id;
   if(count++)emit(',');for(const token of jsonTokens(row))emit(token);
  }
  counts[group]=count;emit(']');
 }
 emit('}');return {sha256:digest.digest('hex'),bytes,counts,normalization:[]};
}

async function originalReceipt(source,revision,file,blobCache){
 const original=JSON.parse(await readFile(file));
 assert.equal(original.schema,1);assert.equal(original.commit,revision.commit);assert.equal(original.tree,revision.tree);
 assert.equal(original.allOriginalBytesVerified,true);assert.equal(original.symlinkTargetsFollowed,false);
 assert.equal(original.recordDigest,hash(JSON.stringify(original.entries)),'Original receipt record digest differs');
 const inventory=await readGit(source,['ls-tree','-r','-z','--full-tree',revision.commit],{binary:true});
 assert.equal(hash(inventory),revision.inventory.sha256);assert.equal(original.inventorySha256,revision.inventory.sha256);
 const expected=[];let start=0;
 for(let end=0;end<inventory.length;end++)if(inventory[end]===0){
  const row=inventory.subarray(start,end),tab=row.indexOf(9);start=end+1;assert.ok(tab>0);
  const match=/^(100644|100755|120000|160000) (blob|commit) ([a-f\d]{40}|[a-f\d]{64})$/.exec(row.subarray(0,tab).toString('ascii'));assert.ok(match);
  const [,mode,type,object]=match;assert.equal(type,mode==='160000'?'commit':'blob');const filename=row.subarray(tab+1);
  expected.push({path:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(filename),pathBytesHex:filename.toString('hex'),mode,object});
 }
 assert.equal(start,inventory.length);expected.sort((a,b)=>compare(a.path,b.path));assert.equal(expected.length,revision.inventory.entries);assert.equal(original.entries.length,expected.length);
 let bytes=0,regular=0,symlinks=0,gitlinks=0;
 for(let index=0;index<expected.length;index++){
  const entry=original.entries[index],identity=expected[index];for(const [key,value] of Object.entries(identity))assert.equal(entry[key],value,'Original receipt Git entry differs');
  if(entry.mode==='160000'){assert.equal(entry.status,'unhydrated-gitlink');gitlinks++;continue;}
  assert.equal(entry.status,entry.mode==='120000'?'literal-symlink-not-followed':'original-regular-bytes');
  let blob=blobCache.get(entry.object);
  if(!blob){
   const data=await readGit(source,['cat-file','blob',entry.object],{binary:true});assert.ok(data.length<=8*1024*1024,'Original blob exceeds the observation profile');
   assert.equal(createHash(entry.object.length===40?'sha1':'sha256').update('blob '+data.length+'\0').update(data).digest('hex'),entry.object);
   blob={bytes:data.length,sha256:hash(data)};blobCache.set(entry.object,blob);
  }
  assert.equal(entry.bytes,blob.bytes,'Original receipt byte length differs');assert.equal(entry.sha256,blob.sha256,'Original receipt SHA-256 differs');bytes+=blob.bytes;
  if(entry.mode==='120000')symlinks++;else regular++;
 }
 assert.deepEqual({regular,symlinks,gitlinks},{regular:revision.inventory.regularFiles,symlinks:revision.inventory.symlinks,gitlinks:revision.inventory.gitlinks});
 assert.equal(original.regularFiles,regular);assert.equal(original.literalSymlinks,symlinks);assert.equal(original.unhydratedGitlinks,gitlinks);assert.equal(original.originalBytes,bytes);
 return original;
}

/** Completed units only: a still-running worker/database must never qualify. */
export async function auditProductionHistoryRepository({specification,record,directory,source}){
 assert.equal(record.id,specification.id);assert.equal(record.head,specification.head);assert.equal(record.status,'verified','Only completed verified repository observations may be audited');
 assert.equal(record.error,null);assert.equal(record.worker.exitCode,0);assert.equal(record.worker.signal,null);assert.equal(record.readOnlyReopenVerified,true);assert.ok(record.completedAt);
 assert.ok(record.worker.samples>0&&record.worker.treePeakKiB>0);assert.ok(Number.isSafeInteger(record.worker.pid)&&record.worker.pid>0);
 if(process.platform==='linux'){
  let live=true;try{await access('/proc/'+record.worker.pid);}catch(error){assert.equal(error.code,'ENOENT');live=false;}
  assert.equal(live,false,'Observed worker is still live; refuse to audit mutable database bytes');
 }
 const selected=[...specification.revisions,...specification.extraRevisions];assert.equal(record.expectedRevisions,selected.length);assert.deepEqual(record.revisions.map(row=>row.commit),selected.map(row=>row.commit));
 directory=await realpath(directory);source=await realpath(source);const database=path.resolve(directory,record.database);
 assert.equal(database,path.join(directory,specification.id,'state','history.db'));assert.equal(await realpath(database),database,'Database path crosses an alias');
 const databaseBefore=await fileHash(database),walBefore=await walIdentity(database),db=new DatabaseSync(database,{readOnly:true}),blobCache=new Map(),versions=Object.fromEntries(Object.keys(groups).map(group=>[group,new Set()]));
 const result={id:specification.id,status:'auditing',database:record.database,databaseSha256:databaseBefore,wal:walBefore,originalBlobObjects:0,revisions:[],method:'Independent JSON token hashing, raw complete SQLite payloads, original Git blob identities and SHA-256, integrity/membership/metadata/statistics checks; no target execution or UI projection',relativeHistoryTimeRssQualified:false,layoutResumeQualified:false,nativeWindowsMacOSQualified:false};
 try{
  db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=10000; BEGIN');assert.equal(db.prepare('PRAGMA user_version').get().user_version,1);
  assert.deepEqual(db.prepare('PRAGMA integrity_check').all().map(row=>row.integrity_check),['ok']);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  const count=table=>Number(db.prepare('SELECT count(*) AS n FROM '+table).get().n);
  assert.equal(count('snapshots'),selected.length);assert.equal(count('commits'),selected.length);assert.equal(count('timelines'),1);
  const timeline=db.prepare('SELECT * FROM timelines WHERE ref=?').get(specification.head);assert.ok(timeline);assert.equal(timeline.head,specification.head);assert.equal(timeline.first_parent,1);assert.deepEqual(JSON.parse(timeline.commits),specification.revisions.map(row=>row.commit));
  assert.equal(db.prepare("SELECT value FROM meta WHERE key='default_ref'").get().value,specification.head);
  const repository=db.prepare("SELECT value FROM meta WHERE key='repository_id'").get().value;
  for(const [group,[singular]] of Object.entries(groups)){
   assert.equal(db.prepare(`SELECT count(*) AS n FROM snapshot_${group} m LEFT JOIN snapshots s ON s.seq=m.snapshot LEFT JOIN ${singular}_versions v ON v.vid=m.version WHERE s.seq IS NULL OR v.vid IS NULL`).get().n,0,'Dangling snapshot membership');
   assert.equal(db.prepare(`SELECT count(*) AS n FROM ${singular}_versions v WHERE NOT EXISTS (SELECT 1 FROM snapshot_${group} m WHERE m.version=v.vid)`).get().n,0,'Unreferenced payload version');
  }
  for(let index=0;index<selected.length;index++){
   const revision=selected[index],observed=record.revisions[index];assert.equal(observed.status,'verified');assert.ok(observed.completedAt);assert.deepEqual(observed.logical.normalization,[]);assert.deepEqual(observed.readback,observed.logical);
   const original=await originalReceipt(source,revision,path.join(directory,specification.id,revision.commit+'-original.json'),blobCache);
   assert.deepEqual(observed.original,{recordDigest:original.recordDigest,regularFiles:original.regularFiles,literalSymlinks:original.literalSymlinks,unhydratedGitlinks:original.unhydratedGitlinks,originalBytes:original.originalBytes});
   const fields=(await readGit(source,['show','-s','--format=%H%x00%T%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%s%x00%b',revision.commit,'--'])).trimEnd().split('\0');assert.equal(fields.length,9);
   const commit=db.prepare('SELECT * FROM commits WHERE sha=?').get(revision.commit);assert.ok(commit);
   assert.deepEqual([commit.sha,commit.tree,JSON.parse(commit.parents).join(' '),commit.author_name,commit.author_email,commit.authored_at,commit.committed_at,commit.subject,commit.body],fields.map((field,i)=>i===8?field.trim():field));assert.equal(commit.tree,revision.tree);assert.deepEqual(JSON.parse(commit.parents),revision.parents);
   const snapshot=db.prepare('SELECT * FROM snapshots WHERE id=?').get(observed.snapshot.id);assert.ok(snapshot);assert.equal(snapshot.seq,index+1);assert.equal(snapshot.seq,observed.snapshot.seq);assert.equal(snapshot.commit_sha,revision.commit);assert.equal(snapshot.identity,record.historyIdentity);
   const run=JSON.parse(snapshot.run),stats=JSON.parse(snapshot.stats);assert.equal(run.id,snapshot.id);assert.equal(run.commitSha,revision.commit);assert.equal(run.analyzedAt,snapshot.analyzed_at);assert.equal(run.repositoryId,repository);assert.deepEqual(stats,observed.snapshot.stats);
   const measured={entities:0,relations:0,diagnostics:0,errors:0,files:0,symbols:0,endpoints:0,loc:0,newVersions:0,applications:[]},records={},originalFiles=new Map(original.entries.map(row=>[row.path,row]));let hashed=0;
   const memberships=Object.fromEntries(Object.entries(groups).map(([group,[singular,key]])=>[group,db.prepare(`SELECT v.vid,v.${key} AS id FROM snapshot_${group} m JOIN ${singular}_versions v ON v.vid=m.version WHERE m.snapshot=?`).all(snapshot.seq).sort((a,b)=>compare(a.id,b.id))]));
   const entityIds=new Set(memberships.entities.map(row=>row.id));
   for(const [group,[singular]] of Object.entries(groups)){
    const payload=db.prepare(`SELECT data FROM ${singular}_versions WHERE vid=?`);
    records[group]={*[Symbol.iterator](){for(const member of memberships[group]){
     const value=JSON.parse(payload.get(member.vid).data);assert.equal(value.id,member.id,'Stored payload identity differs');measured[group]++;
     if(!versions[group].has(member.vid)){versions[group].add(member.vid);measured.newVersions++;}
     if(group==='entities'){
      if(value.type==='file'){
       measured.files++;measured.loc+=value.metrics?.loc??0;const entry=originalFiles.get(value.path);assert.ok(entry&&['100644','100755'].includes(entry.mode),'Stored graph file is not an original regular input');assert.equal(value.metadata.bytes,entry.bytes);
       if(value.metadata.contentHash!==undefined){assert.equal(value.metadata.contentHash,entry.sha256,'Stored indexed source-byte hash differs');hashed++;}
      }else if(symbols.has(value.type))measured.symbols++;else if(['route','api_endpoint'].includes(value.type))measured.endpoints++;
      if(value.type==='application')measured.applications.push(value.name);
      if(value.parentId!==undefined)assert.ok(entityIds.has(value.parentId),'Unknown stored parent entity');
     }else if(group==='relations'){assert.ok(entityIds.has(value.from)&&entityIds.has(value.to),'Unknown stored relationship endpoint');}
     else if(value.severity==='error')measured.errors++;
     yield value;
    }}};
   }
   const exact=independentHistoryJSONDigest(run,records);assert.deepEqual(exact,{sha256:observed.logical.sha256,bytes:observed.logical.bytes,counts:observed.logical.counts,normalization:[]},'Independent exact JSON digest differs from actual worker output');
   measured.applications.sort();for(const [key,value] of Object.entries(measured))assert.deepEqual(stats[key],value,'Stored snapshot statistic differs: '+key);
   assert.deepEqual(observed.graphInputs,{commit:revision.commit,fileEntities:measured.files,hashedOriginalSources:hashed,originalSymlinksExcludedFromFileEntities:true});
   assert.equal(stats.durationMs,Math.round(observed.analysisDurationMs));assert.equal(stats.applicationSource,observed.applications.source);assert.deepEqual(stats.substitutedApplications??{},observed.applications.substituted);assert.deepEqual(stats.missingApplications??[],observed.applications.missing);
   result.revisions.push({commit:revision.commit,seq:snapshot.seq,id:snapshot.id,exact,originalRecordDigest:original.recordDigest,sourceFiles:measured.files,hashedOriginalSources:hashed,newVersions:measured.newVersions});
  }
  const storage={snapshots:count('snapshots'),commits:count('commits'),versions:{},memberships:{},pullRequests:count('pull_requests'),bytes:Number(db.prepare('PRAGMA page_count').get().page_count)*Number(db.prepare('PRAGMA page_size').get().page_size)};
  for(const [group,[singular]] of Object.entries(groups)){storage.versions[group]=count(singular+'_versions');storage.memberships[group]=count('snapshot_'+group);assert.equal(storage.versions[group],versions[group].size);}
  assert.deepEqual(storage,record.storage);result.storage=storage;result.originalBlobObjects=blobCache.size;result.status='verified';result.completedAt=new Date().toISOString();
 }finally{db.close();}
 assert.equal(await fileHash(database),databaseBefore,'Read-only audit database changed');const walAfter=await walIdentity(database);
 // SQLite can create a zero-byte WAL for a read-only open. Preserve that
 // observation; only absent/empty sidecars are equivalent in frame content.
 if((walBefore?.bytes??0)||(walAfter?.bytes??0))assert.deepEqual(walAfter,walBefore,'Read-only audit WAL data changed');result.walAfter=walAfter;return result;
}

export async function auditProductionHistory({corpus,receipt,directory,sources,repository,runInputs}){
 validateCorpus(corpus);assert.equal(receipt.schema,1);assert.equal(receipt.platform,'linux');
 const selected=repository?corpus.repositories.filter(row=>row.id===repository):corpus.repositories;assert.ok(selected.length);
 assert.deepEqual(Object.keys(sources).sort(),selected.map(row=>row.id).sort());
 assert.equal(new Set(receipt.repositories.map(row=>row.id)).size,receipt.repositories.length);
 const result={schema:1,startedAt:new Date().toISOString(),scope:repository?'completed-repository':'complete-selected-corpus',runInputs:runInputs??null,repositories:[],passed:false,full195RevisionGateQualified:false,relativeHistoryTimeRssQualified:false,layoutResumeQualified:false,nativeWindowsMacOSQualified:false};
 for(const specification of selected){
  const record=receipt.repositories.find(row=>row.id===specification.id);assert.ok(record,'Repository observation is missing');
  result.repositories.push(await auditProductionHistoryRepository({specification,record,directory,source:sources[specification.id]}));
 }
 result.passed=true;result.completedAt=new Date().toISOString();
 result.full195RevisionGateQualified=!repository&&Boolean(runInputs)&&receipt.passed===true&&Boolean(receipt.completedAt)&&selected.length===6&&result.repositories.reduce((n,row)=>n+row.revisions.length,0)===195;
 return result;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const options={},sources={},args=process.argv.slice(2);
 for(let i=0;i<args.length;i++){
  const flag=args[i],value=args[++i];assert.ok(value&&!value.startsWith('--'));
  if(flag==='--source'){const at=value.indexOf('=');assert.ok(at>0&&!Object.hasOwn(sources,value.slice(0,at)));sources[value.slice(0,at)]=path.resolve(value.slice(at+1));}
  else{assert.ok(['--corpus','--profiles','--engine','--receipt','--repository','--output'].includes(flag)&&!Object.hasOwn(options,flag));options[flag]=value;}
 }
 const corpusFile=path.resolve(options['--corpus']??fileURLToPath(new URL('../docs/production-history-corpus.json',import.meta.url))),receiptFile=path.resolve(options['--receipt']),output=path.resolve(options['--output']),before=await readFile(fileURLToPath(import.meta.url));
 assert.equal(await realpath(path.dirname(output)),path.dirname(output),'Audit output parent must be an existing unaliased directory');
 for(const root of [await realpath(path.dirname(receiptFile)),...await Promise.all(Object.values(sources).map(source=>realpath(source)))]){const relative=path.relative(root,output);assert.ok(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative),'Audit output must remain outside original inputs and the observation');}
 const receiptBytes=await readFile(receiptFile);
 let result,inputSnapshot;
 try{
  const corpusBytes=await readFile(corpusFile),profilesBytes=await readFile(path.resolve(options['--profiles']??fileURLToPath(new URL('../docs/production-head-profiles.json',import.meta.url)))),corpus=JSON.parse(corpusBytes),receipt=JSON.parse(receiptBytes),engine=path.resolve(options['--engine']??fileURLToPath(new URL('../',import.meta.url)));
  // The parent receipt can advance while a closed repository is audited.
  // Retain the exact bytes we actually read, rather than hashing a later state.
  const inputs={schema:1,engine,files:{}};
  for(const [name,bytes] of Object.entries({corpus:corpusBytes,profiles:profilesBytes,receipt:receiptBytes})){const utf8=bytes.toString('utf8');assert.ok(Buffer.from(utf8).equals(bytes));inputs.files[name]={sha256:hash(bytes),utf8};}
  const inputBytes=Buffer.from(JSON.stringify(inputs,null,2)+'\n');await writeFile(output+'.inputs.json',inputBytes,{flag:'wx'});inputSnapshot={file:path.basename(output)+'.inputs.json',bytes:inputBytes.length,sha256:hash(inputBytes)};
  const runInputs=await verifyProductionHistoryRunInputs({receipt,corpusBytes,profilesBytes,engine});
  result=await auditProductionHistory({corpus,receipt,directory:path.dirname(receiptFile),sources,repository:options['--repository'],runInputs});
  assert.deepEqual(await verifyProductionHistoryRunInputs({receipt,corpusBytes:await readFile(corpusFile),profilesBytes:await readFile(path.resolve(options['--profiles']??fileURLToPath(new URL('../docs/production-head-profiles.json',import.meta.url)))),engine}),runInputs,'Run inputs changed during the independent audit');
 }catch(error){result={schema:1,passed:false,full195RevisionGateQualified:false,completedAt:new Date().toISOString(),error:error.message};process.exitCode=1;}
 assert.equal(hash(await readFile(fileURLToPath(import.meta.url))),hash(before),'Auditor changed during observation');result.auditorSha256=hash(before);result.receiptSha256=hash(receiptBytes);result.inputSnapshot=inputSnapshot??null;
 await writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({passed:result.passed,repositories:result.repositories?.map(row=>({id:row.id,revisions:row.revisions.length})),error:result.error,full195RevisionGateQualified:result.full195RevisionGateQualified}));
}
