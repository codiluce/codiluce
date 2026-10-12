// Reviewed original-byte assertions, independent of analyzer extraction.
// Source-only success never claims graph/source accuracy or release readiness.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstat,readFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {materializedPathReason} from './production-history-blobs.mjs';
import {validateCorpus} from './production-history-inputs.mjs';

const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export function validateSourceContracts(manifest,corpus){
  validateCorpus(corpus);assert.equal(manifest.schema,1,'Unsupported source-contract schema');
  assert.ok(Array.isArray(manifest.contracts)&&manifest.contracts.length>0,'Reviewed source contracts are required');
  const ids=new Set();
  for(const contract of manifest.contracts){
    assert.match(contract.id,/^[a-z][a-z\d-]{0,95}$/);assert.ok(!ids.has(contract.id),'Duplicate source-contract identity');ids.add(contract.id);
    const repository=corpus.repositories.find(item=>item.id===contract.repository);assert.ok(repository,'Unknown reviewed repository');
    assert.ok([...repository.revisions,...repository.extraRevisions].some(item=>item.commit===contract.commit),'Source contract needs a complete reviewed commit pin');
    assert.equal(materializedPathReason(contract.path),undefined,'Source path must be portable and repository-relative');
    assert.match(contract.fileSha256,/^[a-f\d]{64}$/);assert.match(contract.spanSha256,/^[a-f\d]{64}$/);
    assert.ok(['class','controller','function','method'].includes(contract.entityType));
    assert.ok(typeof contract.name==='string'&&contract.name.trim());assert.match(contract.language,/^[a-z][a-z\d-]*$/);
    assert.ok(typeof contract.header==='string'&&contract.header.trim());
    assert.ok(contract.owner===undefined||typeof contract.owner==='string'&&contract.owner.trim());
    for(const key of ['startLine','startColumn','endLine','endColumn'])assert.ok(Number.isSafeInteger(contract.range[key])&&contract.range[key]>0,'Original source coordinates must be positive integers');
    assert.ok(contract.range.endLine>contract.range.startLine||contract.range.endLine===contract.range.startLine&&contract.range.endColumn>=contract.range.startColumn,'Original source range is reversed');
  }
  return manifest;
}

/** One-based UTF-16 coordinates, exclusive end. Implemented independently of
 * analyzer SourceText; CR/LF, CRLF and Unicode line separators stay original. */
export function contractSpan(text,range){
  const lines=text.split(/\r\n|[\r\n\u2028\u2029]/),breaks=[...text.matchAll(/\r\n|[\r\n\u2028\u2029]/g)];
  const offset=(line,column)=>{
    assert.ok(line<=lines.length,'Original source line is outside the file');
    assert.ok(column<=lines[line-1].length+1,'Original UTF-16 column is outside the line');
    return (line===1?0:breaks[line-2].index+breaks[line-2][0].length)+column-1;
  };
  const start=offset(range.startLine,range.startColumn),end=offset(range.endLine,range.endColumn);
  assert.ok(end>=start,'Original source offsets are reversed');return text.slice(start,end);
}

export function inspectContractSource(contract,bytes){
  assert.equal(sha256(bytes),contract.fileSha256,'Original file-byte SHA-256 differs');
  const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes),span=contractSpan(text,contract.range);
  assert.equal(sha256(Buffer.from(span,'utf8')),contract.spanSha256,'Reviewed original declaration span differs');
  assert.ok(span.startsWith(contract.header),'Reviewed original header differs');
  return {fileSha256:contract.fileSha256,spanSha256:contract.spanSha256,range:contract.range,originalBytesVerified:true};
}

export function inspectContractGraph(contract,graph){
  assert.equal(graph.schemaVersion,1,'A complete schema-1 SoftwareGraph is required');
  assert.equal(graph.run?.commitSha,contract.commit,'Graph input revision differs from the reviewed pin');
  assert.ok(Array.isArray(graph.entities)&&Array.isArray(graph.relations)&&Array.isArray(graph.diagnostics),'Complete graph records are required');
  const identities=graph.entities.map(entity=>entity.id);assert.ok(identities.every(id=>typeof id==='string'&&id.length>0)&&new Set(identities).size===identities.length,'Graph entity identities are missing or ambiguous');
  const files=graph.entities.filter(entity=>entity.type==='file'&&entity.path===contract.path);assert.equal(files.length,1,'Original file identity is missing or ambiguous');
  const file=files[0];assert.equal(file.metadata?.contentHash,contract.fileSha256,'Graph file hash differs from the original');
  assert.equal(file.metadata?.analysis?.features?.structure?.status,'supported','Original structure is not supported on this file');
  const symbols=graph.entities.filter(entity=>entity.path===contract.path&&entity.type===contract.entityType&&entity.name===contract.name&&entity.language===contract.language);
  assert.equal(symbols.length,1,'Reviewed original declaration is missing or ambiguous');
  const entity=symbols[0];
  for(const key of ['startLine','startColumn','endLine','endColumn'])assert.equal(entity.sourceRange?.[key],contract.range[key],`Original declaration ${key} differs`);
  assert.equal(entity.metadata?.contentHash,contract.spanSha256,'Graph declaration hash differs from the original reviewed span');
  const parent=graph.entities.find(item=>item.id===entity.parentId);assert.ok(parent,'Original declaration owner is absent');
  if(contract.owner)assert.equal(parent.name,contract.owner,'Original declaration lexical owner differs');
  else assert.equal(parent.id,file.id,'Top-level original declaration is not owned by its file');
  assert.ok(graph.relations.some(edge=>edge.type==='contains'&&edge.from===parent.id&&edge.to===entity.id),'Original containment relationship is absent');
  assert.ok(entity.evidence?.some(item=>item.file===contract.path),'Declaration lacks original-file evidence');
  return {entityId:entity.id,parentId:parent.id,graphOriginalVerified:true};
}

async function materializedOriginal(observation,contract,maxBytes){
  const root=await realpath(path.join(observation,'tree')),receipt=JSON.parse(await readFile(path.join(observation,'receipt.json'),'utf8'));
  assert.equal(receipt.commit,contract.commit,'Materialization revision differs');
  assert.equal(receipt.materializationCompleted,true,'Materialization is incomplete or failed');assert.equal(receipt.verifierUnchanged,true,'Materializer source changed during observation');
  const records=receipt.entries.filter(entry=>entry.path===contract.path);assert.equal(records.length,1,'Original path is missing or ambiguous in materialization');
  const record=records[0];assert.equal(record.status,'materialized','Reviewed declaration file was skipped or failed');assert.equal(record.sha256,contract.fileSha256);assert.equal(record.writtenSha256,contract.fileSha256);assert.equal(record.blobIdentityVerified,true);
  const candidate=path.join(root,...contract.path.split('/')),info=await lstat(candidate);assert.ok(info.isFile()&&!info.isSymbolicLink(),'Source must remain a regular original file');assert.ok(info.size<=maxBytes,'Reviewed original exceeds the source-read limit');
  const actual=await realpath(candidate);assert.equal(actual,candidate,'Original path crosses a filesystem alias');
  const bytes=await readFile(candidate);assert.ok(bytes.length<=maxBytes,'Original grew beyond the source-read limit');assert.equal(bytes.length,record.bytes,'Materialized original byte length differs');return bytes;
}

/** Every contract retains an independent terminal outcome. A manifest of
 * verified source anchors without graphs explicitly leaves graph accuracy
 * pending; zero-exit file reads cannot qualify missing graph assertions. */
export async function verifySourceContracts({manifest,corpus,observations,graphs={},maxSourceBytes=8*1024*1024}){
  validateSourceContracts(manifest,corpus);assert.ok(Number.isSafeInteger(maxSourceBytes)&&maxSourceBytes>0);
  const repositories=new Set(manifest.contracts.map(contract=>contract.repository));for(const id of [...Object.keys(observations),...Object.keys(graphs)])assert.ok(repositories.has(id),'Unknown source-contract repository');
  const result={schema:1,manifestSha256:sha256(JSON.stringify(manifest)),corpusSha256:sha256(JSON.stringify(corpus)),originalSourcesVerified:false,graphContractsVerified:false,analysisQualified:false,contracts:[]};
  for(const contract of manifest.contracts){
    const record={id:contract.id,repository:contract.repository,commit:contract.commit,path:contract.path,status:'pending'};result.contracts.push(record);
    try{
      assert.ok(Object.hasOwn(observations,contract.repository),'Missing original materialization observation');
      Object.assign(record,inspectContractSource(contract,await materializedOriginal(observations[contract.repository],contract,maxSourceBytes)));
      if(Object.hasOwn(graphs,contract.repository)){const graph=graphs[contract.repository];if(graph?.graphLoadError)throw Error(`Graph input failed: ${graph.graphLoadError}`);Object.assign(record,inspectContractGraph(contract,graph));record.status='graph-and-source-verified';}
      else record.status='source-verified-graph-pending';
    }catch(error){record.status='failed';record.error=error.message;}
  }
  result.completedAt=new Date().toISOString();result.originalSourcesVerified=result.contracts.every(record=>record.originalBytesVerified);
  result.graphContractsVerified=result.contracts.every(record=>record.graphOriginalVerified&&record.status==='graph-and-source-verified');return result;
}
