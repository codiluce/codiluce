import assert from 'node:assert/strict';
import {mock, test} from 'node:test';
import {serialize, deserialize} from 'node:v8';
import {encodeTypeScriptPayload as encode, decodeTypeScriptPayload as decode, TypeScriptCodecLimitError, TYPESCRIPT_CODEC_BLOCK_BYTES, type TypeScriptCodecStats} from '../src/analyzers/ts-worker-codec.js';
import {runTypeScriptWorker, typeScriptWorkerRequest} from '../src/analyzers/typescript-isolated.js';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import type {AnalysisContext} from '../src/core/analyzer.js';
import {GraphBuilder} from '../src/core/graph.js';
const roundtrip = (value: unknown) => decode(encode(value, 64 * 1024 * 1024), 64 * 1024 * 1024);
const reference = (value: unknown) => deserialize(serialize(value));

test('string encoding allocates no intermediate Latin-1 or UTF-16 buffers while retaining complete values and aliases', () => {
  const proof = {original: 'é😀\ud800\u0000\udfff'.repeat(1000)}, value: any = {proof, alias: proof, distinct: 'a'.repeat(70000)}; value.self = value;
  const from = Buffer.from, stats = {} as TypeScriptCodecStats;
  const temporary = mock.method(Buffer, 'from', ((...args: any[]) => {
    if (typeof args[0] === 'string' && ['latin1', 'utf16le'].includes(args[1])) throw Error('Forbidden intermediate codec string Buffer');
    return Reflect.apply(from, Buffer, args);
  }) as typeof Buffer.from);
  let encoded: Buffer;
  try { encoded = encode(value, 1024 * 1024, stats); } finally { temporary.mock.restore(); }
  const actual = decode(encoded, 1024 * 1024) as typeof value;
  assert.deepEqual(actual, reference(value)); assert.equal(actual.proof, actual.alias); assert.equal(actual.self, actual);
  assert.equal(stats.peakStringTemporaryBytes, 0); assert.ok(stats.allocatedBlockBytes <= 1024 * 1024);
});

test('direct string writes preserve the approved wire bytes at odd block edges and isolated UTF-16 code units', () => {
  const uint = (value: number) => {const bytes: number[] = []; do {const digit = value % 128; value = Math.floor(value / 128); bytes.push(digit + (value ? 128 : 0));} while (value); return Buffer.from(bytes);};
  const utf16 = '😀\ud800é\udfff\u0000'.repeat(10000);
  for (let shift = 0; shift < 16; shift++) {
    const prefix = 'a'.repeat(TYPESCRIPT_CODEC_BLOCK_BYTES - 32 + shift), value = {prefix, utf16};
    // Independent golden layout for this fixed two-string object. Whole
    // Buffer conversions belong only to this small owned reference oracle.
    const expected = Buffer.concat([Buffer.from([0x43, 0x44, 0x54, 1, 12, 8, 6]), Buffer.from('prefix', 'latin1'), Buffer.from([8]), uint(prefix.length), Buffer.from(prefix, 'latin1'), Buffer.from([8, 5]), Buffer.from('utf16', 'latin1'), Buffer.from([9]), uint(utf16.length), Buffer.from(utf16, 'utf16le'), Buffer.from([0])]);
    const stats = {} as TypeScriptCodecStats, encoded = encode(value, expected.length, stats);
    assert.deepEqual(encoded, expected); assert.deepEqual(decode(encoded, expected.length), value);
    assert.equal(stats.peakStringTemporaryBytes, 0); assert.ok(stats.allocatedBlockBytes <= expected.length);
    const rejected = {} as TypeScriptCodecStats;
    assert.throws(() => encode(value, expected.length - 1, rejected), TypeScriptCodecLimitError); assert.equal(rejected.concatenatedBytes, 0);
  }
});

test('oversized direct strings are rejected before any native string write or final concatenation', () => {
  const write = Buffer.prototype.write; let writes = 0;
  const observation = mock.method(Buffer.prototype, 'write', function(this: Buffer, ...args: any[]) {writes++; return Reflect.apply(write, this, args);});
  try {
    for (const value of ['a'.repeat(1020), '\ud800'.repeat(600)]) {
      const stats = {} as TypeScriptCodecStats; assert.throws(() => encode(value, 1024, stats), TypeScriptCodecLimitError);
      assert.ok(stats.allocatedBlockBytes <= 1024); assert.equal(stats.concatenatedBytes, 0); assert.equal(stats.peakStringTemporaryBytes, 0);
    }
    assert.equal(writes, 0);
  } finally {observation.mock.restore();}
});

test('bounded compiler encoding preserves all primitive values and exact Latin-1/UTF-16 strings including lone surrogates and chunk boundaries', () => {
  for (const value of [undefined, null, true, false, -0, 0, 1, -1, 0xffffffff, -0x80000000, Number.MAX_SAFE_INTEGER, Infinity, -Infinity, NaN, 1.5, 0n, -1n, 2n ** 8192n, -(2n ** 8192n), '', 'é😀\ud800\udfff\0\r\n', '.'.repeat(4095) + '😀' + 'é'.repeat(4097)]) assert.deepEqual(roundtrip(value), reference(value));
});
test('compiler encoding retains cyclic object/map/set ownership and actual shared graph/HTTP network-effect references', () => {
  const effect = {category: 'network', operation: 'fetch'}, caller = {metadata: {effects: [effect]}}, shared = {value: 'é😀'};
  const input: any = {graph: {entities: [caller, shared, shared]}, http: [{effect}], map: new Map(), set: new Set()}; input.self = input; input.map.set(input, shared); input.map.set(shared, input.map); input.set.add(input); input.set.add(input.map);
  const output = roundtrip(input) as typeof input;
  assert.deepEqual(output, reference(input)); assert.equal(output.self, output); assert.equal(output.graph.entities[1], output.graph.entities[2]); assert.equal(output.http[0].effect, output.graph.entities[0].metadata.effects[0]); assert.equal(output.map.get(output), output.graph.entities[1]); assert.equal(output.map.get(output.graph.entities[1]), output.map); assert.ok(output.set.has(output.map));
});
test('sparse arrays, enumerable extra properties, null prototypes and reserved property names clone without prototype mutation', () => {
  const array = new Array(1000000); array[19] = undefined; array[999999] = 'original'; Object.defineProperty(array, 'extra', {value: {saved: true}, enumerable: true});
  const object = Object.create(null); Object.defineProperty(object, '__proto__', {value: {original: true}, enumerable: true}); object.constructor = 'original'; object.array = array;
  const output = roundtrip(object) as typeof object; assert.deepEqual(output, reference(object)); assert.equal(Object.getPrototypeOf(output), Object.prototype); assert.ok(Object.hasOwn(output, '__proto__')); assert.equal(Object.hasOwn(output.array, '0'), false); assert.equal(Object.hasOwn(output.array, '19'), true); assert.equal(output.array.length, 1000000);
});
test('native dates, RegExp, all ordinary binary views and boxed primitives retain their V8 clone values and shared object identity', () => {
  const buffer = new ArrayBuffer(32), bytes = new Uint8Array(buffer); bytes.forEach((_, i) => {bytes[i] = i * 7;});
  const values = [new Date(0), new Date(NaN), /é😀/dgiu, buffer, Buffer.from([0, 1, 255]), new Int8Array(buffer), new Uint8Array(buffer), new Uint8ClampedArray(buffer), new Int16Array(buffer), new Uint16Array(buffer), new Int32Array(buffer), new Uint32Array(buffer), new Float32Array([1.5, -0, NaN]), new Float64Array([1.5, -0, NaN]), new BigInt64Array([-1n, 2n]), new BigUint64Array([1n, 2n]), new DataView(buffer), new Number(-0), new String('é😀'), new Boolean(false), Object(-123n)];
  for (const value of values) { const actual = roundtrip([value, value]) as unknown[], expected = reference([value, value]); if (value instanceof Date && Number.isNaN(value.getTime())) {assert.ok(actual[0] instanceof Date); assert.ok(Number.isNaN(actual[0].getTime())); assert.ok(Number.isNaN(expected[0].getTime()));} else assert.deepEqual(actual, expected); assert.equal(actual[0], actual[1]); }
});
test('native error types, original messages/stacks and causes retain their default V8 clone fields', () => {
  for (const Constructor of [Error, EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError]) {
    const shared = {original: true}, error = new Constructor('é😀 original', {cause: shared});
    const actual = roundtrip({error, shared}) as {error: Error & {cause: unknown}; shared: object}, expected = reference({error, shared});
    assert.deepEqual(actual, expected); assert.equal(actual.error.stack, expected.error.stack); assert.equal(actual.error.cause, actual.shared);
  }
});
test('string interning emits every original field and ordered proof while reducing repetition without producer normalization', () => {
  const proof = {source: 'syntax', analyzer: 'original-producer', analyzerVersion: 'unchanged-7', explanation: 'Original é😀 evidence '.repeat(100)};
  const input = Array.from({length: 1000}, (_, index) => ({id: index, proof: {...proof}, repeated: proof.explanation}));
  const encoded = encode(input, 16 * 1024 * 1024); assert.ok(encoded.length < serialize(input).length / 4); assert.deepEqual(decode(encoded, 16 * 1024 * 1024), reference(input));
});
test('exact buffer budgets succeed at the encoded byte boundary and reject one byte below it', () => {
  for (const input of ['é😀', {map: new Map([['original', new Set([undefined, 1, 2])]])}, 1n, -65535n, Object(123n)]) {
    const bytes = encode(input, 10000); assert.deepEqual(encode(input, bytes.length), bytes); assert.throws(() => encode(input, bytes.length - 1), TypeScriptCodecLimitError); assert.throws(() => decode(bytes, bytes.length - 1), TypeScriptCodecLimitError);
  }
});
test('oversized strings and binary originals cannot allocate an output buffer beyond the selected budget', () => {
  for (const input of ['.'.repeat(5 * 1024 * 1024), '😀'.repeat(3 * 1024 * 1024), Buffer.alloc(5 * 1024 * 1024), new ArrayBuffer(5 * 1024 * 1024), 2n ** 1000000n]) {
    const stats = {} as TypeScriptCodecStats; assert.throws(() => encode(input, 1024, stats), TypeScriptCodecLimitError); assert.ok(stats.allocatedBlockBytes <= 1024); assert.ok(stats.peakBlockBytes <= 1024); assert.equal(stats.concatenatedBytes, 0); assert.ok(stats.peakStringTemporaryBytes <= 8192);
  }
});
test('large successful encodings keep block allocations and final concatenation bounded independently', () => {
  const input = {original: '😀'.repeat(100000), payload: Buffer.alloc(200000)}, stats = {} as TypeScriptCodecStats, encoded = encode(input, 1024 * 1024, stats);
  assert.deepEqual(decode(encoded, 1024 * 1024), reference(input)); assert.ok(stats.allocatedBlockBytes <= 1024 * 1024); assert.ok(stats.peakBlockBytes <= TYPESCRIPT_CODEC_BLOCK_BYTES); assert.ok(stats.concatenatedBytes <= 1024 * 1024); assert.equal(stats.encodedBytes, encoded.length); assert.ok(stats.peakStringTemporaryBytes <= 8192);
});
test('malformed headers, every truncated prefix, invalid references, duplicate properties and trailing bytes fail explicitly', () => {
  const encoded = encode({original: new Map([['nested', [undefined, 'é😀']]])}, 10000);
  for (let size = 0; size < encoded.length; size++) assert.throws(() => decode(encoded.subarray(0, size), 10000));
  assert.throws(() => decode(Buffer.concat([encoded, Buffer.from([0])]), 10000), /Trailing/);
  for (const body of [[11, 0], [10, 0], [255], [12, 8, 1, 97, 5, 1, 10, 0, 5, 2, 0], [13, 0, 14, 0, 5, 1, 0]]) assert.throws(() => decode(Buffer.from([0x43, 0x44, 0x54, 1, ...body]), 10000));
});
test('invalid limits and non-cloneable function/symbol/proxy/weak ownership never acquire an unrestricted fallback', () => {
  for (const max of [0, -1, NaN, 1.5, Infinity]) assert.throws(() => encode({}, max), /positive safe integer/);
  for (const input of [() => 1, Symbol('original'), new Proxy({}, {}), new WeakMap(), new WeakSet(), Promise.resolve(1), new SharedArrayBuffer(1), Object(Symbol('original'))]) assert.throws(() => encode(input, 10000), /Unsupported/);
});
test('the default worker rejects an oversized encoded request before forking or mutating parent graph/HTTP', async () => {
  const graph = new GraphBuilder('owned-codec'), context = {root: '/owned', config: {repository: {name: 'original'}, maxFileBytes: 1}, repositoryId: 'original', files: new Map(), applicationIds: new Map(), http: [], graph} as unknown as AnalysisContext;
  const request = typeScriptWorkerRequest(context); request.graph.namespace = '.'.repeat(100000); let forks = 0;
  const observation = mock.method(cp, 'fork', (() => {forks++; throw Error('Unexpected worker launch');}) as typeof cp.fork); syncBuiltinESMExports();
  try {await assert.rejects(runTypeScriptWorker(request, {maxMessageBytes: 1024}), /input exceeds 1024 bytes/); assert.equal(forks, 0); assert.equal(context.graph.entities.size, 0); assert.equal(context.http.length, 0);} finally {observation.mock.restore(); syncBuiltinESMExports();}
});
