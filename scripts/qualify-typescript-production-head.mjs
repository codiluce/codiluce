// Read-only, original-head conformance across compiler runtimes. Target code,
// package managers, configuration hooks and build tools never execute.
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream, createWriteStream} from 'node:fs';
import {lstat, mkdir, readFile, readlink, realpath, rename, writeFile} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
import {finished} from 'node:stream/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {writeGraphArtifact} from './graph-json-artifact.mjs';
import {productionGraphDigest} from './production-graph-digest.mjs';
import {inspectHeadTree} from './production-head-graphs.mjs';
import {verifySourceContracts} from './production-source-contracts.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
async function fileHash(file) {
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(file)) digest.update(bytes);
  return digest.digest('hex');
}
function relativeFile(root, file) {
  assert.ok(typeof file === 'string' && file && !file.includes('\\') && !path.isAbsolute(file));
  assert.ok(file.split('/').every(part => part && part !== '.' && part !== '..'), 'Noncanonical runtime input');
  return path.join(root, file);
}

/** Compare every graph field. Producer versions, proof storage, source ranges,
 * metadata, diagnostics and record order are preserved. */
export function compareCompilerHeadGraphs(candidate, baseline) {
  for (const graph of [candidate, baseline]) {
    assert.equal(typeof graph.run?.id, 'string');
    assert.equal(typeof graph.run?.analyzedAt, 'string');
  }
  const reference = productionGraphDigest(baseline, {normalize: false});
  const actual = productionGraphDigest({...candidate, run: {...candidate.run, id: baseline.run.id, analyzedAt: baseline.run.analyzedAt}}, {normalize: false});
  assert.deepEqual(actual, reference, 'Complete compiler-head graph differs beyond run UUID/time');
  return {...actual, volatileFields: ['run.id', 'run.analyzedAt'], producerNormalization: false};
}

async function verifyRuntime(root, identity) {
  assert.ok(Array.isArray(identity.files) && identity.files.length);
  if (identity.sha256) assert.equal(hash(JSON.stringify(identity.files)), identity.sha256);
  const names = new Set();
  for (const row of identity.files) {
    const file = relativeFile(root, row.file);
    assert.ok(!names.has(row.file), 'Duplicate runtime input'); names.add(row.file);
    assert.equal(await realpath(file), file, 'Runtime file crosses a filesystem alias');
    const info = await lstat(file); assert.ok(info.isFile());
    if (row.bytes !== undefined) assert.equal(info.size, row.bytes);
    if (row.mode !== undefined) assert.equal(info.mode & 0o777, row.mode);
    assert.equal(await fileHash(file), row.sha256, `Runtime bytes changed: ${row.file}`);
  }
  for (const row of identity.links ?? []) {
    const file = relativeFile(root, row.file);
    assert.ok(!names.has(row.file)); names.add(row.file);
    assert.ok((await lstat(file)).isSymbolicLink());
    assert.equal(await readlink(file), row.target);
  }
  return {files: identity.files.length, links: identity.links?.length ?? 0, sha256: hash(JSON.stringify(identity)), allDeclaredBytesVerified: true};
}

export async function qualifyCompilerHead(job, output) {
  assert.equal(job.schema, 1);
  assert.equal(job.profile.commit, job.revision.commit);
  assert.equal(job.profile.config.maxFileBytes, 8 * 1024 * 1024);
  const destination = path.resolve(output), observation = await realpath(job.observation), root = await realpath(job.runtimeRoot);
  const originalRoot = path.join(observation, 'tree');
  assert.ok(!destination.startsWith(observation + path.sep) && !destination.startsWith(root + path.sep));
  assert.equal(await realpath(path.dirname(destination)), path.dirname(destination));
  const entry = relativeFile(root, job.entry);
  assert.ok(job.identity.files.some(row => row.file === job.entry), 'Entry is absent from the runtime ledger');
  await mkdir(destination);
  await writeFile(path.join(destination, 'job.json'), JSON.stringify(job, null, 2) + '\n', {flag: 'wx'});
  const receipt = {schema: 1, repository: job.profile.id, runtimeLabel: job.runtimeLabel, node: process.version, platform: process.platform, pid: process.pid, passed: false, startedAt: new Date().toISOString(), targetExecution: false, workers: [], stages: [], relativePerformanceQualified: false, fullProductionHistoryQualified: false};
  const publish = async () => {
    const pending = path.join(destination, 'receipt.json.pending');
    await writeFile(pending, JSON.stringify(receipt, null, 2) + '\n');
    await rename(pending, path.join(destination, 'receipt.json'));
  };
  const nativeFork = cp.fork, streams = [], closures = [];
  let imported = false;
  try {
    receipt.originalBefore = await inspectHeadTree(observation, job.revision);
    assert.equal(receipt.originalBefore.tree, originalRoot);
    receipt.runtimeBefore = await verifyRuntime(root, job.identity);
    cp.fork = function(module, args, options) {
      const child = nativeFork.call(this, module, args, options);
      const name = module instanceof URL ? fileURLToPath(module) : String(module);
      if (path.basename(name) !== 'native-ts-worker.mjs') return child;
      const record = {pid: child.pid, module: name, execArgv: options.execArgv, requests: [], responses: []}; receipt.workers.push(record);
      const stream = createWriteStream(path.join(destination, `compiler-${child.pid}-stderr.log`), {flags: 'wx'}); streams.push(stream);
      child.stderr.on('data', bytes => stream.write(bytes));
      const send = child.send;
      child.send = function(message, ...rest) {
        if (Buffer.isBuffer(message)) record.requests.push({bytes: message.length, sha256: hash(message)});
        return send.call(this, message, ...rest);
      };
      child.on('message', message => {if (Buffer.isBuffer(message)) record.responses.push({bytes: message.length, sha256: hash(message)});});
      closures.push(new Promise(resolve => child.once('close', (code, signal) => {record.code = code; record.signal = signal; stream.end(); resolve();})));
      return child;
    };
    syncBuiltinESMExports();
    await publish();
    const {indexRepository} = await import(pathToFileURL(entry).href); imported = true;
    const started = performance.now();
    const graph = await indexRepository(originalRoot, {config: structuredClone(job.profile.config), revision: job.profile.commit, onProgress: name => receipt.stages.push(name)});
    receipt.indexMilliseconds = performance.now() - started;
    assert.equal(graph.run.commitSha, job.profile.commit);
    assert.equal(graph.run.configDigest, hash(JSON.stringify(job.profile.config)));
    receipt.graph = {...await writeGraphArtifact(path.join(destination, 'graph.json'), graph), entities: graph.entities.length, relations: graph.relations.length, diagnostics: graph.diagnostics.length};
    receipt.completeGraph = productionGraphDigest(graph, {normalize: false});
    receipt.originalAfter = await inspectHeadTree(observation, job.revision);
    assert.deepEqual(receipt.originalAfter, receipt.originalBefore);
    receipt.contracts = await verifySourceContracts({manifest: {...job.manifest, contracts: job.manifest.contracts.filter(row => row.repository === job.profile.id)}, corpus: job.corpus, observations: {[job.profile.id]: observation}, graphs: {[job.profile.id]: graph}});
    assert.equal(receipt.contracts.graphContractsVerified, true, 'Independent original-source contracts failed');
    if (job.baselineGraph) {
      const bytes = await readFile(job.baselineGraph); receipt.baselineGraphSha256 = hash(bytes);
      receipt.baselineComparison = compareCompilerHeadGraphs(graph, JSON.parse(bytes));
    }
    await Promise.all(closures);
    assert.equal(receipt.workers.length, 1, 'Expected one compiler worker for the original Node head');
    for (const worker of receipt.workers) {
      assert.equal(worker.code, 0); assert.equal(worker.signal, null);
      assert.equal(worker.requests.length, 1); assert.equal(worker.responses.length, 1);
      assert.ok(worker.execArgv.includes('--max-old-space-size=1024') && worker.execArgv.includes('--max-semi-space-size=16'));
      for (const frame of [...worker.requests, ...worker.responses]) assert.ok(frame.bytes <= 64 * 1024 * 1024);
    }
    receipt.passed = true;
  } catch (error) {
    receipt.error = error.message; receipt.stack = error.stack;
    if (error.partialArtifact) receipt.partialArtifact = error.partialArtifact;
  } finally {
    cp.fork = nativeFork; syncBuiltinESMExports();
    await Promise.all(closures);
    for (const stream of streams) {if (!stream.writableEnded) stream.end(); await finished(stream);}
    try {receipt.runtimeAfter = await verifyRuntime(root, job.identity); if (receipt.runtimeBefore) assert.deepEqual(receipt.runtimeAfter, receipt.runtimeBefore);}
    catch (error) {receipt.passed = false; receipt.runtimeError = error.message;}
    receipt.importedOwnIndexer = imported; receipt.completedAt = new Date().toISOString(); await publish();
  }
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 4, 'Usage: node [own source loader] qualify-typescript-production-head.mjs JOB_JSON FRESH_OUTPUT');
  const receipt = await qualifyCompilerHead(JSON.parse(await readFile(process.argv[2])), process.argv[3]);
  console.log(JSON.stringify({repository: receipt.repository, runtime: receipt.runtimeLabel, passed: receipt.passed, graph: receipt.graph, transfers: receipt.workers.map(row => ({pid: row.pid, requests: row.requests.map(frame => frame.bytes), responses: row.responses.map(frame => frame.bytes)})), error: receipt.error}));
  if (!receipt.passed) process.exitCode = 1;
}
