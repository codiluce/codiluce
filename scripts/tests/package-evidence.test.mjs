import assert from 'node:assert/strict';
import {afterEach,test} from 'node:test';
import {mkdir,mkdtemp,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {capturePackageEvidence,createPackageEvidenceDirectory,packageEvidenceArgument,packageInstallationProfile,packagePortableReceipts,verifyPackageEvidence} from '../package-evidence.mjs';
import {qualify,renderReceipt} from '../native-release-runner.mjs';
const roots=[];afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(){
 const root=await mkdtemp(path.join(os.tmpdir(),'codiluce-package-evidence-'));roots.push(root);const temporary=path.join(root,'scratch'),consumer=path.join(temporary,'consumer');await mkdir(path.join(consumer,'node_modules/codiluce/dist/src'),{recursive:true});await writeFile(path.join(consumer,'node_modules/codiluce/dist/src/original.js'),'export const original = true;');await writeFile(path.join(temporary,'owned-package.tgz'),'owned synthetic tarball bytes');await writeFile(path.join(consumer,'owned-check.mjs'),'throw Error("copy only; must never execute");');
 for(const name of packagePortableReceipts){const value={schema:1,passed:true,targetExecution:false,sourceLoader:false,node:process.version,original:'é😀\r\n'};if(name.startsWith('typescript-input-ownership'))value.programSourceCount=40;else if(name.startsWith('literal-script-generation'))value.defaultCompilerJobsVerified=65;else value.caseCount=1;await writeFile(path.join(consumer,name),JSON.stringify(value)+'\n');}
 const output=await createPackageEvidenceDirectory(path.join(root,'evidence'),temporary);return {root,temporary,consumer,output};
}
test('package evidence CLI is opt-in, canonical and rejects malformed or repeated arguments',()=>{
 assert.equal(packageEvidenceArgument([],process.cwd()),undefined);assert.equal(packageEvidenceArgument(['--evidence-dir','owned evidence'],process.cwd()),path.join(process.cwd(),'owned evidence'));
 for(const args of [['--evidence-dir'],['--unknown','directory'],['--evidence-dir','--plan'],['--evidence-dir','one','--evidence-dir','two']])assert.throws(()=>packageEvidenceArgument(args,process.cwd()));
});
test('package evidence preserves all original receipt bytes and distinct workload schemas after cleanup',async()=>{
 const f=await fixture(),before=await readFile(path.join(f.consumer,packagePortableReceipts[0]));const result=await capturePackageEvidence({...f,packagedChecksPassed:true});assert.equal(result.passed,true);assert.equal(result.portableReceipts.length,18);assert.equal(result.installation.regularFiles,1);await rm(f.temporary,{recursive:true});
 assert.deepEqual(await readFile(path.join(f.output,'validations',packagePortableReceipts[0])),before);const owned=JSON.parse(await readFile(path.join(f.output,'validations',packagePortableReceipts[0])));assert.equal(owned.caseCount,undefined);assert.equal(owned.programSourceCount,40);assert.equal((await verifyPackageEvidence(f.output)).portableReceipts,18);
});
test('package evidence retains incomplete failed checks without rewriting a failed portable result',async()=>{
 const f=await fixture();await rm(path.join(f.consumer,packagePortableReceipts[0]));const failed=path.join(f.consumer,packagePortableReceipts[2]);await writeFile(failed,'{"schema":1,"passed":false,"targetExecution":false,"sourceLoader":false}\n');const result=await capturePackageEvidence({...f,packagedChecksPassed:false,error:'original package failure'});assert.equal(result.passed,false);assert.equal(result.packageError,'original package failure');assert.deepEqual(result.missingPortableReceipts,[packagePortableReceipts[0]]);assert.equal(JSON.parse(await readFile(path.join(f.output,'validations',packagePortableReceipts[2]))).passed,false);await assert.rejects(verifyPackageEvidence(f.output));
});
test('zero-exit package work cannot produce complete evidence with missing, malformed or source-loader receipts',async()=>{
 for(const kind of ['missing','malformed','source-loader','node']){const f=await fixture(),file=path.join(f.consumer,packagePortableReceipts[0]);if(kind==='missing')await rm(file);else if(kind==='malformed')await writeFile(file,'invalid JSON');else{const value=JSON.parse(await readFile(file));if(kind==='source-loader')value.sourceLoader=true;else value.node='v0.0.0';await writeFile(file,JSON.stringify(value));}const result=await capturePackageEvidence({...f,packagedChecksPassed:true});assert.equal(result.passed,false);await assert.rejects(verifyPackageEvidence(f.output));}
});
test('evidence is never created inside scratch or overwritten after an earlier observation',async()=>{
 const f=await fixture();await assert.rejects(createPackageEvidenceDirectory(path.join(f.temporary,'lost'),f.temporary),/survive/);await assert.rejects(createPackageEvidenceDirectory(f.output,f.temporary),/EEXIST/);await capturePackageEvidence({...f,packagedChecksPassed:true});const before=await readFile(path.join(f.output,'receipt.json'));await assert.rejects(capturePackageEvidence({...f,packagedChecksPassed:true}),/must be empty/);assert.deepEqual(await readFile(path.join(f.output,'receipt.json')),before);
});
test('evidence readback rejects changed receipt, tarball, profile and owned probe bytes',async()=>{
 for(const file of ['validations/'+packagePortableReceipts[0],'owned-package.tgz','installed-profile.json','probes/owned-check.mjs']){const f=await fixture();await capturePackageEvidence({...f,packagedChecksPassed:true});await writeFile(path.join(f.output,file),'same count, different original bytes');await assert.rejects(verifyPackageEvidence(f.output));}
});
test('installation profiles retain literal foreign directory links without following them',{skip:process.platform==='win32'&&'Creating test symlinks requires a privileged Windows account; production profiling never creates links'},async()=>{
 const f=await fixture();await symlink('/never-follow-foreign-target',path.join(f.consumer,'node_modules','literal-link'));const profile=await packageInstallationProfile(path.join(f.consumer,'node_modules'));assert.equal(profile.files.length,1);assert.deepEqual(profile.links,[{file:'literal-link',target:'/never-follow-foreign-target'}]);
 const result=await capturePackageEvidence({...f,packagedChecksPassed:true});assert.equal(result.passed,true);assert.equal(result.installation.literalLinks,1);assert.equal((await verifyPackageEvidence(f.output)).installedLiteralLinks,1);
});
test('native release joins preserved package evidence to the actual host and browser report',async()=>{
 const f=await fixture();await capturePackageEvidence({...f,packagedChecksPassed:true});const output=path.join(f.root,'native-report');await mkdir(output);await import('node:fs/promises').then(fs=>fs.rename(f.output,path.join(output,'installed-package-evidence')));
 const identity=async()=>({revision:'owned-fixture',sourceDigest:'owned-original',dirty:false});
 // This is an owned runner join, not a real npm/native-platform gate.
 const fresh=path.join(f.root,'fresh-report');const prepared=path.join(f.root,'prepared-evidence');await import('node:fs/promises').then(fs=>fs.cp(path.join(output,'installed-package-evidence'),prepared,{recursive:true}));
 const script='const fs=require("node:fs");fs.cpSync(process.argv[1],process.argv[2],{recursive:true});';const result=await qualify({root:f.root,output:fresh,identity,commands:[{name:'owned-package-join',executable:process.execPath,parameters:['-e',script,prepared,path.join(fresh,'installed-package-evidence')],packageEvidence:'installed-package-evidence'}]});assert.equal(result.qualified,true);assert.equal(result.checks[0].packageEvidence.portableReceipts,18);assert.match(renderReceipt(result),/installed-package-evidence\/receipt.json/);
 const receiptFile=path.join(prepared,'receipt.json'),receipt=JSON.parse(await readFile(receiptFile));receipt.host.platform='another-host';await writeFile(receiptFile,JSON.stringify(receipt));const wrong=path.join(f.root,'wrong-host');const rejected=await qualify({root:f.root,output:wrong,identity,commands:[{name:'owned-package-join',executable:process.execPath,parameters:['-e',script,prepared,path.join(wrong,'installed-package-evidence')],packageEvidence:'installed-package-evidence'}]});assert.equal(rejected.qualified,false);assert.match(rejected.checks[0].evidenceError,/different native host/);
});
