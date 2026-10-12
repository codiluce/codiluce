// Immutable Git metadata only. Target working trees, hooks, runtimes,
// dependencies and builds are never read as analysis inputs or executed.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,readFile,realpath,rename,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';

const execute=promisify(execFile);
const sha256=value=>createHash('sha256').update(value).digest('hex');
const objectId=value=>typeof value==='string'&&/^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(value);
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function validateCorpus(corpus){
  assert.equal(corpus.schema,1,'Unsupported production-history corpus schema');
  assert.ok(Array.isArray(corpus.repositories)&&corpus.repositories.length>0,'No repositories selected');
  const ids=new Set();
  for(const repository of corpus.repositories){
    assert.match(repository.id,/^[a-z][a-z\d-]{0,63}$/);
    assert.ok(!ids.has(repository.id),'Duplicate repository identity');ids.add(repository.id);
    assert.match(repository.repository,/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/);
    assert.ok(objectId(repository.head),'A complete immutable head is required');
    assert.ok(typeof repository.coverageIntent==='string'&&repository.coverageIntent.trim());
    assert.equal(repository.policy,'consecutive-first-parent');
    assert.ok(Array.isArray(repository.revisions)&&repository.revisions.length>=2);
    assert.ok(Array.isArray(repository.extraRevisions));
    const commits=new Set();
    for(const [index,revision]of repository.revisions.entries()){
      validateRevision(revision);assert.ok(!commits.has(revision.commit),'Duplicate revision');commits.add(revision.commit);
      if(index)assert.equal(revision.parents[0],repository.revisions[index-1].commit,'The selected first-parent chain is discontinuous');
    }
    assert.equal(repository.revisions.at(-1).commit,repository.head,'The selected chain must end at the pinned head');
    for(const revision of repository.extraRevisions){
      validateRevision(revision);assert.ok(typeof revision.reason==='string'&&revision.reason.trim());
      assert.ok(!commits.has(revision.commit),'Duplicate extra revision');commits.add(revision.commit);
    }
  }
  return corpus;
}

function validateRevision(revision){
  assert.ok(objectId(revision.commit)&&objectId(revision.tree),'Commit and tree identities must be complete');
  assert.ok(Array.isArray(revision.parents)&&revision.parents.every(objectId));
  const inventory=revision.inventory;
  assert.match(inventory.sha256,/^[a-f\d]{64}$/);
  for(const field of ['entries','regularFiles','symlinks','gitlinks'])assert.ok(Number.isSafeInteger(inventory[field])&&inventory[field]>=0);
  assert.equal(inventory.entries,inventory.regularFiles+inventory.symlinks+inventory.gitlinks);
}

/** Ignore global/system Git configuration, replacement objects and inherited
 * Git overrides. No checkout, filter, submodule, LFS or target hook runs. */
export async function readGit(root,parameters,{binary=false}={}){
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));
  Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0'});
  return (await execute('git',['--no-replace-objects','-c','core.fsmonitor=false','-c',`core.hooksPath=${path.join(root,'.codiluce','disabled-history-input-hooks')}`,'-C',root,...parameters],{env,encoding:binary?'buffer':'utf8',timeout:30_000,maxBuffer:64*1024*1024})).stdout;
}

/** SHA-256 of the exact NUL-delimited ls-tree inventory, not of file bytes.
 * Blob checksums/materialization remain requirements for analysis evidence. */
export async function readRevision(root,commit){
  assert.ok(objectId(commit),'Revision must be an immutable full object ID');
  const [actual,tree,parents]=(await readGit(root,['show','-s','--format=%H%x00%T%x00%P',commit,'--'])).trimEnd().split('\0');
  assert.equal(actual,commit);
  const bytes=await readGit(root,['ls-tree','-r','-z','--full-tree',commit],{binary:true});
  const entries=bytes.toString('utf8').split('\0').filter(Boolean),inventory={sha256:sha256(bytes),entries:entries.length,regularFiles:0,symlinks:0,gitlinks:0};
  for(const entry of entries){
    const mode=entry.slice(0,6);
    if(mode==='100644'||mode==='100755')inventory.regularFiles++;
    else if(mode==='120000')inventory.symlinks++;
    else if(mode==='160000')inventory.gitlinks++;
    else throw Error(`Unsupported tracked Git mode ${mode}`);
  }
  return {commit,tree,parents:parents?parents.split(' '):[],inventory};
}

export async function inspectHistoryInput(source,specification){
  const root=await realpath(source),top=await realpath((await readGit(root,['rev-parse','--show-toplevel'])).trim());
  assert.equal(root,top,'The input must be a Git repository root');
  const selected=(await readGit(root,['rev-list','--first-parent',`--max-count=${specification.revisions.length}`,'--reverse',specification.head,'--'])).trim().split('\n');
  assert.deepEqual(selected,specification.revisions.map(revision=>revision.commit),'The available pinned first-parent chain differs');
  for(const revision of [...specification.revisions,...specification.extraRevisions]){
    const actual=await readRevision(root,revision.commit),{reason,...expected}=revision;
    assert.deepEqual(actual,expected,`Original Git inventory differs at ${revision.commit}`);
  }
  for(const revision of specification.extraRevisions)await readGit(root,['merge-base','--is-ancestor',revision.commit,specification.head]);
  return {id:specification.id,status:'verified',repository:specification.repository,pinnedHead:specification.head,
    checkedOutHead:(await readGit(root,['rev-parse','HEAD'])).trim(),revisions:specification.revisions.length,extraRevisions:specification.extraRevisions.length,
    workingTreeUsed:false,blobBytesVerified:false};
}

async function resolvedDestination(destination){
  let existing=path.resolve(destination),tail=[];
  for(;;){
    try{return path.join(await realpath(existing),...tail.reverse());}
    catch(error){if(error.code!=='ENOENT')throw error;const parent=path.dirname(existing);if(parent===existing)throw error;tail.push(path.basename(existing));existing=parent;}
  }
}

export function renderInputReceipt(receipt){
  const rows=receipt.repositories.map(repository=>`<tr><td>${repository.repository?`<a href="${escape(repository.repository)}/tree/${escape(repository.pinnedHead)}">${escape(repository.id)}</a>`:escape(repository.id)}</td><td>${escape(repository.status)}</td><td>${repository.revisions??'—'} / ${repository.extraRevisions??'—'}</td><td>${escape(repository.error??repository.pinnedHead??'Not inspected')}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Production history input verification</title><style>body{margin:0;padding:clamp(16px,4vw,40px);font:16px/1.6 system-ui;background:#101822;color:#e5ecf4}main{max-width:1080px;margin:auto}h1{line-height:1.2}.status{padding:16px;border:1px solid #8293a8;border-radius:8px}table{border-collapse:collapse;width:100%;min-width:620px}th,td{padding:12px;text-align:left;border-bottom:1px solid #344353}.scroll{overflow:auto}p,td,pre{overflow-wrap:anywhere}pre{white-space:pre-wrap;font-size:12px}a{color:#8bddd8}</style></head><body><main><h1>Production history input verification</h1><p class="status"><strong>${receipt.inputsVerified?'PINNED INPUT METADATA VERIFIED':receipt.completedAt?'INPUT VERIFICATION FAILED':'INPUT VERIFICATION INCOMPLETE'}</strong><br>Production analysis and performance are pending.</p><p>This receipt compares complete immutable commit/tree/parent identities and SHA-256 hashes of original Git tree inventories. Inventory hashes identify paths, modes and Git object IDs; they do not establish SHA-256 of original file bytes, semantic accuracy, cache/history parity or runtime/performance budgets. Target working trees, hooks, filters, submodules, LFS, dependencies and applications never execute or supply analysis inputs.</p><div class="scroll"><table><thead><tr><th>Repository</th><th>Input outcome</th><th>Consecutive / extra revisions</th><th>Original identity or failure</th></tr></thead><tbody>${rows}</tbody></table></div><details><summary>Exact corpus identity and input receipts</summary><pre>${escape(JSON.stringify(receipt,null,2))}</pre></details></main></body></html>`;
}

export async function verifyHistoryInputs({corpus,sources,output}){
  validateCorpus(corpus);
  for(const id of Object.keys(sources))assert.ok(corpus.repositories.some(repository=>repository.id===id),`Unknown source ${id}`);
  const destination=await resolvedDestination(output);
  for(const source of Object.values(sources)){
    const root=await resolvedDestination(source),relative=path.relative(root,destination);
    assert.ok(relative.startsWith('..'+path.sep)||relative==='..'||path.isAbsolute(relative),'Evidence must be outside every target repository');
  }
  await mkdir(path.dirname(destination),{recursive:true});await mkdir(destination); // No observation overwrite.
  const verifierIdentity=async()=>{
    const files=[];
    for(const file of ['production-history-inputs.mjs','qualify-production-history-inputs.mjs'])files.push({file,sha256:sha256(await readFile(new URL(file,import.meta.url)))});
    return files;
  };
  const receipt={schema:1,startedAt:new Date().toISOString(),inputsVerified:false,analysisQualified:false,corpusCanonicalSha256:sha256(JSON.stringify(corpus)),verifierBefore:await verifierIdentity(),node:process.version,platform:process.platform,repositories:corpus.repositories.map(({id})=>({id,status:'pending'}))};
  await writeFile(path.join(destination,'corpus.json'),JSON.stringify(corpus,null,2)+'\n',{flag:'wx'});
  const publish=async()=>{
    for(const [name,text]of [['receipt.json',JSON.stringify(receipt,null,2)+'\n'],['index.html',renderInputReceipt(receipt)]]){
      const pending=path.join(destination,name+'.pending');await writeFile(pending,text);await rename(pending,path.join(destination,name));
    }
  };
  await publish();
  for(const [index,specification]of corpus.repositories.entries()){
    const record=receipt.repositories[index];record.status='inspecting';await publish();
    try{
      assert.ok(Object.hasOwn(sources,specification.id),`Missing --source ${specification.id}=DIRECTORY`);
      Object.assign(record,await inspectHistoryInput(sources[specification.id],specification));
    }catch(error){Object.assign(record,{status:'failed',error:error.message});}
    await publish();
  }
  receipt.verifierAfter=await verifierIdentity();receipt.verifierUnchanged=JSON.stringify(receipt.verifierBefore)===JSON.stringify(receipt.verifierAfter);
  receipt.completedAt=new Date().toISOString();receipt.inputsVerified=receipt.verifierUnchanged&&receipt.repositories.every(repository=>repository.status==='verified');await publish();
  return receipt;
}
