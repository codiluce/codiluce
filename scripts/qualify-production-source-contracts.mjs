import {createHash} from 'node:crypto';
import {mkdir,readFile,realpath,rename,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifySourceContracts,validateSourceContracts} from './production-source-contracts.mjs';

const project=fileURLToPath(new URL('../',import.meta.url)),args=process.argv.slice(2),observations=Object.create(null),graphFiles=Object.create(null),options=Object.create(null);
for(let index=0;index<args.length;index++){
  const flag=args[index],value=args[++index];
  if(!['--manifest','--corpus','--source-observation','--graph','--output'].includes(flag)||!value||value.startsWith('--'))throw Error('Expected --manifest FILE, --corpus FILE, --source-observation ID=DIRECTORY, --graph ID=JSON or --output FRESH_DIRECTORY');
  if(flag==='--source-observation'||flag==='--graph'){
    const at=value.indexOf('='),map=flag==='--graph'?graphFiles:observations,id=value.slice(0,at);
    if(at<1||at===value.length-1||Object.hasOwn(map,id))throw Error('Original observations and graphs require unique ID=PATH values');map[id]=path.resolve(value.slice(at+1));
  }else{if(Object.hasOwn(options,flag))throw Error(`Duplicate ${flag}`);options[flag]=path.resolve(value);}
}
const manifest=JSON.parse(await readFile(options['--manifest']??path.join(project,'docs/production-source-contracts.json'),'utf8'));
const corpus=JSON.parse(await readFile(options['--corpus']??path.join(project,'docs/production-history-corpus.json'),'utf8'));validateSourceContracts(manifest,corpus);
const ids=new Set(manifest.contracts.map(contract=>contract.repository));for(const id of [...Object.keys(observations),...Object.keys(graphFiles)])if(!ids.has(id))throw Error(`Unknown source-contract repository ${id}`);
const destination=options['--output']??path.join(project,'test-results/production-source-contracts');
async function resolveDestination(target){let current=target,tail=[];for(;;){try{return path.join(await realpath(current),...tail.reverse());}catch(error){if(error.code!=='ENOENT')throw error;const parent=path.dirname(current);if(parent===current)throw error;tail.push(path.basename(current));current=parent;}}}
const actual=await resolveDestination(destination);
for(const source of Object.values(observations)){const relative=path.relative(await resolveDestination(source),actual);if(!(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)))throw Error('Receipt must be outside every original observation');}
await mkdir(path.dirname(actual),{recursive:true});await mkdir(actual);
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const identity=async()=>Promise.all(['production-source-contracts.mjs','qualify-production-source-contracts.mjs','production-history-blobs.mjs','production-history-inputs.mjs'].map(async file=>({file,sha256:sha256(await readFile(new URL(file,import.meta.url)))})));
const before=await identity(),graphs=Object.create(null),graphInputs=[];
for(const [id,file]of Object.entries(graphFiles)){
  try{const info=await stat(file);if(!info.isFile()||info.size>256*1024*1024)throw Error('Graph input must be a regular JSON file of at most 256 MiB');const bytes=await readFile(file);if(bytes.length>256*1024*1024)throw Error('Graph input exceeds the JSON byte limit');graphs[id]=JSON.parse(bytes.toString('utf8'));graphInputs.push({id,sha256:sha256(bytes),bytes:bytes.length});}
  catch(error){graphs[id]={graphLoadError:error.message};graphInputs.push({id,error:error.message});}
}
const receipt=await verifySourceContracts({manifest,corpus,observations,graphs});receipt.verifierBefore=before;receipt.verifierAfter=await identity();receipt.verifierUnchanged=JSON.stringify(before)===JSON.stringify(receipt.verifierAfter);receipt.graphInputs=graphInputs;
if(!receipt.verifierUnchanged){receipt.originalSourcesVerified=false;receipt.graphContractsVerified=false;receipt.error='Source-contract verifier changed during observation';}
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const outcome=receipt.graphContractsVerified?'REVIEWED GRAPH AND ORIGINAL SOURCE CONTRACTS VERIFIED':!receipt.originalSourcesVerified?'SOURCE CONTRACTS FAILED':receipt.contracts.some(contract=>contract.status==='failed')?'GRAPH CONTRACTS FAILED; ORIGINAL SOURCE ANCHORS VERIFIED':Object.keys(graphFiles).length?'GRAPH CONTRACTS INCOMPLETE; ORIGINAL SOURCE ANCHORS VERIFIED':'ORIGINAL SOURCE ANCHORS VERIFIED; GRAPH CONTRACTS PENDING';
const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Production original source contracts</title><style>body{margin:0;padding:clamp(16px,4vw,40px);font:16px/1.6 system-ui;background:#101822;color:#e5ecf4}main{max-width:1080px;margin:auto}h1{line-height:1.2}.status{padding:16px;border:1px solid #8293a8;border-radius:8px}p,pre{overflow-wrap:anywhere}pre{white-space:pre-wrap;font-size:12px}</style></head><body><main><h1>Production original source contracts</h1><p class="status"><strong>${outcome}</strong><br>Complete corpus accuracy, replay/history parity, performance and release qualification are pending.</p><p>Each reviewed assertion requires original file-byte and exact declaration-span SHA-256, one-based UTF-16 coordinates, original header spelling, entity kind/name/language, lexical ownership, containment and original-file evidence. Source-only verification cannot qualify missing graph assertions. This manifest samples reviewed declarations; it does not prove unreviewed facts or an entire framework.</p><details><summary>Every original/graph outcome and exact verifier identity</summary><pre>${escape(JSON.stringify(receipt,null,2))}</pre></details></main></body></html>`;
for(const [name,text]of [['receipt.json',JSON.stringify(receipt,null,2)+'\n'],['index.html',html]]){const pending=path.join(actual,name+'.pending');await writeFile(pending,text);await rename(pending,path.join(actual,name));}
console.log(JSON.stringify({output:actual,originalSourcesVerified:receipt.originalSourcesVerified,graphContractsVerified:receipt.graphContractsVerified,analysisQualified:false,contracts:receipt.contracts.map(({id,status,error})=>({id,status,error}))},null,2));
if(!receipt.originalSourcesVerified||Object.keys(graphFiles).length&&!receipt.graphContractsVerified)process.exitCode=1;
