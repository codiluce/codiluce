import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type {AnalysisContext} from '../src/core/analyzer.js';
import type {StructureFacts} from '../src/analysis/facts.js';
import {GraphBuilder} from '../src/core/graph.js';
import {retireNativeLanguageServices} from '../src/pipeline/language-retirement.js';

test('native retirement preserves later PHP and unknown syntax ownership, borrowed facts and source failure/dependency records', () => {
  const native = {facts: {declarations: [], issues: [], truncated: false, go: {imports: [], comments: [], complete: true}} as StructureFacts, declarations: new Map([['original', 'entity']])};
  const php = {facts: {declarations: [], issues: [], truncated: false, php: {profile: 'php-parser-8.4-original-source', executionUnverified: true, complete: true, namespaces: [], declarations: [], imports: [], loads: [], loaderChanges: [], traits: [], bindings: [], regions: []}} as StructureFacts, declarations: new Map([['php-original', 'php-entity']])};
  const other = {facts: {declarations: [], issues: [], truncated: false}, declarations: new Map<string, string>()};
  const borrowed = new Map([['original.go', native], ['Original.php', php], ['unknown', other]]), failures = new Map([['changed', 'Original changed']]), reads = new Set(['original.go']); let cleared = 0;
  const context = {graph: new GraphBuilder('owned'), syntax: borrowed, sourceReads: reads, sources: {failures, clear() {cleared++;}}, go: {owned: native}, goSymbols: {owned: native}} as unknown as AnalysisContext;
  retireNativeLanguageServices(context);
  assert.deepEqual([...context.syntax!.keys()], ['Original.php', 'unknown']); assert.equal(context.syntax!.get('Original.php'), php); assert.equal(context.syntax!.get('unknown'), other);
  assert.equal(borrowed.size, 3); assert.equal(native.declarations.get('original'), 'entity'); assert.equal(context.go, undefined); assert.equal(context.goSymbols, undefined);
  assert.equal(context.sources!.failures, failures); assert.equal(context.sourceReads, reads); assert.equal(cleared, 1);
  retireNativeLanguageServices(context); assert.equal(context.syntax!.get('Original.php'), php); assert.equal(cleared, 2);
});

test('default pipeline retires all native consumer roots before the next compiler phase and on failure while retaining complete warm and later PHP facts', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'codiluce-native-retirement-receipt-')), file = path.join(root, 'receipt.json'); let passed = false;
  try {
    const stdout = execFileSync(process.execPath, ['--expose-gc', '--experimental-sqlite', '--import', 'tsx', fileURLToPath(new URL('./fixtures/native-consumer-retirement.mjs', import.meta.url)), new URL('../src/', import.meta.url).href, file], {maxBuffer: 8 * 1024 * 1024});
    writeFileSync(path.join(root, 'stdout.bin'), stdout);
    const receipt = JSON.parse(readFileSync(file, 'utf8')); assert.equal(receipt.passed, true); assert.equal(receipt.caseCount, 2); assert.equal(receipt.observations.length, 4); assert.ok(receipt.observations.every((row: {liveAtNextPhase: number}) => row.liveAtNextPhase === 0)); passed = true;
  } catch (error) {
    if (error && typeof error === 'object') {if ('stdout' in error && Buffer.isBuffer(error.stdout)) writeFileSync(path.join(root, 'stdout.bin'), error.stdout); if ('stderr' in error && Buffer.isBuffer(error.stderr)) writeFileSync(path.join(root, 'stderr.bin'), error.stderr);}
    throw error;
  } finally {if (passed) rmSync(root, {recursive: true, force: true}); else console.error('Retained native retirement receipt:', root);}
});
