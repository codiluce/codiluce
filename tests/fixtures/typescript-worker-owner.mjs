// Owned cancellation probe; never part of target application execution.
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {fileURLToPath} from 'node:url';
const {runTypeScriptWorker}=await import(new URL('analyzers/typescript-isolated.js',new URL(process.argv[2])));
const original=cp.fork;cp.fork=(...args)=>{const child=original(...args);process.send({workerPid:child.pid});return child;};syncBuiltinESMExports();
process.once('message',()=>process.exit(31));
const request={protocol:3,context:{config:{repository:{name:'owner-hang'}}}};
void runTypeScriptWorker(request,{worker:fileURLToPath(new URL('./typescript-worker-control.mjs',import.meta.url))}).catch(()=>{});
