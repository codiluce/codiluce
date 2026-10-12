import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyHistoryInputs} from './production-history-inputs.mjs';

const project=fileURLToPath(new URL('../',import.meta.url)),args=process.argv.slice(2),sources=Object.create(null);
let corpusFile=path.join(project,'docs/production-history-corpus.json'),output=path.join(project,'test-results/production-history-inputs');
for(let index=0;index<args.length;index++){
  const flag=args[index],value=args[++index];
  if(!['--corpus','--output','--source'].includes(flag)||!value||value.startsWith('--'))throw Error('Expected --corpus FILE, --output FRESH_DIRECTORY or --source ID=DIRECTORY');
  if(flag==='--corpus')corpusFile=path.resolve(value);
  else if(flag==='--output')output=path.resolve(value);
  else{
    const separator=value.indexOf('=');if(separator<1||separator===value.length-1)throw Error('--source requires ID=DIRECTORY');
    const id=value.slice(0,separator);if(Object.hasOwn(sources,id))throw Error(`Duplicate source ${id}`);
    sources[id]=path.resolve(value.slice(separator+1));
  }
}
const corpus=JSON.parse(await readFile(corpusFile,'utf8'));
const receipt=await verifyHistoryInputs({corpus,sources,output});
console.log(JSON.stringify({output,inputsVerified:receipt.inputsVerified,analysisQualified:false,repositories:receipt.repositories.map(({id,status,revisions,extraRevisions,error})=>({id,status,revisions,extraRevisions,error}))},null,2));
if(!receipt.inputsVerified)process.exitCode=1;
