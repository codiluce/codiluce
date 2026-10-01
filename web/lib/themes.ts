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
  /** CSS custom properties for panels and controls. */
  ui: Record<string, string>;
}
const hsl = (h: number, s: number, l: number): Hsl => ({ h, s, l });
export const THEMES: Theme[] = [
  {
    id: 'midnight', name: 'Midnight', dark: true,
    background: ['#0b1020', '#111a33'], grid: 'rgba(120,150,255,0.05)',
    entity: {
      repository: hsl(225, 25, 16), application: hsl(222, 32, 24), 'application:laravel': hsl(356, 30, 26), 'application:nextjs': hsl(206, 38, 25), group: hsl(268, 30, 30), directory: hsl(214, 26, 31),
      file: hsl(196, 45, 46), class: hsl(150, 45, 46), controller: hsl(28, 75, 54), component: hsl(286, 52, 60),
      function: hsl(170, 50, 46), method: hsl(48, 70, 55), route: hsl(330, 65, 60), api_endpoint: hsl(350, 72, 62),
      model: hsl(100, 45, 48), database_table: hsl(40, 40, 50),
    },
    fallbackEntity: hsl(210, 10, 50), depthStep: 3.2, wallShade: [0.55, 0.72], outline: 'rgba(0,0,0,0.35)',
    text: { primary: '#eef2ff', secondary: '#9fb0d6', halo: 'rgba(8,12,26,0.85)', district: '#c9d5ff' },
    selection: '#ffd166', hover: '#7dd3fc', focusRing: '#ffd166',
    relation: { imports: '#60a5fa', exports: '#34d399', handles: '#f97316', routes_to: '#f472b6', requests: '#facc15', extends: '#a78bfa', implements: '#a78bfa', calls: '#22d3ee', renders: '#e879f9', reads: '#4ade80', writes: '#fb7185', queries: '#4ade80', maps_to: '#fbbf24' },
    fallbackRelation: '#cbd5e1',
    flow: { step: '#ffd166', declared: '#94a3b8', indicator: '#fff7d6', dimAlpha: 0.18 },
    diagnostic: '#fbbf24', dimAlpha: 0.32,
    ui: {
      '--bg': '#0b1020', '--panel': 'rgba(16,22,42,0.94)', '--panel-solid': '#10162a', '--panel-border': 'rgba(148,163,214,0.16)',
      '--text': '#e7ecff', '--muted': '#93a3c8', '--subtle': '#64729a', '--accent': '#ffd166', '--accent-ink': '#1b1400', '--link': '#93c5fd',
      '--chip': 'rgba(148,163,214,0.12)', '--chip-active': 'rgba(255,209,102,0.22)', '--warning': '#fbbf24', '--danger': '#f87171', '--ok': '#4ade80',
      '--code-bg': '#0a0f1e', '--code-highlight': 'rgba(255,209,102,0.13)', '--code-evidence': 'rgba(96,165,250,0.18)', '--shadow': '0 12px 40px rgba(0,0,0,0.45)',
    },
  },
  {
    id: 'paper', name: 'Paper', dark: false,
    background: ['#f4f1ea', '#e9e4d8'], grid: 'rgba(60,50,30,0.05)',
    entity: {
      repository: hsl(40, 18, 86), application: hsl(38, 22, 80), 'application:laravel': hsl(8, 34, 84), 'application:nextjs': hsl(205, 30, 84), group: hsl(268, 25, 80), directory: hsl(205, 22, 78),
      file: hsl(199, 50, 62), class: hsl(150, 40, 58), controller: hsl(26, 78, 60), component: hsl(286, 45, 66),
      function: hsl(170, 42, 55), method: hsl(45, 80, 58), route: hsl(330, 60, 64), api_endpoint: hsl(352, 66, 62),
      model: hsl(100, 40, 55), database_table: hsl(40, 40, 60),
    },
    fallbackEntity: hsl(210, 10, 70), depthStep: -2.6, wallShade: [0.72, 0.84], outline: 'rgba(40,30,10,0.22)',
    text: { primary: '#1d1a14', secondary: '#5e5646', halo: 'rgba(250,247,240,0.9)', district: '#3a3324' },
    selection: '#d9480f', hover: '#1c7ed6', focusRing: '#d9480f',
    relation: { imports: '#1c7ed6', exports: '#2b8a3e', handles: '#d9480f', routes_to: '#c2255c', requests: '#e67700', extends: '#7048e8', implements: '#7048e8', calls: '#0c8599', renders: '#ae3ec9', reads: '#2f9e44', writes: '#e03131', queries: '#2f9e44', maps_to: '#f08c00' },
    fallbackRelation: '#495057',
    flow: { step: '#d9480f', declared: '#868e96', indicator: '#fff4e6', dimAlpha: 0.22 },
    diagnostic: '#e67700', dimAlpha: 0.38,
    ui: {
      '--bg': '#f4f1ea', '--panel': 'rgba(255,253,248,0.95)', '--panel-solid': '#fffdf8', '--panel-border': 'rgba(60,50,30,0.14)',
      '--text': '#1d1a14', '--muted': '#5e5646', '--subtle': '#8a8170', '--accent': '#d9480f', '--accent-ink': '#ffffff', '--link': '#1864ab',
      '--chip': 'rgba(60,50,30,0.07)', '--chip-active': 'rgba(217,72,15,0.14)', '--warning': '#b35c00', '--danger': '#c92a2a', '--ok': '#2b8a3e',
      '--code-bg': '#fbf8f1', '--code-highlight': 'rgba(217,72,15,0.12)', '--code-evidence': 'rgba(28,126,214,0.13)', '--shadow': '0 12px 32px rgba(60,50,30,0.16)',
    },
  },
];
export function themeById(id: string | undefined): Theme { return THEMES.find(theme => theme.id === id) ?? THEMES[0]!; }

export interface Palette { top: string; left: string; right: string; hoverTop: string }
/** Memoized fills for a (theme, type, depth) combination. */
export class PaletteCache {
  private readonly cache = new Map<string, Palette>();
  constructor(readonly theme: Theme) {}
  get(type: string, depth: number): Palette {
    const key = `${type}:${depth}`;
    let palette = this.cache.get(key);
    if (!palette) {
      const base = this.theme.entity[type] ?? this.theme.entity[type.split(':')[0]!] ?? this.theme.fallbackEntity;
      const structural = type === 'directory' || type === 'group' || type.startsWith('application');
      const l = Math.max(4, Math.min(96, base.l + (structural ? depth * this.theme.depthStep : 0)));
      const color = (lightness: number) => `hsl(${base.h} ${base.s}% ${Math.max(2, Math.min(98, lightness)).toFixed(1)}%)`;
      palette = { top: color(l), left: color(l * this.theme.wallShade[0]), right: color(l * this.theme.wallShade[1]), hoverTop: color(l + (this.theme.dark ? 9 : -7)) };
      this.cache.set(key, palette);
    }
    return palette;
  }
}
