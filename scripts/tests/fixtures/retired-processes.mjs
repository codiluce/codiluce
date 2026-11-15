import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {promisify} from 'node:util';

const execute=promisify(execFile),python=process.platform==='win32'?'python':'python3';
export async function retiredProcessIds(count){
 assert.ok(Number.isSafeInteger(count)&&count>0);
 // Keep the actual exited process handles until every audit is complete.
 // Windows can otherwise reuse these PIDs for concurrent test processes.
 const pending=execute(python,['-u','-c',`
import json, subprocess, sys
children = [subprocess.Popen([sys.argv[1], '-e', ''], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) for _ in range(int(sys.argv[2]))]
for child in children:
    assert child.wait(timeout=30) == 0
print(json.dumps([child.pid for child in children]), flush=True)
sys.stdin.buffer.read()
`,process.execPath,String(count)],{timeout:120_000,maxBuffer:1024*1024}),settled=pending.then(()=>undefined,error=>error),lines=createInterface({input:pending.child.stdout});
 const close=async()=>{pending.child.stdin.end();const error=await settled;if(error)throw error;};
 try{
  const [line]=await Promise.race([once(lines,'line'),settled.then(error=>{throw error??Error('Process identity owner exited before readiness');})]),pids=JSON.parse(line);
  assert.equal(pids.length,count);assert.equal(new Set(pids).size,count);assert.ok(pids.every(pid=>Number.isSafeInteger(pid)&&pid>0));return {pids,close};
 }catch(error){await close();throw error;}finally{lines.close();}
}
