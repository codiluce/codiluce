// Explicit maintainer rebuild of Codiluce's WASM asset from pinned generated C.
// No upstream npm hooks, grammar generation, Razor/.NET compiler/MSBuild/target build script runs.
// node scripts/build-razor-grammar.mjs [--artifacts DIRECTORY]
// An offline artifact directory contains source.tgz, cli.gz and sdk.tgz.
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {chmod,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';

const project=fileURLToPath(new URL('../',import.meta.url)),manifest=JSON.parse(await readFile(path.join(project,'grammars/manifest.json'),'utf8')),grammar=manifest.grammars.find(g=>g.language==='razor'),build=grammar.artifactBuild;
const at=process.argv.indexOf('--artifacts'),mirror=at<0?undefined:process.argv[at+1];if(at>=0&&!mirror)throw Error('--artifacts requires a directory');
const root=await mkdtemp(path.join(tmpdir(),'codiluce-razor-build-'));
try{
 const artifacts=[['source.tgz',build.sourceArchive,'sha512',build.sourceIntegrity.slice(7),'base64'],['cli.gz',build.cliUrl,'sha256',build.cliSha256,'hex'],['sdk.tgz',build.sdkUrl,'sha256',build.sdkSha256,'hex']];
 await Promise.all(artifacts.map(async([name,url,algorithm,expected,encoding])=>{let bytes;if(mirror)bytes=await readFile(path.join(mirror,name));else{const response=await fetch(url,{signal:AbortSignal.timeout(60000)});if(!response.ok)throw Error(`Download failed (${response.status}): ${name}`);bytes=Buffer.from(await response.arrayBuffer());}if(createHash(algorithm).update(bytes).digest(encoding)!==expected)throw Error(`Pinned artifact checksum mismatch: ${name}`);await writeFile(path.join(root,name),bytes);}));
 execFileSync('tar',['-xzf',path.join(root,'source.tgz'),'-C',root]);execFileSync('tar',['-xzf',path.join(root,'sdk.tgz'),'-C',root]);
 const cli=path.join(root,'tree-sitter');await writeFile(cli,gunzipSync(await readFile(path.join(root,'cli.gz'))));await chmod(cli,0o755);
 const docker=['run','--rm','--platform','linux/amd64','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--tmpfs','/tmp','--user',`${process.getuid?.()??1000}:${process.getgid?.()??1000}`,'--env','XDG_CACHE_HOME=/work/cache','--env',`TREE_SITTER_WASI_SDK_PATH=/work/wasi-sdk-${build.sdkVersion}-x86_64-linux`,'--mount',`type=bind,source=${root},target=/work`,'--mount',`type=bind,source=${cli},target=/usr/local/bin/tree-sitter,readonly`,'--workdir',`/work/${build.sourceDirectory}`,build.container];
 const version=execFileSync('docker',[...docker,'tree-sitter','--version'],{encoding:'utf8'}).trim();if(version!==`tree-sitter ${build.cliVersion}`&&!version.startsWith(`tree-sitter ${build.cliVersion} `))throw Error(`Unexpected CLI: ${version}`);
 execFileSync('docker',[...docker,'tree-sitter','build','--wasm','--output',grammar.artifactPath],{stdio:'inherit'});
 const bytes=await readFile(path.join(root,build.sourceDirectory,grammar.artifactPath)),hash=createHash('sha256').update(bytes).digest('hex');if(hash!==grammar.sha256)throw Error(`Rebuilt WASM differs: ${hash}; review provenance before updating the manifest`);
 await writeFile(path.join(project,'grammars',grammar.file),bytes);console.log(`Rebuilt and verified ${grammar.file}: ${hash} (${bytes.length} bytes)`);
}finally{await rm(root,{recursive:true,force:true});}
