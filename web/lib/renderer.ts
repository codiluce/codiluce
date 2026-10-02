// Canvas 2D renderer for the isometric map. Stateless per frame: everything it
// draws comes from the visible set, the camera and a RenderState.
import type { NodeSummary } from '@engine/projection/dto';
import { ISO_X, ISO_Y, worldToScreen, type Camera, type Point, type Viewport } from './camera';
import type { LodConfig } from './lod';
import type { Scene, VisibleItem, VisibleSet } from './scene';
import { PaletteCache, type Theme } from './themes';
import { compactNumber, typeLabel } from './format';

export interface EdgeOverlay { key: string; from: string; to: string; fromAncestors: string[]; toAncestors: string[]; type: string; count: number; emphasized?: boolean; change?: 'added' | 'removed' }
export interface FlowOverlay {
  steps: { entityId: string; ancestors: string[]; missing: boolean }[];
  /** Per gap between step i and i+1: graph relationship type if one exists. */
  links: { relationType?: string }[];
  current: number; progress: number; active: boolean;
}
export interface SourceOverlay { nodeId: string; start: number; lines: string[]; focus?: { startLine: number; endLine: number } }
export interface RenderState {
  selectedId?: string; hoveredId?: string;
  /** When set, nodes outside it (and outside their ancestors) are dimmed. */
  emphasis?: Set<string>;
  edges: EdgeOverlay[];
  flow?: FlowOverlay;
  showDiagnostics: boolean;
  source?: SourceOverlay;
  /** Unresolved outgoing calls of the selection, drawn as dangling stubs. */
  unresolved?: { nodeId: string; count: number };
  /** Comparison view: draw change status; optionally fade what did not change. */
  comparison?: { dimUnchanged: boolean };
  time: number;
  reducedMotion: boolean;
}
interface Label { x: number; y: number; lines: { text: string; font: string; color: string }[]; priority: number; align: 'center' | 'above' }
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

export class MapRenderer {
  private palettes: PaletteCache;
  constructor(private theme: Theme) { this.palettes = new PaletteCache(theme); }
  setTheme(theme: Theme): void { this.theme = theme; this.palettes = new PaletteCache(theme); }

  render(ctx: CanvasRenderingContext2D, dpr: number, viewport: Viewport, camera: Camera, scene: Scene, set: VisibleSet, state: RenderState, lod: LodConfig): void {
    const theme = this.theme;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const gradient = ctx.createLinearGradient(0, 0, 0, viewport.height);
    gradient.addColorStop(0, theme.background[0]); gradient.addColorStop(1, theme.background[1]);
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, viewport.width, viewport.height);
    this.grid(ctx, viewport, camera);

    const emphasis = state.emphasis ? this.expandEmphasis(scene, state.emphasis) : undefined;
    const flowSet = state.flow?.active ? this.expandEmphasis(scene, new Set(state.flow.steps.filter(step => !step.missing).flatMap(step => [step.entityId]))) : undefined;
    const labels: Label[] = [];
    for (const item of set.items) {
      const dimmed = (flowSet && !flowSet.has(item.node.id)) || (!flowSet && emphasis && !emphasis.has(item.node.id));
      const alpha = item.alpha * (dimmed ? (flowSet ? theme.flow.dimAlpha : theme.dimAlpha) : 1) * (state.comparison ? this.changeAlpha(item, state.comparison) : 1);
      if (alpha <= 0.01) continue;
      this.prism(ctx, viewport, camera, item, alpha, item.node.id === state.hoveredId);
      if (state.comparison) this.changeOverlay(ctx, viewport, camera, item, alpha);
      if (state.showDiagnostics && !item.open && item.node.diagnostics > 0 && item.size > 10) this.diagnosticMarker(ctx, viewport, camera, item, alpha);
      this.collectLabel(labels, viewport, camera, item, state, alpha, dimmed ?? false);
    }
    const selected = state.selectedId ? set.items[set.index.get(state.selectedId) ?? -1] : undefined;
    if (selected) this.outline(ctx, viewport, camera, selected, theme.selection, 2.5, true);
    else if (state.selectedId) {
      // Selected entity hidden at this LOD: ring its visible ancestor.
      const representative = scene.representative(state.selectedId, set);
      if (representative) this.outline(ctx, viewport, camera, representative, theme.selection, 1.5, false, [5, 4]);
    }
    const hovered = state.hoveredId ? set.items[set.index.get(state.hoveredId) ?? -1] : undefined;
    if (hovered && hovered !== selected) this.outline(ctx, viewport, camera, hovered, theme.hover, 1.5, false);
    if (state.source && selected && selected.node.id === state.source.nodeId && selected.size >= lod.sourcePx) this.sourceFace(ctx, viewport, camera, selected, state.source);
    this.edges(ctx, viewport, camera, set, state.edges);
    if (state.unresolved && state.unresolved.count > 0) this.unresolvedStub(ctx, viewport, camera, scene, set, state.unresolved);
    if (state.flow) this.flow(ctx, viewport, camera, set, state.flow, state);
    this.labels(ctx, labels);
  }
  private expandEmphasis(scene: Scene, ids: Set<string>): Set<string> {
    // Keep ancestors lit so emphasized nodes are not drawn on dimmed platforms.
    const result = new Set<string>();
    for (const id of ids) {
      for (let node: NodeSummary | undefined = scene.nodes.get(id); node; node = node.spatialParentId ? scene.nodes.get(node.spatialParentId) : undefined) {
        if (result.has(node.id)) break;
        result.add(node.id);
      }
      result.add(id);
    }
    return result;
  }
  private grid(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera): void {
    // Ground grid with spacing that adapts to zoom (powers of 4 world units).
    const spacing = 4 ** Math.ceil(Math.log(48 / camera.scale) / Math.log(4));
    const corners = [[0, 0], [viewport.width, 0], [0, viewport.height], [viewport.width, viewport.height]].map(([sx, sy]) => {
      const px = (sx! - viewport.width / 2) / camera.scale + camera.x, py = (sy! - viewport.height / 2) / camera.scale + camera.y;
      const a = px / ISO_X, b = py / ISO_Y;
      return { x: (a + b) / 2, y: (b - a) / 2 };
    });
    const minX = Math.min(...corners.map(c => c.x)), maxX = Math.max(...corners.map(c => c.x));
    const minY = Math.min(...corners.map(c => c.y)), maxY = Math.max(...corners.map(c => c.y));
    if ((maxX - minX) / spacing > 400 || (maxY - minY) / spacing > 400) return;
    ctx.strokeStyle = this.theme.grid; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = Math.floor(minX / spacing) * spacing; x <= maxX; x += spacing) {
      const a = worldToScreen(camera, viewport, x, minY), b = worldToScreen(camera, viewport, x, maxY);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    for (let y = Math.floor(minY / spacing) * spacing; y <= maxY; y += spacing) {
      const a = worldToScreen(camera, viewport, minX, y), b = worldToScreen(camera, viewport, maxX, y);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
  }
  private corners(viewport: Viewport, camera: Camera, item: VisibleItem, z: number): [Point, Point, Point, Point] {
    const { x, y, w, h } = item.node.rect;
    return [worldToScreen(camera, viewport, x, y, z), worldToScreen(camera, viewport, x + w, y, z), worldToScreen(camera, viewport, x + w, y + h, z), worldToScreen(camera, viewport, x, y + h, z)];
  }
  private prism(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera, item: VisibleItem, alpha: number, hovered: boolean): void {
    const palette = this.palettes.get(item.node.type === 'application' && item.node.detail ? `application:${item.node.detail}` : item.node.type, item.node.depth);
    const top = this.corners(viewport, camera, item, item.zTop);
    ctx.globalAlpha = alpha;
    const wallPx = (item.zTop - item.zBase) * camera.scale;
    if (wallPx >= 0.75 && item.size > 3) {
      const bottom = this.corners(viewport, camera, item, item.zBase);
      ctx.fillStyle = palette.left; polygon(ctx, [top[3], top[2], bottom[2], bottom[3]]); ctx.fill();
      ctx.fillStyle = palette.right; polygon(ctx, [top[1], top[2], bottom[2], bottom[1]]); ctx.fill();
    }
    ctx.fillStyle = hovered ? palette.hoverTop : palette.top;
    polygon(ctx, top); ctx.fill();
    if (item.size > 14) { ctx.strokeStyle = this.theme.outline; ctx.lineWidth = 1; ctx.stroke(); }
    if (item.node.kind === 'group' && item.size > 30) {
      // Projection districts get a dashed rim: they are spatial groupings, not entities.
      ctx.setLineDash([4, 4]); ctx.strokeStyle = this.theme.text.secondary; ctx.lineWidth = 1; polygon(ctx, top); ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.globalAlpha = 1;
  }
  /** Comparison fading: ghosts are translucent; with dimming on, blocks with nothing changed in or below them recede. */
  private changeAlpha(item: VisibleItem, comparison: NonNullable<RenderState['comparison']>): number {
    const change = item.node.change;
    if (change?.status === 'removed') return this.theme.change.ghostAlpha;
    if (!comparison.dimUnchanged || item.node.type === 'repository') return 1;
    return change || item.node.changes ? 1 : this.theme.change.unchangedAlpha;
  }
  private changeOverlay(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera, item: VisibleItem, alpha: number): void {
    const node = item.node, colors = this.theme.change;
    const status = node.change?.status;
    if (item.size < 4) return;
    const top = this.corners(viewport, camera, item, item.zTop);
    if (status && status !== 'unchanged') {
      const color = colors[status];
      ctx.save();
      // Open containers keep their children readable: outline only.
      if (!item.open) { ctx.globalAlpha = alpha * (status === 'removed' ? 0.35 : 0.42); ctx.fillStyle = color; polygon(ctx, top); ctx.fill(); }
      ctx.globalAlpha = Math.min(1, alpha * 1.6);
      ctx.strokeStyle = color; ctx.lineWidth = item.open ? 2 : 1.6; ctx.lineJoin = 'round';
      if (status === 'removed') ctx.setLineDash([5, 4]);
      polygon(ctx, top); ctx.stroke();
      ctx.restore();
    } else if (node.change?.facets.length && item.size > 10) {
      // Only its relationships or findings changed: a dotted rim.
      ctx.save(); ctx.globalAlpha = alpha; ctx.strokeStyle = colors.modified; ctx.lineWidth = 1.2; ctx.setLineDash([1.5, 3]); polygon(ctx, top); ctx.stroke(); ctx.restore();
    }
    const counts = node.changes;
    if (counts && !item.open && item.size > 34 && status !== 'removed') this.changeBadge(ctx, viewport, camera, item, counts, alpha);
  }
  /** Changes hidden inside a closed area: one count per status. */
  private changeBadge(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera, item: VisibleItem, counts: NonNullable<NodeSummary['changes']>, alpha: number): void {
    const parts = ([['added', '+'], ['modified', '~'], ['moved', '→'], ['removed', '−']] as const).filter(([key]) => counts[key] > 0);
    if (!parts.length) return;
    const { x, y, w, h } = item.node.rect;
    const anchor = worldToScreen(camera, viewport, x + w * 0.5, y + Math.min(h, w) * 0.08, item.zTop);
    ctx.save();
    ctx.globalAlpha = Math.max(0.6, alpha);
    ctx.font = `700 10px ${FONT}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    const texts = parts.map(([key, glyph]) => ({ key, text: `${glyph}${compactNumber(counts[key])}` }));
    const widths = texts.map(part => ctx.measureText(part.text).width);
    const total = widths.reduce((sum, width) => sum + width, 0) + 8 * (texts.length - 1) + 12;
    let cursor = anchor.x - total / 2;
    ctx.fillStyle = this.theme.dark ? 'rgba(8,12,26,0.82)' : 'rgba(255,253,248,0.92)';
    roundRect(ctx, cursor, anchor.y - 8, total, 16, 8); ctx.fill();
    cursor += 6;
    texts.forEach((part, i) => { ctx.fillStyle = this.theme.change[part.key]; ctx.fillText(part.text, cursor, anchor.y + 0.5); cursor += widths[i]! + 8; });
    ctx.restore();
  }
  private outline(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera, item: VisibleItem, color: string, width: number, glow: boolean, dash?: number[]): void {
    const top = this.corners(viewport, camera, item, item.zTop);
    ctx.save();
    if (glow) { ctx.shadowColor = color; ctx.shadowBlur = 14; }
    if (dash) ctx.setLineDash(dash);
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'round';
    polygon(ctx, top); ctx.stroke();
    ctx.restore();
  }
  private diagnosticMarker(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera, item: VisibleItem, alpha: number): void {
    const { x, y, w } = item.node.rect;
    const p = worldToScreen(camera, viewport, x + w * 0.82, y + Math.min(item.node.rect.h, w) * 0.18, item.zTop);
    const r = Math.min(7, 3 + item.size / 40);
    ctx.globalAlpha = Math.max(0.5, alpha);
    ctx.fillStyle = this.theme.diagnostic;
    ctx.beginPath(); ctx.moveTo(p.x, p.y - r); ctx.lineTo(p.x + r, p.y); ctx.lineTo(p.x, p.y + r); ctx.lineTo(p.x - r, p.y); ctx.closePath(); ctx.fill();
    if (item.size > 60) {
      ctx.font = `600 10px ${FONT}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 3; ctx.strokeStyle = this.theme.text.halo; ctx.strokeText(String(item.node.diagnostics), p.x + r + 2, p.y);
      ctx.fillStyle = this.theme.diagnostic; ctx.fillText(String(item.node.diagnostics), p.x + r + 2, p.y);
    }
    ctx.globalAlpha = 1;
  }
  private collectLabel(labels: Label[], viewport: Viewport, camera: Camera, item: VisibleItem, state: RenderState, alpha: number, dimmed: boolean): void {
    if (item.tier === 'hidden' || alpha < 0.25) return;
    const node = item.node, theme = this.theme;
    const important = node.id === state.selectedId || node.id === state.hoveredId;
    const color = dimmed ? theme.text.secondary : theme.text.primary;
    if (item.tier === 'district') {
      // The repository name is already in the header; its label would hide the first area.
      if (node.type === 'repository') return;
      const top = worldToScreen(camera, viewport, node.rect.x, node.rect.y, item.zTop);
      const size = node.type === 'application' ? 15 : node.type === 'repository' ? 13 : 11;
      const text = `${state.comparison ? changeGlyph(node) : ''}${node.type === 'repository' ? node.name : node.kind === 'group' ? `${node.name}` : node.type === 'directory' ? `${node.name}/` : node.name}`;
      labels.push({ x: top.x, y: top.y - 4, align: 'above', priority: 1e9 - node.depth * 1e6 + item.size, lines: [{ text, font: `${node.type === 'application' ? 700 : 600} ${size}px ${FONT}`, color: theme.text.district }] });
      return;
    }
    const { x, y, w, h } = node.rect;
    const center = worldToScreen(camera, viewport, x + w / 2, y + h / 2, item.zTop);
    const big = node.type === 'application';
    const nameSize = big ? Math.min(22, 13 + item.size / 60) : Math.min(14, 10 + item.size / 70);
    const lines: Label['lines'] = [{ text: `${state.comparison ? changeGlyph(node) : ''}${displayName(node)}`, font: `${big || important ? 700 : 600} ${nameSize.toFixed(1)}px ${FONT}`, color }];
    if (item.tier === 'summary' || item.tier === 'detail') {
      const summary = summaryLine(node);
      if (summary) lines.push({ text: summary, font: `500 ${Math.max(9.5, nameSize - 2.5).toFixed(1)}px ${FONT}`, color: theme.text.secondary });
    }
    if (item.tier === 'detail') {
      const detail = detailLine(node);
      if (detail) lines.push({ text: detail, font: `400 ${Math.max(9, nameSize - 3).toFixed(1)}px ${node.detail?.startsWith('(') ? MONO : FONT}`, color: theme.text.secondary });
    }
    labels.push({ x: center.x, y: center.y, align: 'center', priority: (important ? 2e9 : 0) + item.size, lines });
  }
  private labels(ctx: CanvasRenderingContext2D, labels: Label[]): void {
    labels.sort((a, b) => b.priority - a.priority);
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
    ctx.textBaseline = 'middle'; ctx.textAlign = 'center'; ctx.lineJoin = 'round';
    let count = 0;
    for (const label of labels) {
      if (count > 450) break;
      let width = 0, height = 0;
      const metrics = label.lines.map(line => { ctx.font = line.font; const w = Math.min(320, ctx.measureText(line.text).width); const h = parseFloat(/(\d+(?:\.\d+)?)px/.exec(line.font)![1]!) * 1.25; width = Math.max(width, w); height += h; return { w, h }; });
      const y0 = label.align === 'above' ? label.y - height : label.y - height / 2;
      const box = { x0: label.x - width / 2 - 3, y0: y0 - 2, x1: label.x + width / 2 + 3, y1: y0 + height + 2 };
      if (placed.some(other => box.x0 < other.x1 && box.x1 > other.x0 && box.y0 < other.y1 && box.y1 > other.y0)) continue;
      placed.push(box); count++;
      let cursor = y0;
      label.lines.forEach((line, i) => {
        const h = metrics[i]!.h;
        ctx.font = line.font;
        const text = fit(ctx, line.text, 320);
        ctx.lineWidth = 3.5; ctx.strokeStyle = this.theme.text.halo; ctx.strokeText(text, label.x, cursor + h / 2);
        ctx.fillStyle = line.color; ctx.fillText(text, label.x, cursor + h / 2);
        cursor += h;
      });
    }
  }
  private anchor(viewport: Viewport, camera: Camera, item: VisibleItem): Point {
    const { x, y, w, h } = item.node.rect;
    return worldToScreen(camera, viewport, x + w / 2, y + h / 2, item.zTop);
  }
  private resolve(set: VisibleSet, id: string, ancestors: string[]): { item: VisibleItem; hidden: boolean } | undefined {
    const direct = set.index.get(id);
    if (direct !== undefined) return { item: set.items[direct]!, hidden: false };
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const index = set.index.get(ancestors[i]!);
      if (index !== undefined) return { item: set.items[index]!, hidden: true };
    }
    return undefined;
  }
  private edges(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera, set: VisibleSet, edges: EdgeOverlay[]): void {
    const drawn = new Map<string, { from: Point; to: Point; count: number; color: string; hidden: boolean; emphasized: boolean; change?: 'added' | 'removed' }>();
    for (const edge of edges) {
      const from = this.resolve(set, edge.from, edge.fromAncestors), to = this.resolve(set, edge.to, edge.toAncestors);
      if (!from || !to || from.item === to.item) continue;
      // Merge edges that collapse onto the same visible endpoints at this LOD.
      const key = `${from.item.node.id}>${to.item.node.id}>${edge.type}>${edge.change ?? ''}`;
      const existing = drawn.get(key);
      if (existing) { existing.count += edge.count; existing.emphasized ||= !!edge.emphasized; continue; }
      drawn.set(key, { from: this.anchor(viewport, camera, from.item), to: this.anchor(viewport, camera, to.item), count: edge.count, color: this.theme.relation[edge.type] ?? this.theme.fallbackRelation, hidden: from.hidden || to.hidden, emphasized: !!edge.emphasized, ...(edge.change ? { change: edge.change } : {}) });
    }
    for (const edge of drawn.values()) {
      const { from, to } = edge;
      const dx = to.x - from.x, dy = to.y - from.y, distance = Math.hypot(dx, dy);
      const control = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 - Math.min(220, distance * 0.35 + 20) };
      ctx.save();
      const width = Math.min(5, 1.4 + Math.log2(edge.count) * 0.8) + (edge.emphasized ? 1.2 : 0);
      if (edge.change === 'added') {
        // Added since the baseline: a halo in the added color under the typed edge.
        ctx.strokeStyle = this.theme.change.added; ctx.globalAlpha = 0.45; ctx.lineWidth = width + 5;
        ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.quadraticCurveTo(control.x, control.y, to.x, to.y); ctx.stroke();
      }
      ctx.strokeStyle = edge.change === 'removed' ? this.theme.change.removed : edge.color; ctx.globalAlpha = edge.change === 'removed' ? 0.75 : edge.emphasized ? 1 : 0.85;
      ctx.lineWidth = width;
      if (edge.hidden || edge.change === 'removed') ctx.setLineDash(edge.change === 'removed' ? [3, 5] : [6, 5]);
      ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.quadraticCurveTo(control.x, control.y, to.x, to.y); ctx.stroke();
      ctx.setLineDash([]);
      if (edge.change === 'removed') edge.color = this.theme.change.removed;
      // Arrowhead along the curve tangent at the target.
      const angle = Math.atan2(to.y - control.y, to.x - control.x), size = 7 + ctx.lineWidth;
      ctx.fillStyle = edge.color; ctx.beginPath();
      ctx.moveTo(to.x, to.y); ctx.lineTo(to.x - size * Math.cos(angle - 0.4), to.y - size * Math.sin(angle - 0.4)); ctx.lineTo(to.x - size * Math.cos(angle + 0.4), to.y - size * Math.sin(angle + 0.4)); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.arc(from.x, from.y, 3, 0, Math.PI * 2); ctx.fill();
      if (edge.count > 1) {
        const mid = { x: 0.25 * from.x + 0.5 * control.x + 0.25 * to.x, y: 0.25 * from.y + 0.5 * control.y + 0.25 * to.y };
        const text = compactNumber(edge.count);
        ctx.font = `700 10px ${FONT}`; const width = ctx.measureText(text).width + 10;
        ctx.fillStyle = edge.color; roundRect(ctx, mid.x - width / 2, mid.y - 8, width, 16, 8); ctx.fill();
        ctx.fillStyle = this.theme.dark ? '#0b1020' : '#ffffff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, mid.x, mid.y + 0.5);
      }
      ctx.restore();
    }
  }
  private unresolvedStub(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera, scene: Scene, set: VisibleSet, unresolved: { nodeId: string; count: number }): void {
    const node = scene.nodes.get(unresolved.nodeId);
    const target = node ? this.resolve(set, node.id, ancestorChain(scene, node)) : undefined;
    if (!target) return;
    const from = this.anchor(viewport, camera, target.item);
    const to = { x: from.x + 70, y: from.y - 62 };
    ctx.save();
    ctx.strokeStyle = this.theme.diagnostic; ctx.lineWidth = 1.6; ctx.setLineDash([3, 4]);
    ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.quadraticCurveTo(from.x + 10, to.y, to.x, to.y); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = this.theme.diagnostic; ctx.beginPath(); ctx.arc(to.x, to.y, 9, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = this.theme.dark ? '#0b1020' : '#fff'; ctx.font = `800 12px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('?', to.x, to.y + 0.5);
    ctx.font = `600 10.5px ${FONT}`; ctx.textAlign = 'left'; ctx.lineWidth = 3; ctx.strokeStyle = this.theme.text.halo;
    const text = `${unresolved.count} unresolved HTTP call${unresolved.count === 1 ? '' : 's'}`;
    ctx.strokeText(text, to.x + 13, to.y); ctx.fillStyle = this.theme.diagnostic; ctx.fillText(text, to.x + 13, to.y);
    ctx.restore();
  }
  private flow(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera, set: VisibleSet, flow: FlowOverlay, state: RenderState): void {
    const points = flow.steps.map(step => step.missing ? undefined : this.resolve(set, step.entityId, step.ancestors));
    const anchors = points.map(point => point ? this.anchor(viewport, camera, point.item) : undefined);
    const curve = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - Math.min(160, Math.hypot(b.x - a.x, b.y - a.y) * 0.3 + 16) });
    ctx.save();
    for (let i = 0; i < flow.links.length; i++) {
      const a = anchors[i], b = anchors[i + 1];
      if (!a || !b) continue;
      const link = flow.links[i]!, c = curve(a, b);
      ctx.strokeStyle = link.relationType ? (this.theme.relation[link.relationType] ?? this.theme.flow.step) : this.theme.flow.declared;
      ctx.lineWidth = link.relationType ? 3 : 2;
      ctx.setLineDash(link.relationType ? [] : [7, 6]);
      ctx.globalAlpha = i === flow.current ? 1 : 0.75;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(c.x, c.y, b.x, b.y); ctx.stroke();
    }
    ctx.setLineDash([]); ctx.globalAlpha = 1;
    anchors.forEach((point, i) => {
      if (!point) return;
      const current = i === flow.current;
      const radius = current ? 13 : 10;
      if (current && flow.active && !state.reducedMotion) {
        const pulse = (state.time % 1400) / 1400;
        ctx.strokeStyle = this.theme.flow.step; ctx.globalAlpha = 1 - pulse; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(point.x, point.y, radius + pulse * 16, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1;
      }
      ctx.fillStyle = current ? this.theme.flow.step : this.theme.dark ? '#1e2747' : '#ffffff';
      ctx.strokeStyle = this.theme.flow.step; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(point.x, point.y, radius, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = current ? (this.theme.dark ? '#1b1400' : '#ffffff') : this.theme.flow.step;
      ctx.font = `800 ${current ? 12 : 11}px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(i + 1), point.x, point.y + 0.5);
    });
    // Moving indicator between the current step and the next one.
    const a = anchors[flow.current], b = anchors[flow.current + 1];
    if (flow.active && a && b && flow.progress > 0) {
      const c = curve(a, b), t = state.reducedMotion ? 1 : flow.progress;
      const p = { x: (1 - t) ** 2 * a.x + 2 * (1 - t) * t * c.x + t * t * b.x, y: (1 - t) ** 2 * a.y + 2 * (1 - t) * t * c.y + t * t * b.y };
      ctx.shadowColor = this.theme.flow.step; ctx.shadowBlur = 18; ctx.fillStyle = this.theme.flow.indicator;
      ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
  private sourceFace(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera, item: VisibleItem, source: SourceOverlay): void {
    // Street-level detail: source lines drawn onto the top face in its own plane.
    const { x, y, w, h } = item.node.rect;
    const origin = worldToScreen(camera, viewport, x, y, item.zTop);
    const k = camera.scale;
    // Lines are sized in screen pixels (13–22px) and clipped to the face, starting at the symbol.
    const first = Math.max(0, (source.focus?.startLine ?? source.start) - source.start);
    const lines = source.lines.slice(first);
    const lineHeight = Math.min(22 / k, Math.max(13 / k, h / (lines.length + 1)));
    if (lineHeight * k < 12) return;
    ctx.save();
    ctx.transform(ISO_X * k, ISO_Y * k, -ISO_X * k, ISO_Y * k, origin.x, origin.y);
    ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.clip();
    ctx.fillStyle = this.theme.dark ? 'rgba(6,10,22,0.82)' : 'rgba(255,253,248,0.88)'; ctx.fillRect(0, 0, w, h);
    ctx.font = `${(lineHeight * 0.78).toFixed(3)}px ${MONO}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    lines.forEach((text, i) => {
      const line = source.start + first + i, top = lineHeight * (i + 1);
      if (top > h) return;
      const highlighted = source.focus && line >= source.focus.startLine && line <= source.focus.endLine;
      if (highlighted) { ctx.fillStyle = this.theme.dark ? 'rgba(255,209,102,0.16)' : 'rgba(217,72,15,0.12)'; ctx.fillRect(0, top - lineHeight / 2, w, lineHeight); }
      ctx.fillStyle = this.theme.text.secondary; ctx.fillText(String(line).padStart(4), lineHeight * 0.4, top);
      ctx.fillStyle = this.theme.text.primary; ctx.fillText(text.replace(/\t/g, '  '), lineHeight * 3.4, top);
    });
    ctx.restore();
  }
}
function ancestorChain(scene: Scene, node: NodeSummary): string[] {
  const chain: string[] = [];
  for (let current = node.spatialParentId ? scene.nodes.get(node.spatialParentId) : undefined; current; current = current.spatialParentId ? scene.nodes.get(current.spatialParentId) : undefined) chain.unshift(current.id);
  return chain;
}
function polygon(ctx: CanvasRenderingContext2D, points: Point[]): void {
  ctx.beginPath(); ctx.moveTo(points[0]!.x, points[0]!.y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i]!.x, points[i]!.y);
  ctx.closePath();
}
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function fit(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let low = 0, high = text.length;
  while (low < high) { const mid = (low + high + 1) >> 1; if (ctx.measureText(`${text.slice(0, mid)}…`).width <= max) low = mid; else high = mid - 1; }
  return `${text.slice(0, low)}…`;
}
/** Status glyph so changes read without relying on color alone. */
export function changeGlyph(node: Pick<NodeSummary, 'change'>): string {
  switch (node.change?.status) {
    case 'added': return '+ ';
    case 'removed': return '− ';
    case 'modified': return '~ ';
    case 'moved': return '→ ';
    default: return '';
  }
}
export function displayName(node: Pick<NodeSummary, 'type' | 'name' | 'kind'>): string {
  return node.type === 'directory' ? `${node.name}/` : node.name;
}
/** One-line summary for closed nodes at intermediate zoom. Missing metrics are omitted, never zero. */
export function summaryLine(node: NodeSummary): string | undefined {
  const s = node.stats;
  switch (node.type) {
    case 'application': case 'repository': case 'directory': case 'group': {
      const parts: string[] = [];
      if (s.files) parts.push(`${compactNumber(s.files)} file${s.files === 1 ? '' : 's'}`);
      if (s.endpoints && (node.type !== 'directory')) parts.push(`${compactNumber(s.endpoints)} route${s.endpoints === 1 ? '' : 's'}`);
      if (!s.files && !s.endpoints && s.symbols) parts.push(`${compactNumber(s.symbols)} symbols`);
      return parts.join(' · ') || undefined;
    }
    case 'file': return [node.language, node.loc !== undefined ? `${compactNumber(node.loc)} lines` : undefined].filter(Boolean).join(' · ') || 'not analyzed';
    case 'api_endpoint': case 'route': return node.detail ?? typeLabel(node.type);
    default: return typeLabel(node.type, node.role);
  }
}
export function detailLine(node: NodeSummary): string | undefined {
  const s = node.stats;
  switch (node.type) {
    case 'application': case 'repository': case 'directory': case 'group': {
      const parts: string[] = [];
      if (s.measuredLoc) parts.push(`${compactNumber(s.measuredLoc)} measured lines`);
      if (s.symbols && node.type !== 'group') parts.push(`${compactNumber(s.symbols)} symbols`);
      if (node.diagnostics) parts.push(`${node.diagnostics} unresolved`);
      return parts.join(' · ') || node.detail;
    }
    case 'file': return node.stats.symbols ? `${node.stats.symbols} symbol${node.stats.symbols === 1 ? '' : 's'}${node.diagnostics ? ` · ${node.diagnostics} unresolved` : ''}` : node.diagnostics ? `${node.diagnostics} unresolved` : undefined;
    case 'api_endpoint': case 'route': return node.path ? `${node.path.split('/').slice(-2).join('/')}${node.sourceRange ? `:${node.sourceRange.startLine}` : ''}` : undefined;
    default: return node.detail ?? (node.sourceRange ? `lines ${node.sourceRange.startLine}–${node.sourceRange.endLine}` : undefined);
  }
}
