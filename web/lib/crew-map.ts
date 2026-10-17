// Agents on the map: every observed session as a pixel character on the map
// itself, while Agents › "Show agents on the map" is on. A character hops to
// the files it is reported at (it splits into copies for files worked on at
// the same time; inside a closed area it stands on that area's roof) and steps
// outside, beside the map's edge, for what is about no file: thinking, writing
// the reply, planning, the web, a command, waiting for permission, resting. In
// both projections: positions come from the map's own drawn blocks. A small
// square in the session's color marks each character, as it marks the
// session in the Agents list. The characters take their places before the
// map's labels, which give way to them.
import type { ActivityEvent, ActivitySnapshot } from '@engine/activity/model';
import type { ConversationReplay } from '@engine/conversations/model';
import type { Rect } from '@engine/projection/dto';
import { worldToScreen, type Camera, type Viewport } from './camera';
import { agentColor } from './activity';
import { Cast, crewEvent, sessionOf, sessionReplay, YARD, type CrewEvent, type Move } from './crew';
import { clamp01 as clamp, ease } from './focus-layout';
import type { Box } from './labels';
import { drawPixel, drawShadow, sparkle, type Look } from './pixel-crew';
import type { Scene, VisibleSet } from './scene';

/** Sessions seen within this long are on the map when it starts showing them, at their latest place. */
const RECENT_MS = 5 * 60_000;
/** Characters of other sessions, while the pointer is on one session in the Agents list. */
const DIMMED = 0.18;
interface Anchor { x: number; y: number; rect: Rect; z: number }
type Paint = (ctx: CanvasRenderingContext2D) => void;
/**
 * One frame of the cast: what its characters cover (the map's labels keep off
 * it), what draws them over the map, and whether anything moves (otherwise a
 * few frames a second keep them breathing).
 */
export interface CrewFrame { reserved: Box[]; draw: (ctx: CanvasRenderingContext2D) => void; moving: boolean }
/** A saved session to play again on the map; a new `token` starts it. */
export interface CrewReplay { token: number; data: ConversationReplay }
/** `focus`: only this session's characters; `dim`: the others recede. Both are session keys (`provider:session`). */
export interface CrewView { focus?: string; dim?: string }

export class CrewOnMap {
  private readonly cast: Cast;
  private readonly clock = { now: 0, last: 0 };
  private readonly seen = new Set<string>();
  private readonly requested = new Set<string>();
  /** While a saved session plays: when it ends (cast clock), and which request it is. */
  private replayUntil?: number;
  private replayToken = 0;

  /** `load`: make the blocks of these entities (and the areas holding them) reachable in the scene; `ended`: a replay is over. */
  constructor(private readonly scene: () => Scene, private readonly load: (ids: string[], areas: string[]) => void, private readonly ended: (token: number) => void = () => {}) {
    this.cast = new Cast(id => scene().nodes.get(id)?.rect, () => { const current = scene(); return current.rootId ? current.nodes.get(current.rootId)?.rect : undefined; }, agentColor, true);
  }
  /** Someone is on the map, or about to be. */
  get busy(): boolean { return this.cast.actors.size > 0 || this.cast.pending > 0; }
  /** Playing a saved session again. */
  get replaying(): boolean { return this.replayUntil !== undefined; }
  /** Where each session's characters stand now (the character and its copies), by session key. */
  places(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const actor of this.cast.actors.values()) {
      if (actor.gone !== undefined) continue;
      const here = [actor.target, ...actor.clones.filter(clone => !clone.end).map(clone => clone.target)].filter((id): id is string => !!id && !id.startsWith(YARD));
      if (here.length) (out[sessionOf(actor)] ??= []).push(...here);
    }
    return out;
  }

  /** New observations join the cast as they arrive; the first time, recent sessions start where they are. A new `replay` plays that session; none ends it. */
  sync(snapshot: ActivitySnapshot | undefined, replay?: CrewReplay): void {
    const token = replay?.token ?? 0;
    if (token !== this.replayToken) {
      if (this.replayUntil !== undefined) this.stopReplay();
      this.replayToken = token;
      if (replay) this.startReplay(replay.data);
    }
    if (!snapshot || this.replayUntil !== undefined) return;
    const sessions = snapshot.sessions;
    const fresh = snapshot.events.filter(event => !this.seen.has(event.id)).sort((a, b) => a.at - b.at);
    if (!fresh.length) return;
    const first = this.seen.size === 0;
    for (const event of fresh) this.seen.add(event.id);
    this.ensure(fresh.flatMap(event => event.paths.flatMap(path => (path.id ? [{ id: path.id, areas: path.ancestors ?? [] }] : []))));
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
  /** A saved session, sped up, alone on the map. */
  private startReplay(data: ConversationReplay): void {
    const played: CrewEvent[] = sessionReplay(data, this.clock.now + 200);
    if (!played.length) { this.ended(this.replayToken); return; }
    this.ensure(played.flatMap(ev => ev.targets.map(id => ({ id, areas: ev.ancestors[id] ?? [] }))));
    this.cast.reset();
    this.cast.push(played);
    this.replayUntil = played.at(-1)!.t + 2600;
  }
  /** Back to what happens now: the cast is seeded again from the snapshot. */
  private stopReplay(): void { this.replayUntil = undefined; this.cast.reset(); this.seen.clear(); }
  private ensure(targets: { id: string; areas: string[] }[]): void {
    const ids: string[] = [], areas: string[] = [];
    for (const target of targets) if (!this.requested.has(target.id)) { this.requested.add(target.id); ids.push(target.id); areas.push(...target.areas); }
    if (ids.length) this.load(ids, areas);
  }

  /** Advances the cast and lays it out on the blocks drawn this frame. */
  frame(viewport: Viewport, camera: Camera, set: VisibleSet, time: number, reduced: boolean, view: CrewView = {}): CrewFrame | undefined {
    // Frames come every 16 ms while they move and every 160 ms while they stand: the clock follows real time (up to a second, after a hidden tab).
    const dt = Math.min(1000, time - (this.clock.last || time)); this.clock.last = time;
    this.clock.now += dt;
    const now = this.clock.now;
    if (this.replayUntil !== undefined && now > this.replayUntil && !this.cast.pending) { this.stopReplay(); this.ended(this.replayToken); }
    this.cast.advance(now);
    const actors = [...this.cast.actors.values()].filter(actor => !view.focus || sessionOf(actor) === view.focus);
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
    const size = Math.max(22, Math.min(46, 22 + camera.scale * 40));
    const bodies: { y: number; box: Box; paint: Paint }[] = [];
    // Characters and copies standing on the same drawn block (two files inside one closed area too) gather side by side, in rows of five, instead of on top of one another.
    const drawnAt = (id: string) => (this.cast.yards.has(id) ? id : (set.items[set.index.get(id) ?? -1] ?? scene.representative(id, set))?.node.id ?? id);
    const crowds = new Map<string, string[]>();
    const join = (at: string, member: string) => { const key = drawnAt(at); crowds.set(key, [...crowds.get(key) ?? [], member]); };
    for (const actor of [...actors].sort((a, b) => a.slot - b.slot)) {
      if (actor.target) join(actor.target, actor.key);
      for (const clone of actor.clones) if (!clone.end) join(clone.target, `${actor.key}>${clone.target}`);
    }
    const spread = (pos: ReturnType<typeof position>, at: string | undefined, member: string, s: number) => {
      const crowd = at ? crowds.get(drawnAt(at)) ?? [] : [];
      if (!pos || pos.moving || crowd.length < 2) return pos;
      const i = crowd.indexOf(member), row = Math.floor(i / 5), inRow = Math.min(5, crowd.length - row * 5);
      // Clawd, the widest sprite, is about 1.2 sizes wide.
      const dx = (i % 5 - (inRow - 1) / 2) * s * 1.25, dy = -row * s * 0.6;
      return { ...pos, x: pos.x + dx, y: pos.y + dy, ground: pos.ground + dy };
    };
    const stand = (actor: typeof actors[number], s: number) => spread(position(anchor, actor.move, actor.target, now, s, reduced), actor.target, actor.key, s);
    let moving = false;
    for (const actor of actors) {
      const s = actor.mini ? size * 0.75 : size;
      const pos = stand(actor, s);
      if (!pos) continue;
      // Hops, arrivals, departures, a new pose and parallel reads move: drawn every frame. Otherwise they only breathe.
      moving ||= pos.moving || actor.clones.length > 0 || now - actor.born < 400 || actor.gone !== undefined || now - actor.poseAt < 900;
      if (pos.dx) actor.facing = pos.dx > 0 ? 1 : -1;
      const born = clamp((now - actor.born) / 300), dying = actor.gone !== undefined ? clamp((actor.gone - now) / 600) : 1;
      const alpha = Math.min(born, dying) * (actor.status === 'unknown' ? 0.4 : 1) * (view.dim && sessionOf(actor) !== view.dim ? DIMMED : 1);
      const target = actor.target && !actor.target.startsWith(YARD) ? anchor(actor.target) : undefined;
      if (target && !pos.moving) ring(actor.target!, ctx => outline(ctx, target.rect, target.z, actor.color, 0.75 * alpha, actor.pose === 'search'));
      const look: Look = { provider: actor.provider, color: actor.color, size: s, facing: actor.facing, pose: actor.pose, poseAge: now - actor.poseAt, time: time + actor.seed * 100, alpha, walking: false, seed: actor.seed, ...(actor.result ? { result: actor.result, resultAge: now - (actor.resultAt ?? 0) } : {}) };
      bodies.push({ y: pos.y, box: bodyBox(pos.x, pos.y, s), paint: ctx => { drawShadow(ctx, pos.x, pos.ground, s, pos.ground - pos.y, alpha); drawPixel(ctx, pos.x, pos.y, look); } });
      // Its copies: the same character, on the other files it works on at the same time.
      for (const clone of actor.clones) {
        const end = clone.end ? clamp((now - clone.end) / 700) : 0;
        const cpos = end > 0 ? position(anchor, { from: clone.target, to: actor.target ?? clone.target, start: clone.end!, dur: 600 }, actor.target, now, s, reduced) : spread(position(anchor, clone.move, clone.target, now, s, reduced), clone.target, `${actor.key}>${clone.target}`, s);
        if (!cpos) continue;
        const spot = anchor(clone.target);
        if (spot && !end) ring(clone.target, ctx => outline(ctx, spot.rect, spot.z, actor.color, 0.6 * alpha, false));
        const copy: Look = { ...look, alpha: alpha * 0.92 * (1 - end * 0.6), facing: cpos.dx >= 0 ? 1 : -1, seed: actor.seed + 11 };
        bodies.push({ y: cpos.y, box: bodyBox(cpos.x, cpos.y, s), paint: ctx => { drawShadow(ctx, cpos.x, cpos.ground, s, cpos.ground - cpos.y, copy.alpha); drawPixel(ctx, cpos.x, cpos.y, copy); sparkle(ctx, cpos.x, cpos.y, now - clone.start, actor.color); if (clone.end) sparkle(ctx, cpos.x, cpos.y, now - clone.end, actor.color); } });
      }
    }
    return {
      moving,
      reserved: bodies.map(body => body.box),
      draw: ctx => {
        for (const paint of rings.values()) paint(ctx);
        for (const body of [...bodies].sort((a, b) => a.y - b.y)) body.paint(ctx);
      },
    };
  }
}

/** The screen box a character covers, feet at (x, y), with room for what floats over its head. */
function bodyBox(x: number, y: number, size: number): Box { return { x0: x - size * 0.6, y0: y - size * 1.25, x1: x + size * 0.6, y1: y + 4 }; }
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
