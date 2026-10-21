// Renders the composition frame by frame: node render.mjs <out-dir> [frames...|all] [--workers N]
import { chromium } from '/var/www/html/codiluce/node_modules/playwright/index.mjs';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const S = process.env.S;
const args = process.argv.slice(2);
const out = args[0]; fs.mkdirSync(out, { recursive: true });
const wi = args.indexOf('--workers'); const workers = wi >= 0 ? +args[wi + 1] : 1;
const list = args.slice(1).filter((a, i, all) => a !== '--workers' && all[i - 1] !== '--workers');
const TL = createRequire(import.meta.url)(`${S}/video/timeline.js`);
const total = Math.round(TL.duration * TL.fps);
const frames = list[0] === 'all' ? [...Array(total).keys()] : list.map(x => x.includes('s') ? Math.round(parseFloat(x) * 60) : +x);
const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] });
const t0 = Date.now(); let done = 0;
await Promise.all([...Array(workers).keys()].map(async w => {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', e => console.log('pageerror', e.message));
  page.on('console', m => { if (m.type() === 'error') console.log('console', m.text()); });
  await page.goto(`file://${S}/video/comp.html`);
  await page.evaluate(() => window.ready);
  for (let i = w; i < frames.length; i += workers) {
    const f = frames[i];
    await page.evaluate(f => window.render(f), f);
    await page.screenshot({ path: `${out}/f${String(f).padStart(5, '0')}.png`, clip: { x: 0, y: 0, width: 1920, height: 1080 } });
    if (++done % 120 === 0) console.log(`${done}/${frames.length} ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
}));
console.log(`rendered ${frames.length} frames in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
await browser.close();
