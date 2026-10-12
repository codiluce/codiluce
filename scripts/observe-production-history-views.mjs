import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile,realpath,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {verifyProductionHistoryRunInputs} from './audit-production-history.mjs';
import {snapshotStorageLedger} from './production-history-storage-ledger.mjs';
import {verifyPublicHistoryViews} from './production-history-public-views.mjs';

const args=process.argv.slice(2),options={};for(let index=0;index<args.length;index++){const key=args[index],value=args[++index];assert.ok(['--resume','--output','--engine'].includes(key)&&value&&!value.startsWith('--')&&!Object.hasOwn(options,key));options[key]=value;}
const directory=await realpath(options['--resume']),output=path.resolve(options['--output']),engine=await realpath(options['--engine']??fileURLToPath(new URL('../',import.meta.url))),receipt=JSON.parse(await readFile(path.join(directory,'receipt.json')));
assert.equal(receipt.passed,true);assert.equal(receipt.repositories.length,1);assert.equal(await realpath(path.dirname(output)),path.dirname(output));const relative=path.relative(directory,output);assert.ok(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative),'View receipt must be outside the copied observation');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');async function fileHash(file){const digest=createHash('sha256');for await(const bytes of createReadStream(file))digest.update(bytes);return digest.digest('hex');}
const frozenNames=['observe-production-history-views.mjs','production-history-public-views.mjs','production-history-storage-ledger.mjs','audit-production-history.mjs','production-history-inputs.mjs'],frozen=Object.fromEntries(await Promise.all(frozenNames.map(async name=>[name,await fileHash(fileURLToPath(new URL(name,import.meta.url)))]))),original=JSON.parse(await readFile(path.join(directory,'input-receipt.json'))),corpusBytes=await readFile(path.join(directory,'input-corpus.json')),profilesBytes=await readFile(path.join(directory,'input-profiles.json'));
const verify=async()=>{for(const [name,digest] of Object.entries(frozen))assert.equal(await fileHash(fileURLToPath(new URL(name,import.meta.url))),digest);return verifyProductionHistoryRunInputs({receipt:original,corpusBytes,profilesBytes,engine});};
const runInputs=await verify(),row=receipt.repositories[0],database=path.join(directory,row.id,'state/history.db'),databaseBefore=await fileHash(database),result={schema:1,id:row.id,startedAt:new Date().toISOString(),passed:false,runInputs,frozen,resumeReceiptSha256:hash(await readFile(path.join(directory,'receipt.json'))),databaseSha256:databaseBefore,full195RevisionPublicViewsQualified:false,relativeHistoryTimeRssQualified:false,nativeWindowsMacOSQualified:false};
let history;
try{
 const load=file=>import(pathToFileURL(path.join(engine,file)).href),[{HistoryStore},{GraphStore},{ProjectionService}]=await Promise.all([load('src/history/store.ts'),load('src/storage/sqlite.ts'),load('src/projection/service.ts')]);history=new HistoryStore(database,true);assert.deepEqual(snapshotStorageLedger(history.db),row.child.originalSnapshotLedger);
 result.views=await verifyPublicHistoryViews(history,{GraphStore,ProjectionService});assert.deepEqual(snapshotStorageLedger(history.db),row.child.originalSnapshotLedger);result.passed=true;
}catch(error){result.error=error.message;result.stack=error.stack;process.exitCode=1;}finally{history?.close();}
result.databaseSha256After=await fileHash(database);result.databaseUnchanged=result.databaseSha256After===databaseBefore;if(!result.databaseUnchanged){result.passed=false;result.error='Copied history database changed during public view inspection';process.exitCode=1;}
assert.deepEqual(await verify(),runInputs);result.completedAt=new Date().toISOString();await writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({passed:result.passed,id:result.id,snapshots:result.views?.snapshots.length,offFirstParentSnapshots:result.views?.offFirstParentSnapshots,error:result.error}));
