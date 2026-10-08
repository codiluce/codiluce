import { execFileSync } from 'node:child_process';
import { cpSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
// Remove stale output so deleted modules and compiled tests cannot ship.
rmSync(new URL('../dist/', import.meta.url), { recursive: true, force: true });
try {
  execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit' });
  const manifest = JSON.parse(readFileSync(new URL('../grammars/manifest.json', import.meta.url), 'utf8'));
  for (const grammar of manifest.grammars) {
    const bytes = readFileSync(new URL(`../grammars/${grammar.file}`, import.meta.url));
    if (createHash('sha256').update(bytes).digest('hex') !== grammar.sha256) throw new Error(`Grammar checksum mismatch: ${grammar.language}`);
  }
  cpSync(new URL('../grammars/', import.meta.url), new URL('../dist/grammars/', import.meta.url), { recursive: true });
} catch (error) {
  if (!error.status) console.error(error.message);
  process.exitCode = error.status ?? 1;
}
