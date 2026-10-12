// Offline, original Git objects only. No checkout/filter/submodule/LFS/target
// process runs. A fresh isolated tree supplies future owned analyzer jobs.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,readFile,realpath,rename,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {readGit,readRevision} from './production-history-inputs.mjs';

const execute=promisify(execFile),sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const DEFAULT_BLOB_LIMITS=Object.freeze({maxBlobBytes:8*1024*1024,maxTotalBytes:512*1024*1024,maxEntries:100_000});

/** Portable paths only, with no filesystem aliases or target Git metadata.
 * Unsupported originals remain explicit inventory entries, never renamed. */
export function materializedPathReason(relative){
  if(!relative||relative.includes('\\')||relative.includes('\0')||path.posix.isAbsolute(relative))return 'unsafe-or-nonportable-path';
  for(const segment of relative.split('/')){
    if(!segment||segment==='.'||segment==='..'||segment.toLowerCase()==='.git'||/[<>:"|?*\x00-\x1f]/.test(segment)||/[. ]$/.test(segment)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))return 'unsafe-or-nonportable-path';
  }
}

async function destinationPath(destination){
  let existing=path.resolve(destination),tail=[];
  for(;;){try{return path.join(await realpath(existing),...tail.reverse());}
    catch(error){if(error.code!=='ENOENT')throw error;const parent=path.dirname(existing);if(parent===existing)throw error;tail.push(path.basename(existing));existing=parent;}}
}

/** ls-tree -l is metadata, not the blob-byte proof. Decode paths strictly;
 * unrepresentable path bytes are preserved in hexadecimal in the receipt. */
function inventoryEntries(bytes){
  const entries=[];let start=0;
  for(let end=0;end<bytes.length;end++){
    if(bytes[end]!==0)continue;
    const entry=bytes.subarray(start,end),tab=entry.indexOf(9);start=end+1;
    assert.ok(tab>0,'Malformed original Git inventory');
    const match=/^(100644|100755|120000|160000) (blob|commit) ([a-f\d]{40}|[a-f\d]{64}) +([\d]+|-)$/.exec(entry.subarray(0,tab).toString('ascii'));
    assert.ok(match,`Unsupported or unavailable original Git entry ${entry.subarray(0,tab).toString('ascii')} path-bytes=${entry.subarray(tab+1).toString('hex')}`);
    const [,mode,type,object,size]=match,filename=entry.subarray(tab+1);
    assert.equal(type,mode==='160000'?'commit':'blob');
    let relative,reason;
    try{relative=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(filename);reason=materializedPathReason(relative);}
    catch{reason='non-utf8-path';}
    const length=size==='-'?undefined:Number(size);
    assert.ok(mode==='160000'||Number.isSafeInteger(length)&&length>=0,'Invalid original blob length');
    entries.push({path:relative,pathBytesHex:filename.toString('hex'),mode,object,...(length!==undefined?{bytes:length}:{}),...(reason?{reason}:{})});
  }
  assert.equal(start,bytes.length,'Original Git inventory lacks its final NUL');
  return entries;
}

async function originalBlob(root,entry,limit){
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));
  Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0'});
  const bytes=(await execute('git',['--no-replace-objects','-c','core.fsmonitor=false','-c',`core.hooksPath=${path.join(root,'.codiluce','disabled-history-blob-hooks')}`,'-C',root,'cat-file','blob',entry.object],{env,encoding:'buffer',maxBuffer:limit+1024,timeout:30_000})).stdout;
  assert.equal(bytes.length,entry.bytes,'Original Git blob length differs');
  const actual=createHash(entry.object.length===40?'sha1':'sha256').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  assert.equal(actual,entry.object,'Original Git blob object identity differs');
  return bytes;
}

export function renderBlobReceipt(receipt){
  const counts=Object.entries(receipt.counts??{}).map(([key,value])=>`${escape(key)}: ${value}`).join(' · ');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Original history blob verification</title><style>body{margin:0;padding:clamp(16px,4vw,40px);font:16px/1.6 system-ui;background:#101822;color:#e5ecf4}main{max-width:1080px;margin:auto}h1{line-height:1.2}.status{padding:16px;border:1px solid #8293a8;border-radius:8px}p,pre{overflow-wrap:anywhere}pre{white-space:pre-wrap;font-size:12px}a{color:#8bddd8}</style></head><body><main><h1>Original history blob verification</h1><p class="status"><strong>${receipt.completedAt?escape(receipt.status.toUpperCase()):'MATERIALIZATION INCOMPLETE'}</strong><br>Production analysis, accuracy, history parity and performance remain pending.</p><p>Commit ${escape(receipt.commit)} · ${counts}</p><p>Original regular-file and symlink blobs admitted by the explicit limits are checked against their complete Git object identity and hashed with SHA-256. Written files are independently read back and hashed. Symlinks, gitlinks, LFS pointers, unsafe or nonportable paths, alias collisions and size limits remain explicit skipped entries. No target working-tree content, checkout, hooks, filters, submodules, LFS hydration, dependencies or application executes.</p><details><summary>Exact byte identities, skip/failure inventory and verifier receipt</summary><pre>${escape(JSON.stringify(receipt,null,2))}</pre></details></main></body></html>`;
}

/** One revision, one fresh tree. Callers can analyze then retire it before
 * materializing the next revision; this does not retain 195 decoded trees. */
export async function materializeProductionRevision({source,revision,output,protectedRoots=[],limits={}}){
  const bounds={...DEFAULT_BLOB_LIMITS,...limits};
  assert.deepEqual(Object.keys(bounds).sort(),Object.keys(DEFAULT_BLOB_LIMITS).sort(),'Unknown materialization limit');
  for(const value of Object.values(bounds))assert.ok(Number.isSafeInteger(value)&&value>0,'Limits must be positive safe integers');
  const root=await realpath(source),top=await realpath((await readGit(root,['rev-parse','--show-toplevel'])).trim());
  assert.equal(root,top,'The input must be a Git repository root');
  const destination=await destinationPath(output);
  for(const protectedRoot of [root,...protectedRoots]){
    const relative=path.relative(await destinationPath(protectedRoot),destination);
    assert.ok(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative),'Materialization must be outside every target repository');
  }
  await mkdir(path.dirname(destination),{recursive:true});await mkdir(destination); // Never replace an observation.
  const identity=async()=>Promise.all(['production-history-blobs.mjs','materialize-production-history.mjs','production-history-inputs.mjs'].map(async file=>({file,sha256:sha256(await readFile(new URL(file,import.meta.url)))})));
  const receipt={schema:1,startedAt:new Date().toISOString(),status:'inspecting',commit:revision.commit,tree:revision.tree,limits:bounds,workingTreeUsed:false,analysisQualified:false,materializationCompleted:false,allRegularFilesMaterialized:false,originalBlobBytesComplete:false,verifierBefore:await identity(),node:process.version,platform:process.platform,entries:[]};
  const publish=async()=>{
    for(const [name,text]of [['receipt.json',JSON.stringify(receipt,null,2)+'\n'],['index.html',renderBlobReceipt(receipt)]]){
      const pending=path.join(destination,name+'.pending');await writeFile(pending,text);await rename(pending,path.join(destination,name));
    }
  };
  await writeFile(path.join(destination,'revision.json'),JSON.stringify(revision,null,2)+'\n',{flag:'wx'});await publish();
  try{
    const {reason,...expected}=revision;
    assert.deepEqual(await readRevision(root,revision.commit),expected,'Pinned original revision metadata differs');
    const entries=inventoryEntries(await readGit(root,['ls-tree','-r','-l','-z','--full-tree',revision.commit],{binary:true}));
    assert.equal(entries.length,revision.inventory.entries);assert.ok(entries.length<=bounds.maxEntries,'Original tree exceeds maxEntries');
    // A directory alias can collide even if full file paths differ.
    const aliases=new Map(),collisions=new Set();
    for(const entry of entries){
      if(entry.reason||!entry.path)continue;
      const parts=entry.path.split('/');
      for(let end=1;end<=parts.length;end++){
        const spelling=parts.slice(0,end).join('/'),key=spelling.normalize('NFC').toUpperCase(),previous=aliases.get(key);
        if(previous!==undefined&&previous!==spelling)collisions.add(key);
        else aliases.set(key,spelling);
      }
    }
    const tree=path.join(destination,'tree');await mkdir(tree);let admittedBytes=0;
    receipt.status='materializing';
    for(const entry of entries){
      const record={...entry,status:'pending'};receipt.entries.push(record);
      if(entry.reason){record.status='skipped';continue;}
      if(entry.path.split('/').some((_,index)=>collisions.has(entry.path.split('/').slice(0,index+1).join('/').normalize('NFC').toUpperCase()))){record.status='skipped';record.reason='portable-path-alias-collision';continue;}
      if(entry.mode==='160000'){record.status='skipped';record.reason='gitlink-not-hydrated';continue;}
      if(entry.bytes>bounds.maxBlobBytes){record.status='skipped';record.reason='maxBlobBytes';continue;}
      if(admittedBytes+entry.bytes>bounds.maxTotalBytes){record.status='skipped';record.reason='maxTotalBytes';continue;}
      admittedBytes+=entry.bytes;
      try{
        const bytes=await originalBlob(root,entry,bounds.maxBlobBytes);record.sha256=sha256(bytes);record.blobIdentityVerified=true;
        if(entry.mode==='120000'){record.status='skipped';record.reason='symlink-not-followed';continue;}
        if(/^version https:\/\/git-lfs.github.com\/spec\/v1\r?\n/.test(bytes.subarray(0,1024).toString('utf8'))){record.status='skipped';record.reason='lfs-pointer-not-hydrated';continue;}
        const file=path.join(tree,...entry.path.split('/'));await mkdir(path.dirname(file),{recursive:true});
        // Executable originals become ordinary source bytes. Never chmod +x.
        await writeFile(file,bytes,{flag:'wx',mode:0o600});
        record.writtenSha256=sha256(await readFile(file));assert.equal(record.writtenSha256,record.sha256,'Materialized original bytes differ');
        record.status='materialized';
      }catch(error){record.status='failed';record.error=error.message;}
    }
    receipt.admittedBytes=admittedBytes;
    receipt.counts={materialized:0,skipped:0,failed:0};for(const entry of receipt.entries)receipt.counts[entry.status]++;
    receipt.materializationCompleted=receipt.counts.failed===0;
    receipt.allRegularFilesMaterialized=receipt.materializationCompleted&&receipt.entries.filter(entry=>entry.mode==='100644'||entry.mode==='100755').every(entry=>entry.status==='materialized');
    receipt.originalBlobBytesComplete=receipt.entries.filter(entry=>entry.mode!=='160000').every(entry=>entry.blobIdentityVerified);
    receipt.status=receipt.materializationCompleted?(receipt.counts.skipped?'materialized-with-skips':'materialized'):'failed';
  }catch(error){receipt.status='failed';receipt.error=error.message;}
  receipt.verifierAfter=await identity();receipt.verifierUnchanged=JSON.stringify(receipt.verifierBefore)===JSON.stringify(receipt.verifierAfter);
  if(!receipt.verifierUnchanged){receipt.status='failed';receipt.materializationCompleted=false;receipt.error='Materializer changed during observation';}
  receipt.completedAt=new Date().toISOString();await publish();return receipt;
}
