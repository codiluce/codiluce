// Client side of the history time-lapse: frames from /api/history/evolution
// materialized into scenes that the map draws while scrubbing or playing.
// A frame's scene holds the same nodes in the same places as the settled view
// of that commit compared with the previous one, so swapping in the settled
// view afterwards only adds detail (findings, relationships, lazy children).
import type { EvolutionFrame, EvolutionNode, EvolutionResponse, NodeStats, NodeSummary } from '@engine/projection/dto';
import { Scene } from './scene';

export type EvolutionData = Extract<EvolutionResponse, { status: 'ready' }>;
export type EvolutionStatus = 'added' | 'modified' | 'moved' | 'removed';
const STATUS: (EvolutionStatus | undefined)[] = [undefined, 'added', 'modified', 'moved', 'removed'];
const SYMBOL_TYPES = new Set(['class', 'controller', 'component', 'function', 'method', 'model', 'test']);
const INTERFACE_TYPES = new Set(['route', 'api_endpoint']);
/** Every KEYFRAME-th frame's placements are kept, so any frame is at most KEYFRAME - 1 deltas away. */
const KEYFRAME = 16, SCENE_CACHE = 24;
/** A node in a frame: [parent, x, y, w, h, loc]. */
type Placement = number[];

export class Evolution {
  readonly nodes: EvolutionNode[];
  readonly frames: EvolutionFrame[];
  readonly stamp: string;
  private readonly frameBySnapshot = new Map<string, number>();
  private readonly keyframes = new Map<number, Map<number, Placement>>();
  private readonly scenes = new Map<string, Scene>();
  constructor(data: EvolutionData) {
    this.nodes = data.nodes; this.frames = data.frames; this.stamp = data.stamp;
    data.frames.forEach((frame, index) => this.frameBySnapshot.set(frame.snapshot, index));
  }
  get length(): number { return this.frames.length; }
  frameOf(snapshot: string | undefined): number | undefined { return snapshot === undefined ? undefined : this.frameBySnapshot.get(snapshot); }
  snapshotAt(frame: number): string { return this.frames[frame]!.snapshot; }
  /** Entities changed in a frame, by status. */
  counts(frame: number): Record<EvolutionStatus, number> {
    const counts = { added: 0, modified: 0, moved: 0, removed: 0 };
    for (const [, status] of this.frames[frame]?.changes ?? []) counts[STATUS[status!]!]++;
    return counts;
  }
  /** Where every node of a frame is. */
  placements(frame: number): Map<number, Placement> {
    const base = Math.floor(frame / KEYFRAME) * KEYFRAME;
    const state = new Map(this.keyframe(base));
    for (let index = base + 1; index <= frame; index++) apply(state, this.frames[index]!);
    return state;
  }
  private keyframe(base: number): Map<number, Placement> {
    let from = base;
    while (from > 0 && !this.keyframes.has(from)) from -= KEYFRAME;
    let state = this.keyframes.get(from);
    if (!state) { state = new Map(); apply(state, this.frames[0]!); this.keyframes.set(0, state); }
    for (let key = from + KEYFRAME; key <= base; key += KEYFRAME) {
      state = new Map(state);
      for (let index = key - KEYFRAME + 1; index <= key; index++) apply(state, this.frames[index]!);
      this.keyframes.set(key, state);
    }
    return state;
  }
  /** The map at a frame, as a fully loaded scene; `ghosts: false` leaves out what the commit removed (snapshot mode). */
  scene(frame: number, options: { ghosts?: boolean } = {}): Scene {
    const ghosts = options.ghosts ?? true, key = `${frame}:${ghosts}`;
    const cached = this.scenes.get(key);
    if (cached) { this.scenes.delete(key); this.scenes.set(key, cached); return cached; }
    const scene = this.build(frame, ghosts);
    this.scenes.set(key, scene);
    if (this.scenes.size > SCENE_CACHE) this.scenes.delete(this.scenes.keys().next().value!);
    return scene;
  }
  private build(frame: number, ghosts: boolean): Scene {
    const placed = this.placements(frame);
    const status = new Map(this.frames[frame]!.changes.map(([node, code]) => [node!, STATUS[code!]!]));
    if (!ghosts) for (const [node, code] of status) if (code === 'removed') { placed.delete(node); status.delete(node); }
    const children = new Map<number, number[]>();
    let root = -1;
    for (const [node, [parent]] of placed) {
      if (parent! < 0) { root = node; continue; }
      if (!placed.has(parent!)) continue;
      let list = children.get(parent!);
      if (!list) children.set(parent!, list = []);
      list.push(node);
    }
    const scene = new Scene();
    scene.frame = frame;
    if (root < 0) return scene;
    // Breadth first, so parents precede children; then statistics bottom-up as the server aggregates them.
    const order = [root], depth = new Map([[root, 0]]);
    for (let i = 0; i < order.length; i++) for (const child of children.get(order[i]!) ?? []) { depth.set(child, depth.get(order[i]!)! + 1); order.push(child); }
    const summaries = new Map<number, NodeSummary>();
    for (const node of order) summaries.set(node, this.summary(node, placed.get(node)!, depth.get(node)!, children.get(node)?.length ?? 0, status.get(node)));
    for (let i = order.length - 1; i >= 0; i--) {
      const node = summaries.get(order[i]!)!, s = node.stats;
      if (node.change?.status !== 'removed') {
        if (node.type === 'file') { s.files++; if (node.loc !== undefined) s.measuredLoc += node.loc; else s.unmeasuredFiles++; }
        else if (SYMBOL_TYPES.has(node.type)) s.symbols++;
        else if (INTERFACE_TYPES.has(node.type)) s.endpoints++;
      }
      const parent = placed.get(order[i]!)![0]!;
      if (parent < 0 || !summaries.has(parent)) continue;
      const p = summaries.get(parent)!.stats;
      p.files += s.files; p.symbols += s.symbols; p.endpoints += s.endpoints; p.measuredLoc += s.measuredLoc; p.unmeasuredFiles += s.unmeasuredFiles; p.descendants += s.descendants + 1;
    }
    // Changes hidden inside closed areas: counts on every ancestor.
    for (const [node, code] of status) {
      for (let parent = placed.get(node)?.[0] ?? -1; parent >= 0 && summaries.has(parent); parent = placed.get(parent)![0]!) {
        const summary = summaries.get(parent)!;
        (summary.changes ??= { added: 0, removed: 0, modified: 0, moved: 0 })[code]++;
      }
    }
    scene.reset(summaries.get(root)!);
    for (const node of order) {
      const list = children.get(node);
      if (list?.length) scene.addChildren(this.nodes[node]!.id, list.map(child => summaries.get(child)!), list.length, false);
    }
    return scene;
  }
  private summary(index: number, [parent, x, y, w, h, loc]: Placement, depth: number, childCount: number, status: EvolutionStatus | undefined): NodeSummary {
    const node = this.nodes[index]!;
    const stats: NodeStats = { files: 0, symbols: 0, endpoints: 0, measuredLoc: 0, unmeasuredFiles: 0, descendants: 0 };
    return {
      id: node.id, kind: node.kind, type: node.type, name: node.name,
      ...(node.path ? { path: node.path } : {}), ...(node.language ? { language: node.language } : {}), ...(node.detail ? { detail: node.detail } : {}),
      ...(parent! >= 0 ? { spatialParentId: this.nodes[parent!]!.id } : {}),
      depth, rect: { x: x!, y: y!, w: w!, h: h! }, childCount, ...(loc! >= 0 ? { loc } : {}),
      diagnostics: 0, stats, ...(status ? { change: { status, facets: [] } } : {}),
    };
  }
}
function apply(state: Map<number, Placement>, frame: EvolutionFrame): void {
  for (const node of frame.drop) state.delete(node);
  for (const [node, ...placement] of frame.set) state.set(node!, placement);
}
