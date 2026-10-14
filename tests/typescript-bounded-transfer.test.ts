import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
test('default compiler transfer works with full-value V8 serialization forbidden and rejects oversized input/output without parent mutation', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'codiluce-bounded-transfer-receipt-')), file = path.join(root, 'receipt.json'); let passed = false;
  try {
    const output = execFileSync(process.execPath, ['--experimental-sqlite', '--import', 'tsx', fileURLToPath(new URL('./fixtures/typescript-bounded-codec-qualification.mjs', import.meta.url)), new URL('../src/', import.meta.url).href, file], {maxBuffer: 8 * 1024 * 1024}); writeFileSync(path.join(root, 'stdout.bin'), output);
    const receipt = JSON.parse(readFileSync(file, 'utf8')); assert.equal(receipt.passed, true); assert.equal(receipt.caseCount, 3); assert.equal(receipt.parentFullValueV8Serializations, 0); assert.equal(receipt.targetExecution, false); passed = true;
  } catch (error) {if (error && typeof error === 'object') {if ('stdout' in error && Buffer.isBuffer(error.stdout)) writeFileSync(path.join(root, 'stdout.bin'), error.stdout); if ('stderr' in error && Buffer.isBuffer(error.stderr)) writeFileSync(path.join(root, 'stderr.bin'), error.stderr);} throw error;}
  finally {if (passed) rmSync(root, {recursive: true, force: true}); else console.error('Retained bounded transfer receipt:', root);}
});
