// Qualification infrastructure for Codiluce's own source and installed package.
// This runner never invokes a target application's runtime or dependency build.
import {createHash} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {mkdir,open,readFile,rename,stat} from 'node:fs/promises';
import {arch,release,type} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';

const execute=promisify(execFile);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

export async function npmCliPath(executable=process.execPath,environment=process.env){
  const candidates=[environment.npm_execpath,
    path.join(path.dirname(executable),'node_modules/npm/bin/npm-cli.js'),
    path.resolve(path.dirname(executable),'../lib/node_modules/npm/bin/npm-cli.js'),
    path.resolve(path.dirname(executable),'../libexec/lib/node_modules/npm/bin/npm-cli.js')];
  for(const candidate of candidates.filter(Boolean)){
    try{if((await stat(candidate)).isFile())return candidate;}catch{/* Try the next standard Node installation path. */}
  }
  throw Error('Cannot locate npm-cli.js beside Node; run through npm or use a standard Node installation');
}

export async function sourceIdentity(root){
  const git=async parameters=>(await execute('git',['-c',`core.hooksPath=${path.join(root,'.codiluce','native-release-disabled-hooks')}`,'-c','core.fsmonitor=false',...parameters],{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024})).stdout;
  const revision=(await git(['rev-parse','HEAD'])).trim(),gitVersion=(await git(['--version'])).trim();
  const files=(await git(['ls-files','-z'])).split('\0').filter(Boolean).sort(),hash=createHash('sha256');
  for(const file of files)hash.update(file+'\0').update(await readFile(path.join(root,file))).update('\0');
  return {revision,gitVersion,trackedFiles:files.length,sourceDigest:hash.digest('hex'),dirty:!!(await git(['status','--porcelain','--untracked-files=no'])).trim()};
}

/** Await child completion and close its inherited log descriptor before hashing
 * evidence. A nonzero exit, signal or spawn failure can never become a pass. */
export async function runLoggedCommand(command,parameters,{root,log}){
  const handle=await open(log,'wx');
  let result;
  try{
    result=await new Promise(resolve=>{
      let error;
      const child=spawn(command,parameters,{cwd:root,stdio:['ignore',handle.fd,handle.fd],shell:false});
      child.once('error',failure=>{error=failure.message;});
      child.once('close',(exitCode,signal)=>resolve({exitCode,signal,...error?{error}:{}}));
    });
  }finally{await handle.close();}
  const bytes=await readFile(log);
  return {...result,status:result.exitCode===0&&result.signal===null&&!result.error?'passed':'failed',logBytes:bytes.length,logSha256:digest(bytes)};
}

export function renderReceipt(receipt){
  const rows=receipt.checks.map(check=>`<tr><td>${escape(check.name)}</td><td>${escape(check.status)}</td><td>${check.seconds===undefined?'—':check.seconds.toFixed(2)}</td><td>${check.log?`<a href="${escape(check.log)}">original log</a>`:'—'}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Native compatibility qualification</title><style>body{font:16px/1.6 system-ui;margin:0;padding:clamp(16px,4vw,40px);background:#101822;color:#e5ecf4}main{max-width:1000px;margin:auto}h1{line-height:1.2}a{color:#8bddd8}.status{padding:16px;border:1px solid #8293a8;border-radius:8px}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;min-width:480px}td,th{padding:12px;text-align:left;border-bottom:1px solid #344353}pre,p{overflow-wrap:anywhere}pre{white-space:pre-wrap;font-size:12px}</style></head><body><main><h1>Native compatibility qualification</h1><p class="status"><strong>${receipt.qualified?'PASS for this recorded native host':receipt.completedAt?'NOT QUALIFIED':'INCOMPLETE — checks have not all finished'}</strong></p><p>${escape(receipt.host.platform)}/${escape(receipt.host.architecture)} · ${escape(receipt.host.osType)} ${escape(receipt.host.osRelease)} · Node ${escape(receipt.host.node)}</p><p>This record covers Codiluce's own conformance, typecheck, capability documentation and production-only installed-package checks. The package harness checks parser assets, original source coordinates and identities, framework handlers, cross-file cache changes, inspector HTTP flows and compiled history. Target applications, toolchains, dependencies, hooks and builds never run. A result from one host does not establish another OS, architecture or Node version; native release qualification requires all configured matrix jobs. Wider source accuracy and production performance remain separate gates.</p><div class="scroll"><table><thead><tr><th>Check</th><th>Outcome</th><th>Seconds</th><th>Evidence</th></tr></thead><tbody>${rows}</tbody></table></div><details><summary>Host, exact source identity, commands and receipts</summary><pre>${escape(JSON.stringify(receipt,null,2))}</pre></details></main></body></html>`;
}

export async function writeReceipt(output,receipt){
  for(const [file,content]of [['receipt.json',JSON.stringify(receipt,null,2)+'\n'],['index.html',renderReceipt(receipt)]]){
    const pending=path.join(output,file+'.pending');
    const handle=await open(pending,'w');try{await handle.writeFile(content);await handle.sync();}finally{await handle.close();}
    await rename(pending,path.join(output,file));
  }
}

export async function qualify({root,output,commands,identity=()=>sourceIdentity(root),host={platform:process.platform,architecture:arch(),osType:type(),osRelease:release(),node:process.version,versions:process.versions}}){
  await mkdir(path.dirname(output),{recursive:true});await mkdir(output); // Never overwrite prior observations.
  const receipt={schema:1,startedAt:new Date().toISOString(),qualified:false,host,checks:commands.map(({name})=>({name,status:'pending'}))};
  await writeReceipt(output,receipt);
  try{
    receipt.before=await identity();await writeReceipt(output,receipt);
    let dependenciesAvailable=true;
    for(const [index,command]of commands.entries()){
      const check=receipt.checks[index];
      if(!dependenciesAvailable&&command.requiresInstall){check.status='skipped';check.reason='Dependency installation failed';await writeReceipt(output,receipt);continue;}
      Object.assign(check,{status:'running',command:command.executable,parameters:command.parameters,log:`${index+1}-${command.name}.log`});await writeReceipt(output,receipt);
      console.log(`Starting ${command.name}`);const start=performance.now();
      Object.assign(check,await runLoggedCommand(command.executable,command.parameters,{root,log:path.join(output,check.log)}),{seconds:(performance.now()-start)/1000});
      if(command.install&&check.status!=='passed')dependenciesAvailable=false;
      await writeReceipt(output,receipt);console.log(`${command.name}: ${check.status}`);
    }
    receipt.after=await identity();receipt.sourceUnchanged=receipt.before.sourceDigest===receipt.after.sourceDigest&&receipt.before.revision===receipt.after.revision;
    receipt.qualified=receipt.sourceUnchanged&&!receipt.before.dirty&&!receipt.after.dirty&&receipt.checks.length>0&&receipt.checks.every(check=>check.status==='passed');
  }catch(error){receipt.error=error instanceof Error?error.message:String(error);}
  receipt.completedAt=new Date().toISOString();await writeReceipt(output,receipt);return receipt;
}
