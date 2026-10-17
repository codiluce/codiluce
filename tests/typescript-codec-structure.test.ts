import assert from 'node:assert/strict';
import {mock, test} from 'node:test';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {encodeTypeScriptPayload as encode, decodeTypeScriptPayload as decode, TYPESCRIPT_CODEC_STRUCTURE_LIMITS as limits, TypeScriptCodecStructureLimitError, type TypeScriptCodecStats, type TypeScriptCodecLimits} from '../src/analyzers/ts-worker-codec.js';
import {runTypeScriptWorker, typeScriptWorkerRequest} from '../src/analyzers/typescript-isolated.js';
import {GraphBuilder} from '../src/core/graph.js';
import type {AnalysisContext} from '../src/core/analyzer.js';
const bytes = 64 * 1024 * 1024;
const sample = () => {
  const shared = {proof: 'Original é😀 proof', binary: Buffer.from([1, 2, 3])}, value: any = {first: shared, second: shared, array: [shared, undefined, 'original'], map: new Map([[shared, new Set([shared, 'original'])]])};
  value.self = value; return value;
};
function sparseFrame(length: number): Buffer {
  const value = [0x43, 0x44, 0x54, 1, 13];
  do {const digit = length % 128; length = Math.floor(length / 128); value.push(digit + (length ? 128 : 0));} while (length);
  value.push(0); return Buffer.from(value);
}
test('structural accounting retains complete values, cycles and aliases with matching encoder/decoder pools', () => {
  const input = sample(), written = {} as TypeScriptCodecStats, read = {} as TypeScriptCodecStats, frame = encode(input, bytes, written), output = decode(frame, bytes, read) as typeof input;
  assert.deepEqual(output, input); assert.equal(output.first, output.second); assert.equal(output.self, output); assert.ok(output.map.get(output.first).has(output.first));
  for (const field of ['objects', 'strings', 'properties', 'arraySlots', 'stringUnits', 'binaryBytes'] as const) assert.equal(written[field], read[field], field);
});
test('every cumulative structure pool admits its exact boundary and rejects one unit below in both directions', () => {
  const input = sample(), stats = {} as TypeScriptCodecStats, frame = encode(input, bytes, stats);
  for (const field of ['objects', 'strings', 'properties', 'arraySlots', 'stringUnits', 'binaryBytes'] as const) {
    assert.ok(stats[field] > 1); const exact = {[field]: stats[field]}, below = {[field]: stats[field] - 1};
    assert.deepEqual(encode(input, bytes, undefined, exact), frame); assert.deepEqual(decode(frame, bytes, undefined, exact), input);
    for (const operation of [() => encode(input, bytes, undefined, below), () => decode(frame, bytes, undefined, below)]) assert.throws(operation, (error: unknown) => error instanceof TypeScriptCodecStructureLimitError && error.resource === field);
  }
});
test('depth, pending tasks and per-object property keys have independently enforced boundaries', () => {
  const input = {one: {two: {three: [1, 2, 3]}}}, encodedStats = {} as TypeScriptCodecStats, decodedStats = {} as TypeScriptCodecStats, frame = encode(input, bytes, encodedStats); decode(frame, bytes, decodedStats);
  for (const [field, stat] of [['depth', 'peakDepth'], ['tasks', 'peakTasks'], ['keysPerObject', 'peakKeys']] as const) {
    for (const [operation, stats] of [[(policy: Partial<TypeScriptCodecLimits>) => encode(input, bytes, undefined, policy), encodedStats], [(policy: Partial<TypeScriptCodecLimits>) => decode(frame, bytes, undefined, policy), decodedStats]] as const) {
      operation({[field]: stats[stat]}); assert.throws(() => operation({[field]: stats[stat] - 1}), TypeScriptCodecStructureLimitError);
    }
  }
});
test('ordered encoder task batches retain exact one, two and three task boundaries', () => {
  const cases: Array<[unknown, number]> = [[undefined, 1], [{original: 1}, 2], [new Set([1]), 2], [new Map([[1, 2]]), 3]];
  for (const [input, peakTasks] of cases) {
    const stats = {} as TypeScriptCodecStats, frame = encode(input, bytes, stats, {tasks: peakTasks});
    assert.equal(stats.peakTasks, peakTasks); assert.deepEqual(decode(frame, bytes), input);
    if (peakTasks > 1) {
      const rejected = {} as TypeScriptCodecStats;
      assert.throws(() => encode(input, bytes, rejected, {tasks: peakTasks - 1}), (error: unknown) => error instanceof TypeScriptCodecStructureLimitError && error.resource === 'tasks' && error.selectedLimit === peakTasks - 1);
      assert.equal(rejected.concatenatedBytes, 0);
    }
  }
  assert.deepEqual(encode(new Map([[1, 2]]), bytes), Buffer.from([0x43, 0x44, 0x54, 1, 15, 5, 1, 5, 2, 0]), 'Map keys must precede values in the original wire order');
});
test('a tiny oversized sparse-array frame is rejected before invoking the decoder Array constructor', () => {
  const frame = sparseFrame(limits.arraySlots + 1), Original = globalThis.Array; let allocations = 0;
  globalThis.Array = new Proxy(Original, {construct() {allocations++; throw Error('Unadmitted allocation');}});
  try {assert.throws(() => decode(frame, bytes), (error: unknown) => error instanceof TypeScriptCodecStructureLimitError && error.resource === 'arraySlots'); assert.equal(allocations, 0);} finally {globalThis.Array = Original;}
  assert.ok(frame.length < 16);
});
test('sparse array extents count cumulatively without losing holes or admitted million-slot originals', () => {
  const first = new Array(1_000_000); first[999_999] = 'original'; const input = [first, new Array(1_000_000)], frame = encode(input, bytes);
  const output = decode(frame, bytes) as typeof input; assert.deepEqual(output, input); assert.equal(Object.hasOwn(output[0]!, '0'), false);
  const policy = {arraySlots: 2_000_001}; assert.throws(() => encode(input, bytes, undefined, policy), TypeScriptCodecStructureLimitError); assert.throws(() => decode(frame, bytes, undefined, policy), TypeScriptCodecStructureLimitError);
});
test('key/property admission runs before reading any enumerable original getter', () => {
  let reads = 0; const input = {get first() {reads++; return 'original';}, get second() {reads++; return 'original';}};
  for (const policy of [{properties: 1}, {keysPerObject: 1}]) {assert.throws(() => encode(input, bytes, undefined, policy), TypeScriptCodecStructureLimitError); assert.equal(reads, 0);}
  assert.deepEqual(decode(encode(input, bytes), bytes), {first: 'original', second: 'original'}); assert.equal(reads, 2);
});
test('invalid, unknown or raised structural limits cannot expand the default boundary', () => {
  for (const policy of [{objects: 0}, {objects: 1.5}, {objects: NaN}, {depth: limits.depth + 1}, {unknown: 1}]) {
    assert.throws(() => encode({}, bytes, undefined, policy), /fixed defaults/); assert.throws(() => decode(encode({}, bytes), bytes, undefined, policy), /fixed defaults/);
  }
});
test('the default worker rejects oversized sparse request arrays before fork and leaves parent graph/HTTP untouched', async () => {
  const graph = new GraphBuilder('owned-structure'), context = {root: '/owned', config: {repository: {name: 'original'}}, repositoryId: 'original', files: new Map(), applicationIds: new Map(), http: [], graph} as unknown as AnalysisContext;
  const request = typeScriptWorkerRequest(context); request.graph.entities.length = limits.arraySlots + 1; let forks = 0;
  const observation = mock.method(cp, 'fork', (() => {forks++; throw Error('Unadmitted worker');}) as typeof cp.fork); syncBuiltinESMExports();
  try {await assert.rejects(runTypeScriptWorker(request), /input exceeds structural limit: TypeScript compiler arraySlots/); assert.equal(forks, 0); assert.equal(graph.entities.size, 0); assert.deepEqual(context.http, []);} finally {observation.mock.restore(); syncBuiltinESMExports();}
});
