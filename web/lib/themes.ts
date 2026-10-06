// Visual themes. A theme is data only: the renderer and CSS read colors from it,
// so adding a theme never touches drawing code.
export interface Hsl { h: number; s: number; l: number }
export interface Theme {
  id: string; name: string; dark: boolean;
  background: [string, string];
  grid: string;
  /** Base color per entity/projection type; walls and depth tints derive from it. */
  entity: Record<string, Hsl>;
  fallbackEntity: Hsl;
  /** Lightness change per spatial depth level, so nested districts stay distinguishable. */
  depthStep: number;
  wallShade: [left: number, right: number];
  outline: string;
  text: { primary: string; secondary: string; halo: string; district: string };
  selection: string; hover: string; focusRing: string;
  relation: Record<string, string>; fallbackRelation: string;
  flow: { step: string; declared: string; indicator: string; dimAlpha: number };
  diagnostic: string;
  dimAlpha: number;
  /** Comparison views: added / removed (ghosts) / modified / moved, and how strongly unchanged and removed blocks fade. */
  change: { added: string; removed: string; modified: string; moved: string; ghostAlpha: number; unchangedAlpha: number };
  /** Blast radius: the origin's ring, and the tint from the nearest to the farthest hop (#rrggbb). Absent: renderer defaults. */
  impact?: { origin: string; near: string; far: string };
  /** CSS custom properties for panels and controls. */
  ui: Record<string, string>;
  /** Shape and surface treatment. Absent: sharp blocks on a line grid, panels docked edge to edge. */
  style?: ThemeStyle;
}
export interface ThemeStyle {
  /** Corner radius of block footprints as a fraction of their shorter side (0: sharp corners). */
  rounding: number;
  grid: 'lines' | 'dots';
  /** Soft color fields over the background, in viewport fractions (radius relative to the larger side). */
  glows?: { x: number; y: number; r: number; color: string }[];
  /** Shadow that blocks cast onto what they stand on. */
  shadow?: string;
  /** Strength (0..1) of the highlight across top faces. */
  sheen?: number;
  /** Map labels; the panels read it from the `--font` custom property. */
  font?: string;
  /** Panels float as rounded cards over a backdrop (`--app-bg`) instead of docking edge to edge. */
  floating?: boolean;
}
const hsl = (h: number, s: number, l: number): Hsl => ({ h, s, l });
const ROUNDED_FONT = '"Nunito Variable", Nunito, ui-rounded, "SF Pro Rounded", system-ui, sans-serif';
/** Files colored by language (palette key `file:<language>`); other themes color every file alike. */
function fileLanguages(l: number, s = 0): Record<string, Hsl> {
  const tone = (h: number, saturation: number, lightness = l) => hsl(h, Math.max(0, Math.min(100, saturation + s)), lightness);
  return {
    'file:typescript': tone(222, 92), 'file:javascript': tone(46, 96, l + 4), 'file:php': tone(268, 78, l + 2), 'file:scss': tone(326, 88, l + 2), 'file:css': tone(198, 88, l + 2),
    'file:json': tone(28, 96, l + 2), 'file:markdown': tone(250, 40, l + 10), 'file:html': tone(8, 88, l + 2), 'file:xml': tone(172, 62, l - 4), 'file:yaml': tone(92, 64, l - 2),
    // Hues apart from the web languages above, which appear beside every other; languages that seldom share a repository may share a hue.
    'file:python': tone(140, 62), 'file:go': tone(186, 86), 'file:rust': tone(22, 58, l - 8), 'file:java': tone(6, 72, l - 4), 'file:kotlin': tone(284, 80),
    'file:scala': tone(348, 78), 'file:csharp': tone(120, 58, l - 6), 'file:fsharp': tone(300, 70), 'file:vbnet': tone(236, 50), 'file:ruby': tone(354, 82, l - 2),
    'file:erb': tone(354, 56, l + 8), 'file:c': tone(212, 28), 'file:cpp': tone(336, 80), 'file:objective-c': tone(198, 46, l - 6), 'file:swift': tone(14, 94),
    'file:vue': tone(156, 70), 'file:svelte': tone(18, 100, l + 2), 'file:astro': tone(292, 86, l + 2), 'file:liquid': tone(80, 70), 'file:razor': tone(276, 60),
  };
}
export const THEMES: Theme[] = [
  {
    id: 'midnight', name: 'Midnight', dark: true,
    background: ['#0b1020', '#111a33'], grid: 'rgba(120,150,255,0.05)',
    entity: {
      repository: hsl(225, 25, 16), application: hsl(222, 32, 24), 'application:laravel': hsl(356, 30, 26), 'application:nextjs': hsl(206, 38, 25), group: hsl(268, 30, 30), directory: hsl(214, 26, 31),
      file: hsl(196, 45, 46), class: hsl(150, 45, 46), controller: hsl(28, 75, 54), component: hsl(286, 52, 60),
      function: hsl(170, 50, 46), method: hsl(48, 70, 55), route: hsl(330, 65, 60), api_endpoint: hsl(350, 72, 62),
      model: hsl(100, 45, 48), database_table: hsl(40, 40, 50), command: hsl(192, 62, 52), scheduled_task: hsl(204, 58, 48),
    },
    fallbackEntity: hsl(210, 10, 50), depthStep: 3.2, wallShade: [0.55, 0.72], outline: 'rgba(0,0,0,0.35)',
    text: { primary: '#eef2ff', secondary: '#9fb0d6', halo: 'rgba(8,12,26,0.85)', district: '#c9d5ff' },
    selection: '#ffd166', hover: '#7dd3fc', focusRing: '#ffd166',
    relation: { imports: '#60a5fa', exports: '#34d399', handles: '#f97316', routes_to: '#f472b6', requests: '#facc15', extends: '#a78bfa', implements: '#a78bfa', calls: '#22d3ee', renders: '#e879f9', reads: '#4ade80', writes: '#fb7185', queries: '#4ade80', maps_to: '#fbbf24', foreign_key: '#fbbf24', references: '#2dd4bf', invokes: '#c084fc' },
    impact: { origin: '#38bdf8', near: '#f87171', far: '#fbbf24' },
    fallbackRelation: '#cbd5e1',
    flow: { step: '#ffd166', declared: '#94a3b8', indicator: '#fff7d6', dimAlpha: 0.18 },
    diagnostic: '#fbbf24', dimAlpha: 0.32,
    change: { added: '#4ade80', removed: '#fb7185', modified: '#fbbf24', moved: '#c084fc', ghostAlpha: 0.4, unchangedAlpha: 0.42 },
    ui: {
      '--bg': '#0b1020', '--panel': 'rgba(16,22,42,0.94)', '--panel-solid': '#10162a', '--panel-border': 'rgba(148,163,214,0.16)',
      '--text': '#e7ecff', '--muted': '#93a3c8', '--subtle': '#64729a', '--accent': '#ffd166', '--accent-ink': '#1b1400', '--link': '#93c5fd',
      '--chip': 'rgba(148,163,214,0.12)', '--chip-active': 'rgba(255,209,102,0.22)', '--warning': '#fbbf24', '--danger': '#f87171', '--ok': '#4ade80',
      '--code-bg': '#0a0f1e', '--code-highlight': 'rgba(255,209,102,0.13)', '--code-evidence': 'rgba(96,165,250,0.18)', '--shadow': '0 12px 40px rgba(0,0,0,0.45)',
      '--added': '#4ade80', '--removed': '#fb7185', '--modified': '#fbbf24', '--moved': '#c084fc', '--diff-added': 'rgba(74,222,128,0.13)', '--diff-removed': 'rgba(251,113,133,0.13)',
    },
  },
  {
    id: 'paper', name: 'Paper', dark: false,
    background: ['#f4f1ea', '#e9e4d8'], grid: 'rgba(60,50,30,0.05)',
    entity: {
      repository: hsl(40, 18, 86), application: hsl(38, 22, 80), 'application:laravel': hsl(8, 34, 84), 'application:nextjs': hsl(205, 30, 84), group: hsl(268, 25, 80), directory: hsl(205, 22, 78),
      file: hsl(199, 50, 62), class: hsl(150, 40, 58), controller: hsl(26, 78, 60), component: hsl(286, 45, 66),
      function: hsl(170, 42, 55), method: hsl(45, 80, 58), route: hsl(330, 60, 64), api_endpoint: hsl(352, 66, 62),
      model: hsl(100, 40, 55), database_table: hsl(40, 40, 60), command: hsl(192, 62, 52), scheduled_task: hsl(204, 58, 48),
    },
    fallbackEntity: hsl(210, 10, 70), depthStep: -2.6, wallShade: [0.72, 0.84], outline: 'rgba(40,30,10,0.22)',
    text: { primary: '#1d1a14', secondary: '#5e5646', halo: 'rgba(250,247,240,0.9)', district: '#3a3324' },
    selection: '#d9480f', hover: '#1c7ed6', focusRing: '#d9480f',
    relation: { imports: '#1c7ed6', exports: '#2b8a3e', handles: '#d9480f', routes_to: '#c2255c', requests: '#e67700', extends: '#7048e8', implements: '#7048e8', calls: '#0c8599', renders: '#ae3ec9', reads: '#2f9e44', writes: '#e03131', queries: '#2f9e44', maps_to: '#f08c00', foreign_key: '#e8590c', references: '#0b7285', invokes: '#c084fc' },
    impact: { origin: '#1864ab', near: '#c92a2a', far: '#e67700' },
    fallbackRelation: '#495057',
    flow: { step: '#d9480f', declared: '#868e96', indicator: '#fff4e6', dimAlpha: 0.22 },
    diagnostic: '#e67700', dimAlpha: 0.38,
    change: { added: '#2b8a3e', removed: '#c92a2a', modified: '#d97706', moved: '#7048e8', ghostAlpha: 0.42, unchangedAlpha: 0.5 },
    ui: {
      '--bg': '#f4f1ea', '--panel': 'rgba(255,253,248,0.95)', '--panel-solid': '#fffdf8', '--panel-border': 'rgba(60,50,30,0.14)',
      '--text': '#1d1a14', '--muted': '#5e5646', '--subtle': '#8a8170', '--accent': '#d9480f', '--accent-ink': '#ffffff', '--link': '#1864ab',
      '--chip': 'rgba(60,50,30,0.07)', '--chip-active': 'rgba(217,72,15,0.14)', '--warning': '#b35c00', '--danger': '#c92a2a', '--ok': '#2b8a3e',
      '--code-bg': '#fbf8f1', '--code-highlight': 'rgba(217,72,15,0.12)', '--code-evidence': 'rgba(28,126,214,0.13)', '--shadow': '0 12px 32px rgba(60,50,30,0.16)',
      '--added': '#2b8a3e', '--removed': '#c92a2a', '--modified': '#b45309', '--moved': '#7048e8', '--diff-added': 'rgba(43,138,62,0.12)', '--diff-removed': 'rgba(201,42,42,0.10)',
    },
  },
  {
    // Playful and minimal: soft pastel backdrop, rounded candy-colored blocks, floating glass panels.
    id: 'sorbet', name: 'Sorbet', dark: false,
    background: ['#fdfaff', '#f5f0ff'], grid: 'rgba(110,90,170,0.22)',
    entity: {
      repository: hsl(262, 70, 98), application: hsl(258, 70, 95), 'application:laravel': hsl(334, 100, 95), 'application:nextjs': hsl(216, 100, 95), group: hsl(44, 100, 91), directory: hsl(256, 60, 93),
      file: hsl(250, 26, 80), ...fileLanguages(66), class: hsl(86, 72, 54), controller: hsl(26, 100, 62), component: hsl(326, 92, 64),
      function: hsl(176, 66, 48), method: hsl(44, 100, 60), route: hsl(268, 86, 68), api_endpoint: hsl(350, 94, 66),
      model: hsl(140, 58, 52), database_table: hsl(36, 92, 62), command: hsl(192, 62, 52), scheduled_task: hsl(204, 58, 48),
    },
    fallbackEntity: hsl(250, 20, 82), depthStep: -2, wallShade: [0.86, 0.93], outline: 'rgba(90,70,150,0.10)',
    text: { primary: '#2b2540', secondary: '#6d6690', halo: 'rgba(255,255,255,0.9)', district: '#4b4180' },
    selection: '#ff3d8b', hover: '#3d6bff', focusRing: '#ff3d8b',
    relation: { imports: '#3d6bff', exports: '#16b981', handles: '#ff7a1a', routes_to: '#ff3d8b', requests: '#f5a300', extends: '#8b5cf6', implements: '#8b5cf6', calls: '#06b6d4', renders: '#d946ef', reads: '#22c55e', writes: '#f43f5e', queries: '#22c55e', maps_to: '#f59e0b', foreign_key: '#fb923c', references: '#14b8a6', invokes: '#c084fc' },
    impact: { origin: '#3d6bff', near: '#ff3d8b', far: '#ffb000' },
    fallbackRelation: '#7c7699',
    flow: { step: '#ff3d8b', declared: '#a39dbd', indicator: '#ffffff', dimAlpha: 0.22 },
    diagnostic: '#f59e0b', dimAlpha: 0.36,
    change: { added: '#1fc46f', removed: '#ff4d6d', modified: '#ffa31a', moved: '#8b5cf6', ghostAlpha: 0.42, unchangedAlpha: 0.5 },
    ui: {
      '--bg': '#faf7ff', '--app-bg': 'radial-gradient(1100px 650px at 0% 0%, #ffe2d1 0%, rgba(255,226,209,0) 60%), radial-gradient(1000px 750px at 100% 20%, #e3dbff 0%, rgba(227,219,255,0) 62%), radial-gradient(900px 600px at 45% 100%, #ffdff0 0%, rgba(255,223,240,0) 60%), #faf7ff',
      '--panel': 'rgba(255,255,255,0.74)', '--panel-solid': '#ffffff', '--panel-border': 'rgba(110,90,180,0.14)',
      '--text': '#2b2540', '--muted': '#6d6690', '--subtle': '#a29cbd', '--accent': '#ff3d8b', '--accent-ink': '#ffffff', '--link': '#3d6bff',
      '--chip': 'rgba(110,90,180,0.07)', '--chip-active': 'rgba(255,61,139,0.13)', '--warning': '#d97706', '--danger': '#e11d48', '--ok': '#16a34a',
      '--code-bg': '#fdfbff', '--code-highlight': 'rgba(255,61,139,0.10)', '--code-evidence': 'rgba(61,107,255,0.12)', '--shadow': '0 16px 44px rgba(96,64,170,0.14), 0 2px 6px rgba(96,64,170,0.06)',
      '--added': '#12a05a', '--removed': '#e5385a', '--modified': '#d97a00', '--moved': '#7c4dff', '--diff-added': 'rgba(31,196,111,0.13)', '--diff-removed': 'rgba(255,77,109,0.12)',
      '--font': ROUNDED_FONT, '--radius': '999px', '--radius-card': '18px', '--blur': '18px',
    },
    style: {
      rounding: 0.2, grid: 'dots', shadow: 'rgba(91,61,160,0.13)', sheen: 0.35, font: ROUNDED_FONT, floating: true,
      glows: [{ x: 0.04, y: 0, r: 0.75, color: 'rgba(255,214,190,0.75)' }, { x: 0.98, y: 0.25, r: 0.7, color: 'rgba(214,200,255,0.8)' }, { x: 0.45, y: 1.05, r: 0.6, color: 'rgba(255,200,232,0.6)' }, { x: 0.86, y: 0.96, r: 0.35, color: 'rgba(200,245,225,0.45)' }],
    },
  },
  {
    id: 'sorbet-night', name: 'Sorbet Night', dark: true,
    background: ['#171230', '#0f0c20'], grid: 'rgba(200,180,255,0.14)',
    entity: {
      repository: hsl(256, 34, 14), application: hsl(256, 34, 19), 'application:laravel': hsl(332, 46, 21), 'application:nextjs': hsl(224, 52, 21), group: hsl(44, 40, 21), directory: hsl(256, 28, 25),
      file: hsl(250, 18, 46), ...fileLanguages(62, 4), class: hsl(86, 80, 56), controller: hsl(26, 100, 62), component: hsl(326, 95, 66),
      function: hsl(176, 72, 50), method: hsl(46, 100, 60), route: hsl(268, 92, 72), api_endpoint: hsl(350, 96, 68),
      model: hsl(140, 62, 54), database_table: hsl(36, 92, 62), command: hsl(192, 62, 52), scheduled_task: hsl(204, 58, 48),
    },
    fallbackEntity: hsl(250, 14, 40), depthStep: 2.6, wallShade: [0.62, 0.8], outline: 'rgba(0,0,0,0.3)',
    text: { primary: '#f4f0ff', secondary: '#aba2d2', halo: 'rgba(18,14,36,0.88)', district: '#ddd4ff' },
    selection: '#ff4f9a', hover: '#7aa2ff', focusRing: '#ff4f9a',
    relation: { imports: '#6f95ff', exports: '#34e0a1', handles: '#ff8a3d', routes_to: '#ff5fa8', requests: '#ffd23d', extends: '#a88bff', implements: '#a88bff', calls: '#3ee0f0', renders: '#f07bff', reads: '#5ef08a', writes: '#ff6b86', queries: '#5ef08a', maps_to: '#ffc53d', foreign_key: '#ffb26b', references: '#4ee6c8', invokes: '#c084fc' },
    impact: { origin: '#6f95ff', near: '#ff5fa8', far: '#ffd23d' },
    fallbackRelation: '#c9c2e8',
    flow: { step: '#ff4f9a', declared: '#8e86b0', indicator: '#fff0f7', dimAlpha: 0.18 },
    diagnostic: '#ffc53d', dimAlpha: 0.32,
    change: { added: '#3ee08a', removed: '#ff5c7a', modified: '#ffc23d', moved: '#a88bff', ghostAlpha: 0.4, unchangedAlpha: 0.42 },
    ui: {
      '--bg': '#120e24', '--app-bg': 'radial-gradient(1100px 650px at 0% 0%, rgba(255,79,154,0.20) 0%, rgba(255,79,154,0) 60%), radial-gradient(1000px 750px at 100% 25%, rgba(91,120,255,0.22) 0%, rgba(91,120,255,0) 62%), radial-gradient(900px 600px at 50% 105%, rgba(160,240,90,0.10) 0%, rgba(160,240,90,0) 60%), #100c20',
      '--panel': 'rgba(30,24,54,0.72)', '--panel-solid': '#1c1733', '--panel-border': 'rgba(200,180,255,0.14)',
      '--text': '#f4f0ff', '--muted': '#aba2d2', '--subtle': '#756c9c', '--accent': '#ff4f9a', '--accent-ink': '#21000f', '--link': '#8fb0ff',
      '--chip': 'rgba(200,180,255,0.09)', '--chip-active': 'rgba(255,79,154,0.22)', '--warning': '#ffc53d', '--danger': '#ff6b86', '--ok': '#3ee08a',
      '--code-bg': '#130f26', '--code-highlight': 'rgba(255,79,154,0.14)', '--code-evidence': 'rgba(111,149,255,0.18)', '--shadow': '0 18px 48px rgba(0,0,0,0.45), 0 2px 8px rgba(0,0,0,0.25)',
      '--added': '#3ee08a', '--removed': '#ff5c7a', '--modified': '#ffc23d', '--moved': '#a88bff', '--diff-added': 'rgba(62,224,138,0.13)', '--diff-removed': 'rgba(255,92,122,0.13)',
      '--font': ROUNDED_FONT, '--radius': '999px', '--radius-card': '18px', '--blur': '18px',
    },
    style: {
      rounding: 0.2, grid: 'dots', shadow: 'rgba(0,0,0,0.34)', sheen: 0.12, font: ROUNDED_FONT, floating: true,
      glows: [{ x: 0, y: 0, r: 0.7, color: 'rgba(255,79,154,0.16)' }, { x: 1, y: 0.3, r: 0.75, color: 'rgba(91,120,255,0.20)' }, { x: 0.5, y: 1.05, r: 0.55, color: 'rgba(150,240,90,0.07)' }],
    },
  },
];
/** Every custom property any theme sets, so switching themes can clear the ones the next theme lacks. */
export const UI_PROPERTIES = [...new Set(THEMES.flatMap(theme => Object.keys(theme.ui)))];
/** Palette key of a node: applications by framework, files by language (themes without those keys fall back to the type). */
/** A stable hue per domain key, shared by the map and the panels. */
export function domainHue(key: string): number { let hash = 0; for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0; return (hash * 137) % 360; }
export function paletteKey(node: { id?: string; type: string; detail?: string; language?: string }): string {
  // The Features view: each domain has its own hue.
  if (node.id?.startsWith('lens:domain:')) return `domain:${node.id.slice(12)}`;
  if (node.type === 'application' && node.detail) return `application:${node.detail}`;
  if (node.type === 'file' && node.language) return `file:${node.language}`;
  return node.type;
}
export function themeById(id: string | undefined): Theme { return THEMES.find(theme => theme.id === id) ?? THEMES[0]!; }

export interface Palette { top: string; left: string; right: string; hoverTop: string }
/** Memoized fills for a (theme, type, depth) combination. */
/**
 * Coverage lens: one color per category (in flows green, entry points violet,
 * supporting teal, not reached red, with a known reason amber; tests,
 * configuration, outside code, code that is not analyzed and assets recede in
 * greys).
 */
const COVERAGE_HSL: Record<string, [dark: Hsl, light: Hsl]> = {
  entry: [hsl(266, 82, 72), hsl(266, 66, 56)], flow: [hsl(150, 62, 50), hsl(150, 58, 40)], supporting: [hsl(188, 62, 56), hsl(188, 62, 40)],
  explained: [hsl(38, 92, 58), hsl(34, 88, 48)], unreached: [hsl(356, 80, 63), hsl(356, 72, 52)],
  test: [hsl(48, 14, 52), hsl(48, 12, 62)], config: [hsl(220, 14, 52), hsl(220, 12, 64)], outside: [hsl(220, 8, 38), hsl(220, 8, 74)], unanalyzed: [hsl(250, 10, 34), hsl(250, 10, 78)], asset: [hsl(220, 6, 30), hsl(220, 8, 82)],
};
export function coverageHsl(category: string, dark: boolean): Hsl { const pair = COVERAGE_HSL[category] ?? COVERAGE_HSL.asset!; return dark ? pair[0] : pair[1]; }
export function coverageCss(category: string, dark: boolean): string { const c = coverageHsl(category, dark); return `hsl(${c.h} ${c.s}% ${c.l}%)`; }
export class PaletteCache {
  private readonly cache = new Map<string, Palette>();
  constructor(readonly theme: Theme) {}
  get(type: string, depth: number): Palette {
    const key = `${type}:${depth}`;
    let palette = this.cache.get(key);
    if (!palette) {
      const base = type.startsWith('coverage:') ? coverageHsl(type.slice(9), this.theme.dark) : type.startsWith('domain:') ? { h: domainHue(type.slice(7)), s: this.theme.dark ? 42 : 46, l: this.theme.dark ? 30 : 78 } : this.theme.entity[type] ?? this.theme.entity[type.split(':')[0]!] ?? this.theme.fallbackEntity;
      const structural = type === 'directory' || type === 'group' || type.startsWith('application');
      const l = Math.max(4, Math.min(96, base.l + (structural ? depth * this.theme.depthStep : 0)));
      const color = (lightness: number) => `hsl(${base.h} ${base.s}% ${Math.max(2, Math.min(98, lightness)).toFixed(1)}%)`;
      palette = { top: color(l), left: color(l * this.theme.wallShade[0]), right: color(l * this.theme.wallShade[1]), hoverTop: color(l + (this.theme.dark ? 9 : -7)) };
      this.cache.set(key, palette);
    }
    return palette;
  }
}
