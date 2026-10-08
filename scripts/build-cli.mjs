import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
// Remove stale output so deleted modules and compiled tests cannot ship.
rmSync(new URL('../dist/', import.meta.url), { recursive: true, force: true });
try {
  execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit' });
} catch (error) {
  process.exitCode = error.status ?? 1;
}
