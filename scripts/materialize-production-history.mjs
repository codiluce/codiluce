import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateCorpus} from './production-history-inputs.mjs';
import {materializeProductionRevision} from './production-history-blobs.mjs';

const project=fileURLToPath(new URL('../',import.meta.url)),args=process.argv.slice(2),values=Object.create(null);
for(let index=0;index<args.length;index++){
  const flag=args[index],value=args[++index];
  if(!['--corpus','--repository','--commit','--source','--output'].includes(flag)||!value||value.startsWith('--')||Object.hasOwn(values,flag))throw Error('Expected unique --corpus FILE, --repository ID, --commit COMPLETE_PIN, --source DIRECTORY and --output FRESH_DIRECTORY');
  values[flag]=value;
}
for(const flag of ['--repository','--commit','--source','--output'])if(!values[flag])throw Error(`Missing ${flag}`);
const corpus=validateCorpus(JSON.parse(await readFile(values['--corpus']??path.join(project,'docs/production-history-corpus.json'),'utf8')));
const repository=corpus.repositories.find(item=>item.id===values['--repository']);if(!repository)throw Error('Repository is not in the reviewed corpus');
const revision=[...repository.revisions,...repository.extraRevisions].find(item=>item.commit===values['--commit']);if(!revision)throw Error('Commit is not a complete reviewed corpus pin');
const receipt=await materializeProductionRevision({source:path.resolve(values['--source']),revision,output:path.resolve(values['--output'])});
console.log(JSON.stringify({output:path.resolve(values['--output']),status:receipt.status,commit:receipt.commit,counts:receipt.counts,allRegularFilesMaterialized:receipt.allRegularFilesMaterialized,originalBlobBytesComplete:receipt.originalBlobBytesComplete,analysisQualified:false,error:receipt.error},null,2));
if(!receipt.materializationCompleted)process.exitCode=1;
