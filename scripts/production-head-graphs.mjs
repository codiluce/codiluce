// Cold, original-head observations. A reviewed sample pass is not full-corpus
// accuracy, replay/history parity, performance or a native-platform release.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstat,mkdir,readFile,readdir,realpath,rename,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {materializedPathReason} from './production-history-blobs.mjs';
import {validateSourceContracts,verifySourceContracts} from './production-source-contracts.mjs';
import {writeGraphArtifact,GRAPH_ARTIFACT_LIMITS} from './graph-json-artifact.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const outside=(root,destination)=>{const relative=path.relative(root,destination);return relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative);};
async function destinationPath(target){let current=path.resolve(target),tail=[];for(;;){try{return path.join(await realpath(current),...tail.reverse());}catch(error){if(error.code!=='ENOENT')throw error;tail.push(path.basename(current));const parent=path.dirname(current);if(parent===current)throw error;current=parent;}}}
async function publish(directory,name,value){const pending=path.join(directory,name+'.pending');await writeFile(pending,value);await rename(pending,path.join(directory,name));}

/** Rehash every original regular file and reconstruct its Git object identity;
 * reject changed inventories, extra files, aliases and silently missing inputs.
 * Original symlinks remain explicit receipt records and are never followed. */
export async function inspectHeadTree(observation,revision){
  const directory=await realpath(observation),receiptBytes=await readFile(path.join(directory,'receipt.json'));
  const receipt=JSON.parse(receiptBytes),tree=path.join(directory,'tree');assert.equal(await realpath(tree),tree,'Original tree crosses a filesystem alias');
  assert.equal(receipt.schema,1);assert.equal(receipt.commit,revision.commit);assert.equal(receipt.tree,revision.tree);
  assert.equal(receipt.materializationCompleted,true);assert.equal(receipt.verifierUnchanged,true);assert.equal(receipt.allRegularFilesMaterialized,true);
  assert.ok(Array.isArray(receipt.entries)&&receipt.entries.length===revision.inventory.entries&&receipt.entries.length<=100000,'Original inventory is incomplete');
  const expected=new Map(),skipped=[],metadata=[];let bytesTotal=0,symlinks=0,gitlinks=0;
  for(const record of receipt.entries){
    assert.equal(materializedPathReason(record.path),undefined,'Nonportable original path');assert.ok(!expected.has(record.path)&&!skipped.some(item=>item.path===record.path),'Ambiguous original path');
    assert.ok(['100644','100755','120000','160000'].includes(record.mode));assert.match(record.object,/^(?:[a-f\d]{40}|[a-f\d]{64})$/);
    assert.equal(record.pathBytesHex,Buffer.from(record.path).toString('hex'),'Original path bytes differ');
    metadata.push(Buffer.from(`${record.mode} ${record.mode==='160000'?'commit':'blob'} ${record.object}\t${record.path}\0`));
    if(record.mode==='120000'||record.mode==='160000'){
      if(record.mode==='120000'){symlinks++;assert.equal(record.reason,'symlink-not-followed');assert.equal(record.blobIdentityVerified,true);assert.match(record.sha256,/^[a-f\d]{64}$/);}else{gitlinks++;assert.equal(record.reason,'gitlink-not-hydrated');}
      assert.equal(record.status,'skipped');skipped.push(record);continue;
    }
    assert.equal(record.status,'materialized','An original regular file was skipped or failed');assert.equal(record.blobIdentityVerified,true);
    assert.match(record.sha256,/^[a-f\d]{64}$/);assert.equal(record.writtenSha256,record.sha256);assert.ok(Number.isSafeInteger(record.bytes)&&record.bytes>=0&&record.bytes<=8*1024*1024);
    expected.set(record.path,record);
  }
  assert.equal(sha(Buffer.concat(metadata)),revision.inventory.sha256,'Complete original tree metadata differs');
  assert.equal(expected.size,revision.inventory.regularFiles);assert.equal(symlinks,revision.inventory.symlinks);assert.equal(gitlinks,revision.inventory.gitlinks);
  const found=[];
  async function walk(relative=''){
    for(const entry of await readdir(path.join(tree,relative),{withFileTypes:true})){
      const name=relative?relative+'/'+entry.name:entry.name,absolute=path.join(tree,name),info=await lstat(absolute);
      assert.ok(!info.isSymbolicLink(),'Original tree contains a filesystem alias');
      if(info.isDirectory()){assert.ok([...expected.keys()].some(file=>file.startsWith(name+'/')),'Unexpected original directory');await walk(name);continue;}
      assert.ok(info.isFile(),'Original tree contains a nonregular file');assert.equal(await realpath(absolute),absolute,'Original file crosses a filesystem alias');const record=expected.get(name);assert.ok(record,'Unexpected original file');assert.equal(info.size,record.bytes);
      const bytes=await readFile(absolute);assert.equal(bytes.length,record.bytes);assert.equal(sha(bytes),record.sha256,'Original regular-file bytes changed');
      const algorithm=record.object.length===40?'sha1':'sha256',object=createHash(algorithm).update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');assert.equal(object,record.object,'Original Git blob identity differs');
      bytesTotal+=bytes.length;assert.ok(bytesTotal<=512*1024*1024,'Original tree exceeds the byte profile');found.push([name,record.sha256]);
    }
  }
  await walk();assert.equal(found.length,expected.size,'Original files disappeared');found.sort(([a],[b])=>a<b?-1:a>b?1:0);
  return {tree,receiptSha256:sha(receiptBytes),regularFiles:found.length,originalBytes:bytesTotal,regularFileDigest:sha(JSON.stringify(found)),skipped:skipped.map(({path,mode,object,reason,sha256})=>({path,mode,object,reason,sha256}))};
}

export function validateHeadProfiles(profiles,manifest,corpus){
  validateSourceContracts(manifest,corpus);assert.equal(profiles.schema,1);assert.ok(Array.isArray(profiles.repositories));
  const ids=new Set(manifest.contracts.map(contract=>contract.repository));assert.equal(profiles.repositories.length,ids.size);
  for(const profile of profiles.repositories){
    assert.ok(ids.delete(profile.id),'Unknown or duplicate source profile');const repository=corpus.repositories.find(item=>item.id===profile.id);
    assert.equal(profile.commit,repository.head,'Head profile must pin the reviewed head');assert.ok(typeof profile.scope==='string'&&profile.scope.trim());
    assert.ok(profile.config?.repository?.name&&profile.config.repository.id);assert.equal(profile.config.maxFileBytes,8*1024*1024);
    assert.ok(Array.isArray(profile.config.ignore)&&Array.isArray(profile.config.applications));
    for(const app of profile.config.applications){assert.ok(app.name&&Array.isArray(app.frameworks)&&Array.isArray(app.ecosystems));assert.ok(app.path==='.'||materializedPathReason(app.path)===undefined,'Unsafe application source root');}
    assert.ok(manifest.contracts.filter(contract=>contract.repository===profile.id).every(contract=>contract.commit===profile.commit));
  }
  return profiles;
}

const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function renderHeadReceipt(receipt){
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Original production head graphs</title><style>body{margin:0;padding:clamp(16px,4vw,40px);font:16px/1.6 system-ui;background:#101822;color:#e5ecf4}main{max-width:1100px;margin:auto}h1{line-height:1.2}.status{padding:16px;border:1px solid #8293a8;border-radius:8px}p,pre{overflow-wrap:anywhere}pre{white-space:pre-wrap;font-size:12px}</style></head><body><main><h1>Original production head graphs</h1><p class="status"><strong>${receipt.reviewedHeadsVerified?'REVIEWED ORIGINAL HEAD CONTRACTS VERIFIED':receipt.completedAt?'ORIGINAL HEAD QUALIFICATION FAILED':'ORIGINAL HEAD QUALIFICATION RUNNING'}</strong><br>Full-corpus accuracy, cache/history parity, performance, broader budgets and native-platform qualification remain pending.</p><p>Cold indexing reads only isolated byte-verified original regular files with an explicit 8 MiB per-file source profile. Original symlinks and gitlinks stay skipped and visible; this profile does not reproduce filesystem symlink diagnostics or prove equality with another history materializer. Each successfully saved graph, original-tree identity, selected configuration, engine identity and independent reviewed contract outcome is retained. Serialization failures and partial artifacts remain unqualified. Elapsed indexing times are observations without a baseline or performance claim.</p><details><summary>All independent outcomes and source identities</summary><pre>${escape(JSON.stringify(receipt,null,2))}</pre></details></main></body></html>`;
}

export async function observeProductionHeads({profiles,manifest,corpus,observations,output,analyze,identity,graphArtifactLimits={}}){
  validateHeadProfiles(profiles,manifest,corpus);assert.equal(typeof analyze,'function');assert.equal(typeof identity,'function');
  const ids=new Set(profiles.repositories.map(item=>item.id));for(const id of Object.keys(observations))assert.ok(ids.has(id),'Unknown original observation');
  const destination=await destinationPath(output);for(const observation of Object.values(observations))assert.ok(outside(await destinationPath(observation),destination),'Output must be outside every original observation');
  await mkdir(path.dirname(destination),{recursive:true});await mkdir(destination);
  const receipt={schema:1,startedAt:new Date().toISOString(),reviewedHeadsVerified:false,analysisQualified:false,graphArtifactLimits:{...GRAPH_ARTIFACT_LIMITS,...graphArtifactLimits},node:process.version,platform:process.platform,profilesSha256:sha(JSON.stringify(profiles)),manifestSha256:sha(JSON.stringify(manifest)),corpusSha256:sha(JSON.stringify(corpus)),engineBefore:await identity(),repositories:profiles.repositories.map(({id,commit,scope,config})=>({id,commit,scope,config,status:'pending'}))};
  for(const [name,value]of [['profiles',profiles],['manifest',manifest],['corpus',corpus]])await publish(destination,name+'.json',JSON.stringify(value,null,2)+'\n');
  const save=async()=>{await publish(destination,'receipt.json',JSON.stringify(receipt,null,2)+'\n');await publish(destination,'index.html',renderHeadReceipt(receipt));};await save();
  for(const [index,profile]of profiles.repositories.entries()){
    const record=receipt.repositories[index];record.status='inspecting';await save();
    try{
      assert.ok(Object.hasOwn(observations,profile.id),'Missing original observation');assert.deepEqual(await identity(),receipt.engineBefore,'Engine changed before original indexing');
      const revision=corpus.repositories.find(item=>item.id===profile.id).revisions.at(-1);record.originalBefore=await inspectHeadTree(observations[profile.id],revision);
      record.status='indexing';await save();const started=performance.now(),graph=await analyze(record.originalBefore.tree,{config:structuredClone(profile.config),revision:profile.commit});record.indexingMilliseconds=performance.now()-started;
      assert.equal(graph.schemaVersion,1);assert.equal(graph.run?.commitSha,profile.commit);assert.ok(Array.isArray(graph.entities)&&Array.isArray(graph.relations)&&Array.isArray(graph.diagnostics));
      const file=profile.id+'-graph.json';record.status='serializing';await save();const artifact=await writeGraphArtifact(path.join(destination,file),graph,graphArtifactLimits);record.graph={file,...artifact,entities:graph.entities.length,relations:graph.relations.length,diagnostics:graph.diagnostics.length};
      record.originalAfter=await inspectHeadTree(observations[profile.id],revision);assert.deepEqual(record.originalAfter,record.originalBefore,'Original inputs changed during indexing');
      assert.deepEqual(await identity(),receipt.engineBefore,'Engine changed during original indexing');
      const subset={...manifest,contracts:manifest.contracts.filter(contract=>contract.repository===profile.id)};
      record.contracts=await verifySourceContracts({manifest:subset,corpus,observations:{[profile.id]:observations[profile.id]},graphs:{[profile.id]:graph}});
      assert.equal(record.contracts.graphContractsVerified,true,'Reviewed original graph assertions failed');record.status='reviewed-contracts-verified';
    }catch(error){record.failureStage=record.status;record.status='failed';record.error=error.message;if(error.partialArtifact)record.partialArtifact=error.partialArtifact;}
    await save();
  }
  try{receipt.engineAfter=await identity();receipt.engineUnchanged=JSON.stringify(receipt.engineBefore)===JSON.stringify(receipt.engineAfter);}catch(error){receipt.engineUnchanged=false;receipt.engineIdentityError=error.message;}
  receipt.completedAt=new Date().toISOString();
  receipt.reviewedHeadsVerified=receipt.engineUnchanged&&receipt.repositories.every(record=>record.status==='reviewed-contracts-verified');await save();return receipt;
}
