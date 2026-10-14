import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

test('Default TypeScript compiler worker passes all portable graph, cache, heap, protocol and process-retirement contracts',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'codiluce-worker-contract-receipt-')),file=path.join(directory,'receipt.json');let passed=false;
  try {
    const output=execFileSync(process.execPath,['--experimental-sqlite','--import','tsx',fileURLToPath(new URL('./fixtures/typescript-worker-qualification.mjs',import.meta.url)),new URL('../src/',import.meta.url).href,file],{maxBuffer:8*1024*1024});
    writeFileSync(path.join(directory,'stdout.bin'),output);
    const receipt=JSON.parse(readFileSync(file,'utf8'));
    assert.equal(receipt.passed,true);assert.equal(receipt.caseCount,12);assert.equal(receipt.completedCases.length,12);assert.equal(receipt.targetExecution,false);
    console.log(JSON.stringify(receipt));passed=true;
  } catch(error) {
    if (error && typeof error === 'object') { if ('stdout' in error && Buffer.isBuffer(error.stdout)) writeFileSync(path.join(directory,'stdout.bin'),error.stdout); if ('stderr' in error && Buffer.isBuffer(error.stderr)) writeFileSync(path.join(directory,'stderr.bin'),error.stderr); }
    throw error;
  } finally { if(passed)rmSync(directory,{recursive:true,force:true});else console.error('Retained worker contract observer:',directory); }
});
