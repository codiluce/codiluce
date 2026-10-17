// Agents on the map: every observed session as a pixel character on the map
// itself, while Agents › "Show agents on the map" is on. A character hops to
// the files it is reported at (copies split off for parallel reads; inside a
// closed area it stands on that area's roof) and steps outside, onto a mat
// beside the map's edge, for what is about no file: thinking, writing the
// reply, planning, the web, a command, waiting for permission, resting. In
// both projections: positions come from the map's own drawn blocks. The
// characters take their places before the map's labels, which give way to
// them; their names are placed last, clear of every label and badge.
import type { ActivityEvent, ActivitySnapshot } from '@engine/activity/model';
import type { Rect } from '@engine/projection/dto';
import { isFlat, worldToScreen, type Camera, type Viewport } from './camera';
import { agentColor } from './activity';
import { Cast, crewEvent, replayEvents, YARD, type Move } from './crew';
import { clamp01 as clamp, ease } from './focus-layout';
import { placeLabels, type Box } from './labels';
import { inkFor, pill } from './plan';
import { drawPixel, drawShadow, drawYard, POSE_LABEL, sparkle, type Look } from './pixel-crew';
import type { Scene, VisibleSet } from './scene';
import type { Theme } from './themes';

/** Sessions seen within this long are on the map when it starts showing them, at their latest place. */
const RECENT_MS = 5 * 60_000;
interface Anchor { x: number; y: number; rect: Rect; z: number }
type Paint = (ctx: CanvasRenderingContext2D) => void;
/**
 * One frame of the cast: what its characters cover (the map's labels keep off
 * it), what draws them and their names (clear of `avoid`) over the map, and
 * whether anything moves (otherwise a few frames a second keep them breathing).
 */
export interface CrewFrame { reserved: Box[]; draw: (ctx: CanvasRenderingContext2D, avoid: readonly Box[]) => void; moving: boolean }

export class CrewOnMap {
  private readonly cast: Cast;
  private readonly clock = { now: 0, last: 0 };
  private readonly seen = new Set<string>();
  private readonly requested = new Set<string>();
  private readonly nameSlots = new Map<string, string>();
  /** While replaying the latest observations: when the replay ends (cast clock). */
  private replayUntil?: number;
  private replayToken = 0;

  /** `load`: make the blocks of these entities (and the areas holding them) reachable in the scene. */
  constructor(private readonly scene: () => Scene, private readonly load: (ids: string[], areas: string[]) => void) {
    this.cast = new Cast(id => scene().nodes.get(id)?.rect, () => { const current = scene(); return current.rootId ? current.nodes.get(current.rootId)?.rect : undefined; }, agentColor, true);
  }
  /** Someone is on the map, or about to be. */
  get busy(): boolean { return this.cast.actors.size > 0 || this.cast.pending > 0; }
  /** Playing the latest observations again. */
  get replaying(): boolean { return this.replayUntil !== undefined; }

  /** New observations join the cast as they arrive; the first time, recent sessions start where they are. A new `replay` token plays the latest again. */
  sync(snapshot: ActivitySnapshot | undefined, replay = 0): void {
    if (replay !== this.replayToken) { this.replayToken = replay; if (replay && snapshot) this.startReplay(snapshot); }
    if (!snapshot || this.replayUntil !== undefined) return;
    const sessions = snapshot.sessions;
    const fresh = snapshot.events.filter(event => !this.seen.has(event.id)).sort((a, b) => a.at - b.at);
    if (!fresh.length) return;
    const first = this.seen.size === 0;
    for (const event of fresh) this.seen.add(event.id);
    this.ensure(fresh);
    const now = this.clock.now;
    if (first) {
      // Already done: applied at once, in the past, so nobody walks in.
      const recent = new Set(sessions.filter(session => Date.now() - session.lastSeen <= RECENT_MS && session.status !== 'finished').map(session => session.actor));
      const events = fresh.filter(event => recent.has(event.actor) && Date.now() - event.at <= RECENT_MS);
      this.cast.push(events.flatMap((event, i) => { const ev = crewEvent(event, now - 60_000 + i, sessions); return ev ? [ev] : []; }));
      return;
    }
    this.cast.push(fresh.flatMap((event, i) => { const ev = crewEvent(event, now + i * 120, sessions); return ev ? [ev] : []; }));
  }
  /** The latest observations again, sped up: the sessions that touched files on this map, up to their last file and a little after. */
  private startReplay(snapshot: ActivitySnapshot): void {
    const sorted = [...snapshot.events].sort((a, b) => a.at - b.at);
    const onMap = new Set(sorted.filter(event => event.paths.some(path => path.id)).map(event => event.actor));
    const theirs = onMap.size ? sorted.filter(event => onMap.has(event.actor)) : sorted;
    const lastFile = theirs.findLastIndex(event => event.paths.some(path => path.id));
    const events = theirs.slice(Math.max(0, (lastFile < 0 ? theirs.length : lastFile + 40) - 160), lastFile < 0 ? undefined : lastFile + 40);
    if (!events.length) return;
    this.ensure(events);
    this.cast.reset();
    const played = replayEvents(events, snapshot.sessions, this.clock.now + 200);
    this.cast.push(played);
    this.replayUntil = (played.at(-1)?.t ?? this.clock.now) + 3500;
  }
  /** Back to what happens now: the cast is seeded again from the snapshot. */
  private stopReplay(): void { this.replayUntil = undefined; this.cast.reset(); this.seen.clear(); }
  private ensure(events: ActivityEvent[]): void {
    const ids: string[] = [], areas: string[] = [];
    for (const event of events) for (const path of event.paths) if (path.id && !this.requested.has(path.id)) { this.requested.add(path.id); ids.push(path.id); areas.push(...path.ancestors ?? []); }
    if (ids.length) this.load(ids, areas);
  }

  /** Advances the cast and lays it out on the blocks drawn this frame. */
  /** `focus`: only this agent (and its subagents) is shown. */
  frame(viewport: Viewport, camera: Camera, set: VisibleSet, theme: Theme, time: number, reduced: boolean, focus?: string): CrewFrame | undefined {
    // Frames come every 16 ms while they move and every 160 ms while they stand: the clock follows real time (up to a second, after a hidden tab).
    const dt = Math.min(1000, time - (this.clock.last || time)); this.clock.last = time;
    this.clock.now += dt;
    const now = this.clock.now;
    if (this.replayUntil !== undefined && now > this.replayUntil && !this.cast.pending) this.stopReplay();
    this.cast.advance(now);
    const actors = [...this.cast.actors.values()].filter(actor => !focus || actor.key === focus || actor.parent === focus);
    if (!actors.length) return undefined;
    const scene = this.scene();
    const anchor = (id: string): Anchor | undefined => {
      const yard = this.cast.yards.get(id);
      if (yard) return { ...worldToScreen(camera, viewport, yard.x, yard.y, 0), rect: { x: yard.x - 20, y: yard.y - 20, w: 40, h: 40 }, z: 0 };
      const item = set.items[set.index.get(id) ?? -1] ?? scene.representative(id, set);
      if (!item) return undefined;
      const r = item.node.rect;
      return { ...worldToScreen(camera, viewport, r.x + r.w / 2, r.y + r.h / 2, item.zTop), rect: r, z: item.zTop };
    };
    const outline = (ctx: CanvasRenderingContext2D, rect: Rect, z: number, color: string, alpha: number, dashed: boolean) => {
      const points = [[rect.x, rect.y], [rect.x + rect.w, rect.y], [rect.x + rect.w, rect.y + rect.h], [rect.x, rect.y + rect.h]].map(([x, y]) => worldToScreen(camera, viewport, x!, y!, z));
      ctx.save(); ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash(dashed ? [5, 4] : []);
      // A glow only around blocks of a readable size: blurring a whole area's outline costs a frame.
      if (Math.sqrt(rect.w * rect.h) * camera.scale < 260) { ctx.shadowColor = color; ctx.shadowBlur = 8; }
      ctx.beginPath(); points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.stroke(); ctx.restore();
    };
    // One outline per place, whoever stands there (the first comes first); none around the whole map.
    const rings = new Map<string, Paint>();
    const ring = (id: string, paint: Paint) => { if (id !== scene.rootId && !rings.has(id)) rings.set(id, paint); };
    const size = Math.max(30, Math.min(64, 30 + camera.scale * 55));
    const ink = inkFor(theme);
    const mats: Paint[] = [], bodies: { y: number; box: Box; paint: Paint }[] = [];
    // Agents standing on the same block gather side by side, in rows of five, instead of on top of one another.
    const crowds = new Map<string, string[]>();
    for (const actor of [...actors].sort((a, b) => a.slot - b.slot)) if (actor.target) crowds.set(actor.target, [...crowds.get(actor.target) ?? [], actor.key]);
    const stand = (actor: typeof actors[number], s: number) => {
      const pos = position(anchor, actor.move, actor.target, now, s, reduced);
      const crowd = actor.target ? crowds.get(actor.target)! : [];
      if (!pos || pos.moving || crowd.length < 2) return pos;
      const i = crowd.indexOf(actor.key), row = Math.floor(i / 5), inRow = Math.min(5, crowd.length - row * 5);
      const dx = (i % 5 - (inRow - 1) / 2) * s * 0.8, dy = -row * s * 0.55;
      return { ...pos, x: pos.x + dx, y: pos.y + dy, ground: pos.ground + dy };
    };
    let moving = false;
    for (const actor of actors) {
      const s = actor.mini ? size * 0.72 : size;
      if (actor.target?.startsWith(YARD)) { const yard = anchor(actor.target); if (yard) mats.push(ctx => drawYard(ctx, yard.x, yard.y, s, actor.color, 0.8, isFlat(), theme.dark)); }
      const pos = stand(actor, s);
      if (!pos) continue;
      // Hops, arrivals, departures, a new pose and parallel reads move: drawn every frame. Otherwise they only breathe.
      moving ||= pos.moving || actor.clones.length > 0 || now - actor.born < 400 || actor.gone !== undefined || now - actor.poseAt < 900;
      if (pos.dx) actor.facing = pos.dx > 0 ? 1 : -1;
      const born = clamp((now - actor.born) / 300), dying = actor.gone !== undefined ? clamp((actor.gone - now) / 600) : 1;
      const alpha = Math.min(born, dying) * (actor.status === 'unknown' ? 0.4 : 1);
      const target = actor.target && !actor.target.startsWith(YARD) ? anchor(actor.target) : undefined;
      if (target && !pos.moving) ring(actor.target!, ctx => outline(ctx, target.rect, target.z, actor.color, 0.75 * alpha, actor.pose === 'search'));
      const look: Look = { provider: actor.provider, color: actor.color, size: s, facing: actor.facing, pose: actor.pose, poseAge: now - actor.poseAt, time: time + actor.seed * 100, alpha, walking: false, seed: actor.seed, ...(actor.result ? { result: actor.result, resultAge: now - (actor.resultAt ?? 0) } : {}) };
      bodies.push({ y: pos.y, box: bodyBox(pos.x, pos.y, s), paint: ctx => { drawShadow(ctx, pos.x, pos.ground, s, pos.ground - pos.y, alpha, actor.color); drawPixel(ctx, pos.x, pos.y, look); } });
      for (const clone of actor.clones) {
        const end = clone.end ? clamp((now - clone.end) / 700) : 0;
        const cpos = position(anchor, end > 0 ? { from: clone.target, to: actor.target ?? clone.target, start: clone.end!, dur: 600 } : clone.move, end > 0 ? actor.target : clone.target, now, s * 0.78, reduced);
        if (!cpos) continue;
        const spot = anchor(clone.target);
        if (spot && !end) ring(clone.target, ctx => outline(ctx, spot.rect, spot.z, actor.color, 0.5, false));
        const copy: Look = { ...look, size: s * 0.78, alpha: alpha * 0.62 * (1 - end * 0.6), facing: cpos.dx >= 0 ? 1 : -1, seed: actor.seed + 11 };
        bodies.push({ y: cpos.y, box: bodyBox(cpos.x, cpos.y, s * 0.78), paint: ctx => { drawShadow(ctx, cpos.x, cpos.ground, s * 0.78, cpos.ground - cpos.y, copy.alpha); drawPixel(ctx, cpos.x, cpos.y, copy); sparkle(ctx, cpos.x, cpos.y, now - clone.start, actor.color); if (clone.end) sparkle(ctx, cpos.x, cpos.y, now - clone.end, actor.color); } });
      }
    }
    // Names under them (and what they do outside), never over one another, a character, or the map's labels and badges.
    const names = size < 34 ? [] : actors.flatMap(actor => {
      if (actor.mini) return [];
      const pos = stand(actor, size);
      if (!pos || pos.x < -50 || pos.x > viewport.width + 50) return [];
      const outside = actor.target?.startsWith(YARD) && !pos.moving;
      const text = outside ? `${actor.title} · ${POSE_LABEL[actor.pose]}` : actor.title;
      return [{ color: actor.color, text, ask: { key: actor.key, target: { x0: pos.x - 10, y0: pos.ground - 2, x1: pos.x + 10, y1: pos.ground + 4 }, w: textWidth(text, ink.font) + 11, h: 19 } }];
    });
    const byKey = new Map(names.map(name => [name.ask.key, name]));
    return {
      moving,
      reserved: bodies.map(body => body.box),
      draw: (ctx, avoid) => {
        const { placed } = placeLabels(names.map(name => name.ask), { bounds: { x0: 2, y0: 2, x1: viewport.width - 2, y1: viewport.height - 2 }, avoid: [...bodies.map(body => body.box), ...avoid], memory: this.nameSlots, directions: ['s', 'se', 'sw', 'n', 'e', 'w', 'ne', 'nw'], distances: [2, 14, 30, 52, 80], columns: false });
        for (const paint of mats) paint(ctx);
        for (const paint of rings.values()) paint(ctx);
        for (const body of [...bodies].sort((a, b) => a.y - b.y)) body.paint(ctx);
        for (const spot of placed) {
          const { color, text } = byKey.get(spot.key)!;
          if (spot.leader) { ctx.save(); ctx.strokeStyle = color; ctx.globalAlpha = 0.7; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(spot.leader.from.x, spot.leader.from.y); ctx.lineTo(spot.leader.to.x, spot.leader.to.y); ctx.stroke(); ctx.restore(); }
          pill(ctx, ink, text, (spot.box.x0 + spot.box.x1) / 2, (spot.box.y0 + spot.box.y1) / 2, { color, size: 10, alpha: 0.88 });
        }
      },
    };
  }
}

/** The screen box a character covers, feet at (x, y), with room for what floats over its head. */
function bodyBox(x: number, y: number, size: number): Box { return { x0: x - size * 0.6, y0: y - size * 1.25, x1: x + size * 0.6, y1: y + 4 }; }
let measure: CanvasRenderingContext2D | null | undefined;
function textWidth(text: string, font: string): number {
  measure ??= typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  if (!measure) return text.length * 6;
  measure.font = `700 10px ${font}`;
  return measure.measureText(text).width;
}
/** Where something moving between two places is (a hop along an arc), or where it stands. */
function position(anchor: (id: string) => Anchor | undefined, move: Move | undefined, target: string | undefined, now: number, s: number, reduced: boolean): { x: number; y: number; ground: number; dx: number; moving: boolean } | undefined {
  const end = target ? anchor(target) : undefined;
  if (!end) return undefined;
  if (!move || now >= move.start + move.dur || !move.from || reduced) return { x: end.x, y: end.y, ground: end.y, dx: 0, moving: false };
  const start = anchor(move.from);
  if (!start) return { x: end.x, y: end.y, ground: end.y, dx: 0, moving: false };
  const p = clamp((now - move.start) / move.dur), e = ease(p);
  const x = start.x + (end.x - start.x) * e, ground = start.y + (end.y - start.y) * e;
  const height = Math.min(110, s * 0.5 + Math.hypot(end.x - start.x, end.y - start.y) * 0.32);
  return { x, y: ground - Math.sin(p * Math.PI) * height, ground, dx: end.x - start.x, moving: true };
}
