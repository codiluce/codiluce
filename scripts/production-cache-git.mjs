import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {lstat,mkdir,readFile,realpath,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {readGit} from './production-history-inputs.mjs';

const execute=promisify(execFile),sha=bytes=>createHash('sha256').update(bytes).digest('hex'),empty=process.platform==='win32'?'NUL':'/dev/null';
export function productionGitEnvironment(metadata,tree){
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));
 return Object.assign(env,{GIT_DIR:metadata.directory,GIT_WORK_TREE:tree,GIT_INDEX_FILE:path.join(metadata.directory,'index'),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:empty,GIT_OPTIONAL_LOCKS:'0',GIT_NO_REPLACE_OBJECTS:'1',GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_COUNT:'2',GIT_CONFIG_KEY_0:'core.fsmonitor',GIT_CONFIG_VALUE_0:'false',GIT_CONFIG_KEY_1:'core.hooksPath',GIT_CONFIG_VALUE_1:empty});
}

/** Fresh owned metadata only. Copy exact shallow boundaries: omitting them
 * changes available ancestry and can make an otherwise readable log fail.
 * Source config, indexes, hooks, replacement refs and working files stay out. */
export async function prepareProductionGit({source,tree,commit,output}){
 assert.match(commit,/^(?:[a-f\d]{40}|[a-f\d]{64})$/);
 source=await realpath(source);tree=await realpath(tree);output=path.resolve(output);
 await mkdir(path.dirname(output),{recursive:true});const parent=await realpath(path.dirname(output));assert.equal(path.dirname(output),parent,'Output parent crosses an alias');
 for(const root of [source,tree]){const relative=path.relative(root,output);assert.ok(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative),'Metadata must remain outside original inputs');}
 await mkdir(output); // Existing observations cannot be overwritten.
 const objects=await realpath(path.resolve(source,(await readGit(source,['rev-parse','--git-path','objects'])).trim()));
 assert.ok(!/[\r\n]/.test(objects),'Git object path cannot be represented by an alternate');
 const metadata={commit,directory:output,objectDirectory:objects,files:[],shallow:null};
 const env=productionGitEnvironment(metadata,tree);
 const initialize={...env};delete initialize.GIT_DIR;delete initialize.GIT_WORK_TREE;delete initialize.GIT_INDEX_FILE;
 await execute('git',['init','--bare','--template=','--object-format='+ (commit.length===64?'sha256':'sha1'),output],{env:initialize,maxBuffer:1024*1024});
 await writeFile(path.join(output,'objects/info/alternates'),objects+'\n');await writeFile(path.join(output,'HEAD'),commit+'\n');
 const shallow=path.resolve(source,(await readGit(source,['rev-parse','--git-path','shallow'])).trim());
 try{
  const info=await lstat(shallow);assert.ok(info.isFile()&&!info.isSymbolicLink()&&info.size<=1024*1024,'Original shallow metadata must remain regular and bounded');
  const bytes=await readFile(shallow),text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);assert.ok(text.endsWith('\n')&&text.trim().split('\n').every(id=>new RegExp('^[a-f\\d]{'+commit.length+'}$').test(id)),'Invalid original shallow boundaries');
  await writeFile(path.join(output,'shallow'),bytes);metadata.shallow={source:shallow,bytes:bytes.length,sha256:sha(bytes),boundaries:text.trim().split('\n').length};
 }catch(error){if(error.code!=='ENOENT')throw error;}
 const git=async args=>(await execute('git',['--no-replace-objects',...args],{env,cwd:tree,maxBuffer:64*1024*1024,encoding:'buffer'})).stdout;
 metadata.tree=(await git(['rev-parse','HEAD^{tree}'])).toString().trim();assert.match(metadata.tree,new RegExp('^[a-f\\d]{'+commit.length+'}$'));
 await git(['read-tree',commit]);metadata.status=(await git(['status','--porcelain=v1','-z','--untracked-files=normal'])).toString();
 const log=await git(['-c','core.quotepath=off','log','--no-merges','-M','--numstat','-z','--relative','--max-count=10000','--format=%x1e%H%x1f%aI%x1f%aE','HEAD','--']);
 metadata.logPreflight={sha256:sha(log),bytes:log.length,commits:log.toString().split('\x1e').length-1,maxCommits:10000};assert.ok(metadata.logPreflight.commits>0,'Pinned original Git metrics must remain readable');
 async function collect(relative=''){
  for(const name of (await readdir(path.join(output,relative))).sort()){
   const file=relative?relative+'/'+name:name,info=await lstat(path.join(output,file));assert.ok(!info.isSymbolicLink(),'Owned metadata contains an alias');
   if(info.isDirectory())await collect(file);else{assert.ok(info.isFile());const bytes=await readFile(path.join(output,file));metadata.files.push({file,bytes:bytes.length,sha256:sha(bytes)});}
  }
 }
 await collect();return metadata;
}
