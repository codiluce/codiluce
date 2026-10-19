'use client';
// PROTOTYPE (throwaway) — question: what should agents working on the code look
// like on the map? Characters drawn in code (no image generation): Clawd for
// Claude Code, a cloud with a terminal face for Codex. Four variants that
// disagree on the character and on how it moves:
//   A  Buddies: flat vector characters with props, hopping roof to roof, splitting into copies for parallel reads.
//   B  Pixel crew: pixel art walking the streets (the app's rail router), clones pop in with sparkles.
//   C  Pins: calm tokens showing the character's face, gliding, with a breadcrumb line of their last stops.
//   D  Pixel crew, hopping roof to roof like A.
// What is about no file (thinking, writing the reply, planning, the web, a command, waiting for
// permission, resting) happens outside: the character leaves the map for a mat on the ground
// beside its nearest edge, does it there, and comes back for the next file.
// Sources: a scripted showcase (every pose), the real Codex session the live server observed,
// live polling, or the model sheet (every character in every pose).
import { useEffect, useMemo, useRef, useState } from 'react';
import { project, worldToScreen, type Camera, type Viewport } from '../../../lib/camera';
import { DEFAULT_LOD } from '../../../lib/lod';
import { agentColor } from '../../../lib/activity';
import { railRoute, type RailWorld } from '../../../lib/rails';
import type { Scene, VisibleSet } from '../../../lib/scene';
import { clamp01, ease, fitIso, FONT, loadJson, makeRenderer, MapIndex, nodeHeight, pill, renderState, sceneOf, theme, useCanvas, type N } from './kit';
import { drawBuddy, drawFace, drawPin, drawPixel, drawShadow, drawYard, POSE_LABEL, PROVIDER, sparkle, type Look, type Pose, type Provider } from './characters';

type Kind = 'read' | 'edit' | 'search' | 'command' | 'test' | 'status' | 'spawn' | 'done' | 'think' | 'reply' | 'plan' | 'web';
interface Ev { t: number; actor: string; provider: Provider; title?: string; kind: Kind; phase: 'started' | 'completed' | 'failed' | 'status'; targets: string[]; status?: string; tool?: string; parent?: string; label: string }
interface Point3 { x: number; y: number; z: number }
interface Move { from?: string; to: string; start: number; dur: number; route?: Point3[] }
interface Clone { target: string; tool?: string; start: number; end?: number; move: Move }
interface Actor {
  key: string; provider: Provider; title: string; color: string; parent?: string; mini: boolean; slot: number;
  target?: string; move?: Move; pose: Pose; poseAt: number; last: number; status: string; open: Set<string>; lastFile?: string;
  result?: 'ok' | 'fail'; resultAt?: number; clones: Clone[]; trail: { id: string; at: number }[];
  born: number; gone?: number; facing: 1 | -1; seed: number;
}
interface RawEvent { id: string; at: number; provider: 'codex' | 'claude-code'; actor: string; kind: string; phase: string; paths: { path: string; scope: string }[]; status?: string; toolId?: string; label: string; sessionTitle?: string }
const YARD = 'yard:';
/** Thinking is inferred when a running agent has nothing in flight for this long (live). */
const THINK_AFTER = 2500;

// The showcase: two sessions and a subagent on real files of this repository.
function showcase(index: MapIndex): Ev[] {
  const f = (path: string) => index.byPath.get(path)?.id ?? index.dirs.get(path.replace(/\/$/, ''))?.id;
  const cc = { actor: 'claude-code:showcase', provider: 'claude-code' as const, title: 'Make rails avoid labels' };
  const sub = { actor: 'claude-code:showcase/explore', provider: 'claude-code' as const, title: 'Explore: tree-sitter workers', parent: cc.actor };
  const cx = { actor: 'codex:showcase', provider: 'codex' as const, title: 'Fix history playback' };
  const e = (t: number, who: { actor: string; provider: Provider; title: string; parent?: string }, kind: Kind, phase: Ev['phase'], paths: string[], extra: Partial<Ev> = {}): Ev =>
    ({ t, actor: who.actor, provider: who.provider, title: who.title, kind, phase, targets: paths.map(f).filter((id): id is string => !!id), label: `${kind}${paths.length ? ` ${paths.map(p => p.split('/').pop()).join(', ')}` : ''}`, ...(who.parent ? { parent: who.parent } : {}), ...extra });
  return [
    e(200, cc, 'think', 'status', [], { label: 'prompt: thinking' }),
    e(500, cx, 'think', 'status', [], { label: 'prompt: thinking' }),
    e(1500, cc, 'search', 'started', ['web/lib/'], { tool: 's1', label: 'search “rail” in web/lib/' }),
    e(1700, cx, 'read', 'started', ['src/history/service.ts'], { tool: 'x1' }),
    e(2500, cc, 'search', 'completed', [], { tool: 's1', label: 'search done' }),
    e(2700, cc, 'read', 'started', ['web/lib/rails.ts', 'web/lib/renderer.ts', 'web/lib/scene.ts'], { tool: 'r1', label: 'read 3 files at once' }),
    e(2800, cx, 'read', 'completed', [], { tool: 'x1' }),
    e(3100, cx, 'read', 'started', ['src/projection/evolution.ts', 'web/lib/evolution.ts'], { tool: 'x2', label: 'read 2 files at once' }),
    e(4300, cc, 'read', 'completed', [], { tool: 'r1' }),
    e(4400, cx, 'read', 'completed', [], { tool: 'x2' }),
    e(4500, cc, 'plan', 'started', [], { tool: 'p1', label: 'update the plan' }),
    e(4700, cx, 'web', 'started', [], { tool: 'w1', label: 'search the web' }),
    e(5600, cc, 'plan', 'completed', [], { tool: 'p1' }),
    e(5700, sub, 'spawn', 'status', [], { label: 'subagent starts' }),
    e(5900, cc, 'edit', 'started', ['web/lib/rails.ts'], { tool: 'r2' }),
    e(6000, sub, 'read', 'started', ['src/analysis/tree-sitter/worker.ts'], { tool: 'a1' }),
    e(6300, cx, 'web', 'completed', [], { tool: 'w1' }),
    e(6400, cx, 'command', 'started', [], { tool: 'x3', label: 'run a command' }),
    e(7100, sub, 'read', 'completed', [], { tool: 'a1' }),
    e(7300, sub, 'read', 'started', ['src/analysis/tree-sitter/client.ts', 'src/analysis/tree-sitter/analyzer.ts'], { tool: 'a2' }),
    e(7600, cx, 'command', 'completed', [], { tool: 'x3' }),
    e(7700, cc, 'edit', 'completed', [], { tool: 'r2' }),
    e(7800, cx, 'edit', 'started', ['web/lib/store.ts'], { tool: 'x4' }),
    e(8000, cc, 'test', 'started', [], { tool: 'r3', label: 'run tests' }),
    e(9000, sub, 'read', 'completed', [], { tool: 'a2' }),
    e(9200, cx, 'edit', 'completed', [], { tool: 'x4' }),
    e(9300, cc, 'test', 'completed', [], { tool: 'r3', label: 'tests pass' }),
    e(9400, cx, 'test', 'started', [], { tool: 'x5', label: 'run tests' }),
    e(9600, sub, 'reply', 'status', [], { label: 'subagent writes its report' }),
    e(10600, sub, 'done', 'status', [], { label: 'subagent returns' }),
    e(10700, cc, 'status', 'status', [], { status: 'waiting', label: 'asks for permission' }),
    e(10800, cx, 'test', 'failed', [], { tool: 'x5', label: 'tests fail' }),
    e(11000, cx, 'think', 'status', [], { label: 'thinking about the failure' }),
    e(12200, cx, 'edit', 'started', ['web/lib/store.ts'], { tool: 'x6' }),
    e(12800, cc, 'status', 'status', [], { status: 'running', label: 'permission granted' }),
    e(12900, cc, 'edit', 'started', ['web/lib/renderer.ts'], { tool: 'r4' }),
    e(13200, cx, 'edit', 'completed', [], { tool: 'x6' }),
    e(13400, cx, 'read', 'started', ['web/components/Timeline.tsx'], { tool: 'x7' }),
    e(14200, cx, 'read', 'completed', [], { tool: 'x7' }),
    e(14300, cc, 'edit', 'completed', [], { tool: 'r4' }),
    e(14400, cx, 'test', 'started', [], { tool: 'x8', label: 'run tests' }),
    e(14500, cc, 'reply', 'status', [], { label: 'writes the reply' }),
    e(15800, cx, 'test', 'completed', [], { tool: 'x8', label: 'tests pass' }),
    e(16000, cx, 'reply', 'status', [], { label: 'writes the reply' }),
    e(16500, cc, 'status', 'status', [], { status: 'idle', label: 'turn ends' }),
    e(17600, cx, 'status', 'status', [], { status: 'finished', label: 'session finished' }),
  ];
}
/**
 * Real events on a replay clock (gaps compressed). The hooks observe tools, not
 * the model: a prompt and a long gap after a tool become *thinking*; the gap
 * before a turn ends becomes *writing the reply* (only a replay can look ahead).
 */
function fromRaw(index: MapIndex, raw: RawEvent[], titles: Map<string, string>, start: number, compress: boolean): Ev[] {
  const resolve = (path: { path: string; scope: string }) => (path.scope === 'directory' ? index.dirs.get(path.path.replace(/\/$/, ''))?.id : index.byPath.get(path.path)?.id);
  let t = start, previous: number | undefined;
  const out: Ev[] = [];
  raw.forEach((event, i) => {
    if (compress) { t += previous === undefined ? 300 : Math.min(1400, Math.max(160, (event.at - previous) * 0.2)); previous = event.at; }
    const kind = (['read', 'edit', 'search', 'command', 'test', 'status'].includes(event.kind) ? event.kind : 'command') as Kind;
    const phase = (['started', 'completed', 'failed', 'status'].includes(event.phase) ? event.phase : 'status') as Ev['phase'];
    const targets = event.paths.map(resolve).filter((id): id is string => !!id);
    const title = titles.get(event.actor) ?? event.sessionTitle ?? `${PROVIDER[event.provider].label} ${event.actor.split(':')[1]?.slice(0, 8)}`;
    const base = { actor: event.actor, provider: event.provider, title };
    if (event.label === 'UserPromptSubmit') { out.push({ ...base, t, kind: 'think', phase: 'status', targets: [], label: 'prompt: thinking' }); return; }
    if ((kind === 'read' || kind === 'edit' || kind === 'search') && phase === 'started' && !targets.length) return;
    out.push({ ...base, t, kind, phase, targets, ...(event.status ? { status: event.status } : {}), ...(event.toolId ? { tool: event.toolId } : {}), label: `${event.label}${event.paths.length ? ` ${event.paths.map(p => p.path.split('/').pop()).join(', ')}` : ''}` });
    // Look ahead (replay only): the next event of this actor.
    if (!compress || phase === 'started') return;
    const next = raw.slice(i + 1).find(other => other.actor === event.actor);
    if (!next || next.at - event.at < 4000) return;
    out.push({ ...base, t: t + 120, kind: next.label === 'Stop' ? 'reply' : 'think', phase: 'status', targets: [], label: next.label === 'Stop' ? 'writes the reply' : 'thinking' });
  });
  return out;
}

/** Actors driven by events on a replay clock. */
class Cast {
  actors = new Map<string, Actor>();
  applied: Ev[] = [];
  yards = new Map<string, { x: number; y: number }>();
  private next = 0;
  private slots = 0;
  constructor(public events: Ev[], private place: (id: string) => N['rect'] | undefined, private route: (from: string, to: string, yards: Map<string, { x: number; y: number }>) => Point3[] | undefined, private walking: boolean, private yardFor: (rect: N['rect'], slot: number) => { x: number; y: number }, private infer: boolean) {}
  reset() { this.actors.clear(); this.applied = []; this.next = 0; this.slots = 0; this.yards.clear(); }
  /** A yard target's rect (a small square around its point). */
  rectOf(id: string): N['rect'] | undefined {
    const yard = this.yards.get(id);
    return yard ? { x: yard.x - 20, y: yard.y - 20, w: 40, h: 40 } : this.place(id);
  }
  advance(now: number) {
    while (this.next < this.events.length && this.events[this.next]!.t <= now) this.apply(this.events[this.next++]!, now);
    for (const actor of this.actors.values()) {
      const working = actor.pose === 'read' || actor.pose === 'edit' || actor.pose === 'search';
      const busy = actor.open.size > 0 || actor.clones.some(c => !c.end);
      // Nothing in flight for a while: the model is thinking (live), or the agent went quiet.
      if (this.infer && working && !busy && actor.status === 'running' && now - actor.last > THINK_AFTER) this.outside(actor, 'think', now);
      else if (working && !busy && now - actor.last > 3600) this.pose(actor, 'idle', now);
      if (actor.pose === 'sit' && now - actor.poseAt > 3200) this.pose(actor, 'sleep', now);
      actor.clones = actor.clones.filter(clone => !clone.end || now - clone.end < 900);
      for (const clone of actor.clones) if (!clone.end && now - clone.start > 4200) clone.end = now;
    }
    for (const [key, actor] of this.actors) if (actor.gone && now > actor.gone) this.actors.delete(key);
  }
  get done() { return this.next >= this.events.length; }
  private pose(actor: Actor, pose: Pose, now: number) { if (actor.pose !== pose) { actor.pose = pose; actor.poseAt = now; } }
  /** Step outside (to the actor's mat beside the map edge nearest its last file) and do `pose` there. */
  private outside(actor: Actor, pose: Pose, now: number) {
    const id = `${YARD}${actor.key}`;
    if (actor.target !== id) {
      const near = actor.lastFile ? this.place(actor.lastFile) : actor.target ? this.rectOf(actor.target) : undefined;
      if (near) this.yards.set(id, this.yardFor(near, actor.slot));
      if (this.yards.has(id)) this.moveTo(actor, id, now);
    }
    this.pose(actor, pose, now);
  }
  private moveTo(actor: Actor, to: string, now: number) {
    if (actor.target === to) return;
    const from = actor.target;
    const a = from ? this.rectOf(from) : undefined, b = this.rectOf(to);
    const distance = a && b ? Math.hypot(a.x + a.w / 2 - b.x - b.w / 2, a.y + a.h / 2 - b.y - b.h / 2) : 0;
    const route = this.walking && from ? this.route(from, to, this.yards) : undefined;
    const length = route ? route.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - route[i]!.x, p.y - route[i]!.y) + Math.abs(p.z - route[i]!.z), 0) : distance;
    const dur = this.walking ? Math.max(600, Math.min(3200, length * 1.6)) : Math.max(380, Math.min(1150, 330 + distance * 0.32));
    actor.move = { ...(from ? { from } : {}), to, start: now, dur, ...(route ? { route } : {}) };
    actor.target = to;
    if (!to.startsWith(YARD)) actor.lastFile = to;
    actor.trail.push({ id: to, at: now }); if (actor.trail.length > 7) actor.trail.shift();
  }
  private apply(ev: Ev, now: number) {
    this.applied.push(ev);
    let actor = this.actors.get(ev.actor);
    if (!actor) {
      const parent = ev.parent ? this.actors.get(ev.parent) : undefined;
      actor = { key: ev.actor, provider: ev.provider, title: ev.title ?? ev.actor, color: agentColor(ev.actor), mini: !!ev.parent, slot: this.slots++, ...(ev.parent ? { parent: ev.parent } : {}), pose: 'idle', poseAt: now, last: now, status: 'running', open: new Set(), clones: [], trail: [], born: now, facing: 1, seed: this.actors.size * 7 + 3 };
      const start = parent?.target ?? ev.targets[0];
      if (start) {
        actor.target = start; actor.trail.push({ id: start, at: now });
        if (start.startsWith(YARD)) { this.yards.set(`${YARD}${actor.key}`, this.yards.get(start)!); actor.target = `${YARD}${actor.key}`; actor.lastFile = parent?.lastFile; }
        else actor.lastFile = start;
      } else {
        // Nothing to stand on yet: start outside, by the files this actor will touch first.
        const first = this.events.find(other => other.actor === ev.actor && other.targets.length)?.targets[0];
        const rect = first ? this.place(first) : undefined;
        if (rect) { const id = `${YARD}${actor.key}`; this.yards.set(id, this.yardFor(rect, actor.slot)); actor.target = id; actor.lastFile = first; }
      }
      this.actors.set(ev.actor, actor);
    }
    actor.last = now;
    if (ev.tool && ev.phase === 'started') actor.open.add(ev.tool);
    if (ev.tool && ev.phase !== 'started') actor.open.delete(ev.tool);
    if (ev.kind === 'spawn') return;
    if (ev.kind === 'done') {
      const parent = actor.parent ? this.actors.get(actor.parent) : undefined;
      if (parent?.target) this.moveTo(actor, parent.target, now);
      actor.gone = now + (actor.move?.dur ?? 0) + 150;
      return;
    }
    if ((ev.kind === 'read' || ev.kind === 'edit' || ev.kind === 'search') && ev.phase === 'started' && ev.targets.length) {
      const origin = actor.target;
      this.moveTo(actor, ev.targets[0]!, now);
      this.pose(actor, ev.kind, now);
      for (const target of ev.targets.slice(1, 6)) {
        const place = origin ?? ev.targets[0]!;
        const a = this.rectOf(place), b = this.rectOf(target);
        const distance = a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
        actor.clones.push({ target, ...(ev.tool ? { tool: ev.tool } : {}), start: now, move: { from: place, to: target, start: now + 80, dur: Math.max(380, Math.min(1100, 330 + distance * 0.32)) } });
      }
      return;
    }
    if (ev.phase === 'completed' || ev.phase === 'failed') {
      for (const clone of actor.clones) if (!clone.end && (!ev.tool || clone.tool === ev.tool)) clone.end = now;
      if (ev.kind === 'test' || (ev.kind === 'command' && ev.phase === 'failed')) { actor.result = ev.phase === 'failed' ? 'fail' : 'ok'; actor.resultAt = now; }
      return;
    }
    if (ev.kind === 'command' || ev.kind === 'test') {
      // On a file when the command names one; outside otherwise.
      if (ev.targets.length) { this.moveTo(actor, ev.targets[0]!, now); this.pose(actor, ev.kind, now); }
      else this.outside(actor, ev.kind, now);
      return;
    }
    if (ev.kind === 'think' || ev.kind === 'reply' || ev.kind === 'plan' || ev.kind === 'web') { this.outside(actor, ev.kind, now); return; }
    if (ev.kind === 'status') {
      actor.status = ev.status ?? actor.status;
      if (ev.status === 'waiting') this.outside(actor, 'wait', now);
      else if (ev.status === 'idle' || ev.status === 'interrupted') this.outside(actor, 'sit', now);
      else if (ev.status === 'finished') { this.outside(actor, 'wave', now); actor.gone = now + (actor.move && actor.move.start === now ? actor.move.dur : 0) + 2200; }
      else if (actor.pose === 'wait') this.outside(actor, 'think', now);
    }
  }
}

type Source = 'showcase' | 'real' | 'live' | 'sheet';
const SHEET_POSES: Pose[] = ['idle', 'read', 'edit', 'search', 'command', 'test', 'think', 'reply', 'plan', 'web', 'wait', 'sit', 'sleep', 'wave'];
export function AgentsPrototype({ variant }: { variant: string }) {
  const [data, setData] = useState<{ map: { nodes: N[] }; agents: { sessions: { actor: string; title?: string }[]; events: RawEvent[] } }>();
  const [source, setSource] = useState<Source>('showcase');
  const [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(true);
  const [follow, setFollow] = useState(false);
  const [restart, setRestart] = useState(0);
  const [legend, setLegend] = useState<{ key: string; color: string; provider: Provider; title: string; pose: Pose; mini: boolean; outside: boolean }[]>([]);
  const [feed, setFeed] = useState<string[]>([]);
  const [readout, setReadout] = useState<string[]>([]);
  useEffect(() => { void Promise.all([loadJson<{ nodes: N[] }>('map'), loadJson<{ sessions: { actor: string; title?: string }[]; events: RawEvent[] }>('agents')]).then(([map, agents]) => setData({ map, agents })); }, []);
  const index = useMemo(() => (data ? new MapIndex(data.map.nodes) : undefined), [data]);
  const scene = useMemo(() => (index ? sceneOf(index.nodes) : undefined), [index]);
  const renderer = useMemo(() => makeRenderer(), []);
  const camera = useRef<Camera>({ x: 0, y: 0, scale: 0.2 });
  const fitted = useRef(false);
  const clock = useRef({ now: 0, last: 0 });
  const cast = useRef<Cast | undefined>(undefined);
  const settings = useRef({ speed, playing, follow, source });
  settings.current = { speed, playing, follow, source };
  const walking = variant === 'B';
  const style: 'buddy' | 'pixel' | 'pin' = variant === 'A' ? 'buddy' : variant === 'C' ? 'pin' : 'pixel';
  const hops = variant === 'A' || variant === 'D';

  // The rail world of the full map (routes for walking).
  const world = useMemo<RailWorld | undefined>(() => scene && {
    rect: id => scene.nodes.get(id)?.rect,
    parent: id => scene.nodes.get(id)?.spatialParentId,
    children: id => scene.children.get(id)?.ids ?? [],
    top: id => { const node = scene.nodes.get(id); return node ? scene.zBase(id) + nodeHeight(node) : 0; },
  }, [scene]);
  /** A mat outside the map: beside the edge nearest `rect`, 240 units out, actors side by side. */
  const yardFor = useMemo(() => (rect: N['rect'], slot: number) => {
    const root = index!.root.rect, cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
    const gaps: [number, number][] = [[0, root.x + root.w - cx], [1, cx - root.x], [2, root.y + root.h - cy], [3, cy - root.y]];
    const side = gaps.reduce((best, next) => (next[1] < best[1] ? next : best))[0];
    const spread = [0, 1, -1, 2, -2, 3][slot % 6]! * 170, out = 240;
    const along = (v: number, lo: number, hi: number) => Math.max(lo + 60, Math.min(hi - 60, v + spread));
    if (side === 0) return { x: root.x + root.w + out, y: along(cy, root.y, root.y + root.h) };
    if (side === 1) return { x: root.x - out, y: along(cy, root.y, root.y + root.h) };
    if (side === 2) return { x: along(cx, root.x, root.x + root.w), y: root.y + root.h + out };
    return { x: along(cx, root.x, root.x + root.w), y: root.y - out };
  }, [index]);

  useEffect(() => {
    if (!index || !data || !world) return;
    const titles = new Map(data.agents.sessions.map(session => [session.actor, session.title ?? '']));
    const place = (id: string) => index.byId.get(id)?.rect;
    const rootId = index.root.id, rootTop = world.top(rootId);
    // Walking out: along the rails to the map's outer street, over its edge, down to the mat; and back.
    const out = (file: string, yard: { x: number; y: number }): Point3[] | undefined => {
      let rail: Point3[] | undefined;
      try { rail = railRoute(world, file, rootId)?.points; } catch { rail = undefined; }
      if (!rail?.length) return undefined;
      const last = rail.at(-1)!, root = index.root.rect;
      const edge = yard.x > root.x + root.w ? { x: root.x + root.w, y: last.y } : yard.x < root.x ? { x: root.x, y: last.y } : yard.y > root.y + root.h ? { x: last.x, y: root.y + root.h } : { x: last.x, y: root.y };
      return [...rail, { ...edge, z: rootTop }, { ...edge, z: 0 }, { x: yard.x, y: yard.y, z: 0 }];
    };
    const route = (from: string, to: string, yards: Map<string, { x: number; y: number }>): Point3[] | undefined => {
      const a = yards.get(from), b = yards.get(to);
      if (a && b) return [{ ...a, z: 0 }, { ...b, z: 0 }];
      if (b) return out(from, b);
      if (a) return out(to, a)?.reverse();
      try { return railRoute(world, from, to)?.points; } catch { return undefined; }
    };
    let events: Ev[] = [];
    if (source === 'showcase') events = showcase(index);
    if (source === 'real') {
      const resolvable = (event: RawEvent) => event.paths.some(path => index.byPath.has(path.path));
      const actors = new Set(data.agents.events.filter(resolvable).map(event => event.actor));
      events = fromRaw(index, [...data.agents.events].filter(event => actors.has(event.actor)).sort((a, b) => a.at - b.at), titles, 0, true);
    }
    cast.current = new Cast(events, place, route, walking, yardFor, source === 'live');
    fitted.current = false;
    clock.current = { now: 0, last: performance.now() };
    if (source !== 'live') return;
    // Live: poll the map server (the dev proxy's CODILUCE_API, :4300 by default) for new observations.
    const seen = new Set<string>();
    let first = true;
    const poll = async () => {
      try {
        const snapshot = await (await fetch('/api/agents')).json() as { events: RawEvent[]; sessions: { actor: string; title?: string }[] };
        for (const session of snapshot.sessions) if (session.title) titles.set(session.actor, session.title);
        const fresh = snapshot.events.filter(event => !seen.has(event.id)).sort((a, b) => a.at - b.at);
        fresh.forEach(event => seen.add(event.id));
        if (first) { first = false; return; }
        const evs = fromRaw(index, fresh, titles, clock.current.now, false);
        evs.forEach((ev, i) => { ev.t = clock.current.now + i * 120; });
        cast.current!.events.push(...evs);
      } catch { /* no server */ }
    };
    void poll();
    const timer = setInterval(poll, 1500);
    return () => clearInterval(timer);
  }, [index, data, world, source, restart, walking, yardFor]);

  const drawRef = useCanvas(({ ctx, viewport, time }) => {
    if (!index || !scene || !cast.current) { ctx.fillStyle = theme.background[0]; ctx.fillRect(0, 0, viewport.width, viewport.height); return; }
    const s = settings.current;
    if (!fitted.current) {
      // Frame where the events happen, and the mats beside them.
      const rects = [...new Set(cast.current.events.flatMap(ev => ev.targets))].map(id => index.byId.get(id)?.rect).filter((r): r is N['rect'] => !!r);
      const yards = rects.map(r => { const p = yardFor(r, 0); return { x: p.x - 60, y: p.y - 60, w: 120, h: 120 }; });
      camera.current = fitIso(rects.length ? [...rects, ...yards] : [index.root.rect], viewport, 50); fitted.current = true;
    }
    const dt = Math.min(100, time - clock.current.last); clock.current.last = time;
    if (s.playing) clock.current.now += dt * s.speed;
    const now = clock.current.now;
    const c = cast.current;
    if (s.source === 'sheet') { drawSheet(ctx, viewport, time); return; }
    c.advance(now);
    if (c.done && s.source === 'showcase' && now > (c.events.at(-1)?.t ?? 0) + 3500) { c.reset(); clock.current.now = 0; }
    if (s.follow) followCamera(c);
    const set = scene.visible(camera.current, viewport, DEFAULT_LOD);
    renderer.render(ctx, window.devicePixelRatio || 1, viewport, camera.current, scene, set, renderState(time), DEFAULT_LOD);
    // The map recedes a little so the characters read.
    ctx.fillStyle = 'rgba(8,10,18,0.32)'; ctx.fillRect(0, 0, viewport.width, viewport.height);
    drawCast(ctx, viewport, scene, set, c, now, time);
    if (Math.floor(time / 250) !== Math.floor((time - dt) / 250)) {
      setLegend([...c.actors.values()].map(actor => ({ key: actor.key, color: actor.color, provider: actor.provider, title: actor.title, pose: actor.pose, mini: actor.mini, outside: !!actor.target?.startsWith(YARD) })));
      setFeed(c.applied.slice(-7).reverse().map(ev => `${PROVIDER[ev.provider].short} · ${ev.label}`));
      setReadout([
        `clock      ${(now / 1000).toFixed(1)} s (${s.speed}×${s.playing ? '' : ', paused'})`,
        `events     ${c.applied.length}/${c.events.length}`,
        `actors     ${c.actors.size} (${[...c.actors.values()].filter(a => a.target?.startsWith(YARD)).length} outside), clones ${[...c.actors.values()].reduce((n, a) => n + a.clones.filter(cl => !cl.end).length, 0)}`,
        `zoom       ${camera.current.scale.toFixed(3)} (character ${characterSize(camera.current.scale).toFixed(0)} px)`,
      ]);
    }
  }, camera);

  /** The model sheet: every character in every pose, in this variant's style. */
  function drawSheet(ctx: CanvasRenderingContext2D, viewport: Viewport, time: number) {
    ctx.fillStyle = '#10131f'; ctx.fillRect(0, 0, viewport.width, viewport.height);
    const left = 470, cols = 7, cw = Math.min(150, (viewport.width - left - 30) / cols), rh = 128;
    const providers: Provider[] = ['claude-code', 'codex', 'other'];
    ctx.save(); ctx.font = `800 11px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    providers.forEach((provider, row) => SHEET_POSES.forEach((pose, i) => {
      const col = i % cols, line = row * 2 + Math.floor(i / cols);
      const x = left + col * cw + cw / 2, y = 30 + line * rh + 88;
      ctx.fillStyle = 'rgba(255,255,255,0.04)'; ctx.beginPath(); ctx.roundRect(x - cw / 2 + 4, y - 84, cw - 8, rh - 8, 10); ctx.fill();
      const look: Look = { provider, color: agentColor(provider), size: 52, facing: 1, pose, poseAge: time % 4000, time, stretch: 1, alpha: 1, seed: row * 5 + i, ...(pose === 'test' ? { result: row === 1 ? 'fail' : 'ok', resultAge: (time % 3000) } : {}) };
      if (style !== 'pin') drawShadow(ctx, x, y, 52, 0, 1, look.color);
      if (style === 'buddy') drawBuddy(ctx, x, y, look);
      else if (style === 'pixel') drawPixel(ctx, x, y, { ...look, walking: pose === 'idle' && Math.floor(time / 2000) % 2 === 1 });
      else drawPin(ctx, x, y, look);
      ctx.fillStyle = '#a7a2b8'; ctx.fillText(`${POSE_LABEL[pose]}${pose === 'idle' && style === 'pixel' ? ' / walk' : ''}`, x, y + 22);
    }));
    providers.forEach((provider, row) => { ctx.fillStyle = '#ffcf7a'; ctx.textAlign = 'right'; ctx.font = `800 12px ${FONT}`; ctx.fillText(PROVIDER[provider].label, left - 8, 30 + row * 2 * rh + 30); });
    ctx.restore();
  }

  function anchorOf(scene: Scene, set: VisibleSet, viewport: Viewport, id: string): { x: number; y: number; rect: N['rect']; z: number } | undefined {
    const yard = cast.current?.yards.get(id);
    if (yard) { const p = worldToScreen(camera.current, viewport, yard.x, yard.y, 0); return { ...p, rect: { x: yard.x - 20, y: yard.y - 20, w: 40, h: 40 }, z: 0 }; }
    const item = set.items[set.index.get(id) ?? -1] ?? scene.representative(id, set);
    if (!item) return undefined;
    const r = item.node.rect;
    const p = worldToScreen(camera.current, viewport, r.x + r.w / 2, r.y + r.h / 2, item.zTop);
    return { ...p, rect: r, z: item.zTop };
  }
  function followCamera(c: Cast) {
    const latest = [...c.actors.values()].filter(a => a.move).sort((a, b) => b.move!.start - a.move!.start)[0];
    const rect = latest?.target ? c.rectOf(latest.target) : undefined;
    if (!rect) return;
    const p = project(rect.x + rect.w / 2, rect.y + rect.h / 2, 0);
    const k = 0.04;
    camera.current = { scale: camera.current.scale + (Math.max(camera.current.scale, 0.45) - camera.current.scale) * k, x: camera.current.x + (p.x - camera.current.x) * k, y: camera.current.y + (p.y - camera.current.y) * k };
  }

  function drawCast(ctx: CanvasRenderingContext2D, viewport: Viewport, scene: Scene, set: VisibleSet, c: Cast, now: number, time: number) {
    const size = characterSize(camera.current.scale);
    const drawList: { y: number; draw: () => void }[] = [];
    // The city limit: the map's edge, faintly, so "outside" reads as outside.
    const root = index!.root.rect, top = scene.zBase(index!.root.id) + nodeHeight(index!.root);
    ctx.save(); ctx.strokeStyle = 'rgba(255,236,200,0.28)'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 5]);
    ctx.beginPath();
    [[root.x, root.y], [root.x + root.w, root.y], [root.x + root.w, root.y + root.h], [root.x, root.y + root.h]].forEach(([x, y], i) => { const p = worldToScreen(camera.current, viewport, x!, y!, top); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); });
    ctx.closePath(); ctx.stroke(); ctx.restore();
    // The mats outside, under everyone.
    for (const actor of c.actors.values()) {
      const yard = c.yards.get(`${YARD}${actor.key}`);
      if (!yard || !actor.target?.startsWith(YARD)) continue;
      const p = worldToScreen(camera.current, viewport, yard.x, yard.y, 0);
      drawYard(ctx, p.x, p.y, actor.mini ? size * 0.72 : size, actor.color, 0.8);
    }
    for (const actor of c.actors.values()) {
      const s = actor.mini ? size * 0.72 : size;
      // Where the actor is: moving between two anchors, or at its target.
      const pos = position(scene, set, viewport, actor.move, actor.target, now, s);
      if (!pos) continue;
      if (pos.dx) actor.facing = pos.dx > 0 ? 1 : -1;
      const born = clamp01((now - actor.born) / 300), dying = actor.gone ? clamp01((actor.gone - now) / 600) : 1;
      const alpha = Math.min(born, dying) * (actor.status === 'unknown' ? 0.4 : 1);
      // The block it stands on, outlined in its color.
      const target = actor.target && !actor.target.startsWith(YARD) ? anchorOf(scene, set, viewport, actor.target) : undefined;
      if (target && (!actor.move || now > actor.move.start + actor.move.dur)) footprint(ctx, viewport, target.rect, target.z, actor.color, 0.75 * alpha, actor.pose === 'search');
      if (hops && actor.pose === 'search' && target) cone(ctx, pos.x, pos.y - s * 0.45, viewport, target.rect, target.z, actor.color, alpha);
      if (variant === 'C') breadcrumbs(ctx, scene, set, viewport, actor, now, alpha);
      if (variant === 'B' && actor.move?.route && now < actor.move.start + actor.move.dur + 400) footprints(ctx, viewport, actor.move, now, actor.color);
      const look: Look = { provider: actor.provider, color: actor.color, size: s, facing: actor.facing, pose: actor.pose, poseAge: now - actor.poseAt, time: time + actor.seed * 100, stretch: pos.stretch, alpha, ...(actor.result ? { result: actor.result, resultAge: now - (actor.resultAt ?? 0) } : {}), seed: actor.seed };
      drawList.push({ y: pos.y, draw: () => {
        if (style !== 'pin') drawShadow(ctx, pos.x, pos.ground, s, pos.ground - pos.y, alpha, actor.color);
        if (style === 'buddy') drawBuddy(ctx, pos.x, pos.y, look);
        else if (style === 'pixel') drawPixel(ctx, pos.x, pos.y, { ...look, walking: pos.moving && walking });
        else drawPin(ctx, pos.x, pos.y, look);
      } });
      // Clones: copies of the actor (A, B, D) or branches (C).
      for (const clone of actor.clones) {
        const end = clone.end ? clamp01((now - clone.end) / 700) : 0;
        const cpos = position(scene, set, viewport, end > 0 ? { from: clone.target, to: actor.target ?? clone.target, start: clone.end!, dur: 600 } : clone.move, clone.target, now, s * 0.78, true);
        if (!cpos) continue;
        if (style === 'pin') { branch(ctx, pos.x, pos.y - s * 0.9, cpos.x, cpos.y, actor.color, 1 - end); continue; }
        const look2: Look = { ...look, size: s * 0.78, alpha: alpha * 0.62 * (1 - end * 0.6), facing: cpos.dx >= 0 ? 1 : -1, stretch: cpos.stretch, seed: actor.seed + 11 };
        const tgt = anchorOf(scene, set, viewport, clone.target);
        if (tgt && !end) footprint(ctx, viewport, tgt.rect, tgt.z, actor.color, 0.5, false);
        drawList.push({ y: cpos.y, draw: () => {
          drawShadow(ctx, cpos.x, cpos.ground, s * 0.78, cpos.ground - cpos.y, look2.alpha);
          if (style === 'buddy') drawBuddy(ctx, cpos.x, cpos.y, look2);
          else { drawPixel(ctx, cpos.x, cpos.y, { ...look2, walking: false }); sparkle(ctx, cpos.x, cpos.y, now - clone.start, actor.color); if (end) sparkle(ctx, cpos.x, cpos.y, now - clone.end!, actor.color); }
        } });
      }
    }
    drawList.sort((a, b) => a.y - b.y).forEach(item => item.draw());
    // Names under the characters when zoomed in enough (and what they do outside).
    if (size >= 34) for (const actor of c.actors.values()) {
      const pos = position(scene, set, viewport, actor.move, actor.target, now, size);
      if (!pos || actor.mini) continue;
      const outside = actor.target?.startsWith(YARD) && (!actor.move || now > actor.move.start + actor.move.dur);
      pill(ctx, outside ? `${actor.title} · ${POSE_LABEL[actor.pose]}` : actor.title, pos.x, pos.ground + 16, { color: actor.color, size: 10, alpha: 0.85 });
    }
  }

  /** Screen position of something moving from one place to another (hop, walk or glide), or standing on one. */
  function position(scene: Scene, set: VisibleSet, viewport: Viewport, move: Move | undefined, target: string | undefined, now: number, s: number, clone = false): { x: number; y: number; ground: number; dx: number; stretch: number; moving: boolean } | undefined {
    const end = target ? anchorOf(scene, set, viewport, target) : undefined;
    if (!end) return undefined;
    if (!move || now >= move.start + move.dur || !move.from) {
      const since = move ? now - (move.start + move.dur) : 1e9;
      const squash = since < 140 && variant !== 'C' ? 1 - 0.16 * Math.sin((since / 140) * Math.PI) : 1;
      return { x: end.x, y: end.y, ground: end.y, dx: 0, stretch: squash, moving: false };
    }
    const start = anchorOf(scene, set, viewport, move.from);
    if (!start) return { x: end.x, y: end.y, ground: end.y, dx: 0, stretch: 1, moving: false };
    const p = clamp01((now - move.start) / move.dur);
    if (walking && !clone && move.route && move.route.length > 1) {
      // Walk the route, then hop onto the roof for the last 20% (or step onto the mat).
      const route = move.route;
      const k = Math.min(1, p / 0.8);
      const lengths = [0];
      for (let i = 1; i < route.length; i++) lengths.push(lengths[i - 1]! + Math.hypot(route[i]!.x - route[i - 1]!.x, route[i]!.y - route[i - 1]!.y) + Math.abs(route[i]!.z - route[i - 1]!.z));
      const at = k * lengths.at(-1)!;
      const i = Math.max(1, lengths.findIndex(l => l >= at));
      const q = (at - lengths[i - 1]!) / Math.max(1e-6, lengths[i]! - lengths[i - 1]!);
      const a = route[i - 1]!, b = route[i]!;
      const w = worldToScreen(camera.current, viewport, a.x + (b.x - a.x) * q, a.y + (b.y - a.y) * q, a.z + (b.z - a.z) * q);
      if (p < 0.8) return { x: w.x, y: w.y, ground: w.y, dx: b.x - a.x + (b.y - a.y) * -1 > 0 ? 1 : -1, stretch: 1, moving: true };
      const last = worldToScreen(camera.current, viewport, route.at(-1)!.x, route.at(-1)!.y, route.at(-1)!.z);
      const h = (p - 0.8) / 0.2;
      return { x: last.x + (end.x - last.x) * h, y: last.y + (end.y - last.y) * h - Math.sin(h * Math.PI) * s * 0.5, ground: last.y + (end.y - last.y) * h, dx: end.x - last.x, stretch: 1.05, moving: false };
    }
    const e = ease(p);
    const x = start.x + (end.x - start.x) * e, ground = start.y + (end.y - start.y) * e;
    if (variant === 'C') return { x, y: ground, ground, dx: end.x - start.x, stretch: 1, moving: true };
    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    const height = Math.min(110, s * 0.5 + distance * 0.32);
    const lift = Math.sin(p * Math.PI) * height;
    return { x, y: ground - lift, ground, dx: end.x - start.x, stretch: p < 0.12 ? 0.86 : 1.12, moving: true };
  }

  function footprint(ctx: CanvasRenderingContext2D, viewport: Viewport, r: N['rect'], z: number, color: string, alpha: number, dashed: boolean) {
    const pts = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]].map(([x, y]) => worldToScreen(camera.current, viewport, x!, y!, z));
    ctx.save(); ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash(dashed ? [5, 4] : []); ctx.shadowColor = color; ctx.shadowBlur = 8;
    ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.stroke(); ctx.restore();
  }
  function cone(ctx: CanvasRenderingContext2D, x: number, y: number, viewport: Viewport, r: N['rect'], z: number, color: string, alpha: number) {
    const pts = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]].map(([px, py]) => worldToScreen(camera.current, viewport, px!, py!, z));
    const left = pts.reduce((a, b) => (b.x < a.x ? b : a)), right = pts.reduce((a, b) => (b.x > a.x ? b : a));
    ctx.save(); ctx.globalAlpha = 0.16 * alpha; ctx.fillStyle = color;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(left.x, left.y); ctx.lineTo(right.x, right.y); ctx.closePath(); ctx.fill(); ctx.restore();
  }
  function breadcrumbs(ctx: CanvasRenderingContext2D, scene: Scene, set: VisibleSet, viewport: Viewport, actor: Actor, now: number, alpha: number) {
    const points = actor.trail.map(step => ({ ...anchorOf(scene, set, viewport, step.id), age: now - step.at })).filter(p => p.x !== undefined) as { x: number; y: number; age: number }[];
    if (points.length < 2) return;
    ctx.save(); ctx.strokeStyle = actor.color; ctx.lineWidth = 2; ctx.setLineDash([2, 5]); ctx.lineCap = 'round';
    for (let i = 1; i < points.length; i++) {
      ctx.globalAlpha = alpha * Math.max(0.15, 1 - points[i]!.age / 30000) * (i / points.length);
      const a = points[i - 1]!, b = points[i]!;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo((a.x + b.x) / 2, Math.min(a.y, b.y) - 30, b.x, b.y); ctx.stroke();
    }
    ctx.setLineDash([]);
    points.slice(0, -1).forEach((p, i) => { ctx.globalAlpha = alpha * Math.max(0.25, 1 - p.age / 30000); ctx.fillStyle = actor.color; ctx.beginPath(); ctx.arc(p.x, p.y, 7, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#0b0d16'; ctx.font = `900 8px Nunito Variable, system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(i + 1), p.x, p.y + 0.5); });
    ctx.restore();
  }
  function branch(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, color: string, alpha: number) {
    ctx.save(); ctx.globalAlpha = alpha * 0.85; ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.quadraticCurveTo((x0 + x1) / 2, Math.min(y0, y1) - 40, x1, y1); ctx.stroke(); ctx.setLineDash([]);
    const pulse = (performance.now() % 1000) / 1000;
    ctx.globalAlpha = alpha * (1 - pulse); ctx.beginPath(); ctx.arc(x1, y1, 5 + pulse * 10, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = alpha; ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x1, y1, 4, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  }
  function footprints(ctx: CanvasRenderingContext2D, viewport: Viewport, move: Move, now: number, color: string) {
    const route = move.route!;
    ctx.save(); ctx.fillStyle = color;
    const p = clamp01((now - move.start) / move.dur / 0.8);
    const total = route.length - 1;
    for (let i = 0; i <= 24; i++) {
      const k = i / 24;
      if (k > p) break;
      const at = k * total, j = Math.min(total - 1, Math.floor(at)), q = at - j;
      const a = route[j]!, b = route[j + 1]!;
      const s = worldToScreen(camera.current, viewport, a.x + (b.x - a.x) * q, a.y + (b.y - a.y) * q, a.z + (b.z - a.z) * q);
      ctx.globalAlpha = 0.5 * (k / Math.max(0.01, p)); ctx.fillRect(Math.round(s.x) - 1, Math.round(s.y) - 1, 3, 3);
    }
    ctx.restore();
  }

  const title = variant === 'A' ? 'Buddies: hop roof to roof' : variant === 'B' ? 'Pixel crew: walk the streets' : variant === 'C' ? 'Pins: glide, leave breadcrumbs' : 'Pixel crew: hop roof to roof';
  return (
    <div className="proto-stage">
      <canvas ref={drawRef} className="proto-canvas" />
      <aside className="proto-panel">
        <p className="proto-kicker">Prototype 2 · Agent characters (drawn in code)</p>
        <h2>{title}</h2>
        <div className="proto-row">
          {(['showcase', 'real', 'live', 'sheet'] as const).map(id => <button key={id} className={source === id ? 'on' : ''} onClick={() => setSource(id)}>{id === 'showcase' ? 'Showcase script' : id === 'real' ? 'Real session (replay)' : id === 'live' ? 'Live (:4300)' : 'Model sheet'}</button>)}
        </div>
        {source !== 'sheet' ? (
          <>
            <div className="proto-row">
              <button onClick={() => setPlaying(p => !p)}>{playing ? '❚❚ Pause' : '▶ Play'}</button>
              <button onClick={() => setSpeed(s => (s === 1 ? 2 : s === 2 ? 4 : s === 4 ? 0.5 : 1))}>{speed}×</button>
              <button className={follow ? 'on' : ''} onClick={() => setFollow(f => !f)}>Follow</button>
              <button onClick={() => setRestart(r => r + 1)}>↻ Restart</button>
            </div>
            <h3>On the map</h3>
            <ul className="proto-legend">
              {legend.length ? legend.map(item => <li key={item.key}><FaceIcon provider={item.provider} color={item.color} />{item.mini ? '↳ ' : ''}{item.title}<small>{item.outside ? 'outside · ' : ''}{POSE_LABEL[item.pose]}</small></li>) : <li>Nobody yet{source === 'live' ? ' (waiting for hooks on :4300)' : ''}</li>}
            </ul>
            <h3>Observed</h3>
            <ul className="proto-legend">{feed.map((line, i) => <li key={i} style={{ opacity: 1 - i * 0.12 }}>{line}</li>)}</ul>
            <p className="proto-hint">Files: on the roofs. Thinking, writing the reply, planning, the web, commands, permission and rest: outside, on a mat by the nearest edge. Zoom in to see poses. ← → switch variants.</p>
          </>
        ) : <p className="proto-text">Every character in every pose, in this variant’s style (← → to compare styles). Claude Code is Clawd, Codex a cloud with a terminal face, Bolt any other harness.</p>}
      </aside>
      {source !== 'sheet' ? <pre className="proto-readout">{readout.join('\n')}</pre> : null}
    </div>
  );
}
/** The character's face for the legend (a tiny canvas). */
function FaceIcon({ provider, color }: { provider: Provider; color: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current; if (!canvas) return;
    const ctx = canvas.getContext('2d')!, dpr = window.devicePixelRatio || 1;
    canvas.width = 22 * dpr; canvas.height = 22 * dpr; ctx.scale(dpr, dpr);
    ctx.fillStyle = '#141826'; ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(11, 11, 9.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    drawFace(ctx, provider, 11, 11, 8.5);
  }, [provider, color]);
  return <canvas ref={ref} style={{ width: 22, height: 22, flex: 'none' }} />;
}
function characterSize(scale: number): number { return Math.max(30, Math.min(64, 30 + scale * 55)); }
