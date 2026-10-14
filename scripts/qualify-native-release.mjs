import {readdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {npmCliPath,qualify} from './native-release-runner.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),args=process.argv.slice(2);
if(args.some((arg,index)=>!['--install','--plan','--output'].includes(arg)&&args[index-1]!=='--output'))throw Error('Expected --install, --plan or --output DIRECTORY');
if(args.includes('--output')&&(!args[args.indexOf('--output')+1]||args[args.indexOf('--output')+1].startsWith('--')))throw Error('--output requires a directory');
const output=path.resolve(root,args.includes('--output')?args[args.indexOf('--output')+1]:'test-results/native-release');
const manifest=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')),minimum=/^>=(\d+)\.(\d+)\.(\d+)$/.exec(manifest.engines.node);
if(!minimum)throw Error('Unrecognized project Node engine range');
const actual=process.versions.node.split('.').map(Number),required=minimum.slice(1).map(Number);
if(actual[0]<required[0]||actual[0]===required[0]&&(actual[1]<required[1]||actual[1]===required[1]&&actual[2]<required[2]))throw Error(`Node ${manifest.engines.node} is required`);
const npmCli=await npmCliPath(),testFiles=[];
for(const folder of ['tests','web/tests','scripts/tests'])for(const file of(await readdir(path.join(root,folder))).sort())if(/\.test\.(?:ts|mjs)$/.test(file))testFiles.push(`${folder}/${file}`);
const commands=[
  ...args.includes('--install')?[{name:'dependencies',executable:process.execPath,parameters:[npmCli,'ci','--ignore-scripts','--no-audit','--no-fund'],install:true}]:[],
  {name:'tests',executable:process.execPath,parameters:['--experimental-sqlite','--import','tsx','--test','--test-concurrency=4',...testFiles],requiresInstall:true},
  {name:'typecheck',executable:process.execPath,parameters:[npmCli,'run','typecheck'],requiresInstall:true},
  {name:'capability-docs',executable:process.execPath,parameters:['scripts/generate-compatibility-docs.mjs','--check'],requiresInstall:true},
  {name:'installed-package',executable:process.execPath,parameters:[npmCli,'run','test:package','--','--evidence-dir',path.join(output,'installed-package-evidence')],requiresInstall:true,packageEvidence:'installed-package-evidence'},
];
if(args.includes('--plan'))console.log(JSON.stringify({root,output,node:process.version,minimum:manifest.engines.node,commands},null,2));
else{const receipt=await qualify({root,output,commands});console.log(JSON.stringify({output,qualified:receipt.qualified,sourceUnchanged:receipt.sourceUnchanged,checks:receipt.checks.map(({name,status})=>({name,status}))},null,2));if(!receipt.qualified)process.exitCode=1;}
