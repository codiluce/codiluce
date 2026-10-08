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
  grid: 'lines' | 'dots' | 'none';
  /** Soft color fields over the background, in viewport fractions (radius relative to the larger side). */
  glows?: { x: number; y: number; r: number; color: string }[];
  /** Shadow that blocks cast onto what they stand on. */
  shadow?: string;
  /** Strength (0..1) of the highlight across top faces. */
  sheen?: number;
  /** Width of the outline around block tops (default 1). */
  outlineWidth?: number;
  /** Blur of a glow in their own color around relation edges (0 or absent: none). */
  edgeGlow?: number;
  /** Map labels; the panels read it from the `--font` custom property. */
  font?: string;
  /**
   * Panels float as cards over a backdrop (`--app-bg`) instead of docking edge to edge. The space
   * between them (`--gap`), their corners (`--radius-*`) and borders (`--border-width`) come from `ui`.
   */
  floating?: boolean;
}
const hsl = (h: number, s: number, l: number): Hsl => ({ h, s, l });
const ROUNDED_FONT = '"Nunito Variable", Nunito, ui-rounded, "SF Pro Rounded", system-ui, sans-serif';
const INTER = '"Inter Variable", Inter, system-ui, sans-serif';
const GEIST = '"Geist Variable", Geist, system-ui, sans-serif';
const GEIST_MONO = '"Geist Mono Variable", "Geist Mono", ui-monospace, monospace';
const FRAUNCES = '"Fraunces Variable", Fraunces, Georgia, serif';
const JETBRAINS_MONO = '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace';
const ARCHIVO = '"Archivo Variable", Archivo, system-ui, sans-serif';
const SPACE_GROTESK = '"Space Grotesk Variable", "Space Grotesk", system-ui, sans-serif';
const UNBOUNDED = '"Unbounded Variable", Unbounded, system-ui, sans-serif';
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
    change: { added: '#4ade80', removed: '#fb7185', modified: '#fbbf24', moved: '#c084fc', ghostAlpha: 0.4, unchangedAlpha: 0.14 },
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
    change: { added: '#2b8a3e', removed: '#c92a2a', modified: '#d97706', moved: '#7048e8', ghostAlpha: 0.42, unchangedAlpha: 0.18 },
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
    change: { added: '#1fc46f', removed: '#ff4d6d', modified: '#ffa31a', moved: '#8b5cf6', ghostAlpha: 0.42, unchangedAlpha: 0.18 },
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
    change: { added: '#3ee08a', removed: '#ff5c7a', modified: '#ffc23d', moved: '#a88bff', ghostAlpha: 0.4, unchangedAlpha: 0.14 },
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
  {
    // Super minimal, light: white paper, hairlines, docked panels, quiet tints; the one accent marks what you interact with.
    id: 'ink', name: 'Ink', dark: false,
    background: ['#ffffff', '#fafafa'], grid: 'rgba(0,0,0,0.035)',
    entity: {
      repository: hsl(0, 0, 98), application: hsl(0, 0, 95), group: hsl(0, 0, 92), directory: hsl(0, 0, 93),
      file: hsl(0, 0, 84), class: hsl(150, 16, 70), controller: hsl(20, 30, 66), component: hsl(280, 16, 74),
      function: hsl(180, 16, 66), method: hsl(45, 26, 72), route: hsl(330, 20, 70), api_endpoint: hsl(350, 26, 66),
      model: hsl(100, 14, 64), database_table: hsl(35, 16, 62), command: hsl(200, 18, 64), scheduled_task: hsl(210, 16, 70),
    },
    fallbackEntity: hsl(0, 0, 78), depthStep: -2.2, wallShade: [0.8, 0.9], outline: 'rgba(0,0,0,0.12)',
    text: { primary: '#0a0a0a', secondary: '#737373', halo: 'rgba(255,255,255,0.92)', district: '#262626' },
    selection: '#0047ff', hover: '#0a0a0a', focusRing: '#0047ff',
    relation: { imports: '#a3a3a3', exports: '#b8b8b8', handles: '#0047ff', routes_to: '#0047ff', requests: '#0047ff', extends: '#525252', implements: '#525252', calls: '#262626', renders: '#525252', reads: '#737373', writes: '#e5484d', queries: '#737373', maps_to: '#8a8a8a', foreign_key: '#8a8a8a', references: '#8a8a8a', invokes: '#404040' },
    impact: { origin: '#0047ff', near: '#e5484d', far: '#b5b5b5' },
    fallbackRelation: '#8a8a8a',
    flow: { step: '#0047ff', declared: '#a3a3a3', indicator: '#ffffff', dimAlpha: 0.16 },
    diagnostic: '#d97706', dimAlpha: 0.3,
    change: { added: '#16a34a', removed: '#e5484d', modified: '#d97706', moved: '#7c3aed', ghostAlpha: 0.4, unchangedAlpha: 0.16 },
    ui: {
      '--bg': '#ffffff', '--panel': 'rgba(255,255,255,0.96)', '--panel-solid': '#ffffff', '--panel-border': '#ebebeb',
      '--text': '#0a0a0a', '--muted': '#737373', '--subtle': '#a3a3a3', '--accent': '#0047ff', '--accent-ink': '#ffffff', '--link': '#0047ff',
      '--chip': '#f5f5f5', '--chip-active': 'rgba(0,71,255,0.08)', '--warning': '#b45309', '--danger': '#dc2626', '--ok': '#16a34a',
      '--code-bg': '#fcfcfc', '--code-highlight': 'rgba(0,71,255,0.07)', '--code-evidence': 'rgba(0,0,0,0.05)', '--shadow': '0 0 0 transparent',
      '--added': '#16a34a', '--removed': '#dc2626', '--modified': '#b45309', '--moved': '#7c3aed', '--diff-added': 'rgba(22,163,74,0.10)', '--diff-removed': 'rgba(220,38,38,0.08)',
      '--font': INTER, '--font-display': INTER, '--radius': '3px', '--radius-chip': '3px', '--radius-item': '3px', '--radius-float': '4px', '--radius-panel': '4px',
      '--title-size': '10.5px', '--title-weight': '600', '--title-tracking': '0.12em',
    },
    style: { rounding: 0, grid: 'lines', font: INTER },
  },
  {
    // Super minimal, dark: pure black, flat cards held apart by space alone, a grey map; white marks what you interact with.
    id: 'void', name: 'Void', dark: true,
    background: ['#000000', '#050505'], grid: 'transparent',
    entity: {
      repository: hsl(0, 0, 6), application: hsl(0, 0, 9), group: hsl(0, 0, 11), directory: hsl(0, 0, 12),
      file: hsl(0, 0, 30), class: hsl(160, 12, 42), controller: hsl(30, 18, 46), component: hsl(270, 14, 50),
      function: hsl(190, 12, 42), method: hsl(45, 16, 48), route: hsl(330, 14, 48), api_endpoint: hsl(350, 18, 48),
      model: hsl(110, 10, 40), database_table: hsl(35, 10, 38), command: hsl(200, 14, 44), scheduled_task: hsl(215, 12, 46),
    },
    fallbackEntity: hsl(0, 0, 34), depthStep: 2.4, wallShade: [0.55, 0.75], outline: 'rgba(0,0,0,0.5)',
    text: { primary: '#ededed', secondary: '#8f8f8f', halo: 'rgba(0,0,0,0.85)', district: '#d4d4d4' },
    selection: '#ffffff', hover: '#8f8f8f', focusRing: '#ffffff',
    relation: { imports: '#6e6e6e', exports: '#8f8f8f', handles: '#ededed', routes_to: '#ededed', requests: '#cfcfcf', extends: '#7a7a7a', implements: '#7a7a7a', calls: '#a8a8a8', renders: '#9a9a9a', reads: '#7f7f7f', writes: '#ff6166', queries: '#7f7f7f', maps_to: '#7a7a7a', foreign_key: '#7a7a7a', references: '#8a8a8a', invokes: '#b5b5b5' },
    impact: { origin: '#ffffff', near: '#ff6166', far: '#4d4d4d' },
    fallbackRelation: '#8f8f8f',
    flow: { step: '#ffffff', declared: '#5c5c5c', indicator: '#000000', dimAlpha: 0.16 },
    diagnostic: '#f5a623', dimAlpha: 0.3,
    change: { added: '#3ecf8e', removed: '#ff6166', modified: '#f5a623', moved: '#a78bfa', ghostAlpha: 0.4, unchangedAlpha: 0.14 },
    ui: {
      '--bg': '#000000', '--app-bg': '#000000', '--panel': '#0a0a0a', '--panel-solid': '#0a0a0a', '--panel-border': 'rgba(255,255,255,0.08)',
      '--text': '#ededed', '--muted': '#8f8f8f', '--subtle': '#5c5c5c', '--accent': '#ededed', '--accent-ink': '#000000', '--link': '#d4d4d4',
      '--chip': 'rgba(255,255,255,0.05)', '--chip-active': 'rgba(255,255,255,0.11)', '--warning': '#f5a623', '--danger': '#ff6166', '--ok': '#3ecf8e',
      '--code-bg': '#050505', '--code-highlight': 'rgba(255,255,255,0.07)', '--code-evidence': 'rgba(255,255,255,0.05)', '--shadow': '0 0 0 transparent',
      '--added': '#3ecf8e', '--removed': '#ff6166', '--modified': '#f5a623', '--moved': '#a78bfa', '--diff-added': 'rgba(62,207,142,0.11)', '--diff-removed': 'rgba(255,97,102,0.11)',
      '--font': GEIST, '--font-display': GEIST, '--font-mono': GEIST_MONO, '--gap': '16px', '--blur': '0px', '--control-shadow': '0 0 0 transparent', '--primary-shadow': '0 0 0 transparent',
      '--radius': '8px', '--radius-chip': '6px', '--radius-item': '8px', '--radius-float': '10px', '--radius-panel': '12px', '--panel-pad': '16px 18px',
      '--title-size': '13px', '--title-weight': '500', '--title-tracking': '-0.01em',
    },
    style: { rounding: 0.05, grid: 'none', font: GEIST, floating: true },
  },
  {
    // Editorial: warm newsprint, serif type, wide margins between flat sheets, an earthy map and one oxblood accent.
    id: 'gazette', name: 'Gazette', dark: false,
    background: ['#f8f5ef', '#f3efe6'], grid: 'rgba(60,40,20,0.16)',
    entity: {
      repository: hsl(40, 25, 95), application: hsl(38, 22, 91), group: hsl(30, 18, 88), directory: hsl(40, 14, 89),
      file: hsl(36, 10, 80), class: hsl(150, 18, 54), controller: hsl(14, 55, 54), component: hsl(345, 30, 62),
      function: hsl(190, 20, 50), method: hsl(42, 55, 62), route: hsl(4, 52, 48), api_endpoint: hsl(355, 45, 54),
      model: hsl(90, 20, 50), database_table: hsl(30, 30, 48), command: hsl(210, 22, 48), scheduled_task: hsl(215, 18, 60),
    },
    fallbackEntity: hsl(36, 8, 76), depthStep: -2.4, wallShade: [0.8, 0.9], outline: 'rgba(40,30,20,0.14)',
    text: { primary: '#1a1714', secondary: '#6b625a', halo: 'rgba(250,248,243,0.92)', district: '#2a2420' },
    selection: '#b3261e', hover: '#1a1714', focusRing: '#b3261e',
    relation: { imports: '#3f5c7a', exports: '#5b7a3a', handles: '#b3541e', routes_to: '#a3263e', requests: '#b8860b', extends: '#6a4c93', implements: '#6a4c93', calls: '#2f6f6f', renders: '#8e3b6b', reads: '#4f7a3a', writes: '#b3261e', queries: '#4f7a3a', maps_to: '#a6761d', foreign_key: '#a35a1d', references: '#2f6f6f', invokes: '#6a4c93' },
    impact: { origin: '#1a1714', near: '#b3261e', far: '#c9a227' },
    fallbackRelation: '#6b625a',
    flow: { step: '#b3261e', declared: '#9a9086', indicator: '#fffaf0', dimAlpha: 0.2 },
    diagnostic: '#b8860b', dimAlpha: 0.34,
    change: { added: '#3d7a3a', removed: '#b3261e', modified: '#b8860b', moved: '#6a4c93', ghostAlpha: 0.42, unchangedAlpha: 0.18 },
    ui: {
      '--bg': '#efebe2', '--app-bg': '#efebe2', '--panel': '#fbf9f4', '--panel-solid': '#fbf9f4', '--panel-border': 'rgba(26,23,20,0.12)',
      '--text': '#1a1714', '--muted': '#6b625a', '--subtle': '#a1978c', '--accent': '#b3261e', '--accent-ink': '#ffffff', '--link': '#1f4e79',
      '--chip': 'rgba(26,23,20,0.045)', '--chip-active': 'rgba(179,38,30,0.09)', '--warning': '#9a6700', '--danger': '#b3261e', '--ok': '#3d7a3a',
      '--code-bg': '#fdfcf8', '--code-highlight': 'rgba(179,38,30,0.08)', '--code-evidence': 'rgba(31,78,121,0.09)', '--shadow': '0 1px 0 rgba(26,23,20,0.05)',
      '--added': '#3d7a3a', '--removed': '#b3261e', '--modified': '#9a6700', '--moved': '#6a4c93', '--diff-added': 'rgba(61,122,58,0.10)', '--diff-removed': 'rgba(179,38,30,0.08)',
      '--font': FRAUNCES, '--font-display': FRAUNCES, '--font-size': '13.5px', '--gap': '22px', '--blur': '0px', '--control-shadow': '0 0 0 transparent', '--primary-shadow': '0 0 0 transparent',
      '--radius': '2px', '--radius-chip': '2px', '--radius-item': '2px', '--radius-float': '3px', '--radius-panel': '3px', '--panel-pad': '16px 22px',
      '--title-size': '20px', '--title-weight': '500', '--title-tracking': '-0.01em',
    },
    style: { rounding: 0, grid: 'dots', font: FRAUNCES, floating: true },
  },
  {
    // A phosphor terminal: green on black in a monospace, tight tiles, square corners, a faint glow and scanlines; amber marks the selection.
    id: 'phosphor', name: 'Phosphor', dark: true,
    background: ['#030b06', '#020603'], grid: 'rgba(51,255,102,0.07)',
    entity: {
      repository: hsl(140, 40, 5), application: hsl(140, 45, 8), group: hsl(140, 35, 10), directory: hsl(140, 30, 10),
      file: hsl(140, 30, 24), class: hsl(140, 80, 40), controller: hsl(40, 100, 52), component: hsl(160, 90, 45),
      function: hsl(120, 70, 38), method: hsl(90, 70, 45), route: hsl(45, 100, 60), api_endpoint: hsl(30, 100, 55),
      model: hsl(150, 60, 32), database_table: hsl(170, 60, 32), command: hsl(180, 80, 42), scheduled_task: hsl(190, 70, 40),
    },
    fallbackEntity: hsl(140, 20, 22), depthStep: 2.2, wallShade: [0.42, 0.62], outline: 'rgba(51,255,102,0.22)',
    text: { primary: '#b8ffc9', secondary: '#4fae6a', halo: 'rgba(2,6,3,0.9)', district: '#7dffa0' },
    selection: '#ffb000', hover: '#e6ffe9', focusRing: '#ffb000',
    relation: { imports: '#33ff66', exports: '#7dff9e', handles: '#ffb000', routes_to: '#ffcc4d', requests: '#ffd966', extends: '#00e5c7', implements: '#00e5c7', calls: '#66ffcc', renders: '#99ff33', reads: '#33ff99', writes: '#ff5533', queries: '#33ff99', maps_to: '#ffb000', foreign_key: '#ff9900', references: '#00e5c7', invokes: '#b3ff66' },
    impact: { origin: '#e6ffe9', near: '#ffb000', far: '#1f7a3a' },
    fallbackRelation: '#4fae6a',
    flow: { step: '#ffb000', declared: '#2f7a45', indicator: '#fff2cc', dimAlpha: 0.16 },
    diagnostic: '#ffb000', dimAlpha: 0.3,
    change: { added: '#33ff66', removed: '#ff5533', modified: '#ffb000', moved: '#00e5c7', ghostAlpha: 0.4, unchangedAlpha: 0.14 },
    ui: {
      '--bg': '#020603', '--app-bg': '#020603', '--panel': '#030e07', '--panel-solid': '#030e07', '--panel-border': 'rgba(51,255,102,0.2)',
      '--text': '#b8ffc9', '--muted': '#4fbf70', '--subtle': '#2f7a45', '--accent': '#ffb000', '--accent-ink': '#140d00', '--link': '#66ffcc',
      '--chip': 'rgba(51,255,102,0.07)', '--chip-active': 'rgba(51,255,102,0.16)', '--warning': '#ffb000', '--danger': '#ff5533', '--ok': '#33ff66',
      '--code-bg': '#010402', '--code-highlight': 'rgba(255,176,0,0.12)', '--code-evidence': 'rgba(51,255,102,0.10)', '--shadow': '0 0 0 1px rgba(51,255,102,0.04), 0 0 24px rgba(51,255,102,0.07)',
      '--added': '#33ff66', '--removed': '#ff5533', '--modified': '#ffb000', '--moved': '#00e5c7', '--diff-added': 'rgba(51,255,102,0.11)', '--diff-removed': 'rgba(255,85,51,0.12)',
      '--font': JETBRAINS_MONO, '--font-display': JETBRAINS_MONO, '--font-mono': JETBRAINS_MONO, '--font-size': '12px', '--gap': '6px', '--blur': '0px', '--control-shadow': '0 0 0 transparent', '--primary-shadow': '0 0 14px rgba(255,176,0,0.35)',
      '--radius': '0px', '--radius-chip': '0px', '--radius-item': '0px', '--radius-float': '0px', '--radius-panel': '0px', '--panel-pad': '10px 12px',
      '--title-size': '11.5px', '--title-weight': '700', '--title-case': 'uppercase', '--title-tracking': '0.08em',
    },
    style: { rounding: 0, grid: 'lines', font: JETBRAINS_MONO, floating: true, edgeGlow: 6, glows: [{ x: 0.5, y: 0.45, r: 0.7, color: 'rgba(51,255,102,0.05)' }] },
  },
  {
    // Neo-brutalist poster: a halftone yellow backdrop, heavy expanded type, black borders, hard offset shadows, flat primaries outlined in ink.
    id: 'brutal', name: 'Brutal', dark: false,
    background: ['#f4f1e8', '#f4f1e8'], grid: 'rgba(10,10,10,0.08)',
    entity: {
      repository: hsl(45, 25, 96), application: hsl(48, 100, 86), 'application:laravel': hsl(10, 100, 88), 'application:nextjs': hsl(225, 100, 90), group: hsl(300, 80, 90), directory: hsl(45, 20, 91),
      file: hsl(0, 0, 100), ...fileLanguages(58, 10), class: hsl(152, 100, 38), controller: hsl(16, 100, 52), component: hsl(320, 100, 62),
      function: hsl(190, 100, 42), method: hsl(50, 100, 50), route: hsl(228, 100, 60), api_endpoint: hsl(0, 90, 55),
      model: hsl(100, 70, 45), database_table: hsl(36, 100, 50), command: hsl(270, 90, 60), scheduled_task: hsl(204, 100, 48),
    },
    fallbackEntity: hsl(45, 10, 82), depthStep: -1.6, wallShade: [0.45, 0.66], outline: '#0a0a0a',
    text: { primary: '#0a0a0a', secondary: '#3d3d3d', halo: 'rgba(244,241,232,0.95)', district: '#0a0a0a' },
    selection: '#ff2e00', hover: '#2f5bff', focusRing: '#ff2e00',
    relation: { imports: '#2f5bff', exports: '#00a85a', handles: '#ff5a00', routes_to: '#ff2e93', requests: '#e6b800', extends: '#7a3cff', implements: '#7a3cff', calls: '#0a0a0a', renders: '#d6249f', reads: '#00a85a', writes: '#ff2e00', queries: '#00a85a', maps_to: '#e6a100', foreign_key: '#e67300', references: '#008f8f', invokes: '#7a3cff' },
    impact: { origin: '#2f5bff', near: '#ff2e00', far: '#ffd400' },
    fallbackRelation: '#0a0a0a',
    flow: { step: '#ff2e00', declared: '#7a7a7a', indicator: '#ffd400', dimAlpha: 0.2 },
    diagnostic: '#e6a100', dimAlpha: 0.36,
    change: { added: '#00a85a', removed: '#ff2e00', modified: '#e6a100', moved: '#7a3cff', ghostAlpha: 0.42, unchangedAlpha: 0.18 },
    ui: {
      '--bg': '#ffd400', '--app-bg': 'radial-gradient(rgba(10,10,10,0.2) 1px, transparent 1.4px) 0 0 / 11px 11px, #ffd400',
      '--panel': '#ffffff', '--panel-solid': '#ffffff', '--panel-border': '#0a0a0a',
      '--text': '#0a0a0a', '--muted': '#4a4a4a', '--subtle': '#8a8a8a', '--accent': '#0a0a0a', '--accent-ink': '#ffd400', '--link': '#2f5bff',
      '--chip': 'rgba(10,10,10,0.06)', '--chip-active': '#ffd400', '--warning': '#b35c00', '--danger': '#e01e00', '--ok': '#00875a',
      '--code-bg': '#fffdf5', '--code-highlight': 'rgba(255,212,0,0.35)', '--code-evidence': 'rgba(47,91,255,0.14)', '--shadow': '4px 4px 0 #0a0a0a',
      '--added': '#00875a', '--removed': '#e01e00', '--modified': '#b35c00', '--moved': '#7a3cff', '--diff-added': 'rgba(0,168,90,0.14)', '--diff-removed': 'rgba(255,46,0,0.12)',
      '--font': ARCHIVO, '--font-display': ARCHIVO, '--display-stretch': '125%', '--gap': '14px', '--border-width': '2px', '--blur': '0px', '--control-shadow': '3px 3px 0 #0a0a0a', '--primary-shadow': '3px 3px 0 #ff2e00',
      '--radius': '0px', '--radius-chip': '0px', '--radius-item': '0px', '--radius-float': '0px', '--radius-panel': '0px',
      '--title-size': '13px', '--title-weight': '900', '--title-case': 'uppercase', '--title-tracking': '0.01em',
    },
    style: { rounding: 0, grid: 'lines', font: ARCHIVO, floating: true, outlineWidth: 2, shadow: '#0a0a0a' },
  },
  {
    // Synthwave: glassy cards glowing over a dark violet night, wide display type, vivid blocks with dark walls, edges that glow.
    id: 'neon', name: 'Neon', dark: true,
    background: ['#0b0818', '#05040c'], grid: 'rgba(0,229,255,0.07)',
    entity: {
      repository: hsl(250, 40, 8), application: hsl(255, 45, 12), 'application:laravel': hsl(330, 55, 14), 'application:nextjs': hsl(195, 60, 12), group: hsl(280, 45, 15), directory: hsl(250, 35, 14),
      file: hsl(240, 20, 36), ...fileLanguages(56, 8), class: hsl(150, 100, 50), controller: hsl(25, 100, 58), component: hsl(310, 100, 62),
      function: hsl(180, 100, 48), method: hsl(55, 100, 55), route: hsl(285, 100, 68), api_endpoint: hsl(340, 100, 60),
      model: hsl(120, 90, 55), database_table: hsl(40, 100, 55), command: hsl(195, 100, 55), scheduled_task: hsl(210, 100, 62),
    },
    fallbackEntity: hsl(250, 20, 30), depthStep: 2.6, wallShade: [0.36, 0.52], outline: 'rgba(0,0,0,0.4)',
    text: { primary: '#f5f3ff', secondary: '#9d95c9', halo: 'rgba(5,4,12,0.9)', district: '#c4b5fd' },
    selection: '#00f0ff', hover: '#ff2bd6', focusRing: '#00f0ff',
    relation: { imports: '#4d7cff', exports: '#00ffa3', handles: '#ff8a00', routes_to: '#ff2bd6', requests: '#ffe600', extends: '#a855ff', implements: '#a855ff', calls: '#00f0ff', renders: '#ff4dff', reads: '#39ff88', writes: '#ff3d6e', queries: '#39ff88', maps_to: '#ffc400', foreign_key: '#ff9e3d', references: '#2bffd9', invokes: '#c77dff' },
    impact: { origin: '#00f0ff', near: '#ff2bd6', far: '#ffe600' },
    fallbackRelation: '#b8b2e0',
    flow: { step: '#00f0ff', declared: '#6b6394', indicator: '#e6fdff', dimAlpha: 0.15 },
    diagnostic: '#ffc400', dimAlpha: 0.3,
    change: { added: '#39ff88', removed: '#ff3d6e', modified: '#ffc400', moved: '#a855ff', ghostAlpha: 0.4, unchangedAlpha: 0.14 },
    ui: {
      '--bg': '#05040c', '--app-bg': 'radial-gradient(900px 600px at 0% 0%, rgba(255,43,214,0.16) 0%, rgba(255,43,214,0) 60%), radial-gradient(1000px 700px at 100% 100%, rgba(0,240,255,0.13) 0%, rgba(0,240,255,0) 60%), #05040c',
      '--panel': 'rgba(13,10,28,0.78)', '--panel-solid': '#0d0a1c', '--panel-border': 'rgba(167,139,250,0.2)',
      '--text': '#f5f3ff', '--muted': '#a39dc9', '--subtle': '#6b6394', '--accent': '#00f0ff', '--accent-ink': '#001417', '--link': '#5ee7ff',
      '--chip': 'rgba(167,139,250,0.08)', '--chip-active': 'rgba(0,240,255,0.14)', '--warning': '#ffc400', '--danger': '#ff3d6e', '--ok': '#39ff88',
      '--code-bg': '#080612', '--code-highlight': 'rgba(0,240,255,0.10)', '--code-evidence': 'rgba(255,43,214,0.12)', '--shadow': '0 0 0 1px rgba(0,240,255,0.05), 0 0 28px rgba(255,43,214,0.10), 0 18px 48px rgba(0,0,0,0.55)',
      '--added': '#39ff88', '--removed': '#ff3d6e', '--modified': '#ffc400', '--moved': '#a855ff', '--diff-added': 'rgba(57,255,136,0.12)', '--diff-removed': 'rgba(255,61,110,0.13)',
      '--font': SPACE_GROTESK, '--font-display': UNBOUNDED, '--gap': '10px', '--blur': '20px', '--control-shadow': '0 0 14px rgba(0,240,255,0.08)', '--primary-shadow': '0 0 18px rgba(0,240,255,0.45)',
      '--radius': '10px', '--radius-chip': '999px', '--radius-item': '10px', '--radius-float': '14px', '--radius-panel': '16px',
      '--title-size': '10.5px', '--title-weight': '600', '--title-case': 'uppercase', '--title-tracking': '0.16em',
    },
    style: {
      rounding: 0.08, grid: 'lines', font: SPACE_GROTESK, floating: true, edgeGlow: 9, sheen: 0.08,
      glows: [{ x: 0, y: 0, r: 0.65, color: 'rgba(255,43,214,0.13)' }, { x: 1, y: 1, r: 0.7, color: 'rgba(0,240,255,0.10)' }, { x: 0.55, y: 0.5, r: 0.45, color: 'rgba(124,58,237,0.08)' }],
    },
  },
  {
    // The brand in daylight: ink on paper at full contrast, geometric type. Folders are grey plates, files stand
    // out white on them, and amber light marks what you interact with and where flows run.
    id: 'codiluce-dawn', name: 'Codiluce Dawn', dark: false,
    background: ['#f5f5f2', '#eeeeea'], grid: 'rgba(17,17,19,0.16)',
    entity: {
      repository: hsl(60, 5, 93), application: hsl(60, 3, 89), group: hsl(240, 3, 86), directory: hsl(240, 3, 86),
      file: hsl(60, 2, 99), class: hsl(240, 4, 95), controller: hsl(240, 4, 94), component: hsl(240, 4, 95),
      function: hsl(240, 4, 93), method: hsl(240, 4, 91), route: hsl(36, 80, 88), api_endpoint: hsl(36, 86, 84),
      model: hsl(240, 4, 94), database_table: hsl(240, 4, 92), command: hsl(240, 4, 95), scheduled_task: hsl(240, 4, 94),
    },
    fallbackEntity: hsl(240, 3, 90), depthStep: -2.4, wallShade: [0.7, 0.84], outline: 'rgba(17,17,19,0.34)',
    text: { primary: '#111113', secondary: '#55555c', halo: 'rgba(245,245,242,0.94)', district: '#111113' },
    selection: '#d97400', hover: '#111113', focusRing: '#d97400',
    relation: { imports: '#808087', exports: '#9c9ca2', handles: '#d97400', routes_to: '#d97400', requests: '#d97400', extends: '#55555c', implements: '#55555c', calls: '#d97400', renders: '#d97400', reads: '#d97400', writes: '#d97400', queries: '#d97400', maps_to: '#808087', foreign_key: '#808087', references: '#808087', invokes: '#d97400' },
    fallbackRelation: '#808087', impact: { origin: '#111113', near: '#d6452a', far: '#e8c27a' },
    flow: { step: '#d97400', declared: '#808087', indicator: '#fff4e0', dimAlpha: 0.2 },
    diagnostic: '#b86200', dimAlpha: 0.3,
    change: { added: '#1f7a4d', removed: '#c42b1c', modified: '#b86200', moved: '#6b46c1', ghostAlpha: 0.42, unchangedAlpha: 0.16 },
    ui: {
      '--bg': '#f5f5f2', '--panel': '#ffffff', '--panel-solid': '#ffffff', '--panel-border': '#d9d9d4',
      '--text': '#111113', '--muted': '#55555c', '--subtle': '#76767d', '--accent': '#9a5a00', '--accent-ink': '#ffffff', '--link': '#9a5a00',
      '--chip': '#efefeb', '--chip-active': 'rgba(217,116,0,0.14)', '--warning': '#9a5a00', '--danger': '#c42b1c', '--ok': '#1f7a4d',
      '--code-bg': '#fafaf8', '--code-highlight': 'rgba(217,116,0,0.13)', '--code-evidence': 'rgba(17,17,19,0.06)', '--shadow': '0 6px 20px rgba(17,17,19,0.08)',
      '--added': '#1f7a4d', '--removed': '#c42b1c', '--modified': '#9a5a00', '--moved': '#6b46c1', '--diff-added': 'rgba(31,122,77,0.10)', '--diff-removed': 'rgba(196,43,28,0.09)',
      '--font': SPACE_GROTESK, '--font-display': SPACE_GROTESK, '--font-mono': GEIST_MONO, '--blur': '0px',
      '--radius': '8px', '--radius-chip': '6px', '--radius-item': '8px', '--radius-float': '10px', '--radius-panel': '10px',
      '--title-size': '11px', '--title-weight': '600', '--title-case': 'uppercase', '--title-tracking': '0.09em',
    },
    style: {
      rounding: 0.025, grid: 'dots', font: SPACE_GROTESK, shadow: 'rgba(17,17,19,0.12)', sheen: 0.05, outlineWidth: 1, edgeGlow: 3,
      glows: [{ x: 0.5, y: 0.45, r: 0.6, color: 'rgba(255,255,255,0.5)' }],
    },
  },
  {
    // The brand after dark: paper on ink at full contrast, geometric type. Folders are near-black plates, files
    // catch the light in grey, and amber light marks what you interact with and where flows run.
    id: 'codiluce-dusk', name: 'Codiluce Dusk', dark: true,
    background: ['#0c0c0d', '#0a0a0b'], grid: 'rgba(245,245,243,0.09)',
    entity: {
      repository: hsl(240, 4, 6), application: hsl(240, 4, 9), group: hsl(240, 4, 11), directory: hsl(240, 4, 11),
      file: hsl(240, 3, 34), class: hsl(240, 3, 38), controller: hsl(240, 3, 37), component: hsl(240, 3, 36),
      function: hsl(240, 3, 38), method: hsl(240, 3, 40), route: hsl(38, 40, 34), api_endpoint: hsl(38, 48, 36),
      model: hsl(240, 3, 37), database_table: hsl(240, 3, 38), command: hsl(240, 3, 36), scheduled_task: hsl(240, 3, 36),
    },
    fallbackEntity: hsl(240, 3, 24), depthStep: 1.3, wallShade: [0.5, 0.72], outline: 'rgba(245,245,243,0.13)',
    text: { primary: '#f5f5f3', secondary: '#a1a1a7', halo: 'rgba(10,10,11,0.92)', district: '#f5f5f3' },
    selection: '#ffbf47', hover: '#f5f5f3', focusRing: '#ffbf47',
    relation: { imports: '#76767d', exports: '#929297', handles: '#ffbf47', routes_to: '#ffbf47', requests: '#ffbf47', extends: '#a1a1a7', implements: '#a1a1a7', calls: '#ffbf47', renders: '#ffbf47', reads: '#ffbf47', writes: '#ffbf47', queries: '#ffbf47', maps_to: '#929297', foreign_key: '#929297', references: '#929297', invokes: '#ffbf47' },
    fallbackRelation: '#929297', impact: { origin: '#f5f5f3', near: '#ff7a59', far: '#7a6234' },
    flow: { step: '#ffbf47', declared: '#76767d', indicator: '#fff3d6', dimAlpha: 0.16 },
    diagnostic: '#ffa940', dimAlpha: 0.28,
    change: { added: '#5ee39a', removed: '#ff6b6b', modified: '#ffbf47', moved: '#b9a3ff', ghostAlpha: 0.4, unchangedAlpha: 0.14 },
    ui: {
      '--bg': '#0a0a0b', '--panel': '#111113', '--panel-solid': '#111113', '--panel-border': '#2a2a2f',
      '--text': '#f5f5f3', '--muted': '#a1a1a7', '--subtle': '#7d7d84', '--accent': '#ffbf47', '--accent-ink': '#1a1100', '--link': '#ffcf70',
      '--chip': '#1c1c1f', '--chip-active': 'rgba(255,191,71,0.16)', '--warning': '#ffbf47', '--danger': '#ff6b6b', '--ok': '#5ee39a',
      '--code-bg': '#0a0a0b', '--code-highlight': 'rgba(255,191,71,0.14)', '--code-evidence': 'rgba(245,245,243,0.07)', '--shadow': '0 8px 28px rgba(0,0,0,0.5)',
      '--added': '#5ee39a', '--removed': '#ff6b6b', '--modified': '#ffbf47', '--moved': '#b9a3ff', '--diff-added': 'rgba(94,227,154,0.12)', '--diff-removed': 'rgba(255,107,107,0.12)',
      '--font': SPACE_GROTESK, '--font-display': SPACE_GROTESK, '--font-mono': GEIST_MONO, '--blur': '0px',
      '--radius': '8px', '--radius-chip': '6px', '--radius-item': '8px', '--radius-float': '10px', '--radius-panel': '10px',
      '--title-size': '11px', '--title-weight': '600', '--title-case': 'uppercase', '--title-tracking': '0.09em',
    },
    style: {
      rounding: 0.025, grid: 'dots', font: SPACE_GROTESK, shadow: 'rgba(0,0,0,0.45)', sheen: 0.06, outlineWidth: 1, edgeGlow: 5,
      glows: [{ x: 0.5, y: 0.45, r: 0.6, color: 'rgba(245,245,243,0.025)' }],
    },
  },
];
/** Every custom property any theme sets, so switching themes can clear the ones the next theme lacks. */
export const UI_PROPERTIES = [...new Set(THEMES.flatMap(theme => Object.keys(theme.ui)))];
/** A stable hue per key (a family's when the order of the families is not at hand). */
export function domainHue(key: string): number { let hash = 0; for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0; return (hash * 137) % 360; }
/**
 * Data families: hues spread by the golden angle in the order given (most files
 * first), so the largest families and neighbours in the legend differ. Code
 * without a family is grey.
 */
export function familyHues(keys: string[]): Map<string, number> { return new Map(keys.map((key, i) => [key, Math.round((210 + i * 137.508) % 360)])); }
/** Features: hues spread by the golden angle over their keys in alphabetical order, so every list and the map agree. */
export function featureHues(keys: string[]): Map<string, number> { return familyHues([...keys].sort()); }
/** People: hues spread by the golden angle over their order of first commit, so a person keeps one color in every window and view. */
export function personHue(order: number): number { return Math.round((28 + order * 137.508) % 360); }
export function personHues(people: { key: string; order: number }[]): Map<string, number> { return new Map(people.map(person => [person.key, personHue(person.order)])); }
/** A family's hue when the order of the families is not at hand. */
export function familyHashHue(key: string): number { return domainHue(`family:${key}`); }
export function familyHsl(hue: number | 'none', dark: boolean): Hsl { return hue === 'none' ? hsl(220, 8, dark ? 34 : 78) : hsl(hue, dark ? 60 : 58, dark ? 58 : 50); }
export function familyCss(hue: number | 'none', dark: boolean): string { const c = familyHsl(hue, dark); return `hsl(${c.h} ${c.s}% ${c.l}%)`; }
/** Palette key of a node: applications by framework, files by language (themes without those keys fall back to the type). */
export function paletteKey(node: { type: string; detail?: string; language?: string }): string {
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
      const base = type.startsWith('coverage:') ? coverageHsl(type.slice(9), this.theme.dark)
        : type.startsWith('family:') ? familyHsl(type === 'family:none' ? 'none' : Number(type.slice(7)), this.theme.dark)
        : this.theme.entity[type] ?? this.theme.entity[type.split(':')[0]!] ?? this.theme.fallbackEntity;
      const structural = type === 'directory' || type === 'group' || type.startsWith('application');
      const l = Math.max(4, Math.min(96, base.l + (structural ? depth * this.theme.depthStep : 0)));
      const color = (lightness: number) => `hsl(${base.h} ${base.s}% ${Math.max(2, Math.min(98, lightness)).toFixed(1)}%)`;
      palette = { top: color(l), left: color(l * this.theme.wallShade[0]), right: color(l * this.theme.wallShade[1]), hoverTop: color(l + (this.theme.dark ? 9 : -7)) };
      this.cache.set(key, palette);
    }
    return palette;
  }
}
