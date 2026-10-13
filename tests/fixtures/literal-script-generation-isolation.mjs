// Owned ordinary-Node conformance; application source and imports never execute.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { writeFile } from 'node:fs/promises';

const root = new URL(process.argv[2]);
const { StructureParser } = await import(new URL('analysis/tree-sitter/client.js', root));
const { IndexedStructureParser } = await import(new URL('analysis/tree-sitter/native-budget.js', root));
const { TemplateScriptParser, TEMPLATE_SCRIPT_GENERATION_LIMITS } = await import(new URL('analysis/tree-sitter/template-scripts.js', root));
const { canonicalJson } = await import(new URL('history/fingerprint.js', root));
for (const limits of [null, false, 0, {}, { maxJobs: 0, maxSourceBytes: 1 }]) {
  assert.throws(() => Reflect.construct(TemplateScriptParser, [10000, limits]), /positive safe integers/);
}
const source = '<!-- é😀 -->\r\n<script>function original(){return 1;}throw new Error("Target never executes");</script>';
const profiles = [
  ['erb', { erbHost: 'html' }],
  ['razor', { razorKind: 'component' }],
  ['liquid', { liquidHost: 'html', liquidEngine: 'shopify', liquidBodyTags: true }],
];
const expected = [], staged = [];
const original = new StructureParser();
try {
  for (const [language, options] of profiles) expected.push(canonicalJson(await original.parse(language, source, options)));
} finally { await original.closeAndWait(); }
const native = new StructureParser();
try {
  for (const [language, options] of profiles) staged.push(await native.parse(language, source, { ...options, nativeOnly: true }));
} finally { await native.closeAndWait(); }
const fork = childProcess.fork, children = [], jobs = [];
childProcess.fork = (...args) => {
  assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null), 'No overlapping worker generations');
  const child = fork(...args);
  children.push(child);
  const send = child.send.bind(child);
  child.send = (message, ...rest) => { jobs.push({ pid: child.pid, id: message.id, language: message.language ?? message.template }); return send(message, ...rest); };
  return child;
};
syncBuiltinESMExports();
const compiler = new TemplateScriptParser();
let compilerStats, oversizedCompilerStats, oversizedNativeStats;
try {
  for (let i = 0; i < 100; i++) compiler.prewarm();
  assert.equal(children.length, 1);
  assert.equal(jobs.length, 0, 'Prewarm dispatches no source');
  for (let i = 0; i < 65; i++) {
    assert.equal(canonicalJson(await compiler.finish(source, staged[i % 3])), expected[i % 3]);
    if (i === 63) assert.ok(children[0].exitCode !== null || children[0].signalCode !== null, 'Exhausted compiler exits before returning complete facts');
  }
  assert.equal(children.length, 2);
  compilerStats = compiler.workerGenerationStats();
  assert.equal(compilerStats.peakJobs, 64);
  assert.equal(compilerStats.jobs, 1);
  await compiler.closeAndWait();
  const oversized = new TemplateScriptParser(10000, { maxJobs: 64, maxSourceBytes: 1 });
  try {
    assert.equal(canonicalJson(await oversized.finish(source, staged[0])), expected[0]);
    oversizedCompilerStats = oversized.workerGenerationStats();
    assert.equal(oversizedCompilerStats.jobs, 0);
    assert.equal(oversizedCompilerStats.sourceBytes, 0);
    assert.ok(children.at(-1).exitCode !== null || children.at(-1).signalCode !== null);
  } finally { await oversized.closeAndWait(); }
  const boundedNative = new IndexedStructureParser(10000, { maxGrammars: 6, maxSourceBytes: 1 });
  try {
    assert.equal(canonicalJson(await boundedNative.parse('erb', source, { erbHost: 'html', nativeOnly: true })), canonicalJson(staged[0]));
    oversizedNativeStats = boundedNative.generationStats();
    assert.equal(oversizedNativeStats.sourceBytes, 0);
    assert.equal(oversizedNativeStats.grammars, 0);
    assert.ok(children.at(-1).exitCode !== null || children.at(-1).signalCode !== null);
  } finally { await boundedNative.closeAndWait(); }
  assert.deepEqual(TEMPLATE_SCRIPT_GENERATION_LIMITS, { maxJobs: 64, maxSourceBytes: 16 * 1024 * 1024 });
  assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null));
  const record = {
    schema: 1, passed: true, sourceLoader: false, targetExecution: false,
    defaultCompilerJobsVerified: 65, sourceFreePrewarmCalls: 100, malformedBudgetOverridesRejected: true,
    completeCombinedWorkerFactSha256: expected.map(text => createHash('sha256').update(text).digest('hex')),
    compilerStats, oversizedCompilerStats, oversizedNativeStats,
    actualChildren: children.map(child => ({ pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode, sourceLoader: child.spawnargs.some(argument => argument === 'tsx') })),
    dispatchedJobs: jobs,
    scope: 'Real compiled worker generation exit and complete original facts. Queue payload ownership, AST/native allocations and physical RSS are separate.',
  };
  if (process.argv[3]) await writeFile(process.argv[3], `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify({ ...record, dispatchedJobs: undefined }));
} finally {
  await compiler.closeAndWait();
  childProcess.fork = fork;
  syncBuiltinESMExports();
}
