import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const bundled = Object.keys(manifest.devDependencies).filter(name => name.startsWith('@fontsource-variable/') || ['next', 'react', 'react-dom', 'highlight.js'].includes(name));
const destination = new URL('../web/out/licenses/', import.meta.url);
await mkdir(destination, { recursive: true });
for (const name of bundled) {
  const directory = path.dirname(require.resolve(`${name}/package.json`));
  const filename = name === 'next' ? 'license.md' : 'LICENSE';
  await copyFile(path.join(directory, filename), new URL(`${name.replace(/^@/, '').replaceAll('/', '-')}.txt`, destination));
}
