// Preserve Codiluce-owned package observations before the harness cleans up.
// Targets, install hooks and framework applications never execute here.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {chmod,copyFile,lstat,mkdir,readFile,readdir,readlink,realpath,writeFile} from 'node:fs/promises';
import path from 'node:path';

export const packagePortableReceipts=Object.freeze([
 'typescript-input-ownership-validation.json','literal-script-generation-validation.json','rails-callback-chain-validation.json',
 'jvm-build-selection-validation.json','gradle-compiler-inputs-validation.json','spring-boot-gradle-validation.json','spring-boot-maven-validation.json',
 'kotlin-spring-compiler-validation.json','kotlin-webflux-invoke-validation.json','spring-boot35-validation.json','typescript-jsdoc-cache-validation.json',
 'typescript-worker-validation.json','typescript-preparation-validation.json','native-consumer-retirement-validation.json',
 'typescript-bounded-transfer-validation.json','typescript-codec-structure-validation.json','native-wasm-memory-validation.json','parser-fatal-validation.json','parser-frame-validation.json','framework-frame-validation.json'
]);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const inside=(root,file)=>file.startsWith(root+path.sep);
const canonical=file=>typeof file==='string'&&file.length>0&&!path.isAbsolute(file)&&!file.includes('\\')&&file.split('/').every(part=>part&&part!=='.'&&part!=='..');
async function exists(file){try{return await lstat(file);}catch(error){if(error.code==='ENOENT')return;throw error;}}
async function fileHash(file){const h=createHash('sha256');for await(const bytes of createReadStream(file))h.update(bytes);return h.digest('hex');}
async function regular(file){assert.equal(await realpath(file),file,'Evidence input crosses an alias');const info=await lstat(file);assert.ok(info.isFile(),'Evidence input must be regular');return info;}

export function packageEvidenceArgument(args,root){
 if(!args.length)return undefined;
 assert.equal(args.length,2,'Expected --evidence-dir DIRECTORY');assert.equal(args[0],'--evidence-dir');assert.ok(args[1]&&!args[1].startsWith('--'),'Evidence directory is required');return path.resolve(root,args[1]);
}

/** Literal links are recorded without following files or directory targets. */
export async function packageInstallationProfile(root){
 assert.equal(await realpath(root),root);assert.ok((await lstat(root)).isDirectory());const files=[],links=[];
 const visit=async directory=>{
  for(const name of (await readdir(directory)).sort()){
   const file=path.join(directory,name),info=await lstat(file),relative=path.relative(root,file).split(path.sep).join('/');assert.ok(canonical(relative));
   if(info.isSymbolicLink())links.push({file:relative,target:await readlink(file)});
   else if(info.isDirectory())await visit(file);
   else{assert.ok(info.isFile(),'Unsupported package filesystem member');await regular(file);files.push({file:relative,bytes:info.size,mode:info.mode&0o777,sha256:await fileHash(file)});}
  }
 };
 await visit(root);return {files,links};
}

/** Start outside the scratch tree and never overwrite an earlier observation. */
export async function createPackageEvidenceDirectory(output,temporary){
 output=path.resolve(output);temporary=await realpath(temporary);assert.ok(!inside(temporary,output)&&output!==temporary,'Evidence must survive scratch cleanup');
 await mkdir(path.dirname(output),{recursive:true});assert.equal(await realpath(path.dirname(output)),path.dirname(output));await mkdir(output);return output;
}

export async function capturePackageEvidence({temporary,output,packagedChecksPassed,error,host={node:process.version,platform:process.platform,architecture:process.arch}}){
 temporary=await realpath(temporary);output=await realpath(output);assert.deepEqual(await readdir(output),[],'Evidence output must be empty');assert.ok(!inside(temporary,output)&&output!==temporary);assert.equal(typeof packagedChecksPassed,'boolean');
 const consumer=path.join(temporary,'consumer'),receipt={schema:1,startedAt:new Date().toISOString(),passed:false,packagedChecksPassed,host,originalTemporaryDirectory:temporary,targetExecution:false,expectedPortableReceipts:[...packagePortableReceipts],portableReceipts:[],missingPortableReceipts:[],collectionErrors:[],artifacts:[]};if(error)receipt.packageError=String(error);
 const copy=async(source,relative)=>{
  assert.ok(canonical(relative));const before=await regular(source),digest=await fileHash(source),destination=path.join(output,relative);await mkdir(path.dirname(destination),{recursive:true});await copyFile(source,destination);await chmod(destination,before.mode&0o777);assert.equal(await fileHash(destination),digest);assert.equal(await fileHash(source),digest);assert.equal((await lstat(source)).mode&0o777,before.mode&0o777);
  const row={file:relative,bytes:before.size,mode:before.mode&0o777,sha256:digest};receipt.artifacts.push(row);return row;
 };
 const observe=async(label,action)=>{try{return await action();}catch(error){receipt.collectionErrors.push({input:label,error:error.message});}};
 for(const name of packagePortableReceipts){
  const source=path.join(consumer,name);if(!await exists(source)){receipt.missingPortableReceipts.push(name);continue;}
  await observe(name,async()=>{const row=await copy(source,'validations/'+name),value=JSON.parse(await readFile(source));receipt.portableReceipts.push({...row,passed:value.passed===true});assert.equal(value.schema,1);assert.equal(value.passed,true);assert.equal(value.targetExecution,false);if(value.node!==undefined)assert.equal(value.node,host.node,'Portable receipt belongs to a different Node runtime');assert.ok(value.sourceLoader===false||value.typescriptSourceLoader===false,'Portable receipt must record ordinary JavaScript');assert.notEqual(value.sourceLoader,true);assert.notEqual(value.typescriptSourceLoader,true);});
 }
 const tarballs=(await readdir(temporary)).filter(name=>name.endsWith('.tgz'));if(tarballs.length===1)await observe('tarball',async()=>{receipt.tarball=await copy(path.join(temporary,tarballs[0]),tarballs[0]);});else receipt.collectionErrors.push({input:'tarball',error:'Expected one actual package tarball, found '+tarballs.length});
 const installed=path.join(consumer,'node_modules');if(await exists(installed))await observe('installed-profile',async()=>{const profile=await packageInstallationProfile(installed),bytes=JSON.stringify(profile,null,2)+'\n',file=path.join(output,'installed-profile.json');await writeFile(file,bytes,{flag:'wx'});const row={file:'installed-profile.json',bytes:Buffer.byteLength(bytes),sha256:sha(bytes)};receipt.artifacts.push(row);receipt.installation={...row,regularFiles:profile.files.length,literalLinks:profile.links.length};});else receipt.collectionErrors.push({input:'installed-profile',error:'Installation was not created'});
 if(await exists(consumer)){
  for(const name of (await readdir(consumer)).sort())if(name.endsWith('.mjs')||name==='package.json')await observe(name,()=>copy(path.join(consumer,name),'probes/'+name));
  for(const name of ['native-wasm-originals','parser-fatal-fixtures','parser-frame-fixtures','framework-frame-fixtures']){
   const directory=path.join(consumer,name);if(!await exists(directory))continue;
   await observe(name,async()=>{const profile=await packageInstallationProfile(directory);assert.equal(profile.links.length,0,'Owned qualification originals must be regular');for(const row of profile.files)await copy(path.join(directory,...row.file.split('/')),'inputs/'+name+'/'+row.file);});
  }
 }
 receipt.passed=packagedChecksPassed&&!receipt.missingPortableReceipts.length&&!receipt.collectionErrors.length&&receipt.portableReceipts.length===packagePortableReceipts.length&&receipt.installation?.regularFiles>0&&!!receipt.tarball;
 receipt.completedAt=new Date().toISOString();await writeFile(path.join(output,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});return receipt;
}

/** Independent readback remains usable after the temporary consumer is gone. */
export async function verifyPackageEvidence(output){
 output=await realpath(output);const file=path.join(output,'receipt.json');await regular(file);const bytes=await readFile(file),receipt=JSON.parse(bytes);
 assert.equal(receipt.schema,1);assert.equal(receipt.passed,true);assert.equal(receipt.packagedChecksPassed,true);assert.equal(receipt.targetExecution,false);assert.ok(receipt.completedAt);assert.deepEqual(receipt.expectedPortableReceipts,packagePortableReceipts);assert.deepEqual(receipt.missingPortableReceipts,[]);assert.deepEqual(receipt.collectionErrors,[]);
 const rows=new Map();for(const row of receipt.artifacts){assert.ok(canonical(row.file)&&!rows.has(row.file));rows.set(row.file,row);const input=path.join(output,...row.file.split('/'));const info=await regular(input);assert.equal(info.size,row.bytes);if(row.mode!==undefined)assert.equal(info.mode&0o777,row.mode);assert.equal(await fileHash(input),row.sha256);}
 assert.deepEqual(receipt.portableReceipts.map(row=>row.file),packagePortableReceipts.map(name=>'validations/'+name));
 for(const row of receipt.portableReceipts){assert.deepEqual(rows.get(row.file),Object.fromEntries(Object.entries(row).filter(([key])=>key!=='passed')));assert.equal(row.passed,true);const value=JSON.parse(await readFile(path.join(output,row.file)));assert.equal(value.schema,1);if(value.node!==undefined)assert.equal(value.node,receipt.host.node);assert.equal(value.passed,true);assert.equal(value.targetExecution,false);assert.ok(value.sourceLoader===false||value.typescriptSourceLoader===false);assert.notEqual(value.sourceLoader,true);assert.notEqual(value.typescriptSourceLoader,true);}
 assert.deepEqual(rows.get(receipt.tarball.file),receipt.tarball);assert.ok(receipt.tarball.bytes>0);
 const {regularFiles,literalLinks,...profileRow}=receipt.installation;assert.deepEqual(rows.get(profileRow.file),profileRow);const profile=JSON.parse(await readFile(path.join(output,profileRow.file)));assert.equal(profile.files.length,regularFiles);assert.equal(profile.links.length,literalLinks);assert.ok(regularFiles>0);
 const names=new Set();for(const row of [...profile.files,...profile.links]){assert.ok(canonical(row.file)&&!names.has(row.file));names.add(row.file);if(row.target===undefined){assert.match(row.sha256,/^[a-f\d]{64}$/);assert.ok(Number.isSafeInteger(row.bytes)&&row.bytes>=0);}else assert.equal(typeof row.target,'string');}
 assert.equal(await fileHash(file),sha(bytes));return {file:'installed-package-evidence/receipt.json',sha256:sha(bytes),portableReceipts:receipt.portableReceipts.length,installedRegularFiles:regularFiles,installedLiteralLinks:literalLinks,tarballSha256:receipt.tarball.sha256,host:receipt.host};
}
