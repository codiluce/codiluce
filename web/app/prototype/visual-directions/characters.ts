// PROTOTYPE (throwaway) — agent characters drawn in code (no image generation).
// Styles: Buddies (flat vector, poses with props), Pixel crew (pixel art from
// string matrices), Pins (calm tokens showing the character's face).
// Characters: Claude Code is Clawd, the little orange mascot of its terminal
// banner (a wide body, two slit eyes, arm nubs, four legs); Codex is a blue
// cloud with a terminal face (">_"); anything else is a grey robot, Bolt.
// Origin is the feet (x, y). The session's color is a ring on the ground.

export type Pose =
  | 'idle' | 'read' | 'edit' | 'search' | 'command' | 'test' | 'wait' | 'sit' | 'sleep' | 'wave' | 'build' | 'erase'
  | 'think' | 'reply' | 'plan' | 'web';
export type Provider = 'claude-code' | 'codex' | 'other';
/** Poses that are about no file or folder: the character steps outside the map to do them. */
export const OUTSIDE = new Set<Pose>(['think', 'reply', 'plan', 'web', 'wait', 'command', 'test', 'sit', 'sleep', 'wave']);
export const POSE_LABEL: Record<Pose, string> = {
  idle: 'idle', read: 'reading', edit: 'editing', search: 'searching', command: 'running a command', test: 'running tests', wait: 'waiting for permission',
  sit: 'resting', sleep: 'asleep', wave: 'done', build: 'adding', erase: 'removing', think: 'thinking', reply: 'writing the reply', plan: 'planning', web: 'on the web',
};
export interface Look {
  provider: Provider;
  /** The session's color (ground ring, name). */
  color: string;
  /** Height in CSS px of 40 body units. */
  size: number;
  facing: 1 | -1;
  pose: Pose;
  /** ms since the pose started (animations), and a global clock. */
  poseAge: number;
  time: number;
  /** Squash (<1) and stretch (>1) of the body. */
  stretch: number;
  alpha: number;
  result?: 'ok' | 'fail';
  resultAge?: number;
  seed: number;
}

export const PROVIDER = {
  'claude-code': { body: '#d97757', dark: '#b45a3c', light: '#eba183', accent: '#f4b08f', label: 'Claude Code', short: 'CC' },
  codex: { body: '#3e6ff4', dark: '#2747c4', light: '#86a6ff', accent: '#9fe6ff', label: 'Codex', short: 'CX' },
  other: { body: 'hsl(220 6% 62%)', dark: 'hsl(220 8% 34%)', light: 'hsl(220 8% 78%)', accent: 'hsl(48 90% 60%)', label: 'Other agent', short: '··' },
} as const;

// Shared bits -----------------------------------------------------------------------

export function drawShadow(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, height: number, alpha = 1, color?: string) {
  const k = Math.max(0.35, 1 - height / (size * 2.2));
  ctx.save(); ctx.globalAlpha = 0.35 * alpha * k; ctx.fillStyle = '#000';
  ctx.beginPath(); ctx.ellipse(x, y, size * 0.42 * k, size * 0.13 * k, 0, 0, Math.PI * 2); ctx.fill();
  if (color && height < 4) {
    // The session's ring on the ground.
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
function bubble(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, text: string, pulse: number) {
  ctx.save(); ctx.translate(x, y); ctx.scale(1 + pulse * 0.08, 1 + pulse * 0.08);
  ctx.fillStyle = '#fffaf0'; ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.roundRect(-r, -r * 0.85, r * 2, r * 1.7, r * 0.6); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-r * 0.3, r * 0.8); ctx.lineTo(-r * 0.7, r * 1.35); ctx.lineTo(r * 0.1, r * 0.8); ctx.fill();
  ctx.fillStyle = '#1d1a26'; ctx.font = `900 ${r * 1.25}px Nunito Variable, system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, 0, 0); ctx.restore();
}
/** Thinking: a cloud with three dots taking turns, and two small puffs leading up to it. */
function thought(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, time: number) {
  ctx.save(); ctx.fillStyle = '#f6f2ff'; ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.lineWidth = 1;
  for (const [dx, dy, k] of [[-r * 1.1, r * 1.55, 0.18], [-r * 0.6, r * 1.05, 0.28]] as const) { ctx.beginPath(); ctx.arc(x + dx, y + dy, r * k, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
  ctx.beginPath();
  for (const [dx, dy, k] of [[-0.75, 0.1, 0.55], [-0.25, -0.35, 0.62], [0.35, -0.3, 0.6], [0.8, 0.1, 0.52], [0.05, 0.35, 0.6]] as const) { ctx.moveTo(x + dx * r + k * r, y + dy * r); ctx.arc(x + dx * r, y + dy * r, k * r, 0, Math.PI * 2); }
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#f6f2ff';
  for (const [dx, dy, k] of [[-0.75, 0.1, 0.55], [-0.25, -0.35, 0.62], [0.35, -0.3, 0.6], [0.8, 0.1, 0.52], [0.05, 0.35, 0.6]] as const) { ctx.beginPath(); ctx.arc(x + dx * r, y + dy * r, k * r - 1, 0, Math.PI * 2); ctx.fill(); }
  for (let i = 0; i < 3; i++) {
    const on = Math.floor(time / 330) % 4 > i;
    ctx.fillStyle = on ? '#3a3550' : '#c9c3dc'; ctx.beginPath(); ctx.arc(x + (i - 1) * r * 0.42, y, r * 0.13, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}
/** Writing the reply: a speech bubble whose lines fill in, with a blinking caret. */
function speech(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, age: number, time: number) {
  const w = r * 2.6, h = r * 1.9;
  ctx.save(); ctx.fillStyle = '#fffaf0'; ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.roundRect(x - w / 2, y - h / 2, w, h, r * 0.45); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x - w * 0.2, y + h / 2 - 1); ctx.lineTo(x - w * 0.34, y + h / 2 + r * 0.55); ctx.lineTo(x - w * 0.02, y + h / 2 - 1); ctx.fill();
  const typed = (age / 900) % 3.4, widths = [0.82, 0.66, 0.74];
  ctx.strokeStyle = '#6a6385'; ctx.lineWidth = Math.max(1, r * 0.16); ctx.lineCap = 'round';
  let caret = { x: x - w * 0.4, y: y - h * 0.25 };
  for (let i = 0; i < 3; i++) {
    const k = Math.max(0, Math.min(1, typed - i));
    if (k <= 0) break;
    const ly = y - h * 0.25 + i * h * 0.25, lx = x - w * 0.4, len = w * widths[i]! * k;
    ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(lx + len, ly); ctx.stroke();
    caret = { x: lx + len + r * 0.18, y: ly };
  }
  if (time % 800 < 480) { ctx.strokeStyle = '#d97757'; ctx.beginPath(); ctx.moveTo(caret.x, caret.y - r * 0.2); ctx.lineTo(caret.x, caret.y + r * 0.2); ctx.stroke(); }
  ctx.restore();
}
function zees(ctx: CanvasRenderingContext2D, x: number, y: number, u: number, time: number) {
  ctx.save(); ctx.fillStyle = '#cfe3ff'; ctx.textAlign = 'center';
  for (let i = 0; i < 3; i++) {
    const p = ((time / 1400) + i / 3) % 1;
    ctx.globalAlpha = Math.sin(p * Math.PI); ctx.font = `900 ${(5 + p * 5) * u}px Nunito Variable, system-ui`;
    ctx.fillText('z', x + p * 8 * u, y - p * 14 * u);
  }
  ctx.restore();
}

// Props (vector), drawn around a hand at (13, -12) body units -----------------------------------

function magnifier(ctx: CanvasRenderingContext2D, u: number, t: number) {
  const dx = Math.sin(t / 320) * 2 * u, cx = 12 * u + dx, cy = -21 * u;
  ctx.strokeStyle = '#7a4d33'; ctx.lineWidth = 2.6 * u; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(cx + 3.6 * u, cy + 3.6 * u); ctx.lineTo(cx + 7 * u, cy + 8 * u); ctx.stroke();
  ctx.fillStyle = 'rgba(175,220,255,0.45)'; ctx.strokeStyle = '#ece6d6'; ctx.lineWidth = 1.9 * u;
  ctx.beginPath(); ctx.arc(cx, cy, 5 * u, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1 * u; ctx.beginPath(); ctx.arc(cx, cy, 3.2 * u, Math.PI * 1.1, Math.PI * 1.55); ctx.stroke();
}
function notebook(ctx: CanvasRenderingContext2D, u: number, t: number) {
  ctx.save(); ctx.translate(8 * u, -15 * u); ctx.rotate(-0.18);
  ctx.fillStyle = '#f4ecd8'; ctx.strokeStyle = '#b8a47c'; ctx.lineWidth = 0.8 * u;
  ctx.beginPath(); ctx.roundRect(-5 * u, -6.5 * u, 10 * u, 13 * u, 1.5 * u); ctx.fill(); ctx.stroke();
  ctx.strokeStyle = '#c95f4a'; ctx.beginPath(); ctx.moveTo(-3.2 * u, -6.5 * u); ctx.lineTo(-3.2 * u, 6.5 * u); ctx.stroke();
  ctx.strokeStyle = '#9fb4cf'; ctx.lineWidth = 0.6 * u;
  for (let i = 0; i < 4; i++) { const w = i === 3 ? 2 + ((t / 120) % 5) : 6.5; ctx.beginPath(); ctx.moveTo(-2.2 * u, (-3.5 + i * 2.6) * u); ctx.lineTo((-2.2 + w) * u, (-3.5 + i * 2.6) * u); ctx.stroke(); }
  pencil(ctx, u, t, 2, 3);
  ctx.restore();
}
function pencil(ctx: CanvasRenderingContext2D, u: number, t: number, x: number, y: number) {
  const px = Math.sin(t / 85) * 1.8 * u, py = Math.cos(t / 130) * 1.2 * u;
  ctx.save(); ctx.translate(x * u + px, y * u + py); ctx.rotate(0.9);
  ctx.fillStyle = '#f2c94c'; ctx.fillRect(-1 * u, -9 * u, 2 * u, 8 * u);
  ctx.fillStyle = '#3a2a1a'; ctx.beginPath(); ctx.moveTo(-1 * u, -1 * u); ctx.lineTo(1 * u, -1 * u); ctx.lineTo(0, 1.5 * u); ctx.fill();
  ctx.fillStyle = '#e98a9a'; ctx.fillRect(-1 * u, -10.5 * u, 2 * u, 1.6 * u);
  ctx.restore();
}
function hammer(ctx: CanvasRenderingContext2D, u: number, t: number) {
  const swing = -0.9 + Math.abs(Math.sin(t / 110)) * 1.4;
  ctx.save(); ctx.translate(11 * u, -14 * u); ctx.rotate(swing);
  ctx.strokeStyle = '#8a5a3c'; ctx.lineWidth = 2.2 * u; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -11 * u); ctx.stroke();
  ctx.fillStyle = '#9aa3ad'; ctx.beginPath(); ctx.roundRect(-4.5 * u, -14 * u, 9 * u, 4.2 * u, 1 * u); ctx.fill();
  ctx.restore();
}
function eraser(ctx: CanvasRenderingContext2D, u: number, t: number) {
  const rub = Math.sin(t / 70) * 2.5 * u;
  ctx.save(); ctx.translate(12 * u + rub, -9 * u); ctx.rotate(-0.4);
  ctx.fillStyle = '#f08aa0'; ctx.beginPath(); ctx.roundRect(-4 * u, -3 * u, 8 * u, 6 * u, 1.5 * u); ctx.fill();
  ctx.fillStyle = '#4a7fd0'; ctx.fillRect(-4 * u, -3 * u, 3 * u, 6 * u);
  ctx.restore();
  ctx.fillStyle = 'rgba(255,255,255,0.6)'; for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.arc((14 + i * 2.5) * u + rub, (-3 + Math.sin(t / 50 + i) * 1.5) * u, 0.7 * u, 0, Math.PI * 2); ctx.fill(); }
}
/** Binoculars, centered on the face at `faceY`. */
function binoculars(ctx: CanvasRenderingContext2D, u: number, t: number, faceY: number) {
  const sway = Math.sin(t / 500) * 1.5 * u, y = faceY * u;
  ctx.fillStyle = '#26232e'; ctx.strokeStyle = '#4a4656'; ctx.lineWidth = 0.8 * u;
  for (const ex of [-3.4, 3.4]) { ctx.beginPath(); ctx.roundRect((ex - 2.8) * u + sway, y - 3.5 * u, 5.6 * u, 7 * u, 2 * u); ctx.fill(); ctx.stroke(); }
  ctx.fillStyle = 'rgba(140,210,255,0.8)';
  for (const ex of [-3.4, 3.4]) { ctx.beginPath(); ctx.arc(ex * u + sway, y + 1.9 * u, 1.6 * u, 0, Math.PI * 2); ctx.fill(); }
}
function laptop(ctx: CanvasRenderingContext2D, u: number, t: number, accent: string) {
  ctx.fillStyle = '#3b3846'; ctx.beginPath(); ctx.moveTo(3 * u, -1 * u); ctx.lineTo(19 * u, -1 * u); ctx.lineTo(17 * u, -4 * u); ctx.lineTo(5 * u, -4 * u); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#26232e'; ctx.beginPath(); ctx.roundRect(6 * u, -14 * u, 11 * u, 10 * u, 1.2 * u); ctx.fill();
  ctx.fillStyle = '#0d1420'; ctx.fillRect(7 * u, -13 * u, 9 * u, 8 * u);
  ctx.fillStyle = accent; ctx.font = `800 ${4.4 * u}px ui-monospace, monospace`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  ctx.fillText((t / 400) % 2 < 1 ? '>_' : '> ', 8 * u, -9 * u);
}
function flask(ctx: CanvasRenderingContext2D, u: number, t: number) {
  ctx.save(); ctx.translate(12 * u, -19 * u); ctx.rotate(Math.sin(t / 240) * 0.15);
  ctx.fillStyle = 'rgba(220,240,255,0.35)'; ctx.strokeStyle = '#e6eef7'; ctx.lineWidth = 1 * u;
  ctx.beginPath(); ctx.moveTo(-1.6 * u, -6 * u); ctx.lineTo(1.6 * u, -6 * u); ctx.lineTo(1.6 * u, -2 * u); ctx.lineTo(5 * u, 5 * u); ctx.lineTo(-5 * u, 5 * u); ctx.lineTo(-1.6 * u, -2 * u); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillStyle = 'hsl(140 70% 52%)'; ctx.beginPath(); ctx.moveTo(-3.3 * u, 1.6 * u); ctx.lineTo(3.3 * u, 1.6 * u); ctx.lineTo(4.6 * u, 4.5 * u); ctx.lineTo(-4.6 * u, 4.5 * u); ctx.closePath(); ctx.fill();
  ctx.fillStyle = 'rgba(210,255,220,0.9)';
  for (let i = 0; i < 3; i++) { const p = ((t / 700) + i / 3) % 1; ctx.globalAlpha = 1 - p; ctx.beginPath(); ctx.arc((i - 1) * 1.6 * u, (2 - p * 12) * u, (0.6 + p) * u, 0, Math.PI * 2); ctx.fill(); }
  ctx.restore();
}
/** Planning: a clipboard whose boxes get ticked one by one. */
function clipboard(ctx: CanvasRenderingContext2D, u: number, t: number) {
  ctx.save(); ctx.translate(9 * u, -17 * u); ctx.rotate(-0.12);
  ctx.fillStyle = '#8a5a3c'; ctx.beginPath(); ctx.roundRect(-6 * u, -8 * u, 12 * u, 16 * u, 1.5 * u); ctx.fill();
  ctx.fillStyle = '#f7f2e4'; ctx.fillRect(-4.8 * u, -6 * u, 9.6 * u, 13 * u);
  ctx.fillStyle = '#b8bec8'; ctx.beginPath(); ctx.roundRect(-2.5 * u, -9 * u, 5 * u, 2.6 * u, 0.8 * u); ctx.fill();
  const done = Math.floor(t / 650) % 5;
  for (let i = 0; i < 3; i++) {
    const y = (-3.3 + i * 3.6) * u;
    ctx.strokeStyle = '#6a6385'; ctx.lineWidth = 0.6 * u; ctx.strokeRect(-3.8 * u, y - 1 * u, 2 * u, 2 * u);
    ctx.beginPath(); ctx.moveTo(-0.8 * u, y); ctx.lineTo(3.4 * u, y); ctx.stroke();
    if (i < done) { ctx.strokeStyle = '#2fbf71'; ctx.lineWidth = 0.9 * u; ctx.beginPath(); ctx.moveTo(-3.6 * u, y); ctx.lineTo(-2.9 * u, y + 0.8 * u); ctx.lineTo(-1.5 * u, y - 1.3 * u); ctx.stroke(); }
  }
  ctx.restore();
}
/** On the web: a small turning globe on a stand. */
function globe(ctx: CanvasRenderingContext2D, u: number, t: number) {
  const cx = 13 * u, cy = -21 * u, r = 5.6 * u;
  ctx.save();
  ctx.strokeStyle = '#8a5a3c'; ctx.lineWidth = 1.2 * u; ctx.beginPath(); ctx.arc(cx, cy, r + 1.6 * u, Math.PI * 0.25, Math.PI * 1.05); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx, cy + r + 1.6 * u); ctx.lineTo(cx, cy + r + 4 * u); ctx.stroke();
  ctx.fillStyle = '#3d8bd9'; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.clip();
  const spin = (t / 1800) % 1;
  ctx.fillStyle = '#5cc27a';
  for (const [lon, lat, s] of [[0, -0.3, 0.45], [0.45, 0.35, 0.35], [0.75, -0.1, 0.3]] as const) {
    const x = ((lon + spin) % 1) * 2 - 1;
    ctx.beginPath(); ctx.ellipse(cx + x * r * 1.2, cy + lat * r, r * s * (1 - Math.abs(x) * 0.5), r * s * 0.7, 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 0.6 * u;
  for (const k of [-0.5, 0, 0.5]) { ctx.beginPath(); ctx.ellipse(cx, cy, r * Math.abs(Math.cos((spin + k) * Math.PI)), r, 0, 0, Math.PI * 2); ctx.stroke(); }
  ctx.restore(); ctx.restore();
}
function bench(ctx: CanvasRenderingContext2D, u: number) {
  ctx.fillStyle = '#6b4a35'; ctx.beginPath(); ctx.roundRect(-22 * u, -6 * u, 44 * u, 4 * u, 1 * u); ctx.fill();
  ctx.fillStyle = '#4e3526'; for (const x of [-18, 15]) ctx.fillRect(x * u, -2 * u, 3 * u, 2.6 * u);
}

// Bodies (vector) ---------------------------------------------------------------------------

interface Rig {
  /** Where props are held (body units), the face's height (binoculars), the head's top (bubbles), how far a sitter drops. */
  hand: { x: number; y: number }; faceY: number; top: number; sitDrop: number;
  draw(ctx: CanvasRenderingContext2D, u: number, look: Look, sit: boolean): void;
}
/** Clawd: the terminal banner's block mascot, one cell = 3 × 6 units. */
const CLAWD: Rig = {
  hand: { x: 24, y: -15 }, faceY: -21, top: -30, sitDrop: 6,
  draw(ctx, u, look, sit) {
    const t = look.time, pose = look.pose, body = PROVIDER['claude-code'].body, shade = '#bf6142', light = '#e8977a', eye = '#24140f';
    const box = (x0: number, y0: number, x1: number, y1: number, fill: string, r = 1) => { ctx.fillStyle = fill; ctx.beginPath(); ctx.roundRect(x0 * u, y0 * u, (x1 - x0) * u, (y1 - y0) * u, r * u); ctx.fill(); };
    if (!sit) {
      // Four legs; a walk or hop lifts them in pairs.
      const lift = look.stretch > 1.04 ? 2 : 0;
      for (const [x, k] of [[-15, 0], [-9, 1], [6, 0], [12, 1]] as const) box(x, -6, x + 3, k ? -lift : 0, shade, 0.6);
    } else if (pose === 'sit' || pose === 'sleep') for (const x of [-15, 12]) box(x, -6, x + 3, -2.5, shade, 0.6);
    // Left arm.
    box(-24, -18, -17, -12, body, 1.2);
    // Body: a wide block, lighter on top, darker at the base.
    box(-18, -30, 18, -6, body, 2.2);
    box(-17, -29.2, 17, -27, light, 1.2);
    box(-18, -9, 18, -6, shade, 1.6);
    // Eyes: two slits, closed while asleep or blinking, raised while thinking.
    const closed = pose === 'sleep' || blinking(t, look.seed), up = pose === 'think' ? -1.2 : 0;
    for (const x of [-12, 9]) closed ? box(x, -19.5, x + 3, -18, eye, 0.5) : box(x, -24 + up, x + 3, -18 + up, eye, 0.6);
    // Right arm: out to the side, raised (asking), or waving.
    if (pose === 'wait') box(18, -36, 24, -12, body, 1.2);
    else if (pose === 'wave') {
      ctx.save(); ctx.translate(18 * u, -15 * u); ctx.rotate(-1.2 + Math.sin(t / 110) * 0.55);
      box(0, -3, 8, 3, body, 1.2); ctx.restore();
    } else box(17, -18, 24, -12, body, 1.2);
  },
};
/** Codex: a blue cloud head with a terminal face, a small body with ">_" on its chest. */
const CLOUD: Rig = {
  hand: { x: 11, y: -10 }, faceY: -25, top: -41, sitDrop: 4,
  draw(ctx, u, look, sit) {
    const t = look.time, pose = look.pose, { body, dark, light, accent } = PROVIDER.codex;
    if (!sit) {
      const lift = look.stretch > 1.04 ? 1.6 : 0;
      ctx.fillStyle = dark;
      ctx.beginPath(); ctx.roundRect(-5.5 * u, -5.5 * u, 4 * u, (5.5 - lift) * u, 1.6 * u); ctx.roundRect(1.5 * u, -5.5 * u, 4 * u, 5.5 * u, 1.6 * u); ctx.fill();
    }
    // Arms.
    const raise = pose === 'wait' ? -1 : pose === 'wave' ? -0.6 + Math.sin(t / 110) * 0.5 : 0;
    ctx.fillStyle = dark;
    ctx.beginPath(); ctx.ellipse(-9.6 * u, -10 * u, 2.6 * u, 3.8 * u, 0.45, 0, Math.PI * 2); ctx.fill();
    ctx.save(); ctx.translate(8 * u, -12 * u); ctx.rotate(raise * 2.2);
    ctx.beginPath(); ctx.ellipse(1.8 * u, 2.2 * u, 2.6 * u, 3.8 * u, -0.45, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    // Body with its ">_".
    ctx.fillStyle = body; ctx.beginPath(); ctx.roundRect(-8 * u, -16 * u, 16 * u, 12 * u, 5 * u); ctx.fill();
    ctx.strokeStyle = dark; ctx.lineWidth = 1.1 * u; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(-3.2 * u, -11.8 * u); ctx.lineTo(-1.4 * u, -10.4 * u); ctx.lineTo(-3.2 * u, -9 * u); ctx.moveTo(0 * u, -9 * u); ctx.lineTo(2.8 * u, -9 * u); ctx.stroke();
    // The cloud: an outline pass, the fill, a highlight.
    const puffs: [number, number, number][] = [[0, -27, 11], [-9, -25, 7.5], [9, -25.5, 7.5], [-5.5, -33, 6.5], [5, -34, 7], [-11.5, -20.5, 5.5], [11.5, -20.5, 5.5], [0, -19, 9.5]];
    ctx.fillStyle = dark; ctx.beginPath(); for (const [x, y, r] of puffs) { ctx.moveTo((x + r + 0.9) * u, y * u); ctx.arc(x * u, y * u, (r + 0.9) * u, 0, Math.PI * 2); } ctx.fill();
    ctx.fillStyle = body; ctx.beginPath(); for (const [x, y, r] of puffs) { ctx.moveTo((x + r) * u, y * u); ctx.arc(x * u, y * u, r * u, 0, Math.PI * 2); } ctx.fill();
    ctx.fillStyle = light; ctx.globalAlpha *= 0.7; ctx.beginPath(); ctx.ellipse(-6 * u, -34.5 * u, 3.4 * u, 2 * u, -0.5, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha /= 0.7;
    // The screen and its face (never mirrored: ">_" reads the same whichever way it faces).
    ctx.save(); ctx.scale(look.facing, 1);
    ctx.fillStyle = '#0c1736'; ctx.beginPath(); ctx.roundRect(-9.5 * u, -31.5 * u, 19 * u, 12.5 * u, 4.5 * u); ctx.fill();
    ctx.strokeStyle = accent; ctx.lineWidth = 1.8 * u; ctx.shadowColor = accent; ctx.shadowBlur = 4 * u;
    const closed = pose === 'sleep' || blinking(t, look.seed);
    ctx.beginPath();
    if (closed) { ctx.moveTo(-6.5 * u, -24.5 * u); ctx.lineTo(-3 * u, -24.5 * u); }
    else if (pose === 'think') { ctx.moveTo(-6.5 * u, -27 * u); ctx.lineTo(-3.5 * u, -26.2 * u); ctx.lineTo(-6.5 * u, -24.4 * u); }
    else { ctx.moveTo(-6.3 * u, -28 * u); ctx.lineTo(-3 * u, -25 * u); ctx.lineTo(-6.3 * u, -22 * u); }
    if (pose === 'sleep' || (t / 530) % 2 < 1.3) { ctx.moveTo(0, -22.3 * u); ctx.lineTo(5.6 * u, -22.3 * u); }
    ctx.stroke(); ctx.shadowBlur = 0;
    ctx.restore();
  },
};
/** Bolt: a grey round robot with a visor (any other harness). */
const BOLT: Rig = {
  hand: { x: 13.5, y: -10 }, faceY: -18, top: -36, sitDrop: 3,
  draw(ctx, u, look, sit) {
    const { body, dark, accent } = PROVIDER.other, pose = look.pose;
    ctx.fillStyle = dark;
    if (!sit) for (const fx of [-5, 5]) { ctx.beginPath(); ctx.ellipse(fx * u, -1.8 * u, 3.8 * u, 2.2 * u, 0, 0, Math.PI * 2); ctx.fill(); }
    ctx.strokeStyle = dark; ctx.lineWidth = 3.4 * u; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-10 * u, -14 * u); ctx.lineTo(-13.5 * u, -8.5 * u); ctx.stroke();
    ctx.lineWidth = 1.2 * u; ctx.beginPath(); ctx.moveTo(0, -28 * u); ctx.lineTo(0, -33 * u); ctx.stroke();
    ctx.fillStyle = accent; ctx.beginPath(); ctx.arc(0, -34 * u, 2 * u, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = body; ctx.beginPath(); ctx.arc(0, -15.5 * u, 13 * u, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = dark; ctx.beginPath(); ctx.roundRect(-9 * u, -22 * u, 18 * u, 8 * u, 4 * u); ctx.fill();
    const closed = pose === 'sleep' || blinking(look.time, look.seed);
    ctx.fillStyle = '#e9f3ff';
    for (const ex of [-4, 4]) { ctx.beginPath(); closed ? ctx.rect((ex - 1.8) * u, -18.4 * u, 3.6 * u, 0.9 * u) : ctx.ellipse(ex * u, -18 * u, 1.9 * u, 2.4 * u, 0, 0, Math.PI * 2); ctx.fill(); }
    const up = pose === 'wait' ? [13, -33] : pose === 'wave' ? [10 + Math.cos(-1.9 + Math.sin(look.time / 110) * 0.5) * 10, -14 + Math.sin(-1.9 + Math.sin(look.time / 110) * 0.5) * 10] : [13.5, -9];
    ctx.strokeStyle = dark; ctx.lineWidth = 3.4 * u; ctx.beginPath(); ctx.moveTo(10 * u, -14 * u); ctx.lineTo(up[0]! * u, up[1]! * u); ctx.stroke();
  },
};
const RIGS: Record<Provider, Rig> = { 'claude-code': CLAWD, codex: CLOUD, other: BOLT };

/** A flat vector character with poses and props. */
export function drawBuddy(ctx: CanvasRenderingContext2D, x: number, y: number, look: Look) {
  const u = look.size / 40, t = look.time, pose = look.pose, rig = RIGS[look.provider], accent = PROVIDER[look.provider].accent;
  const sit = pose === 'sit' || pose === 'sleep' || pose === 'reply' || pose === 'plan';
  const breathe = pose === 'sleep' ? Math.sin(t / 700) * 0.03 : Math.sin(t / 420 + look.seed) * 0.02;
  ctx.save();
  ctx.globalAlpha = look.alpha;
  ctx.translate(x, y);
  if (pose === 'sit' || pose === 'sleep') { ctx.save(); bench(ctx, u); ctx.restore(); }
  ctx.scale(look.facing / Math.sqrt(look.stretch), look.stretch * (1 + breathe));
  if (sit) ctx.translate(0, (rig.sitDrop - (pose === 'sit' || pose === 'sleep' ? 6 : 0)) * u);
  rig.draw(ctx, u, look, sit);
  // A prop in the hand (props are drawn around a hand at (13, -12)).
  ctx.save(); ctx.translate((rig.hand.x - 13) * u, (rig.hand.y + 12) * u);
  if (pose === 'read') magnifier(ctx, u, t);
  if (pose === 'edit') notebook(ctx, u, t);
  if (pose === 'test') flask(ctx, u, t);
  if (pose === 'build') hammer(ctx, u, t);
  if (pose === 'erase') eraser(ctx, u, t);
  if (pose === 'plan') clipboard(ctx, u, t);
  if (pose === 'web') globe(ctx, u, t);
  ctx.restore();
  if (pose === 'command') { ctx.save(); ctx.translate((rig.hand.x - 13) * u, 0); laptop(ctx, u, t, accent); ctx.restore(); }
  if (pose === 'search') binoculars(ctx, u, t, rig.faceY);
  ctx.restore();
  // Bubbles stay upright.
  ctx.save(); ctx.globalAlpha = look.alpha;
  const top = y + rig.top * u * look.stretch;
  if (pose === 'wait') bubble(ctx, x + 14 * u * look.facing, top - 12 * u, 6 * u, '?', Math.max(0, Math.sin(t / 260)));
  if (pose === 'think') thought(ctx, x + 12 * u * look.facing, top - 13 * u, 9 * u, t);
  if (pose === 'reply') speech(ctx, x + 12 * u * look.facing, top - 12 * u, 8 * u, look.poseAge, t);
  if (pose === 'sleep') zees(ctx, x + 8 * u * look.facing, top - 2 * u, u, t);
  if (look.result && look.resultAge !== undefined && look.resultAge < 2600) resultBadge(ctx, x - 14 * u * look.facing, top - 6 * u, 5.5 * u, look.result, look.resultAge);
  ctx.restore();
}

// Pixel crew -----------------------------------------------------------------------------------

interface Sprite { rows: string[]; colors: Record<string, string>; hand: [number, number]; top: number }
// Clawd: the banner's 16 × 5 half-blocks with rows doubled (square pixels), shaded top and base.
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
  'claude-code': { rows: CLAWD_ROWS, colors: { B: '#d97757', A: '#d97757', R: '#d97757', T: '#e8977a', S: '#bf6142', L: '#bf6142', E: '#24140f' }, hand: [17, 4], top: 0 },
  codex: { rows: CODEX_ROWS, colors: { B: '#3e6ff4', A: '#2f58dc', R: '#2f58dc', L: '#86a6ff', D: '#2747c4', K: '#0c1736', C: '#9fe6ff', N: '#1b2f78' }, hand: [15, 14], top: 0 },
  other: { rows: BOLT_ROWS, colors: { B: '#9aa0aa', L: '#c4c9d1', D: '#4a4f58', W: '#e9f3ff', C: '#f2c94c' }, hand: [11, 8], top: 0 },
};
const PIXEL_PROPS: Partial<Record<Pose, { rows: string[]; colors: Record<string, string> }>> = {
  read: { rows: ['.WWW...', 'W...W..', 'W...W..', 'W...W..', '.WWW...', '....HH.', '.....HH'], colors: { W: '#e8e2d4', H: '#8a5a3c' } },
  edit: { rows: ['NNNNN..', 'NRNNN..', 'NRNNNY.', 'NRNNYY.', 'NRNYY..', 'NNNNN..', '.......'], colors: { N: '#f4ecd8', R: '#c95f4a', Y: '#f2c94c' } },
  command: { rows: ['KKKKKK.', 'KCCKKK.', 'KKKKKK.', 'KKKKKK.', 'DDDDDDD', '.......', '.......'], colors: { K: '#0d1420', C: '#4fe0f0', D: '#3b3846' } },
  test: { rows: ['..W....', '..W....', '.W.W...', 'W...W..', 'WGGGW..', '.WWW...', '.......'], colors: { W: '#e6eef7', G: '#3ddc84' } },
  plan: { rows: ['.HHH...', 'BPPPB..', 'BGPPB..', 'BPPPB..', 'BGPPB..', 'BPPPB..', 'BBBBB..'], colors: { H: '#b8bec8', B: '#8a5a3c', P: '#f7f2e4', G: '#2fbf71' } },
  web: { rows: ['.OOO...', 'OGOOO..', 'OGGOG..', 'OOOGG..', '.OOO...', '..H....', '.HHH...'], colors: { O: '#3d8bd9', G: '#5cc27a', H: '#8a5a3c' } },
  build: { rows: ['GGG....', 'GGG....', '.H.....', '.H.....', '.H.....', '.......', '.......'], colors: { G: '#9aa3ad', H: '#8a5a3c' } },
  erase: { rows: ['.......', '.......', 'PPPBB..', 'PPPBB..', '.......', '.......', '.......'], colors: { P: '#f08aa0', B: '#4a7fd0' } },
};
// Bubbles in pixels: thinking (a cloud with dots), writing (a speech bubble with lines), asking (?), binoculars.
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
/** The sprite's rows for a pose and an animation frame. */
function frameRows(provider: Provider, pose: Pose, walking: boolean, frame: number, time: number, seed: number): string[] {
  const rows = [...SPRITES[provider].rows];
  const sit = pose === 'sit' || pose === 'sleep' || pose === 'reply' || pose === 'plan';
  const closed = pose === 'sleep' || blinking(time, seed);
  if (provider === 'claude-code') {
    if (closed) { rows[2] = rows[2]!.replace(/E/g, 'B'); }
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
/** Pixel art from string matrices: 2-frame walk and bob, props and bubbles as pixel icons. */
export function drawPixel(ctx: CanvasRenderingContext2D, x: number, y: number, look: Look & { walking: boolean }) {
  const sprite = SPRITES[look.provider], p = pixelSize(look.provider, look.size);
  const frame = Math.floor(look.time / (look.walking ? 140 : 480)) % 2;
  const rows = frameRows(look.provider, look.pose, look.walking, frame, look.time, look.seed);
  const sit = look.pose === 'sit' || look.pose === 'sleep' || look.pose === 'reply' || look.pose === 'plan';
  const bob = !look.walking && frame && !sit ? p : 0;
  const w = rows[0]!.length * p, h = rows.length * p, x0 = x - w / 2, y0 = y - h + bob + (sit ? p : 0);
  ctx.save(); ctx.globalAlpha = look.alpha; ctx.imageSmoothingEnabled = false;
  if (look.pose === 'sit' || look.pose === 'sleep') pixels(ctx, ['BBBBBBBBBBBBBBBBBBBBBB', '.L..................L.'], { B: '#6b4a35', L: '#4e3526' }, x - 11 * p, y - 2 * p, p);
  if (look.facing < 0) { ctx.translate(x * 2, 0); ctx.scale(-1, 1); }
  pixels(ctx, rows, sprite.colors, x0, y0, p);
  const prop = PIXEL_PROPS[look.pose];
  // Props sit by the hand (the sprite's hand cell, two rows lower when an arm was raised).
  const handRow = sprite.hand[1] + (rows.length - sprite.rows.length);
  if (prop) pixels(ctx, prop.rows, prop.colors, x0 + sprite.hand[0] * p, y0 + (handRow - 4) * p, p);
  ctx.restore();
  if (look.provider === 'codex' && look.facing < 0) {
    // The screen again, unmirrored (">_" must not read "_<").
    ctx.save(); ctx.globalAlpha = look.alpha;
    pixels(ctx, rows.map((row, j) => (j >= 4 && j <= 10 ? row.replace(/[^KC]/g, '.') : '')), sprite.colors, x0, y0, p);
    ctx.restore();
  }
  if (look.pose === 'search') { ctx.save(); ctx.globalAlpha = look.alpha; pixels(ctx, BINO_ROWS, { K: '#26232e', G: '#8cd2ff' }, x0 + (rows[0]!.length / 2 - 3) * p, y0 + (look.provider === 'codex' ? 5 : look.provider === 'claude-code' ? 4 : 5) * p, p); ctx.restore(); }
  ctx.save(); ctx.globalAlpha = look.alpha; ctx.imageSmoothingEnabled = false;
  const bx = x + (look.facing > 0 ? w * 0.18 : -w * 0.18 - 12 * p), by = y0 - 9 * p;
  if (look.pose === 'think') {
    const dots = Math.floor(look.time / 330) % 4;
    pixels(ctx, THINK_ROWS, { W: '#f6f2ff', 1: dots > 0 ? '#3a3550' : '#c9c3dc', 2: dots > 1 ? '#3a3550' : '#c9c3dc', 3: dots > 2 ? '#3a3550' : '#c9c3dc' }, bx, by, p);
  }
  if (look.pose === 'reply') {
    const typed = (look.poseAge / 900) % 3.4;
    pixels(ctx, SPEAK_ROWS.map((row, j) => { const line = j === 2 ? 0 : j === 4 ? 1 : j === 6 ? 2 : -1; if (line < 0) return row; const k = Math.max(0, Math.min(1, typed - line)); const len = Math.round((row.match(/[123]/g)?.length ?? 0) * k); let seen = 0; return [...row].map(ch => (/[123]/.test(ch) ? (seen++ < len ? 'I' : 'W') : ch)).join(''); }), { W: '#fffaf0', I: '#6a6385' }, bx, by + p, p);
  }
  if (look.pose === 'wait') pixels(ctx, ASK_ROWS, { W: '#fffaf0', Q: '#1d1a26' }, x + (look.facing > 0 ? w * 0.25 : -w * 0.25 - 7 * p), y0 - 10 * p, p);
  ctx.restore();
  ctx.save(); ctx.globalAlpha = look.alpha;
  if (look.pose === 'sleep') zees(ctx, x + 4 * p, y0, p / 2.5, look.time);
  if (look.result && look.resultAge !== undefined && look.resultAge < 2600) resultBadge(ctx, x - (w / 2 + 2 * p) * look.facing, y0 - p, 3 * p, look.result, look.resultAge);
  ctx.restore();
}
/** Sparkles where a pixel clone pops in or out. */
export function sparkle(ctx: CanvasRenderingContext2D, x: number, y: number, age: number, color: string) {
  if (age > 500) return;
  ctx.save(); ctx.fillStyle = color; ctx.globalAlpha = 1 - age / 500;
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2, r = 6 + age / 22; ctx.fillRect(Math.round(x + Math.cos(a) * r), Math.round(y - 14 + Math.sin(a) * r * 0.7), 3, 3); }
  ctx.restore();
}
/** The character's face in pixels, fitted in a circle (pins, legends). */
export function drawFace(ctx: CanvasRenderingContext2D, provider: Provider, cx: number, cy: number, r: number, time = 0, seed = 0) {
  const rows = frameRows(provider, 'idle', false, 0, time, seed).filter(row => /[^.]/.test(row));
  const top = provider === 'codex' ? rows.slice(0, 13) : rows;
  const p = (r * 1.5) / Math.max(top[0]!.length, top.length);
  ctx.save(); ctx.imageSmoothingEnabled = false;
  pixels(ctx, top, SPRITES[provider].colors, cx - (top[0]!.length * p) / 2, cy - (top.length * p) / 2, p);
  ctx.restore();
}

// Pins -----------------------------------------------------------------------------------------

const ICONS: Partial<Record<Pose, (ctx: CanvasRenderingContext2D, r: number) => void>> = {
  read: (ctx, r) => { ctx.beginPath(); ctx.arc(-r * 0.15, -r * 0.15, r * 0.42, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.moveTo(r * 0.15, r * 0.15); ctx.lineTo(r * 0.55, r * 0.55); ctx.stroke(); },
  edit: (ctx, r) => { ctx.beginPath(); ctx.moveTo(-r * 0.5, r * 0.5); ctx.lineTo(-r * 0.35, r * 0.1); ctx.lineTo(r * 0.3, -r * 0.55); ctx.lineTo(r * 0.55, -r * 0.3); ctx.lineTo(-r * 0.1, r * 0.35); ctx.closePath(); ctx.stroke(); },
  search: (ctx, r) => { ctx.beginPath(); ctx.arc(-r * 0.3, 0, r * 0.28, 0, Math.PI * 2); ctx.arc(r * 0.3, 0, r * 0.28, 0, Math.PI * 2); ctx.stroke(); },
  command: (ctx, r) => { ctx.beginPath(); ctx.moveTo(-r * 0.5, -r * 0.35); ctx.lineTo(-r * 0.15, 0); ctx.lineTo(-r * 0.5, r * 0.35); ctx.moveTo(0, r * 0.4); ctx.lineTo(r * 0.5, r * 0.4); ctx.stroke(); },
  test: (ctx, r) => { ctx.beginPath(); ctx.moveTo(-r * 0.15, -r * 0.5); ctx.lineTo(-r * 0.15, -r * 0.1); ctx.lineTo(-r * 0.5, r * 0.45); ctx.lineTo(r * 0.5, r * 0.45); ctx.lineTo(r * 0.15, -r * 0.1); ctx.lineTo(r * 0.15, -r * 0.5); ctx.stroke(); },
  wait: (ctx, r) => { ctx.font = `900 ${r * 1.2}px Nunito Variable, system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('?', 0, r * 0.05); },
  sleep: (ctx, r) => { ctx.font = `900 ${r * 1.1}px Nunito Variable, system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('z', 0, 0); },
  wave: (ctx, r) => { ctx.font = `900 ${r}px Nunito Variable, system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('✓', 0, 0); },
  think: (ctx, r) => { for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.arc((i - 1) * r * 0.38, 0, r * 0.12, 0, Math.PI * 2); ctx.fill(); } },
  reply: (ctx, r) => { for (const [y, w] of [[-0.3, 0.9], [0, 0.7], [0.3, 0.8]] as const) { ctx.beginPath(); ctx.moveTo(-r * 0.45, y * r); ctx.lineTo(-r * 0.45 + w * r, y * r); ctx.stroke(); } },
  plan: (ctx, r) => { ctx.strokeRect(-r * 0.45, -r * 0.5, r * 0.9, r); for (const y of [-0.2, 0.15]) { ctx.beginPath(); ctx.moveTo(-r * 0.25, y * r); ctx.lineTo(r * 0.25, y * r); ctx.stroke(); } },
  web: (ctx, r) => { ctx.beginPath(); ctx.arc(0, 0, r * 0.5, 0, Math.PI * 2); ctx.moveTo(-r * 0.5, 0); ctx.lineTo(r * 0.5, 0); ctx.ellipse(0, 0, r * 0.22, r * 0.5, 0, 0, Math.PI * 2); ctx.stroke(); },
};
/** A calm token on a pin: the character's face on a dark disc ringed in the session's color, an icon badge for what it is doing. */
export function drawPin(ctx: CanvasRenderingContext2D, x: number, y: number, look: Look) {
  const r = look.size * 0.36, rest = look.pose === 'sit' || look.pose === 'sleep' || look.pose === 'idle';
  const k = rest ? 0.86 : 1, top = y - look.size * 0.95 * k;
  ctx.save(); ctx.globalAlpha = look.alpha * (look.pose === 'sleep' ? 0.7 : 1);
  ctx.strokeStyle = look.color; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, top + r); ctx.stroke();
  ctx.fillStyle = look.color; ctx.beginPath(); ctx.ellipse(x, y, 3.5, 1.8, 0, 0, Math.PI * 2); ctx.fill();
  if (look.pose === 'wait') { const pulse = (look.time % 900) / 900; ctx.strokeStyle = '#fff3c4'; ctx.globalAlpha = look.alpha * (1 - pulse); ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, top, r * (1.1 + pulse * 0.8), 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = look.alpha; }
  ctx.fillStyle = '#141826'; ctx.strokeStyle = look.color; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(x, top, r * k, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  drawFace(ctx, look.provider, x, top, r * k * 0.95, look.time, look.seed);
  const icon = ICONS[look.pose];
  if (icon) {
    const bx = x + r * 0.95, by = top - r * 0.8, br = r * 0.6;
    ctx.fillStyle = '#fffaf0'; ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#1d1a26'; ctx.fillStyle = '#1d1a26'; ctx.lineWidth = 1.6; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.save(); ctx.translate(bx, by); icon(ctx, br); ctx.restore();
  }
  ctx.restore();
  if (look.result && look.resultAge !== undefined && look.resultAge < 2600) resultBadge(ctx, x - r * 0.95, top - r * 0.8, r * 0.55, look.result, look.resultAge);
}

/** Where an agent goes to do what is about no file: a mat on the ground outside the map, in its session's color. */
export function drawYard(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string, alpha: number) {
  ctx.save(); ctx.globalAlpha = alpha;
  const w = size * 1.25, h = size * 0.42;
  ctx.fillStyle = 'rgba(70,74,96,0.55)'; ctx.beginPath(); ctx.moveTo(x - w, y); ctx.lineTo(x, y - h); ctx.lineTo(x + w, y); ctx.lineTo(x, y + h); ctx.closePath(); ctx.fill();
  ctx.fillStyle = 'rgba(40,42,58,0.9)'; ctx.beginPath(); ctx.moveTo(x - w, y); ctx.lineTo(x, y + h); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + 3); ctx.lineTo(x, y + h + 3); ctx.lineTo(x - w, y + 3); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = color; ctx.lineWidth = 1.4; ctx.setLineDash([4, 3]);
  ctx.beginPath(); ctx.moveTo(x - w, y); ctx.lineTo(x, y - h); ctx.lineTo(x + w, y); ctx.lineTo(x, y + h); ctx.closePath(); ctx.stroke();
  ctx.restore();
}

/** A person (commit author): a simple bust with initials, in their color. */
export function drawPerson(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, initials: string, hue: number, pose: Pose, time: number, alpha = 1) {
  const u = size / 40;
  ctx.save(); ctx.globalAlpha = alpha; ctx.translate(x, y);
  ctx.fillStyle = `hsl(${hue} 45% 42%)`; ctx.beginPath(); ctx.roundRect(-10 * u, -20 * u, 20 * u, 19 * u, [9 * u, 9 * u, 3 * u, 3 * u]); ctx.fill();
  ctx.fillStyle = `hsl(${hue} 50% 72%)`; ctx.beginPath(); ctx.arc(0, -27 * u, 8.5 * u, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#1b1a26'; ctx.font = `900 ${8 * u}px Nunito Variable, system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(initials, 0, -26.5 * u);
  if (pose === 'build') hammer(ctx, u, time);
  if (pose === 'erase') eraser(ctx, u, time);
  if (pose === 'edit') notebook(ctx, u, time);
  ctx.restore();
}
