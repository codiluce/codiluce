// Frame-exact capture of the real Codiluce UI: Playwright's fake clock steps the app 1/FPS at a time.
// Usage: node capture.mjs <clip-name> [--preview]
import { chromium } from '/var/www/html/codiluce/node_modules/playwright/index.mjs';
import fs from 'node:fs';
import { CLIPS } from './clips.mjs';
const S = process.env.S;
const [,, name, flag] = process.argv;
const clip = CLIPS[name]; if (!clip) throw new Error(`no clip ${name}`);
const fps = clip.fps ?? 60, frames = Math.round((clip.seconds ?? 3.5) * fps);
const out = `${S}/clips/${name}`; fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: clip.viewport ?? { width: 1440, height: 900 }, deviceScaleFactor: flag === '--preview' ? 1 : (clip.dpr ?? 2) });
await ctx.route(/googletagmanager|google-analytics/, r => r.abort());
await ctx.addInitScript(({ storage }) => {
  try { for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v); } catch {}
  // A visible cursor that follows Playwright's mouse (headless has none).
  const install = () => {
    if (document.getElementById('__cursor')) return;
    const c = document.createElement('div'); c.id = '__cursor';
    c.innerHTML = '<svg width="26" height="26" viewBox="0 0 26 26"><path d="M4 2.5 L4 20.5 L8.6 16.4 L11.6 23.2 L14.6 21.9 L11.7 15.3 L17.9 15.1 Z" fill="#f5f5f3" stroke="#0a0a0b" stroke-width="1.6" stroke-linejoin="round"/></svg><i></i>';
    Object.assign(c.style, { position: 'fixed', left: '-100px', top: '-100px', zIndex: 2147483647, pointerEvents: 'none', filter: 'drop-shadow(0 2px 3px rgba(0,0,0,.55))', transition: 'none' });
    const st = document.createElement('style');
    st.textContent = '#__cursor svg{position:absolute;left:-4px;top:-2px;transform-origin:4px 2px;transition:transform 90ms}#__cursor.down svg{transform:scale(.86)}#__cursor i{position:absolute;left:-18px;top:-18px;width:36px;height:36px;border-radius:50%;border:2px solid #ffbf47;opacity:0;transform:scale(.3)}#__cursor.ring i{animation:__ring 420ms ease-out}@keyframes __ring{0%{opacity:.95;transform:scale(.3)}100%{opacity:0;transform:scale(1.25)}}';
    document.documentElement.append(st, c);
    addEventListener('mousemove', e => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
    addEventListener('mousedown', () => { c.classList.add('down'); c.classList.remove('ring'); void c.offsetWidth; c.classList.add('ring'); }, true);
    addEventListener('mouseup', () => c.classList.remove('down'), true);
    if (window.__hideCursor) c.style.display = 'none';
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', install); else install();
}, { storage: { 'codiluce:onboarding': JSON.stringify({ seen: true, chapters: [] }), ...(clip.storage ?? {}) } });
const page = await ctx.newPage();
page.on('console', m => { if (m.type() === 'error') console.log('console:', m.text().slice(0, 160)); });
page.on('pageerror', e => console.log('pageerror:', e.message.slice(0, 160)));
await page.clock.install({ time: new Date(clip.time ?? Date.now()) });
await page.goto(clip.url);
const h = {
  page, fps,
  /** Let the app load and settle: fake time advances while real time lets fetches land. */
  async settle(ms = 3000, step = 100) { for (let t = 0; t < ms; t += step) { await page.clock.runFor(step); await page.waitForTimeout(25); } },
  async waitReal(ms) { await page.waitForTimeout(ms); },
  mouse: undefined,
  async move(x, y) { this.mouse = { x, y }; await page.mouse.move(x, y); },
  /** A wheel turn on whatever is at (x, y), without moving the pointer (no hover). */
  async wheelAt(x, y, deltaY) { await page.evaluate(([x, y, deltaY]) => { const el = document.elementFromPoint(x, y); el?.dispatchEvent(new WheelEvent('wheel', { clientX: x, clientY: y, deltaY, deltaMode: 0, bubbles: true, cancelable: true })); }, [x, y, deltaY]); },
  /** Where a node is drawn now (or undefined). */
  async posOf(...ids) { return page.evaluate(ids => { for (const id of ids) { const p = window.__CODILUCE__?.screenPositionOf(id); if (p) return p; } return undefined; }, ids); },
  async cursor(show) { await page.evaluate(show => { const c = document.getElementById('__cursor'); if (c) c.style.visibility = show ? 'visible' : 'hidden'; }, show); },
  async event(provider, payload) {
    const r = await fetch(`${clip.api ?? new URL(clip.url).origin}/api/agents/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-codiluce-request': 'activity' }, body: JSON.stringify({ provider, payload }) });
    if (r.status !== 202) console.log('event refused', r.status, await r.text());
  },
};
await clip.setup?.(h);
if (h.mouse) await page.mouse.move(h.mouse.x, h.mouse.y);
const t0 = Date.now();
for (let i = 0; i < frames; i++) {
  await clip.frame?.(h, i, i / fps);
  await page.clock.runFor(1000 / fps);
  if (clip.realWait) await page.waitForTimeout(clip.realWait);
  await page.screenshot({ path: `${out}/f${String(i).padStart(4, '0')}.jpg`, type: 'jpeg', quality: 90, caret: 'initial' });
  if (flag === '--preview' && i % 30) continue;
}
console.log(`${name}: ${frames} frames in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
await browser.close();
