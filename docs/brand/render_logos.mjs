// Render the vector originals faithfully at 2× resolution, then build the archive.
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = path.join(root, 'web/public/brand-explorations');
const { directions } = JSON.parse(await readFile(path.join(output, 'directions.json'), 'utf8'));
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1200, height: 720 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  for (const direction of directions) {
    for (const mode of ['dark', 'light']) {
      const folder = path.join(output, direction.id);
      await page.goto(`file://${path.join(folder, `${mode}.svg`)}`);
      await page.screenshot({ path: path.join(folder, `${mode}.png`) });
    }
  }
  console.log('Rendered 20 PNGs at 2400 × 1440 pixels.');
} finally {
  await browser.close();
}
const zip = spawnSync('python3', ['-c', `
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
root = Path(${JSON.stringify(output)})
with ZipFile(root / 'codiluce-10-logo-directions.zip', 'w', ZIP_DEFLATED) as archive:
    for path in sorted(root.rglob('*')):
        if path.is_file() and path.suffix != '.zip':
            archive.write(path, 'codiluce-logos/' + str(path.relative_to(root)))
print('Created the complete download archive.')
`], { encoding: 'utf8' });
if (zip.status !== 0) throw new Error(zip.stderr);
console.log(zip.stdout.trim());
