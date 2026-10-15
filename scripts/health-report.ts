// Code health metrics over directories, to check the numbers on real code:
//   node --import tsx scripts/health-report.ts <directory>... [--top 10] [--json out.json]
// Prints, per language, how the metrics spread (median, 90th percentile, max)
// and the functions ranking worst on each, outside tests.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { languageOf } from '../src/core/languages.js';
import { createMeasurer, metricsDialect } from '../src/analysis/metrics/grammars.js';
import { generatedReason } from '../src/analysis/metrics/generated.js';
import type { FunctionMetrics } from '../src/analysis/metrics/measure.js';
import { TEST_FILE } from '../src/analysis/metrics/analyzer.js';

const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', 'vendor', 'dist', 'build', 'out', '.next', 'target', '__pycache__', '.venv', 'venv', 'third_party']);
const MAX_BYTES = 512 * 1024;
const METRICS = ['length', 'complexity', 'nesting', 'parameters'] as const;

const args = process.argv.slice(2);
const option = (name: string) => { const at = args.indexOf(name); if (at < 0) return undefined; const [, value] = args.splice(at, 2); return value; };
const top = Number(option('--top') ?? 10), json = option('--json');
if (!args.length) { console.error('usage: health-report.ts <directory>... [--top 10] [--json out.json]'); process.exit(1); }

interface Row extends FunctionMetrics { file: string; language: string; test: boolean }
const rows: Row[] = [];
const files = new Map<string, { files: number; lines: number; skipped: number }>();
const skippedBy = new Map<string, number>();
const measurer = await createMeasurer();
const started = performance.now();
for (const root of args) {
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (!SKIP_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.')) walk(full); continue; }
      const relative = path.relative(root, full).split(path.sep).join('/');
      const language = languageOf(relative), dialect = metricsDialect(language, relative);
      if (!dialect || !language) continue;
      const stats = files.get(language) ?? { files: 0, lines: 0, skipped: 0 }; files.set(language, stats);
      const content = statSync(full).size <= MAX_BYTES ? readFileSync(full, 'utf8') : undefined;
      const reason = content === undefined ? 'larger than 512 KB' : generatedReason(relative, content);
      if (reason || content === undefined) { stats.skipped++; skippedBy.set(reason!, (skippedBy.get(reason!) ?? 0) + 1); continue; }
      const result = measurer.measure(dialect, content);
      stats.files++; stats.lines += result.lines;
      const file = `${path.basename(root)}/${relative}`, test = TEST_FILE.test(relative);
      for (const item of result.functions) rows.push({ ...item, file, language, test });
    }
  };
  walk(root);
}
const elapsed = performance.now() - started;
measurer.close();

const quantile = (values: number[], q: number) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0; };
const languages = [...files.keys()].sort();
console.log(`Measured ${[...files.values()].reduce((sum, item) => sum + item.files, 0)} files and ${rows.length} functions in ${Math.round(elapsed)} ms\n`);
console.log(`${'language'.padEnd(12)}${'files'.padStart(7)}${'skipped'.padStart(9)}${'code lines'.padStart(12)}${'functions'.padStart(11)}   ${METRICS.map(name => `${name} p50/p90/max`.padStart(24)).join('')}`);
for (const language of languages) {
  const stats = files.get(language)!, own = rows.filter(row => row.language === language && !row.test);
  console.log(`${language.padEnd(12)}${String(stats.files).padStart(7)}${String(stats.skipped).padStart(9)}${String(stats.lines).padStart(12)}${String(own.length).padStart(11)}   ${METRICS.map(name => {
    const values = own.map(row => row[name]);
    return `${quantile(values, 0.5)} / ${quantile(values, 0.9)} / ${Math.max(0, ...values)}`.padStart(24);
  }).join('')}`);
}
console.log(`\nSkipped: ${[...skippedBy].map(([reason, count]) => `${count} ${reason}`).join('; ') || 'none'}`);
console.log('(functions outside tests; tests are listed separately below)');
for (const name of ['complexity', 'nesting', 'length'] as const) {
  console.log(`\nWorst ${name}, outside tests:`);
  for (const row of rows.filter(item => !item.test).sort((a, b) => b[name] - a[name] || b.complexity - a.complexity).slice(0, top))
    console.log(`  ${String(row[name]).padStart(5)}  ${row.name.slice(0, 48).padEnd(48)} ${row.file}:${row.startLine}  (length ${row.length}, complexity ${row.complexity}, nesting ${row.nesting}, ${row.parameters} parameters)`);
}
const tests = rows.filter(row => row.test);
if (tests.length) console.log(`\nTests: ${tests.length} functions, longest ${Math.max(...tests.map(row => row.length))} lines (${tests.sort((a, b) => b.length - a.length)[0]!.name} in ${tests[0]!.file})`);
if (json) { writeFileSync(json, JSON.stringify(rows)); console.log(`\nWrote ${rows.length} functions to ${json}`); }
