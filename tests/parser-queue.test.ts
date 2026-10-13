import assert from 'node:assert/strict';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {fileURLToPath} from 'node:url';
import {mock, test} from 'node:test';
import {StructureParser} from '../src/analysis/tree-sitter/client.js';
import {PhpParser} from '../src/analysis/php/client.js';
import type {StructureFacts} from '../src/analysis/facts.js';

const worker = fileURLToPath(new URL('./fixtures/parser-queue-worker.mjs', import.meta.url));
type Reply = StructureFacts & {original: string; language: string; pid: number};
const parse = (parser: StructureParser, language: string, options: Record<string, unknown> = {}) =>
  parser.parse(language, JSON.stringify(options)) as Promise<Reply>;
function observe() {
  const children: cp.ChildProcess[] = [], overlap: number[] = [], fork = cp.fork;
  const spy = mock.method(cp, 'fork', (...args: Parameters<typeof cp.fork>) => {
    overlap.push(children.filter(c => c.exitCode === null && c.signalCode === null).length);
    const child = fork(...args); children.push(child); return child;
  });
  syncBuiltinESMExports();
  return {children, overlap, restore() {spy.mock.restore(); syncBuiltinESMExports();}};
}

test('six queued source jobs each retain the full active deadline beyond one batch deadline', async () => {
  const parser = new StructureParser(1100, worker);
  try {
    await parse(parser, 'warm');
    const results = await Promise.all(Array.from({length: 6}, (_, i) => parse(parser, `original-${i}`, {delay: 300})));
    assert.deepEqual(results.map(r => r.language), Array.from({length: 6}, (_, i) => `original-${i}`));
    assert.equal(new Set(results.map(r => r.pid)).size, 1);
    assert.ok(results.every(r => r.original === '{"delay":300}' && !r.truncated && !r.issues.length));
  } finally {await parser.closeAndWait();}
});

for (const bytes of [0, 2 * 1024 * 1024]) test(`a completed native response survives a busy parent (${bytes} payload bytes)`, async () => {
  const observed = observe(), parser = new StructureParser(1000, worker);
  try {
    await parse(parser, 'warm');
    const child = observed.children[0]!;
    let stalled = false;
    child.on('message', (message: {kind?: string; job?: string}) => {
      if (message.kind === 'started' && message.job === 'parent-busy') {
        stalled = true;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
      }
    });
    const result = await parse(parser, 'parent-busy', {delay: 50, bytes});
    assert.equal(stalled, true);
    assert.equal(result.language, 'parent-busy');
    assert.equal((result as Reply & {payload: string}).payload.length, bytes);
    assert.equal((await parse(parser, 'after-parent-busy')).pid, result.pid);
  } finally {await parser.closeAndWait(); observed.restore();}
});

test('a late worker completion still fails when the parent misses its timer while busy', async () => {
  const observed = observe(), parser = new StructureParser(1000, worker);
  try {
    await parse(parser, 'warm');
    const child = observed.children[0]!;
    let completed: string | undefined;
    child.on('message', (message: {kind?: string; job?: string; type?: string; completedAtNs?: string}) => {
      if (message.kind === 'started' && message.job === 'late') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
      if (message.type === 'completed') completed = message.completedAtNs;
    });
    const started = process.hrtime.bigint();
    await assert.rejects(parse(parser, 'late', {delay: 1200}), /exceeded 1000 ms for late/);
    assert.ok(completed && BigInt(completed) - started > 1_000_000_000n);
    assert.equal((await parse(parser, 'after-late')).language, 'after-late');
    assert.deepEqual(observed.overlap, [0, 0]);
  } finally {await parser.closeAndWait(); observed.restore();}
});

test('completed payload delivery excludes a parent stall after the completion frame', async () => {
  const observed = observe(), parser = new StructureParser(1000, worker);
  try {
    await parse(parser, 'warm');
    let stalled = false;
    observed.children[0]!.on('message', (message: {type?: string}) => {
      if (message.type === 'completed') setImmediate(() => {
        if (!stalled) {stalled = true; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);}
      });
    });
    const result = await parse(parser, 'payload-after-parent-busy', {bytes: 2 * 1024 * 1024, delayPayload: 100});
    assert.equal(stalled, true);
    assert.equal((result as Reply & {payload: string}).payload.length, 2 * 1024 * 1024);
  } finally {await parser.closeAndWait(); observed.restore();}
});

test('an encoded completion without a response still has a finite idle delivery deadline', async () => {
  const observed = observe(), parser = new StructureParser(500, worker);
  try {
    await assert.rejects(parse(parser, 'missing-payload', {noPayload: true}), /response exceeded 500 idle ms/);
    assert.equal((await parse(parser, 'after-missing-payload')).language, 'after-missing-payload');
    assert.deepEqual(observed.overlap, [0, 0]);
  } finally {await parser.closeAndWait(); observed.restore();}
});

for (const fault of ['badClock', 'badSize', 'badPayload', 'missingCompletion', 'duplicateCompletion']) test(`invalid ${fault} response retires its worker without changing queued facts`, async () => {
  const observed = observe(), parser = new StructureParser(2000, worker);
  try {
    const results = await Promise.allSettled([parse(parser, 'bad', {[fault]: true}), parse(parser, 'healthy')]);
    assert.equal(results[0]!.status, 'rejected');
    assert.match(String((results[0] as PromiseRejectedResult).reason), /Invalid parser/);
    assert.equal(results[1]!.status, 'fulfilled');
    assert.equal((results[1] as PromiseFulfilledResult<Reply>).value.language, 'healthy');
    assert.deepEqual(observed.overlap, [0, 0]);
  } finally {await parser.closeAndWait(); observed.restore();}
});

test('reported PHP-style source errors preserve the queued healthy job and reusable worker', async () => {
  const parser = new StructureParser(2000, worker, undefined, false);
  try {
    const warm = await parse(parser, 'warm');
    const results = await Promise.allSettled([parse(parser, 'bad', {error: true}), parse(parser, 'healthy')]);
    assert.equal(results[0]!.status, 'rejected');
    assert.match(String((results[0] as PromiseRejectedResult).reason), /Owned source error/);
    assert.equal(results[1]!.status, 'fulfilled');
    assert.equal((results[1] as PromiseFulfilledResult<Reply>).value.pid, warm.pid);
  } finally {await parser.closeAndWait();}
});

test('a deadline reaps its worker before dispatching the next queued original', async () => {
  const observed = observe(), parser = new StructureParser(1000, worker);
  try {
    const warm = await parse(parser, 'warm');
    const results = await Promise.allSettled([parse(parser, 'slow', {delay: 10000}), parse(parser, 'healthy')]);
    assert.equal(results[0]!.status, 'rejected');
    assert.match(String((results[0] as PromiseRejectedResult).reason), /exceeded 1000 ms for slow/);
    assert.equal(results[1]!.status, 'fulfilled');
    assert.notEqual((results[1] as PromiseFulfilledResult<Reply>).value.pid, warm.pid);
    assert.deepEqual(observed.overlap, [0, 0]);
  } finally {await parser.closeAndWait(); observed.restore();}
  assert.ok(observed.children.every(c => c.exitCode !== null || c.signalCode !== null));
});

test('source-free bootstrap also waits for a generation retired by a deadline', async () => {
  class BootstrapParser extends StructureParser {prewarm() {this.start();}}
  const observed = observe(), parser = new BootstrapParser(500, worker);
  try {
    await parse(parser, 'warm');
    await assert.rejects(parse(parser, 'slow', {delay: 10000}), /exceeded 500 ms/);
    assert.throws(() => parser.prewarm(), /retiring/);
    assert.equal(observed.children.length, 1);
    await parser.closeAndWait();
    parser.prewarm();
    assert.equal((await parse(parser, 'after-retirement')).language, 'after-retirement');
    assert.deepEqual(observed.overlap, [0, 0]);
  } finally {await parser.closeAndWait(); observed.restore();}
});

for (const kind of ['error', 'exit'] as const) test(`a ${kind} retires an unusable generation without losing the next queued original`, async () => {
  const observed = observe(), parser = new StructureParser(2000, worker);
  try {
    const results = await Promise.allSettled([parse(parser, 'bad', {[kind]: true}), parse(parser, 'healthy')]);
    assert.equal(results[0]!.status, 'rejected');
    assert.equal(results[1]!.status, 'fulfilled');
    assert.equal((results[1] as PromiseFulfilledResult<Reply>).value.language, 'healthy');
    assert.deepEqual(observed.overlap, [0, 0]);
  } finally {await parser.closeAndWait(); observed.restore();}
});

test('explicit retirement cancels admitted queued inputs and permits fresh jobs only after exit', async () => {
  const observed = observe(), parser = new StructureParser(2000, worker);
  try {
    await parse(parser, 'warm');
    const queued = Promise.allSettled([parse(parser, 'queued-one'), parse(parser, 'queued-two')]);
    const retirement = parser.closeAndWait();
    await assert.rejects(parse(parser, 'during-retirement'), /retiring/);
    await retirement;
    const results = await queued;
    assert.ok(results.every(r => r.status === 'rejected' && /closed before dispatch/.test(String(r.reason))));
    assert.equal(observed.children.length, 1);
    assert.equal((await parse(parser, 'after-retirement')).language, 'after-retirement');
    assert.deepEqual(observed.overlap, [0, 0]);
  } finally {await parser.closeAndWait(); observed.restore();}
});

test('real PHP queued parsing retains complete original Unicode/CRLF facts and native trees', async () => {
  const queued = new PhpParser(), serial = new PhpParser();
  const originals = Array.from({length: 6}, (_, i) => `<?php\r\n// café 😀 ${i}\r\nnamespace Original${i};\r\nclass Handler${i} { public function show(): string { return 'never executes'; } }\r\n`);
  try {
    const expected = [];
    for (const source of originals) expected.push(await serial.parseUnit(source));
    assert.deepEqual(await Promise.all(originals.map(source => queued.parseUnit(source))), expected);
  } finally {await queued.closeAndWait(); await serial.closeAndWait();}
});
