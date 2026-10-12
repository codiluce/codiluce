// Lossless JSON artifacts for public plain-data graphs. No full graph or
// record is converted to a single string; limits cover output and buffering,
// not the already-live graph, traversal keys, decoded objects or physical RSS.
import {createHash} from 'node:crypto';
import {link,open,unlink} from 'node:fs/promises';

export const GRAPH_ARTIFACT_LIMITS=Object.freeze({maxBytes:1024*1024*1024,chunkBytes:64*1024,maxDepth:4096});
function limits(options){
  for(const key of Object.keys(options))if(!Object.hasOwn(GRAPH_ARTIFACT_LIMITS,key))throw Error(`Unknown graph artifact limit ${key}`);
  const selected={...GRAPH_ARTIFACT_LIMITS,...options};
  for(const value of Object.values(selected))if(!Number.isSafeInteger(value)||value<1)throw Error('Graph artifact limits must be positive safe integers');
  if(selected.chunkBytes>1024*1024)throw Error('Graph artifact chunks may not exceed 1 MiB');
  return selected;
}
const omitted=value=>value===undefined||typeof value==='function'||typeof value==='symbol';
function* quoted(text){
  yield '"';
  for(let start=0;start<text.length;){
    let end=Math.min(start+4096,text.length);
    // JSON.stringify escapes lone surrogates, while an original pair is literal
    // Unicode. Keep a pair together across independently escaped string pieces.
    if(end<text.length&&text.charCodeAt(end-1)>=0xd800&&text.charCodeAt(end-1)<=0xdbff&&text.charCodeAt(end)>=0xdc00&&text.charCodeAt(end)<=0xdfff)end--;
    yield JSON.stringify(text.slice(start,end)).slice(1,-1);start=end;
  }
  yield '"';
}
function* tokens(value,maxDepth){
  if(omitted(value))throw TypeError('A JSON root value is required');
  const stack=[{kind:'value',value,depth:0}],active=new WeakSet();
  while(stack.length){
    const task=stack.pop();
    if(task.kind==='frame'){
      const {value,keys}=task;let key,item,found=false;
      while(task.index<(keys?keys.length:value.length)){
        key=keys?keys[task.index]:task.index;task.index++;item=value[key];
        if(keys&&omitted(item))continue;found=true;break;
      }
      if(!found){active.delete(value);yield keys?'}':']';continue;}
      if(task.emitted++)yield ',';
      if(keys){yield* quoted(key);yield ':';}
      stack.push(task,{kind:'value',value:keys?item:omitted(item)?null:item,depth:task.depth+1});continue;
    }
    const item=task.value;
    if(task.depth>maxDepth)throw RangeError('Graph artifact JSON depth limit exceeded');
    if(typeof item==='string'){yield* quoted(item);continue;}
    if(item===null||typeof item!=='object'){
      if(typeof item==='bigint')throw TypeError('BigInt is not a plain JSON value');
      const text=JSON.stringify(item);if(text===undefined)throw TypeError('Unsupported JSON value');yield text;continue;
    }
    if(active.has(item))throw TypeError('Graph artifact contains a JSON cycle');
    const array=Array.isArray(item),prototype=Object.getPrototypeOf(item);
    if(!array&&prototype!==Object.prototype&&prototype!==null)throw TypeError('Graph artifacts require plain JSON objects');
    const hook=Object.getOwnPropertyDescriptor(item,'toJSON');
    if(hook&&(typeof hook.value==='function'||hook.get||hook.set))throw TypeError('Graph artifacts cannot execute custom toJSON');
    active.add(item);yield array?'[':'{';stack.push({kind:'frame',value:item,keys:array?undefined:Object.keys(item),index:0,emitted:0,depth:task.depth});
  }
}

/** Atomic, non-overwriting publication. Failure retains an explicitly partial
 * .pending artifact and byte/hash evidence; it never exposes a complete JSON.
 * The default 1 GiB output limit does not change a graph reader's input limit. */
export async function writeGraphArtifact(file,value,options={}){
  const selected=limits(options),pending=file+'.pending',handle=await open(pending,'wx'),hash=createHash('sha256');
  let bytes=0,peakChunkBytes=0,buffer=Buffer.allocUnsafe(selected.chunkBytes),used=0,closed=false;
  async function flush(){
    if(!used)return;let offset=0;peakChunkBytes=Math.max(peakChunkBytes,used);
    try{
      while(offset<used){const result=await handle.write(buffer,offset,used-offset);if(!result.bytesWritten)throw Error('Graph artifact write made no progress');hash.update(buffer.subarray(offset,offset+result.bytesWritten));bytes+=result.bytesWritten;offset+=result.bytesWritten;}
    }finally{if(offset<used)buffer.copy(buffer,0,offset,used);used-=offset;}
  }
  try{
    for(const token of tokens(value,selected.maxDepth)){
      const encoded=Buffer.from(token,'utf8');
      if(bytes+used+encoded.length>selected.maxBytes)throw RangeError('Graph artifact JSON byte limit exceeded');
      for(let offset=0;offset<encoded.length;){const count=Math.min(encoded.length-offset,buffer.length-used);encoded.copy(buffer,used,offset,offset+count);used+=count;offset+=count;if(used===buffer.length)await flush();}
    }
    if(bytes+used+1>selected.maxBytes)throw RangeError('Graph artifact JSON byte limit exceeded');
    if(used===buffer.length)await flush();buffer[used++]=10;await flush();await handle.sync();await handle.close();closed=true;
    // A hard link publishes the completed inode atomically and refuses an
    // existing destination on every supported platform; rename could replace it.
    await link(pending,file);await unlink(pending);
    return {sha256:hash.digest('hex'),bytes,peakChunkBytes,limits:selected,serialization:'lossless-plain-json-chunks'};
  }catch(error){
    if(!closed){try{await flush();}catch(failure){error.partialRetentionError=failure.message;}finally{try{await handle.close();}catch(failure){error.closeError=failure.message;}closed=true;}}
    error.partialArtifact={file:pending,bytes,sha256:hash.digest('hex'),peakChunkBytes,limits:selected};throw error;
  }
}
