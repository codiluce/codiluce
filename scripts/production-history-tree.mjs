import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstat,readFile,readlink,readdir,realpath} from 'node:fs/promises';
import path from 'node:path';
import {readGit,readRevision} from './production-history-inputs.mjs';
import {materializedPathReason} from './production-history-blobs.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
/** Check the actual production TreeMirror output, including literal symlinks
 * (readlink only) and unhydrated gitlink directories. No target is followed. */
export async function inspectProductionHistoryTree({source,directory,revision,maxBlobBytes=8*1024*1024,maxTotalBytes=512*1024*1024,maxEntries=100000}){
 for(const value of [maxBlobBytes,maxTotalBytes,maxEntries])assert.ok(Number.isSafeInteger(value)&&value>0);
 source=await realpath(source);directory=path.resolve(directory);assert.equal(await realpath(directory),directory,'Mirror root crosses an alias');
 const relative=path.relative(source,directory);assert.ok(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative),'Mirror must remain outside original working files');
 const {reason,...expected}=revision;assert.deepEqual(await readRevision(source,revision.commit),expected,'Pinned original Git metadata differs');
 const inventory=await readGit(source,['ls-tree','-r','-z','--full-tree',revision.commit],{binary:true});assert.equal(sha(inventory),revision.inventory.sha256);
 const entries=new Map(),directories=new Set();let start=0;
 for(let end=0;end<inventory.length;end++)if(inventory[end]===0){
  const row=inventory.subarray(start,end),tab=row.indexOf(9);start=end+1;assert.ok(tab>0);
  const match=/^(100644|100755|120000|160000) (blob|commit) ([a-f\d]{40}|[a-f\d]{64})$/.exec(row.subarray(0,tab).toString('ascii'));assert.ok(match);
  const file=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(row.subarray(tab+1));assert.equal(materializedPathReason(file),undefined,'Original path is outside portable source profile');assert.ok(!entries.has(file));
  const [,mode,type,object]=match;assert.equal(type,mode==='160000'?'commit':'blob');entries.set(file,{path:file,pathBytesHex:row.subarray(tab+1).toString('hex'),mode,object});
  for(let parent=path.posix.dirname(file);parent!=='.';parent=path.posix.dirname(parent))directories.add(parent);
 }
 assert.equal(start,inventory.length);assert.equal(entries.size,revision.inventory.entries);assert.ok(entries.size<=maxEntries);
 const records=[],found=new Set();let total=0,regular=0,symlinks=0,gitlinks=0;
 async function walk(parent=''){
  for(const name of (await readdir(path.join(directory,parent))).sort()){
   const file=parent?parent+'/'+name:name,absolute=path.join(directory,file),info=await lstat(absolute),entry=entries.get(file);
   if(info.isDirectory()){
    assert.equal(await realpath(absolute),absolute,'Mirror directory crosses an alias');
    if(entry){assert.equal(entry.mode,'160000','Original blob replaced with a directory');assert.deepEqual(await readdir(absolute),[],'Gitlink must remain unhydrated');found.add(file);gitlinks++;records.push({...entry,status:'unhydrated-gitlink'});}
    else{assert.ok(directories.has(file),'Unexpected mirror directory');await walk(file);}
    continue;
   }
   assert.ok(entry&&!found.has(file),'Unexpected or ambiguous mirror file');found.add(file);let bytes;
   if(info.isSymbolicLink()){
    assert.equal(entry.mode,'120000','Original regular file replaced by an alias');bytes=await readlink(absolute,{encoding:'buffer'});symlinks++;
   }else{
    assert.ok(info.isFile()&&['100644','100755'].includes(entry.mode),'Original type changed');assert.equal(await realpath(absolute),absolute,'Original regular file crosses an alias');assert.ok(info.size<=maxBlobBytes);bytes=await readFile(absolute);regular++;
   }
   assert.ok(bytes.length<=maxBlobBytes);total+=bytes.length;assert.ok(total<=maxTotalBytes);
   const object=createHash(entry.object.length===40?'sha1':'sha256').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex');assert.equal(object,entry.object,'Actual mirror bytes differ from original Git blob');
   records.push({...entry,status:entry.mode==='120000'?'literal-symlink-not-followed':'original-regular-bytes',bytes:bytes.length,sha256:sha(bytes)});
  }
 }
 await walk();assert.equal(found.size,entries.size,'Original inputs missing from mirror');assert.equal(regular,revision.inventory.regularFiles);assert.equal(symlinks,revision.inventory.symlinks);assert.equal(gitlinks,revision.inventory.gitlinks);
 records.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 return {schema:1,commit:revision.commit,tree:revision.tree,inventorySha256:sha(inventory),originalBytes:total,regularFiles:regular,literalSymlinks:symlinks,unhydratedGitlinks:gitlinks,allOriginalBytesVerified:true,symlinkTargetsFollowed:false,recordDigest:sha(JSON.stringify(records)),entries:records};
}

/** Scanner hashes prove the bytes used for analyzable sources. All remaining
 * original byte identities are still verified by the complete mirror walk. */
export function verifyHistoryGraphInputs(graph,original){
 assert.equal(graph.run.commitSha,original.commit);const entries=new Map(original.entries.map(row=>[row.path,row])),files=graph.entities.filter(row=>row.type==='file');let hashed=0;
 for(const file of files){
  const entry=entries.get(file.path);assert.ok(entry&&['100644','100755'].includes(entry.mode),'Graph file is not an original regular input');
  assert.equal(file.metadata.bytes,entry.bytes,'Graph original file size differs');
  if(file.metadata.contentHash!==undefined){assert.equal(file.metadata.contentHash,entry.sha256,'Indexed source-byte hash differs');hashed++;}
 }
 return {commit:original.commit,fileEntities:files.length,hashedOriginalSources:hashed,originalSymlinksExcludedFromFileEntities:true};
}
