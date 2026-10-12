// Synchronous observation keeps the shipped worker waiting for its actual
// store acknowledgement while the complete materialized input is inspected.
// No event/message/acknowledgement or production function is replaced.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstatSync,readFileSync,readlinkSync,readdirSync,realpathSync} from 'node:fs';
import path from 'node:path';
import {materializedPathReason} from './production-history-blobs.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function inspectHistoryTreeSync(directory,original,{maxBlobBytes=8*1024*1024,maxTotalBytes=512*1024*1024,maxEntries=100000}={}){
 for(const limit of [maxBlobBytes,maxTotalBytes,maxEntries])assert.ok(Number.isSafeInteger(limit)&&limit>0);
 assert.equal(original.schema,1);assert.equal(original.allOriginalBytesVerified,true);assert.equal(original.symlinkTargetsFollowed,false);
 assert.equal(original.recordDigest,hash(JSON.stringify(original.entries)),'Original source receipt digest differs');
 assert.ok(original.entries.length<=maxEntries);directory=path.resolve(directory);assert.equal(realpathSync(directory),directory);
 const entries=new Map(),directories=new Set();
 for(const entry of original.entries){
  assert.equal(materializedPathReason(entry.path),undefined);assert.ok(!entries.has(entry.path));assert.equal(Buffer.from(entry.path,'utf8').toString('hex'),entry.pathBytesHex);entries.set(entry.path,entry);
  for(let parent=path.posix.dirname(entry.path);parent!=='.';parent=path.posix.dirname(parent))directories.add(parent);
 }
 const records=[],found=new Set();let total=0;
 function walk(parent=''){
  for(const name of readdirSync(path.join(directory,parent)).sort()){
   const file=parent?parent+'/'+name:name,absolute=path.join(directory,file),info=lstatSync(absolute),entry=entries.get(file);
   if(info.isDirectory()){
    assert.equal(realpathSync(absolute),absolute);
    if(entry){assert.equal(entry.mode,'160000');assert.deepEqual(readdirSync(absolute),[]);found.add(file);records.push({...entry});}
    else{assert.ok(directories.has(file),'Unexpected materialized directory');walk(file);}
    continue;
   }
   assert.ok(entry&&!found.has(file),'Unexpected materialized file');found.add(file);let bytes;
   if(info.isSymbolicLink()){assert.equal(entry.mode,'120000');bytes=readlinkSync(absolute,{encoding:'buffer'});}
   else{assert.ok(info.isFile()&&['100644','100755'].includes(entry.mode));assert.equal(realpathSync(absolute),absolute);assert.ok(info.size<=maxBlobBytes);bytes=readFileSync(absolute);}
   assert.ok(bytes.length<=maxBlobBytes);total+=bytes.length;assert.ok(total<=maxTotalBytes);
   assert.equal(createHash(entry.object.length===40?'sha1':'sha256').update('blob '+bytes.length+'\0').update(bytes).digest('hex'),entry.object,'Actual original Git blob bytes differ');
   assert.equal(bytes.length,entry.bytes);assert.equal(hash(bytes),entry.sha256,'Original source SHA-256 differs');records.push({...entry});
  }
 }
 walk();assert.equal(found.size,entries.size,'Materialized original source is missing');assert.equal(total,original.originalBytes);
 records.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);assert.equal(hash(JSON.stringify(records)),original.recordDigest);
 return {commit:original.commit,recordDigest:original.recordDigest,entries:found.size,bytes:total,literalSymlinks:original.literalSymlinks,symlinkTargetsFollowed:false};
}
