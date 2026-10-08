// Restore the pinned release assets from development dependencies. Normal CLI
// builds copy the committed assets; this command neither downloads nor compiles.
import { createHash } from 'node:crypto';
import { readFileSync, copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const manifest = JSON.parse(readFileSync(path.join(root, 'grammars/manifest.json'), 'utf8'));
for (const grammar of manifest.grammars) {
  const directory = path.dirname(require.resolve(`${grammar.artifactPackage}/package.json`));
  const pkg = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
  if (pkg.version !== grammar.artifactVersion) throw new Error(`Unexpected grammar artifact version: ${grammar.artifactPackage}`);
  const source = path.join(directory, grammar.artifactPath);
  const hash = createHash('sha256').update(readFileSync(source)).digest('hex');
  if (hash !== grammar.sha256) throw new Error(`Grammar checksum mismatch: ${grammar.language}`);
  copyFileSync(source, path.join(root, 'grammars', grammar.file));
}
console.log(`Restored ${manifest.grammars.length} pinned grammar assets.`);
