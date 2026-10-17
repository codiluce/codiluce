// The pixel crew: agents drawn in code as pixel art (string matrices, no
// images). Claude Code is Clawd, the little orange mascot of its terminal
// banner; Codex is a blue cloud with a terminal face (">_"); any other harness
// is a grey robot, Bolt. Poses come with a prop (a magnifier for reading, a
// notebook for editing…) or a bubble (thinking, writing the reply, asking).
// The origin of a character is its feet; the session's color is a ring on
// the ground. Drawing only: what the agents do is decided in crew.ts.

export type Pose =
  | 'idle' | 'read' | 'edit' | 'search' | 'command' | 'test' | 'wait' | 'sit' | 'sleep' | 'wave'
  | 'think' | 'reply' | 'plan' | 'web';
export type Provider = 'claude-code' | 'codex' | 'other';
export const POSE_LABEL: Record<Pose, string> = {
  idle: 'idle', read: 'reading', edit: 'editing', search: 'searching', command: 'running a command', test: 'running tests', wait: 'waiting for permission',
  sit: 'resting', sleep: 'asleep', wave: 'done', think: 'thinking', reply: 'writing the reply', plan: 'planning', web: 'on the web',
};
export const PROVIDER: Record<Provider, { label: string; short: string }> = {
  'claude-code': { label: 'Claude Code', short: 'CC' },
  codex: { label: 'Codex', short: 'CX' },
  other: { label: 'Other agent', short: '··' },
};
export function providerOf(provider: string): Provider { return provider === 'codex' || provider === 'claude-code' ? provider : 'other'; }
export interface Look {
  provider: Provider;
  /** The session's color (ground ring, name). */
  color: string;
  /** Height in CSS px. */
  size: number;
  facing: 1 | -1;
  pose: Pose;
  /** ms since the pose started (animations), and a global clock. */
  poseAge: number;
  time: number;
  alpha: number;
  walking: boolean;
  result?: 'ok' | 'fail';
  resultAge?: number;
  seed: number;
}

/** A soft shadow, and the session's ring on the ground while the character stands. */
export function drawShadow(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, height: number, alpha = 1, color?: string) {
  const k = Math.max(0.35, 1 - height / (size * 2.2));
  ctx.save(); ctx.globalAlpha = 0.35 * alpha * k; ctx.fillStyle = '#000';
  ctx.beginPath(); ctx.ellipse(x, y, size * 0.42 * k, size * 0.13 * k, 0, 0, Math.PI * 2); ctx.fill();
  if (color && height < 4) {
    ctx.globalAlpha = 0.9 * alpha; ctx.strokeStyle = color; ctx.lineWidth = Math.max(1.5, size / 24);
    ctx.beginPath(); ctx.ellipse(x, y, size * 0.52, size * 0.16, 0, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();
}
function blinking(time: number, seed: number): boolean { return (time + seed * 977) % 3900 < 130; }
function resultBadge(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, result: 'ok' | 'fail', age: number) {
  const pop = Math.min(1, age / 180), k = pop < 1 ? 0.6 + 0.6 * pop : 1 + 0.08 * Math.max(0, 1 - (age - 180) / 300);
  ctx.save(); ctx.translate(x, y); ctx.scale(k, k);
  ctx.fillStyle = result === 'ok' ? '#2fbf71' : '#ef4f5f'; ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = r * 0.28; ctx.lineCap = 'round'; ctx.beginPath();
  if (result === 'ok') { ctx.moveTo(-r * 0.45, 0); ctx.lineTo(-r * 0.1, r * 0.38); ctx.lineTo(r * 0.5, -r * 0.35); }
  else { ctx.moveTo(-r * 0.38, -r * 0.38); ctx.lineTo(r * 0.38, r * 0.38); ctx.moveTo(r * 0.38, -r * 0.38); ctx.lineTo(-r * 0.38, r * 0.38); }
  ctx.stroke(); ctx.restore();
}
function zees(ctx: CanvasRenderingContext2D, x: number, y: number, u: number, time: number) {
  ctx.save(); ctx.fillStyle = '#cfe3ff'; ctx.textAlign = 'center';
  const base = ctx.globalAlpha;
  for (let i = 0; i < 3; i++) {
    const p = ((time / 1400) + i / 3) % 1;
    ctx.globalAlpha = base * Math.sin(p * Math.PI); ctx.font = `900 ${(5 + p * 5) * u}px system-ui, sans-serif`;
    ctx.fillText('z', x + p * 8 * u, y - p * 14 * u);
  }
  ctx.restore();
}

interface Sprite { rows: string[]; colors: Record<string, string>; hand: [number, number] }
// Clawd: the banner's 16 × 5 half-blocks with rows doubled (square pixels), a lighter top and a shaded base.
const CLAWD_ROWS = [
  '...TTTTTTTTTTTT...',
  '...BBBBBBBBBBBB...',
  '...BBEBBBBBBEBB...',
  '...BBEBBBBBBEBB...',
  '.AABBBBBBBBBBBBRR.',
  '.AABBBBBBBBBBBBRR.',
  '...BBBBBBBBBBBB...',
  '...SSSSSSSSSSSS...',
  '....L.L....L.L....',
  '....L.L....L.L....',
];
// Codex: a cloud head with a dark screen showing ">_", a small body with ">_" on its chest, arms and legs.
const CODEX_ROWS = [
  '.....LLL..LLL.....',
  '...LLBBBLLBBBL....',
  '..LBBBBBBBBBBBBL..',
  '.LBBBBBBBBBBBBBBB.',
  '.BBKKKKKKKKKKKKBB.',
  'BBKKCCKKKKKKKKKKBB',
  'BBKKKCCKKKKKKKKKBB',
  'BBKKKKCCKKKKKKKKBB',
  'BBKKKCCKKKKKKKKKBB',
  'BBKKCCKKKCCCCKKKBB',
  '.BBKKKKKKKKKKKKBB.',
  '.DBBBBBBBBBBBBBBD.',
  '..DDBBBBBBBBBBDD..',
  '.....DBBBBBBD.....',
  '....ABBBBBBBBR....',
  '...AABNBBBBBBRR...',
  '...AABBNNBBBBRR...',
  '.....BBBBBBBB.....',
  '.....LL....LL.....',
  '.....DD....DD.....',
];
const BOLT_ROWS = [
  '.....C......',
  '.....D......',
  '...BBBBBB...',
  '..BBBBBBBB..',
  '.BDDDDDDDDB.',
  '.BDWWDDWWDB.',
  '.BDDDDDDDDB.',
  '.BBBBBBBBBB.',
  '.BBBLLLLBBB.',
  '..BBBBBBBB..',
  '..BBBBBBBB..',
  '...BB..BB...',
  '...DD..DD...',
  '............',
];
const SPRITES: Record<Provider, Sprite> = {
  'claude-code': { rows: CLAWD_ROWS, colors: { B: '#d97757', A: '#d97757', R: '#d97757', T: '#e8977a', S: '#bf6142', L: '#bf6142', E: '#24140f' }, hand: [17, 4] },
  codex: { rows: CODEX_ROWS, colors: { B: '#3e6ff4', A: '#2f58dc', R: '#2f58dc', L: '#86a6ff', D: '#2747c4', K: '#0c1736', C: '#9fe6ff', N: '#1b2f78' }, hand: [15, 14] },
  other: { rows: BOLT_ROWS, colors: { B: '#9aa0aa', L: '#c4c9d1', D: '#4a4f58', W: '#e9f3ff', C: '#f2c94c' }, hand: [11, 8] },
};
const PROPS: Partial<Record<Pose, { rows: string[]; colors: Record<string, string> }>> = {
  read: { rows: ['.WWW...', 'W...W..', 'W...W..', 'W...W..', '.WWW...', '....HH.', '.....HH'], colors: { W: '#e8e2d4', H: '#8a5a3c' } },
  edit: { rows: ['NNNNN..', 'NRNNN..', 'NRNNNY.', 'NRNNYY.', 'NRNYY..', 'NNNNN..', '.......'], colors: { N: '#f4ecd8', R: '#c95f4a', Y: '#f2c94c' } },
  command: { rows: ['KKKKKK.', 'KCCKKK.', 'KKKKKK.', 'KKKKKK.', 'DDDDDDD', '.......', '.......'], colors: { K: '#0d1420', C: '#4fe0f0', D: '#3b3846' } },
  test: { rows: ['..W....', '..W....', '.W.W...', 'W...W..', 'WGGGW..', '.WWW...', '.......'], colors: { W: '#e6eef7', G: '#3ddc84' } },
  plan: { rows: ['.HHH...', 'BPPPB..', 'BGPPB..', 'BPPPB..', 'BGPPB..', 'BPPPB..', 'BBBBB..'], colors: { H: '#b8bec8', B: '#8a5a3c', P: '#f7f2e4', G: '#2fbf71' } },
  web: { rows: ['.OOO...', 'OGOOO..', 'OGGOG..', 'OOOGG..', '.OOO...', '..H....', '.HHH...'], colors: { O: '#3d8bd9', G: '#5cc27a', H: '#8a5a3c' } },
};
// Bubbles: thinking (a cloud with dots), writing (a speech bubble with lines), asking (?); binoculars for searching.
const THINK_ROWS = ['..WWWW.WWW..', '.WWWWWWWWWW.', 'WWWWWWWWWWWW', 'WW1WW2WW3WWW', 'WWWWWWWWWWWW', '.WWWWWWWWWW.', '..WW..WWW...', '............', '.W..........', '............', 'W...........'];
const SPEAK_ROWS = ['.WWWWWWWWWW.', 'WWWWWWWWWWWW', 'WW11111111WW', 'WWWWWWWWWWWW', 'WW222222WWWW', 'WWWWWWWWWWWW', 'WW3333333WWW', '.WWWWWWWWWW.', '..WW........', '.W..........'];
const ASK_ROWS = ['.WWWWW.', 'WWQQQWW', 'WWWWQWW', 'WWWQQWW', 'WWWQWWW', 'WWWWWWW', 'WWWQWWW', '.WWWWW.', '.W.....'];
const BINO_ROWS = ['KK..KK', 'KK..KK', 'GKKKKG'];
function pixels(ctx: CanvasRenderingContext2D, rows: string[], colors: Record<string, string>, x: number, y: number, p: number) {
  rows.forEach((row, j) => [...row].forEach((ch, i) => {
    const color = colors[ch];
    if (ch === '.' || !color) return;
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x + i * p), Math.round(y + j * p), Math.ceil(p), Math.ceil(p));
  }));
}
const SITTING = new Set<Pose>(['sit', 'sleep', 'reply', 'plan']);
/** The sprite's rows for a pose and an animation frame. */
function frameRows(provider: Provider, pose: Pose, walking: boolean, frame: number, time: number, seed: number): string[] {
  const rows = [...SPRITES[provider].rows];
  const sit = SITTING.has(pose);
  const closed = pose === 'sleep' || blinking(time, seed);
  if (provider === 'claude-code') {
    if (closed) rows[2] = rows[2]!.replace(/E/g, 'B');
    if (walking && frame) { rows[8] = '....L.L....L.L....'; rows[9] = '......L......L....'; }
    if (sit) { rows[8] = '....L........L....'; rows[9] = '..................'; }
    if (pose === 'wait' || (pose === 'wave' && frame)) {
      // The right arm goes up from the shoulder, past the head.
      for (const j of [0, 1, 2, 3]) rows[j] = `${rows[j]!.slice(0, 15)}RR.`;
      rows.unshift('...............RR.', '...............RR.');
      return rows;
    }
    return ['..................', '..................', ...rows];
  }
  if (provider === 'codex') {
    // Closed, the ">" becomes a "-" (the "_" stays).
    if (closed) { rows[5] = rows[6] = rows[8] = 'BBKKKKKKKKKKKKKKBB'; rows[7] = 'BBKKCCCCKKKKKKKKBB'; rows[9] = 'BBKKKKKKKCCCCKKKBB'; }
    if (walking && frame) { rows[18] = '.....LL.....LL....'; rows[19] = '.....DD.....DD....'; }
    if (sit) { rows[18] = '....LL......LL....'; rows[19] = '..................'; }
    if (pose === 'wait' || (pose === 'wave' && frame)) {
      // The right arm goes up and out, under the cloud.
      rows[14] = rows[14]!.replace('R', '.'); rows[15] = rows[15]!.replace('RR', '..'); rows[16] = rows[16]!.replace('RR', '..');
      rows[12] = '..DDBBBBBBBBBBDRR.'; rows[13] = '.....DBBBBBBDRR...';
    }
    return rows;
  }
  if (walking && frame) { rows[11] = '..BB....BB..'; rows[12] = '..DD....DD..'; }
  if (sit) { rows[11] = '.BBBB..BBBB.'; rows[12] = '............'; }
  if (closed) rows[5] = rows[5]!.replace(/W/g, 'D');
  return rows;
}
/** Pixel size for a character height (Clawd is short and wide, the cloud tall). */
export function pixelSize(provider: Provider, size: number): number { return Math.max(2, Math.round(size / (provider === 'claude-code' ? 15 : provider === 'codex' ? 19 : 14))); }

/** A character: a two-frame walk and bob, its prop by the hand, its bubble above. */
export function drawPixel(ctx: CanvasRenderingContext2D, x: number, y: number, look: Look) {
  const sprite = SPRITES[look.provider], p = pixelSize(look.provider, look.size);
  const frame = Math.floor(look.time / (look.walking ? 140 : 480)) % 2;
  const rows = frameRows(look.provider, look.pose, look.walking, frame, look.time, look.seed);
  const sit = SITTING.has(look.pose);
  const bob = !look.walking && frame && !sit ? p : 0;
  const w = rows[0]!.length * p, h = rows.length * p, x0 = x - w / 2, y0 = y - h + bob + (sit ? p : 0);
  ctx.save(); ctx.globalAlpha = look.alpha; ctx.imageSmoothingEnabled = false;
  if (look.pose === 'sit' || look.pose === 'sleep') pixels(ctx, ['BBBBBBBBBBBBBBBBBBBBBB', '.L..................L.'], { B: '#6b4a35', L: '#4e3526' }, x - 11 * p, y - 2 * p, p);
  if (look.facing < 0) { ctx.translate(x * 2, 0); ctx.scale(-1, 1); }
  pixels(ctx, rows, sprite.colors, x0, y0, p);
  const prop = PROPS[look.pose];
  // Props sit by the hand (two rows lower when an arm was raised).
  const handRow = sprite.hand[1] + (rows.length - sprite.rows.length);
  if (prop) pixels(ctx, prop.rows, prop.colors, x0 + sprite.hand[0] * p, y0 + (handRow - 4) * p, p);
  ctx.restore();
  if (look.provider === 'codex' && look.facing < 0) {
    // The screen again, unmirrored (">_" must not read "_<").
    ctx.save(); ctx.globalAlpha = look.alpha;
    pixels(ctx, rows.map((row, j) => (j >= 4 && j <= 10 ? row.replace(/[^KC]/g, '.') : '')), sprite.colors, x0, y0, p);
    ctx.restore();
  }
  if (look.pose === 'search') { ctx.save(); ctx.globalAlpha = look.alpha; pixels(ctx, BINO_ROWS, { K: '#26232e', G: '#8cd2ff' }, x0 + (rows[0]!.length / 2 - 3) * p, y0 + (look.provider === 'claude-code' ? 4 : 5) * p, p); ctx.restore(); }
  ctx.save(); ctx.globalAlpha = look.alpha; ctx.imageSmoothingEnabled = false;
  const bx = x + (look.facing > 0 ? w * 0.18 : -w * 0.18 - 12 * p), by = y0 - 9 * p;
  if (look.pose === 'think') {
    const dots = Math.floor(look.time / 330) % 4;
    pixels(ctx, THINK_ROWS, { W: '#f6f2ff', 1: dots > 0 ? '#3a3550' : '#c9c3dc', 2: dots > 1 ? '#3a3550' : '#c9c3dc', 3: dots > 2 ? '#3a3550' : '#c9c3dc' }, bx, by, p);
  }
  if (look.pose === 'reply') {
    const typed = (look.poseAge / 900) % 3.4;
    pixels(ctx, SPEAK_ROWS.map((row, j) => {
      const line = j === 2 ? 0 : j === 4 ? 1 : j === 6 ? 2 : -1;
      if (line < 0) return row;
      const k = Math.max(0, Math.min(1, typed - line)), len = Math.round((row.match(/[123]/g)?.length ?? 0) * k);
      let seen = 0;
      return [...row].map(ch => (/[123]/.test(ch) ? (seen++ < len ? 'I' : 'W') : ch)).join('');
    }), { W: '#fffaf0', I: '#6a6385' }, bx, by + p, p);
  }
  if (look.pose === 'wait') pixels(ctx, ASK_ROWS, { W: '#fffaf0', Q: '#1d1a26' }, x + (look.facing > 0 ? w * 0.25 : -w * 0.25 - 7 * p), y0 - 10 * p, p);
  ctx.restore();
  ctx.save(); ctx.globalAlpha = look.alpha;
  if (look.pose === 'sleep') zees(ctx, x + 4 * p, y0, p / 2.5, look.time);
  if (look.result && look.resultAge !== undefined && look.resultAge < 2600) resultBadge(ctx, x - (w / 2 + 2 * p) * look.facing, y0 - p, 3 * p, look.result, look.resultAge);
  ctx.restore();
}
/** Sparkles where a copy pops in or out (parallel reads). */
export function sparkle(ctx: CanvasRenderingContext2D, x: number, y: number, age: number, color: string) {
  if (age > 500) return;
  ctx.save(); ctx.fillStyle = color; ctx.globalAlpha *= 1 - age / 500;
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2, r = 6 + age / 22; ctx.fillRect(Math.round(x + Math.cos(a) * r), Math.round(y - 14 + Math.sin(a) * r * 0.7), 3, 3); }
  ctx.restore();
}
/** The character's face fitted in a circle (legends, lists). */
export function drawFace(ctx: CanvasRenderingContext2D, provider: Provider, cx: number, cy: number, r: number, time = 0, seed = 0) {
  const rows = frameRows(provider, 'idle', false, 0, time, seed).filter(row => /[^.]/.test(row));
  const top = provider === 'codex' ? rows.slice(0, 13) : rows;
  const p = (r * 1.5) / Math.max(top[0]!.length, top.length);
  ctx.save(); ctx.imageSmoothingEnabled = false;
  pixels(ctx, top, SPRITES[provider].colors, cx - (top[0]!.length * p) / 2, cy - (top.length * p) / 2, p);
  ctx.restore();
}
/** Where an agent does what is about no file: a mat on the ground outside the map, edged in its session's color. */
export function drawYard(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string, alpha: number, flat: boolean, dark: boolean) {
  ctx.save(); ctx.globalAlpha = alpha;
  const w = size * 1.25, h = flat ? size * 0.7 : size * 0.42;
  const fill = dark ? 'rgba(70,74,96,0.55)' : 'rgba(150,140,120,0.35)', side = dark ? 'rgba(40,42,58,0.9)' : 'rgba(120,110,95,0.5)';
  ctx.fillStyle = fill; ctx.strokeStyle = color; ctx.lineWidth = 1.4; ctx.setLineDash([4, 3]);
  if (flat) { ctx.beginPath(); ctx.roundRect(x - w, y - h / 2, w * 2, h, h * 0.35); ctx.fill(); ctx.stroke(); ctx.restore(); return; }
  ctx.beginPath(); ctx.moveTo(x - w, y); ctx.lineTo(x, y - h); ctx.lineTo(x + w, y); ctx.lineTo(x, y + h); ctx.closePath(); ctx.fill();
  ctx.setLineDash([]); ctx.fillStyle = side; ctx.beginPath(); ctx.moveTo(x - w, y); ctx.lineTo(x, y + h); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + 3); ctx.lineTo(x, y + h + 3); ctx.lineTo(x - w, y + 3); ctx.closePath(); ctx.fill();
  ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(x - w, y); ctx.lineTo(x, y - h); ctx.lineTo(x + w, y); ctx.lineTo(x, y + h); ctx.closePath(); ctx.stroke();
  ctx.restore();
}
