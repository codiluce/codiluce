import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = path.join(root, 'web/public/brand-explorations/eclipse-daybreak');
const { versions } = JSON.parse(await readFile(path.join(output, 'versions.json'), 'utf8'));
const browser = await chromium.launch({ headless:true });
try {
  const page = await browser.newPage({ viewport:{width:1200,height:720}, deviceScaleFactor:2 });
  for (const version of versions) {
    for (const mode of ['dark','light']) {
      const folder = path.join(output,version.path);
      await page.goto(`file://${path.join(folder,`${mode}.svg`)}`);
      await page.screenshot({path:path.join(folder,`${mode}.png`)});
    }
  }
  console.log('Rendered 40 PNGs at 2400 × 1440.');
} finally { await browser.close(); }

const result = spawnSync('python3',['-c',`
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json
root = Path(${JSON.stringify(output)})
for family in ['all','eclipse','daybreak']:
    name = 'codiluce-eclipse-daybreak-20-versions.zip' if family == 'all' else f'codiluce-{family}-10-versions.zip'
    with ZipFile(root/name,'w',ZIP_DEFLATED) as archive:
        for p in sorted(root.rglob('*')):
            relative = p.relative_to(root)
            if not p.is_file() or p.suffix == '.zip':
                continue
            if family != 'all':
                if relative.parts[0] not in [family,'fonts','versions.json']:
                    continue
                if relative.parts[0] == 'versions.json':
                    data = json.loads(p.read_text())
                    data['versions'] = [v for v in data['versions'] if v['mark'] == family]
                    archive.writestr('codiluce-refinements/versions.json',json.dumps(data,indent=2))
                    continue
            archive.write(p,'codiluce-refinements/'+str(relative))
        if family != 'all':
            archive.writestr('codiluce-refinements/README.txt',f'Codiluce {family.title()}: ten typography and proportion variations.\\nEach numbered folder contains transparent SVGs and dark/light presentation SVGs and PNGs.\\nTagline: Bring your code to light.\\n')
print('Created archives for Eclipse, Daybreak and the complete collection.')
`],{encoding:'utf8'});
if(result.status!==0)throw new Error(result.stderr);
console.log(result.stdout.trim());
