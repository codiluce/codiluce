import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareProductionGit} from './production-cache-git.mjs';
import {inspectHeadTree} from './production-head-graphs.mjs';
import {validateCorpus} from './production-history-inputs.mjs';

const project=fileURLToPath(new URL('../',import.meta.url)),args=process.argv.slice(2),options={},sources={},observations={};
for(let i=0;i<args.length;i++){
 const flag=args[i],value=args[++i];assert.ok(value&&!value.startsWith('--'),'Every option requires a value');
 if(['--source','--source-observation'].includes(flag)){const at=value.indexOf('='),group=flag==='--source'?sources:observations;assert.ok(at>0&&at<value.length-1&&!Object.hasOwn(group,value.slice(0,at)));group[value.slice(0,at)]=path.resolve(value.slice(at+1));}
 else{assert.ok(['--corpus','--output'].includes(flag)&&!Object.hasOwn(options,flag));options[flag]=path.resolve(value);}
}
const corpus=validateCorpus(JSON.parse(await readFile(options['--corpus']??path.join(project,'docs/production-history-corpus.json'),'utf8'))),ids=corpus.repositories.map(row=>row.id).sort();assert.deepEqual(Object.keys(sources).sort(),ids);assert.deepEqual(Object.keys(observations).sort(),ids);
const destination=options['--output'];await mkdir(destination);const receipt={schema:1,startedAt:new Date().toISOString(),completedAt:null,policy:'Isolated owned config/index/HEAD and exact shallow boundaries; read-only original Git objects; no target Git config, hooks, replacement refs, dependencies or code execute',repositories:{}};
for(const repository of corpus.repositories){const original=await inspectHeadTree(observations[repository.id],repository.revisions.at(-1)),metadata=await prepareProductionGit({source:sources[repository.id],tree:original.tree,commit:repository.head,output:path.join(destination,repository.id+'-git')});assert.equal(metadata.tree,repository.revisions.at(-1).tree);assert.deepEqual(await inspectHeadTree(observations[repository.id],repository.revisions.at(-1)),original);receipt.repositories[repository.id]=metadata;await writeFile(path.join(destination,'git-metadata.json'),JSON.stringify(receipt,null,2)+'\n');}
receipt.completedAt=new Date().toISOString();await writeFile(path.join(destination,'git-metadata.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify({output:destination,repositories:Object.keys(receipt.repositories)}));
