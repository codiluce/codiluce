import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

test('Default indexing prepares component recipes and rootless TypeScript configuration while compiler construction and optional parser loading are forbidden in the parent',()=>{
  const root=mkdtempSync(path.join(tmpdir(),'codiluce-preparation-receipt-')),file=path.join(root,'receipt.json');let passed=false;
  try{
    const output=execFileSync(process.execPath,['--experimental-sqlite','--loader',new URL('./fixtures/typescript-preparation-parent-loader.mjs',import.meta.url).href,'--import','tsx',fileURLToPath(new URL('./fixtures/typescript-preparation-parent-probe.mjs',import.meta.url)),new URL('../src/',import.meta.url).href,file],{maxBuffer:8*1024*1024});writeFileSync(path.join(root,'stdout.bin'),output);
    const receipt=JSON.parse(readFileSync(file,'utf8'));assert.equal(receipt.passed,true);assert.equal(receipt.profiles.length,4);assert.ok(receipt.profiles.every((profile:{passed:boolean;parentCompilerForbidden:boolean})=>profile.passed&&profile.parentCompilerForbidden));assert.equal(receipt.targetExecution,false);console.log(JSON.stringify(receipt));passed=true;
  }catch(error){if(error&&typeof error==='object'){if('stdout'in error&&Buffer.isBuffer(error.stdout))writeFileSync(path.join(root,'stdout.bin'),error.stdout);if('stderr'in error&&Buffer.isBuffer(error.stderr))writeFileSync(path.join(root,'stderr.bin'),error.stderr);}throw error;}
  finally{if(passed)rmSync(root,{recursive:true,force:true});else console.error('Retained preparation observer:',root);}
});

test('Embedded extraction and recipe heap failure leave all parent identities, graph and semantic cache state unpublished',()=>{
  const root=mkdtempSync(path.join(tmpdir(),'codiluce-preparation-fault-receipt-')),file=path.join(root,'receipt.json');let passed=false;
  try{
    const output=execFileSync(process.execPath,['--experimental-sqlite','--import','tsx',fileURLToPath(new URL('./fixtures/typescript-preparation-atomic.mjs',import.meta.url)),new URL('../src/',import.meta.url).href,file],{maxBuffer:8*1024*1024});writeFileSync(path.join(root,'stdout.bin'),output);const receipt=JSON.parse(readFileSync(file,'utf8'));assert.equal(receipt.passed,true);assert.equal(receipt.parentGraphUnchanged,true);assert.equal(receipt.parentEmbeddedObjectsAbsent,true);assert.equal(receipt.failedSemanticComponentStored,false);console.log(JSON.stringify({...receipt,rawStderr:'Preserved by qualification receipt'}));passed=true;
  }catch(error){if(error&&typeof error==='object'){if('stdout'in error&&Buffer.isBuffer(error.stdout))writeFileSync(path.join(root,'stdout.bin'),error.stdout);if('stderr'in error&&Buffer.isBuffer(error.stderr))writeFileSync(path.join(root,'stderr.bin'),error.stderr);}throw error;}
  finally{if(passed)rmSync(root,{recursive:true,force:true});else console.error('Retained preparation atomic observer:',root);}
});
