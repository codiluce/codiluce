import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';

test('framework V8 guard loads an owned absolute worker path with URL-significant characters',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'codiluce-framework-path-'));let passed=false;
 try{
  const worker=path.join(root,'owned worker é # %.mjs');
  await writeFile(worker,'import assert from "node:assert/strict";import v8 from "node:v8";assert.throws(()=>v8.serialize({facts:{original:true}}),/Owned forbidden full-framework V8 serialization/);process.stdout.write("owned framework URL passed");\n');
  const output=execFileSync(process.execPath,[fileURLToPath(new URL('../../tests/fixtures/framework-no-v8.mjs',import.meta.url))],{env:{...process.env,CODILUCE_OWNED_FRAMEWORK_WORKER:worker},encoding:'utf8',stdio:['ignore','pipe','pipe']});
  assert.equal(output,'owned framework URL passed');passed=true;
 }finally{if(passed)await rm(root,{recursive:true});else console.error('Retained owned framework worker path fixture:',root);}
});
