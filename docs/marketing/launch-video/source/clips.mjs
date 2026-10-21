const BOOK = 'http://127.0.0.1:4390/';
const ease = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const easeOut = t => 1 - Math.pow(1 - t, 3);
const lerp = (a, b, t) => a + (b - a) * t;
/** Wheel deltas that zoom by `total` between frames f0..f1 along an ease, around the mouse. */
function zoomPlan(total, f0, f1, curve = ease) {
  const k = Math.log(total) / 0.0018;
  return i => { if (i < f0 || i >= f1) return 0; const a = curve((i - f0) / (f1 - f0)), b = curve((i + 1 - f0) / (f1 - f0)); return -(b - a) * k; };
}
async function collapseInspector(h) { const b = h.page.getByRole('button', { name: 'Collapse inspector' }); if (await b.count()) await b.click(); await h.settle(800); await h.cursor(false); }
const ROOT = '/var/www/html/codiluce/examples/bookstack';
let tool = 0;
/** Hook payloads as Claude Code / Codex / Cursor send them (the generic shape the normalizer reads). */
const agent = (h, provider, session, title) => ({
  start: () => h.event(provider, { hook_event_name: 'SessionStart', session_id: session, cwd: ROOT, session_title: title }),
  prompt: () => h.event(provider, { hook_event_name: 'UserPromptSubmit', session_id: session, cwd: ROOT, session_title: title }),
  async use(name, input, done = false) { const id = `t${++tool}`; await h.event(provider, { hook_event_name: 'PreToolUse', session_id: session, cwd: ROOT, tool_name: name, tool_input: input, tool_use_id: id, session_title: title }); return id; },
  done: (name, input, id) => h.event(provider, { hook_event_name: 'PostToolUse', session_id: session, cwd: ROOT, tool_name: name, tool_input: input, tool_use_id: id, tool_response: { success: true }, session_title: title }),
});
const file = p => ({ file_path: `${ROOT}/${p}` });

/** The cursor glides from where it is to (x, y) between t0 and t1 (seconds). */
function glide(h, t, t0, t1, from, to, curve = ease) {
  if (t < t0 || t > t1 + 1 / 60) return false;
  const k = curve(Math.min(1, (t - t0) / (t1 - t0)));
  return h.move(lerp(from[0], to[0], k), lerp(from[1], to[1], k));
}
async function box(h, locator) { const b = await locator.boundingBox(); if (!b) throw new Error('no box'); return [b.x + b.width / 2, b.y + b.height / 2]; }
async function zoomInto(h, id, factor) { const steps = 30, d = -Math.log(factor) / 0.0018 / steps; for (let k = 0; k < steps; k++) { const p = await h.posOf(id); if (p) await h.wheelAt(p.x, p.y, d); await h.settle(16, 16); } await h.settle(600); }
const ENTITIES = 'directory:cc8b53a26bf036a20f422a2c';
const TOUR = 'http://127.0.0.1:4390/#explain=2026-10-19-what-happens-when-someone-saves-a-page-eccb';

// The invented storefront (Laravel API + Next.js web), served with the GitHub stand-in for its open PR #2841.
const SF = 'http://127.0.0.1:4391/';
const SF_TIME = '2026-10-16T11:05:00Z';
const SF_TOUR = `${SF}#explain=2026-10-19-what-pull-request-2841-changes-c88f`;
const CHECKOUT_SERVICE = 'file:88da27c35262f0d64a362ec1';
/** A click where nothing moves the pointer first (no hover on the map). */
async function tap(h, x, y) {
  await h.page.evaluate(([x, y]) => { const el = document.elementFromPoint(x, y); const o = { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, isPrimary: true };
    el?.dispatchEvent(new PointerEvent('pointerdown', o)); el?.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 })); el?.dispatchEvent(new MouseEvent('click', o)); }, [x, y]);
}
const click = async (h, real = 300) => { await h.page.mouse.down(); await h.page.mouse.up(); await h.waitReal(real); };

export const CLIPS = {
  wishflow: {
    url: SF, time: SF_TIME, seconds: 3.7,
    async setup(h) {
      await h.settle(4000); await collapseInspector(h);
      await h.page.getByRole('button', { name: 'Flows', exact: true }).click(); await h.settle(1200);
      await h.page.getByPlaceholder(/Filter: entry/).fill('wishlist'); await h.settle(1200);
      h.target = await box(h, h.page.getByText('/api/wishlist/{product}', { exact: true }).first());
      h.from = [h.target[0] + 40, h.target[1] + 150];
      await h.move(...h.from); await h.cursor(true);
    },
    async frame(h, i, t) {
      await glide(h, t, 0.05, 0.48, h.from, h.target);
      if (i === 33) await click(h, 400);
      await glide(h, t, 1.0, 1.6, h.target, [h.target[0] - 40, h.target[1] + 130]);
    },
  },
  prfocus: {
    url: SF, time: SF_TIME, seconds: 3.2,
    async setup(h) {
      await h.settle(4000); await collapseInspector(h);
      await h.page.getByRole('button', { name: 'PRs', exact: true }).first().click(); await h.settle(2500);
      h.row = await box(h, h.page.getByText('Add coupons and gift cards at checkout').first());
      h.from = [h.row[0] + 70, h.row[1] + 170];
      await h.move(...h.from); await h.cursor(true);
    },
    async frame(h, i, t) {
      await glide(h, t, 0.0, 0.3, h.from, h.row);
      if (i === 20) { await click(h, 900); h.focus = await box(h, h.page.locator('.feature-focus').getByRole('button', { name: 'Focus' })); }
      if (h.focus) await glide(h, t, 0.62, 1.0, h.row, h.focus);
      if (i === 63) await click(h, 700);
      if (h.focus) await glide(h, t, 1.3, 1.8, h.focus, [h.focus[0] - 30, h.focus[1] + 360]);
    },
  },
  prtour: {
    url: SF_TOUR, time: SF_TIME, seconds: 3.4, storage: { 'codiluce:prefs': JSON.stringify({ tourView: 'diagram' }) },
    async setup(h) {
      await h.settle(5000); await collapseInspector(h); await h.settle(1500);
      h.target = await box(h, h.page.getByRole('button', { name: /Next scene|Next/ }).last());
      h.from = [h.target[0] - 140, h.target[1] + 2];
      await h.move(...h.from); await h.cursor(true);
    },
    async frame(h, i, t) {
      await glide(h, t, 0.1, 0.62, h.from, h.target);
      if (i === 42) await click(h, 400);
      await glide(h, t, 1.2, 1.8, h.target, [h.target[0] + 90, h.target[1] + 4]);
    },
  },
  health: {
    url: BOOK, seconds: 3.3,
    async setup(h) {
      await h.settle(4000); await collapseInspector(h); await zoomInto(h, ENTITIES, 4.5);
      h.button = await box(h, h.page.getByRole('button', { name: /^Color by:/ }));
      h.from = [h.button[0] - 160, h.button[1] + 40];
      await h.move(...h.from); await h.cursor(true);
    },
    async frame(h, i, t) {
      await glide(h, t, 0.0, 0.2, h.from, h.button);
      if (i === 13) { await click(h, 200); h.item = await box(h, h.page.getByRole('menuitemradio', { name: /Hotspots/ }).or(h.page.getByRole('menuitem', { name: /Hotspots/ })).first()); }
      if (h.item) await glide(h, t, 0.25, 0.5, h.button, h.item);
      if (i === 31) {
        await click(h, 900); h.hot = await box(h, h.page.getByText('PageRepo.php', { exact: true }).first());
        // The pointer crosses the map on its way to the list: no hover outlines or tooltips on the way.
        await h.page.addStyleTag({ content: 'canvas { pointer-events: none !important; }' });
      }
      if (h.hot) await glide(h, t, 0.95, 1.35, h.item, h.hot);
      if (i === 84) await click(h, 400);
      if (h.hot) await glide(h, t, 1.55, 2.0, h.hot, [h.hot[0] + 10, h.hot[1] - 150]);
    },
  },
  people: {
    url: SF, time: SF_TIME, seconds: 1.5,
    async setup(h) {
      await h.settle(4000); await collapseInspector(h);
      await h.page.getByRole('button', { name: 'People', exact: true }).first().click(); await h.settle(2000);
      await zoomInto(h, 'application:c27effc249b4f3d416a49c7a', 1.6);
      h.box = await box(h, h.page.getByText('Color files by who changed them most'));
      await h.cursor(false);
    },
    async frame(h, i) { if (i === 5) { await h.page.getByText('Color files by who changed them most').click(); await h.waitReal(600); } },
  },
  deps: {
    url: SF, time: SF_TIME, seconds: 1.6,
    async setup(h) {
      await h.settle(4000); await collapseInspector(h);
      await h.page.getByRole('button', { name: 'Dependencies', exact: true }).first().click(); await h.settle(800);
      await zoomInto(h, 'directory:649fef15be959865be3ee58a', 3.2);
      await h.cursor(false);
    },
    async frame(h, i) { if (i === 5) { const p = await h.posOf(CHECKOUT_SERVICE); if (p) await tap(h, p.x, p.y); await h.waitReal(700); } },
  },
  flow: {
    url: BOOK, seconds: 3.6,
    async setup(h) {
      await h.settle(4000); await collapseInspector(h);
      await h.page.getByRole('button', { name: 'Flows', exact: true }).click(); await h.settle(1200);
      await h.page.getByText('bookstack:create-admin').first().click(); await h.settle(1500);
      await h.page.getByRole('button', { name: 'Map', exact: true }).last().click(); await h.settle(1500);
      await h.page.getByText('Map', { exact: true }).first().click(); await h.settle(1500);
      h.target = await box(h, h.page.getByText('bookstack:delete-users').first());
      await h.move(520, 640); await h.cursor(true);
    },
    async frame(h, i, t) {
      await glide(h, t, 0.05, 0.5, [520, 640], [h.target[0] - 20, h.target[1] + 2]);
      if (i === 33) { await h.page.mouse.down(); await h.page.mouse.up(); await h.waitReal(300); }
      await glide(h, t, 1.0, 1.7, [h.target[0] - 20, h.target[1] + 2], [h.target[0] - 60, h.target[1] + 150]);
    },
  },
  impact: {
    url: BOOK, seconds: 3.4,
    async setup(h) {
      await h.settle(4000); await h.cursor(false);
      await h.page.keyboard.press('/'); await h.page.keyboard.type('PermissionApplicator'); await h.settle(1500);
      await h.page.keyboard.press('Enter'); await h.settle(2500);
      h.target = await box(h, h.page.locator('aside, .inspector').getByRole('button', { name: 'Impact', exact: true }).first());
      await h.move(1150, 520); await h.cursor(true);
    },
    async frame(h, i, t) {
      await glide(h, t, 0.05, 0.45, [1150, 520], h.target);
      if (i === 30) { await h.page.mouse.down(); await h.page.mouse.up(); await h.waitReal(500); }
      await glide(h, t, 0.9, 1.6, h.target, [640, 300]);
    },
  },
  explain: {
    url: TOUR, seconds: 3.6, storage: { 'codiluce:prefs': JSON.stringify({ tourView: 'diagram' }) },
    async setup(h) {
      await h.settle(5000); await collapseInspector(h); await h.settle(1500);
      h.target = await box(h, h.page.getByRole('button', { name: /Next scene|Next/ }).last());
      await h.move(h.target[0] - 240, h.target[1] + 2); await h.cursor(true);
    },
    async frame(h, i, t) {
      await glide(h, t, 0.1, 0.7, [h.target[0] - 240, h.target[1] + 2], h.target);
      if (i === 46) { await h.page.mouse.down(); await h.page.mouse.up(); await h.waitReal(400); }
      await glide(h, t, 1.3, 2.0, h.target, [h.target[0] + 90, h.target[1] + 4]);
    },
  },
  plan: {
    url: BOOK, seconds: 1.8,
    async setup(h) { await h.settle(4000); await collapseInspector(h); h.target = await box(h, h.page.getByRole('button', { name: 'Isometric 3D map' })); },
    async frame(h, i) { if (i === 6) { await h.page.getByRole('button', { name: 'Isometric 3D map' }).click(); await h.waitReal(200); } },
  },
  history: {
    url: BOOK, seconds: 2.6,
    async setup(h) {
      await h.settle(4000); await collapseInspector(h);
      await h.page.getByRole('button', { name: 'History', exact: true }).first().click(); await h.settle(3500);
      for (let k = 0; k < 7; k++) { await h.page.getByRole('button', { name: 'Previous commit' }).first().click(); await h.settle(900); }
      h.next = await box(h, h.page.getByRole('button', { name: 'Next commit' }).first());
      await h.move(h.next[0] + 120, h.next[1] + 40); await h.cursor(true);
    },
    async frame(h, i, t) {
      await glide(h, t, 0.0, 0.15, [h.next[0] + 120, h.next[1] + 40], h.next);
      if (i === 10 || i === 82) { await h.page.mouse.down(); await h.page.mouse.up(); await h.waitReal(400); }
    },
  },
  hotspots: {
    url: BOOK, seconds: 1.8,
    async setup(h) {
      await h.settle(4000); await collapseInspector(h); await zoomInto(h, ENTITIES, 4.5);
      h.button = await box(h, h.page.getByRole('button', { name: /^Color by:/ }));
      await h.move(h.button[0] - 160, h.button[1] + 2); await h.cursor(true);
    },
    async frame(h, i, t) {
      await glide(h, t, 0.0, 0.2, [h.button[0] - 160, h.button[1] + 2], h.button);
      if (i === 13) { await h.page.mouse.down(); await h.page.mouse.up(); await h.waitReal(200); h.item = await box(h, h.page.getByRole('menuitemradio', { name: /Hotspots/ }).or(h.page.getByRole('menuitem', { name: /Hotspots/ })).first()); }
      if (h.item) await glide(h, t, 0.25, 0.5, h.button, h.item);
      if (i === 31) { await h.page.mouse.down(); await h.page.mouse.up(); await h.waitReal(500); }
    },
  },
  probe: {
    url: BOOK, seconds: 1 / 60,
    async setup(h) { await h.settle(4000); await collapseInspector(h); await h.settle(1500); },
  },
  agents: {
    url: BOOK, seconds: 4.2, realWait: 0,
    async setup(h) {
      await h.settle(4000); await collapseInspector(h);
      await h.page.getByRole('button', { name: 'Agents', exact: true }).first().click(); await h.settle(1200); await h.cursor(false);
      for (let k = 0; k < 40; k++) { const p = await h.posOf('directory:cc8b53a26bf036a20f422a2c'); if (p) await h.wheelAt(p.x + 25, p.y + 45, -17.4); await h.settle(16, 16); }
      h.cc = agent(h, 'claude-code', 'cc-7f3a91d2', 'Add page templates');
      h.cx = agent(h, 'codex', 'cx-019a44b7', 'Speed up search');
      h.cu = agent(h, 'cursor', 'cu-5b2e8c10', 'Fix image uploads');
      for (const a of [h.cc, h.cx, h.cu]) { await a.start(); await a.prompt(); await h.waitReal(80); await h.settle(300); }
      h.r0 = await h.cc.use('Read', file('app/Entities/Repos/PageRepo.php')); await h.waitReal(150); await h.settle(400);
      h.s0 = await h.cx.use('Grep', { pattern: 'searchTerm', path: `${ROOT}/app/Search` }); await h.waitReal(150); await h.settle(1400);
    },
    frame: (() => {
      const plan = [
        [0.15, async h => { h.u1 = await h.cu.use('Read', file('app/Uploads/ImageService.php')); }],
        [0.35, async h => { await h.cc.done('Read', file('app/Entities/Repos/PageRepo.php'), h.r0); await h.cx.done('Grep', {}, h.s0); }],
        [0.55, async h => { h.p = []; for (const f of ['app/Entities/Tools/PageContent.php', 'app/Entities/Models/Page.php', 'app/Entities/Controllers/PageTemplateController.php']) h.p.push([f, await h.cc.use('Read', file(f))]); }],
        [0.95, async h => { h.r1 = await h.cx.use('Read', file('app/Search/SearchRunner.php')); }],
        [1.55, async h => { await h.cu.done('Read', file('app/Uploads/ImageService.php'), h.u1); }],
        [1.9, async h => { for (const [f, id] of h.p) await h.cc.done('Read', file(f), id); await h.cx.done('Read', file('app/Search/SearchRunner.php'), h.r1); }],
        [2.05, async h => { h.e1 = await h.cx.use('Edit', file('app/Search/SearchIndex.php')); }],
        [2.25, async h => { h.e0 = await h.cc.use('Edit', file('app/Entities/Repos/PageRepo.php')); }],
        [2.6, async h => { h.e2 = await h.cu.use('Edit', file('app/Uploads/ImageRepo.php')); }],
        [3.3, async h => { await h.cx.done('Edit', file('app/Search/SearchIndex.php'), h.e1); await h.cc.done('Edit', file('app/Entities/Repos/PageRepo.php'), h.e0); }],
      ];
      let next = 0;
      return async (h, i, t) => { let fired = false; while (next < plan.length && plan[next][0] <= t) { await plan[next++][1](h); fired = true; } if (fired) await h.waitReal(220); };
    })(),
  },
  map: {
    url: BOOK, seconds: 3.6,
    async setup(h) { await h.settle(4000); await collapseInspector(h); await h.settle(1500); },
    frame: (() => { const z = zoomPlan(30, 0, 214); let anchor; return async (h, i) => {
      const p = await h.posOf('directory:f7d411d9bd60f2eb00274c94', 'directory:cc8b53a26bf036a20f422a2c');
      if (p) anchor = p;
      const d = z(i); if (d && anchor) await h.wheelAt(anchor.x, anchor.y, d);
    }; })(),
  },
};
