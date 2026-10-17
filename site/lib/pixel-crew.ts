// The map's agent characters for the landing page's demo: a copy of Clawd and the Codex cloud from
// web/lib/pixel-crew.ts (the site is a separate package), with the props and bubbles the demo plays. Keep the two in
// step when the characters change. The origin of a character is its feet; the session's color is the small square
// over its head, as in the app.
export type Who = 'claude' | 'codex';
export type Pose = 'idle' | 'read' | 'edit' | 'search' | 'test' | 'think' | 'reply';

interface Sprite { rows: string[]; colors: Record<string, string>; hand: [number, number] }
const SPRITES: Record<Who, Sprite> = {
  // Clawd: the banner's 16 × 5 half-blocks with rows doubled (square pixels), a lighter top and a shaded base.
  claude: {
    rows: [
      '...TTTTTTTTTTTT...', '...BBBBBBBBBBBB...', '...BBEBBBBBBEBB...', '...BBEBBBBBBEBB...', '.AABBBBBBBBBBBBRR.',
      '.AABBBBBBBBBBBBRR.', '...BBBBBBBBBBBB...', '...SSSSSSSSSSSS...', '....L.L....L.L....', '....L.L....L.L....',
    ],
    colors: { B: '#d97757', A: '#d97757', R: '#d97757', T: '#e8977a', S: '#bf6142', L: '#bf6142', E: '#24140f' },
    hand: [17, 4],
  },
  // Codex: a cloud head with a dark screen showing ">_", a small body with ">_" on its chest, arms and legs.
  codex: {
    rows: [
      '.....LLL..LLL.....', '...LLBBBLLBBBL....', '..LBBBBBBBBBBBBL..', '.LBBBBBBBBBBBBBBB.', '.BBKKKKKKKKKKKKBB.',
      'BBKKCCKKKKKKKKKKBB', 'BBKKKCCKKKKKKKKKBB', 'BBKKKKCCKKKKKKKKBB', 'BBKKKCCKKKKKKKKKBB', 'BBKKCCKKKCCCCKKKBB',
      '.BBKKKKKKKKKKKKBB.', '.DBBBBBBBBBBBBBBD.', '..DDBBBBBBBBBBDD..', '.....DBBBBBBD.....', '....ABBBBBBBBR....',
      '...AABNBBBBBBRR...', '...AABBNNBBBBRR...', '.....BBBBBBBB.....', '.....LL....LL.....', '.....DD....DD.....',
    ],
    colors: { B: '#3e6ff4', A: '#2f58dc', R: '#2f58dc', L: '#86a6ff', D: '#2747c4', K: '#0c1736', C: '#9fe6ff', N: '#1b2f78' },
    hand: [15, 14],
  },
};
const PROPS: Partial<Record<Pose, { rows: string[]; colors: Record<string, string> }>> = {
  read: { rows: ['.WWW...', 'W...W..', 'W...W..', 'W...W..', '.WWW...', '....HH.', '.....HH'], colors: { W: '#e8e2d4', H: '#8a5a3c' } },
  edit: { rows: ['NNNNN..', 'NRNNN..', 'NRNNNY.', 'NRNNYY.', 'NRNYY..', 'NNNNN..', '.......'], colors: { N: '#f4ecd8', R: '#c95f4a', Y: '#f2c94c' } },
  test: { rows: ['..W....', '..W....', '.W.W...', 'W...W..', 'WGGGW..', '.WWW...', '.......'], colors: { W: '#e6eef7', G: '#3ddc84' } },
};
const THINK_ROWS = ['..WWWW.WWW..', '.WWWWWWWWWW.', 'WWWWWWWWWWWW', 'WW1WW2WW3WWW', 'WWWWWWWWWWWW', '.WWWWWWWWWW.', '..WW..WWW...', '............', '.W..........', '............', 'W...........'];
const SPEAK_ROWS = ['.WWWWWWWWWW.', 'WWWWWWWWWWWW', 'WW11111111WW', 'WWWWWWWWWWWW', 'WW222222WWWW', 'WWWWWWWWWWWW', 'WW3333333WWW', '.WWWWWWWWWW.', '..WW........', '.W..........'];
const BINO_ROWS = ['KK..KK', 'KK..KK', 'GKKKKG'];

function pixels(ctx: CanvasRenderingContext2D, rows: string[], colors: Record<string, string>, x: number, y: number, p: number) {
  rows.forEach((row, j) => [...row].forEach((ch, i) => {
    const color = colors[ch];
    if (ch === '.' || !color) return;
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x + i * p), Math.round(y + j * p), Math.ceil(p), Math.ceil(p));
  }));
}

/** The sprite's rows for an animation frame: blinking, and the legs while it hops. */
function frameRows(who: Who, walking: boolean, frame: number, time: number, seed: number): string[] {
  const rows = [...SPRITES[who].rows];
  const closed = (time + seed * 977) % 3900 < 130;
  if (who === 'claude') {
    if (closed) rows[2] = rows[2]!.replace(/E/g, 'B');
    if (walking && frame) { rows[8] = '....L.L....L.L....'; rows[9] = '......L......L....'; }
    return rows;
  }
  if (closed) { rows[5] = rows[6] = rows[8] = 'BBKKKKKKKKKKKKKKBB'; rows[7] = 'BBKKCCCCKKKKKKKKBB'; rows[9] = 'BBKKKKKKKCCCCKKKBB'; }
  if (walking && frame) { rows[18] = '.....LL.....LL....'; rows[19] = '.....DD.....DD....'; }
  return rows;
}

export interface Look { who: Who; color: string; size: number; pose: Pose; facing: 1 | -1; time: number; alpha: number; walking: boolean; seed: number; poseAge: number }

/** A soft shadow on the ground (smaller while the character is in the air). */
export function drawShadow(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, height: number, alpha = 1) {
  const k = Math.max(0.35, 1 - height / (size * 2.2));
  ctx.save(); ctx.globalAlpha = 0.3 * alpha * k; ctx.fillStyle = '#000';
  ctx.beginPath(); ctx.ellipse(x, y, size * 0.4 * k, size * 0.12 * k, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

/** A character with its prop by the hand, its bubble beside its head, and its session's square over it. */
export function drawCharacter(ctx: CanvasRenderingContext2D, x: number, y: number, look: Look) {
  const sprite = SPRITES[look.who], p = Math.max(2, Math.round(look.size / (look.who === 'claude' ? 15 : 19)));
  const frame = Math.floor(look.time / (look.walking ? 140 : 480)) % 2;
  const rows = frameRows(look.who, look.walking, frame, look.time, look.seed);
  const bob = !look.walking && frame ? p : 0;
  const w = rows[0]!.length * p, h = rows.length * p, x0 = x - w / 2, y0 = y - h + bob;
  ctx.save(); ctx.globalAlpha = look.alpha; ctx.imageSmoothingEnabled = false;
  if (look.facing < 0) { ctx.translate(x * 2, 0); ctx.scale(-1, 1); }
  pixels(ctx, rows, sprite.colors, x0, y0, p);
  const prop = PROPS[look.pose];
  if (prop) pixels(ctx, prop.rows, prop.colors, x0 + sprite.hand[0] * p, y0 + (sprite.hand[1] - 4) * p, p);
  ctx.restore();
  ctx.save(); ctx.globalAlpha = look.alpha; ctx.imageSmoothingEnabled = false;
  if (look.who === 'codex' && look.facing < 0) pixels(ctx, rows.map((row, j) => (j >= 4 && j <= 10 ? row.replace(/[^KC]/g, '.') : '')), sprite.colors, x0, y0, p);
  if (look.pose === 'search') pixels(ctx, BINO_ROWS, { K: '#26232e', G: '#8cd2ff' }, x0 + (rows[0]!.length / 2 - 3) * p, y0 + (look.who === 'claude' ? 2 : 5) * p, p);
  const bx = x + (look.facing > 0 ? w * 0.18 : -w * 0.18 - 12 * p), by = y0 - 9 * p;
  if (look.pose === 'think') {
    const dots = Math.floor(look.time / 330) % 4, dot = (n: number) => (dots > n ? '#3a3550' : '#c9c3dc');
    pixels(ctx, THINK_ROWS, { W: '#f6f2ff', 1: dot(0), 2: dot(1), 3: dot(2) }, bx, by, p);
  }
  if (look.pose === 'reply') {
    const typed = (look.poseAge / 700) % 3.4;
    pixels(ctx, SPEAK_ROWS.map((row, j) => {
      const line = j === 2 ? 0 : j === 4 ? 1 : j === 6 ? 2 : -1;
      if (line < 0) return row;
      const length = Math.round((row.match(/[123]/g)?.length ?? 0) * Math.max(0, Math.min(1, typed - line)));
      let seen = 0;
      return [...row].map(ch => (/[123]/.test(ch) ? (seen++ < length ? 'I' : 'W') : ch)).join('');
    }), { W: '#fffaf0', I: '#6a6385' }, bx, by + p, p);
  }
  // The session's square, just over the head.
  const side = Math.max(4, Math.round(p * 2.5)), top = y0 + (rows.findIndex(row => /[^.]/.test(row)) - 1) * p;
  ctx.fillStyle = 'rgba(12, 14, 22, 0.75)'; ctx.fillRect(Math.round(x - side / 2) - 1, Math.round(top - side) - 1, side + 2, side + 2);
  ctx.fillStyle = look.color; ctx.fillRect(Math.round(x - side / 2), Math.round(top - side), side, side);
  ctx.restore();
}

/** Sparkles where a copy pops out of a character or back into it. */
export function sparkle(ctx: CanvasRenderingContext2D, x: number, y: number, age: number, color: string) {
  if (age < 0 || age > 500) return;
  ctx.save(); ctx.fillStyle = color; ctx.globalAlpha *= 1 - age / 500;
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2, r = 6 + age / 22; ctx.fillRect(Math.round(x + Math.cos(a) * r), Math.round(y - 14 + Math.sin(a) * r * 0.7), 3, 3); }
  ctx.restore();
}
