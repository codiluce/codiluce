// Agents on the map: every observed session as a pixel character on the map
// itself, while Agents › "Show agents on the map" is on. A character hops to
// the files it is reported at (it splits into copies for files worked on at
// the same time; inside a closed area it stands on that area's roof) and goes
// back to its place in the queue for what is about no file: thinking, writing
// the reply, planning, the web, a command, waiting for permission, resting.
// The queue stands beside the map's right edge, from the top down in the
// order the sessions started (another column to the right when one is full),
// and stays on screen. A short label says what each character is doing
// ("reading crew.ts", "thinking"). In both projections: positions come from
// the map's own drawn blocks. A small square in the session's color marks
// each character, as it marks the session in the Agents list. The characters
// and their labels take their places before the map's labels, which give way
// to them. A saved session replays here step by step: it plays, pauses,
// steps back and forth and changes speed.
import type { ActivityEvent, ActivitySnapshot } from '@engine/activity/model';
import type { ConversationReplay } from '@engine/conversations/model';
import type { Rect } from '@engine/projection/dto';
import { worldToScreen, type Camera, type Viewport } from './camera';
import { agentColor } from './activity';
import { Cast, crewEvent, doing, HOP_MS, inQueue, labelOf, QUEUE, sessionOf, sessionReplay, type Actor, type Move, type ReplayPlan } from './crew';
import { clamp01 as clamp, ease } from './focus-layout';
import type { Box } from './labels';
import { captionWidth, drawBackdrop, drawCaption, drawPixel, drawShadow, sparkle, type Look, type Pose } from './pixel-crew';
import type { Scene, VisibleSet } from './scene';

/** Sessions seen within this long are on the map when it starts showing them, at their latest place. */
const RECENT_MS = 5 * 60_000;
/** Characters of other sessions, while the pointer is on one session in the Agents list. */
const DIMMED = 0.18;
/** Labels are at most this wide (px), in the queue a little less: its columns leave room for them. */
const LABEL_MAX = 170, QUEUE_LABEL = 150;
const LABEL_H = 17;
/** The map's zoom and view buttons, at the viewport's right edge: the queue keeps clear of them. */
const CONTROLS = 60;
interface Anchor { x: number; y: number; rect: Rect; z: number }
type Paint = (ctx: CanvasRenderingContext2D) => void;
/**
 * One frame of the cast: what its characters and labels cover (the map's
 * labels keep off it), what the labels say and where, what draws them over
 * the map, and whether anything moves (otherwise a few frames a second keep
 * them breathing).
 */
export interface CrewFrame { reserved: Box[]; captions: { text: string; box: Box }[]; draw: (ctx: CanvasRenderingContext2D) => void; moving: boolean }
/**
 * A saved session to play again on the map; a new `token` starts it.
 * `playing` and `speed` (1 = a visit to a file lasts about a second) control
 * it; a new `seek.n` goes to step `seek.step`.
 */
export interface CrewReplay { token: number; data: ConversationReplay; playing: boolean; speed: number; seek?: { step: number; n: number } }
/** Where a replay is: its step (0-based, of `total`), what the agent does in it, and whether the replay is over. */
export interface ReplayProgress { token: number; step: number; total: number; text: string; failed: boolean; done: boolean }
/** `focus`: only this session's characters; `dim`: the others recede. Both are session keys (`provider:session`). */
export interface CrewView { focus?: string; dim?: string }

export class CrewOnMap {
  private readonly cast: Cast;
  private readonly clock = { now: 0, last: 0 };
  private readonly seen = new Set<string>();
  private readonly requested = new Set<string>();
  /** Places in the queue (offsets from its first place, easing when someone leaves), by actor. */
  private readonly lanes = new Map<string, { x: number; y: number }>();
  /** The saved session playing: its plan, where it is, and how it plays. `playUntil`: a step shown while paused plays up to then. */
  private replay?: { token: number; plan: ReplayPlan; start: number; step: number; done: boolean; seekN: number; playing: boolean; speed: number; playUntil?: number };
  private replayToken = 0;

  /** `load`: make the blocks of these entities (and the areas holding them) reachable in the scene; `report`: where the replay is, when that changes. */
  constructor(private readonly scene: () => Scene, private readonly load: (ids: string[], areas: string[]) => void, private readonly report: (progress: ReplayProgress) => void = () => {}) {
    this.cast = new Cast(agentColor, true);
  }
  /** Someone is on the map, or about to be. */
  get busy(): boolean { return this.cast.actors.size > 0 || this.cast.pending > 0; }
  /** Playing a saved session again. */
  get replaying(): boolean { return this.replay !== undefined; }
  /**
   * The room (px) the queue wants at the right of a map fitted to the screen:
   * its columns at the largest character size, for everyone on the map. It
   * changes only as columns are added or removed.
   */
  room(viewport: Viewport): number {
    const count = [...this.cast.actors.values()].filter(actor => actor.gone === undefined).length;
    if (!count) return 0;
    const size = 46, perColumn = Math.max(3, Math.floor((viewport.height - 28 - size * 1.45) / (size * 1.8)) + 1);
    return 26 + CONTROLS + Math.ceil(count / perColumn) * (size * 1.25 + QUEUE_LABEL + 12);
  }
  /** Where each session's characters stand now on the map (the character and its copies, not the queue), by session key. */
  places(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const actor of this.cast.actors.values()) {
      if (actor.gone !== undefined) continue;
      const here = [actor.target, ...actor.clones.filter(clone => !clone.end).map(clone => clone.target)].filter((id): id is string => !!id && !inQueue(id));
      if (here.length) (out[sessionOf(actor)] ??= []).push(...here);
    }
    return out;
  }

  /** New observations join the cast as they arrive; the first time, recent sessions start where they are. A new `replay` plays that session; none ends it. */
  sync(snapshot: ActivitySnapshot | undefined, replay?: CrewReplay): void {
    const token = replay?.token ?? 0;
    if (token !== this.replayToken) {
      if (this.replay) this.stopReplay();
      this.replayToken = token;
      if (replay) this.startReplay(replay);
    }
    if (this.replay && replay) {
      this.replay.playing = replay.playing; this.replay.speed = replay.speed;
      if (replay.seek && replay.seek.n !== this.replay.seekN) { this.replay.seekN = replay.seek.n; this.seek(replay.seek.step); }
    }
    if (!snapshot || this.replay) return;
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
      this.cast.push(events.flatMap((event, i) => { const ev = crewEvent(event, now - 60_000 + i, sessions); return ev ? [{ ...ev, instant: true }] : []; }));
      return;
    }
    this.cast.push(fresh.flatMap((event: ActivityEvent, i) => { const ev = crewEvent(event, now + i * 120, sessions); return ev ? [ev] : []; }));
  }
  /** A saved session, alone on the map. */
  private startReplay(replay: CrewReplay): void {
    const start = this.clock.now + 200;
    const plan = sessionReplay(replay.data, start);
    this.cast.reset();
    this.replay = { token: replay.token, plan, start, step: -1, done: false, seekN: replay.seek?.n ?? 0, playing: replay.playing, speed: replay.speed };
    if (!plan.events.length) return;
    this.ensure(plan.events.flatMap(ev => ev.targets.map(id => ({ id, areas: ev.ancestors[id] ?? [] }))));
    this.cast.push(plan.events);
  }
  /** Back to what happens now: the cast is seeded again from the snapshot. */
  private stopReplay(): void { this.replay = undefined; this.cast.reset(); this.seen.clear(); }
  /** To a step of the replay: everything before it played at once, then the step itself plays (its hop shows), paused or not. */
  private seek(step: number): void {
    const replay = this.replay, marks = replay?.plan.marks;
    if (!replay || !marks?.length) return;
    const k = Math.max(0, Math.min(marks.length - 1, step)), t = marks[k]!.t;
    this.cast.reset();
    this.cast.push(replay.plan.events);
    for (let at = replay.start; at < t; at += 200) this.cast.advance(at);
    this.cast.advance(t);
    this.clock.now = t;
    // Its hop plays, short of the next step (a call made together with it comes 120 ms later).
    replay.playUntil = Math.min(t + HOP_MS + 120, (marks[k + 1]?.t ?? Infinity) - 1);
    replay.step = -1; replay.done = false;
  }
  private ensure(targets: { id: string; areas: string[] }[]): void {
    const ids: string[] = [], areas: string[] = [];
    for (const target of targets) if (!this.requested.has(target.id)) { this.requested.add(target.id); ids.push(target.id); areas.push(...target.areas); }
    if (ids.length) this.load(ids, areas);
  }
  /** Moves the clock (a replay at its speed, or stopped while paused) and tells where the replay is. Returns whether the replay plays. */
  private tick(dt: number): boolean {
    const replay = this.replay;
    if (!replay) { this.clock.now += dt; return false; }
    const stepping = replay.playUntil !== undefined;
    const rate = replay.playing && !replay.done ? replay.speed : stepping ? 1 : 0;
    this.clock.now += dt * rate;
    if (stepping && this.clock.now >= replay.playUntil!) { if (!replay.playing) this.clock.now = replay.playUntil!; replay.playUntil = undefined; }
    const marks = replay.plan.marks, now = this.clock.now;
    let step = Math.max(0, replay.step);
    while (step + 1 < marks.length && marks[step + 1]!.t <= now) step++;
    while (step > 0 && marks[step]!.t > now) step--;
    const done = !marks.length || now >= replay.plan.end;
    if (step !== replay.step || done !== replay.done) {
      replay.step = step; replay.done = done;
      const mark = marks[step];
      this.report({ token: replay.token, step, total: marks.length, text: mark?.text ?? '', failed: !!mark?.failed, done });
    }
    return rate > 0;
  }

  /** Advances the cast and lays it out on the blocks drawn this frame, the queue beside the map. */
  frame(viewport: Viewport, camera: Camera, set: VisibleSet, time: number, reduced: boolean, view: CrewView = {}): CrewFrame | undefined {
    // Frames come every 16 ms while they move and every 160 ms while they stand: the clock follows real time (up to a second, after a hidden tab).
    const dt = Math.min(1000, time - (this.clock.last || time)); this.clock.last = time;
    const playing = this.tick(dt);
    const now = this.clock.now;
    this.cast.advance(now);
    const actors = [...this.cast.actors.values()].filter(actor => !view.focus || sessionOf(actor) === view.focus);
    const scene = this.scene();
    const root = scene.rootId ? scene.nodes.get(scene.rootId)?.rect : undefined;
    if (!actors.length || !root) return undefined;
    const size = Math.max(22, Math.min(46, 22 + camera.scale * 40));
    const lane = this.lane(viewport, camera, root, actors, size, dt);
    const anchor = (id: string): Anchor | undefined => {
      if (inQueue(id)) { const spot = lane.places.get(id.slice(QUEUE.length)); return spot ? { ...spot, rect: { x: 0, y: 0, w: 0, h: 0 }, z: 0 } : undefined; }
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
    // Who stands in the queue is drawn after the others (over the queue's backdrop, when it stands over the map).
    const bodies: { y: number; box: Box; paint: Paint; queued?: boolean }[] = [];
    // What each character is doing: beside it in the queue, over its head on a file. Labels in the queue come first; on the map, one that would cover another stacks above it, or is left out.
    const captions: { box: Box; text: string; color: string; alpha: number }[] = [];
    const queued: typeof captions = [], onMap: { x: number; top: number; text: string; color: string; alpha: number; first: boolean }[] = [];
    // Characters and copies standing on the same drawn block (two files inside one closed area too) gather side by side, in rows of five, instead of on top of one another.
    const drawnAt = (id: string) => (inQueue(id) ? id : (set.items[set.index.get(id) ?? -1] ?? scene.representative(id, set))?.node.id ?? id);
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
    const stand = (actor: Actor, s: number) => spread(position(anchor, actor.move, actor.target, now, s, reduced), actor.target, actor.key, s);
    let moving = playing || lane.moving;
    for (const actor of actors) {
      const s = actor.mini ? size * 0.75 : size;
      const pos = stand(actor, s);
      if (!pos) continue;
      // Hops, arrivals, departures, a new pose and parallel reads move: drawn every frame. Otherwise they only breathe.
      moving ||= pos.moving || actor.clones.length > 0 || now - actor.born < 400 || actor.gone !== undefined || now - actor.poseAt < 900;
      const waiting = inQueue(actor.target) && !pos.moving;
      // In the queue, a character faces the map.
      if (pos.dx) actor.facing = pos.dx > 0 ? 1 : -1; else if (waiting) actor.facing = -1;
      const born = clamp((now - actor.born) / 300), dying = actor.gone !== undefined ? clamp((actor.gone - now) / 600) : 1;
      const alpha = Math.min(born, dying) * (actor.status === 'unknown' ? 0.4 : 1) * (view.dim && sessionOf(actor) !== view.dim ? DIMMED : 1);
      const target = actor.target && !inQueue(actor.target) ? anchor(actor.target) : undefined;
      if (target && !pos.moving) ring(actor.target!, ctx => outline(ctx, target.rect, target.z, actor.color, 0.75 * alpha, actor.pose === 'search'));
      const look: Look = { provider: actor.provider, color: actor.color, size: s, facing: actor.facing, pose: actor.pose, poseAge: now - actor.poseAt, time: time + actor.seed * 100, alpha, walking: false, seed: actor.seed, ...(actor.result ? { result: actor.result, resultAge: now - (actor.resultAt ?? 0) } : {}) };
      bodies.push({ y: pos.y, box: bodyBox(pos.x, pos.y, s), queued: waiting, paint: ctx => { drawShadow(ctx, pos.x, pos.ground, s, pos.ground - pos.y, alpha); drawPixel(ctx, pos.x, pos.y, look); } });
      const text = labelOf(actor);
      if (waiting) { const x0 = pos.x + s * 0.62 + 4, y0 = pos.y - s * 0.48 - LABEL_H / 2; queued.push({ box: { x0, y0, x1: x0 + captionWidth(text, QUEUE_LABEL), y1: y0 + LABEL_H }, text, color: actor.color, alpha }); }
      else if (!pos.moving) onMap.push({ x: pos.x, top: pos.y - s * 1.3 - 3, text, color: actor.color, alpha, first: true });
      // Its copies: the same character, on the other files it works on at the same time.
      for (const clone of actor.clones) {
        const end = clone.end ? clamp((now - clone.end) / 700) : 0;
        const cpos = end > 0 ? position(anchor, { from: clone.target, to: actor.target ?? clone.target, start: clone.end!, dur: HOP_MS }, actor.target, now, s, reduced) : spread(position(anchor, clone.move, clone.target, now, s, reduced), clone.target, `${actor.key}>${clone.target}`, s);
        if (!cpos) continue;
        const spot = anchor(clone.target);
        if (spot && !end) ring(clone.target, ctx => outline(ctx, spot.rect, spot.z, actor.color, 0.6 * alpha, false));
        const copy: Look = { ...look, pose: clone.kind as Pose, alpha: alpha * 0.92 * (1 - end * 0.6), facing: cpos.dx >= 0 ? 1 : -1, seed: actor.seed + 11 };
        bodies.push({ y: cpos.y, box: bodyBox(cpos.x, cpos.y, s), paint: ctx => { drawShadow(ctx, cpos.x, cpos.ground, s, cpos.ground - cpos.y, copy.alpha); drawPixel(ctx, cpos.x, cpos.y, copy); sparkle(ctx, cpos.x, cpos.y, now - clone.start, actor.color); if (clone.end) sparkle(ctx, cpos.x, cpos.y, now - clone.end, actor.color); } });
        if (!end && !cpos.moving) onMap.push({ x: cpos.x, top: cpos.y - s * 1.3 - 3, text: doing(clone.kind as Pose, clone.detail), color: actor.color, alpha: copy.alpha, first: false });
      }
    }
    captions.push(...queued);
    const free = (box: Box) => !captions.some(other => box.x0 < other.box.x1 && box.x1 > other.box.x0 && box.y0 < other.box.y1 && box.y1 > other.box.y0);
    for (const label of onMap.sort((a, b) => Number(b.first) - Number(a.first))) {
      const w = captionWidth(label.text, LABEL_MAX);
      for (let lift = 0; lift < 3; lift++) {
        const y1 = label.top - lift * (LABEL_H + 2), box = { x0: label.x - w / 2, y0: y1 - LABEL_H, x1: label.x + w / 2, y1 };
        if (free(box)) { captions.push({ ...label, box }); break; }
      }
    }
    return {
      moving,
      reserved: [...bodies.map(body => body.box), ...captions.map(caption => caption.box), ...(lane.backdrop ? [lane.backdrop] : [])],
      captions: captions.map(caption => ({ text: caption.text, box: caption.box })),
      draw: ctx => {
        for (const paint of rings.values()) paint(ctx);
        const sorted = [...bodies].sort((a, b) => a.y - b.y);
        for (const body of sorted) if (!body.queued) body.paint(ctx);
        if (lane.backdrop) drawBackdrop(ctx, lane.backdrop);
        for (const body of sorted) if (body.queued) body.paint(ctx);
        for (const caption of captions) drawCaption(ctx, caption.box, caption.text, caption.color, caption.alpha);
      },
    };
  }
  /**
   * The queue: beside the map's right edge, from its top down in the order
   * the sessions started (a subagent after its session), another column to
   * the right when one is full. It stays on screen: without room beside the
   * map (a map fitted to the screen, zoomed in), it stands over the map's
   * right side, on a backdrop. Places are kept while their characters are on
   * the map; when one leaves, the others move up.
   */
  private lane(viewport: Viewport, camera: Camera, root: Rect, actors: Actor[], size: number, dt: number): { places: Map<string, { x: number; y: number }>; moving: boolean; backdrop?: Box } {
    const corners = [[root.x, root.y], [root.x + root.w, root.y], [root.x + root.w, root.y + root.h], [root.x, root.y + root.h]].map(([x, y]) => worldToScreen(camera, viewport, x!, y!, 0));
    const right = Math.max(...corners.map(p => p.x)), top = Math.min(...corners.map(p => p.y)), bottom = Math.max(...corners.map(p => p.y));
    const since = (actor: Actor) => (actor.parent ? this.cast.actors.get(actor.parent)?.since : undefined) ?? actor.since;
    const order = [...actors].sort((a, b) => since(a) - since(b) || Number(a.mini) - Number(b.mini) || a.since - b.since || a.slot - b.slot);
    const row = size * 1.8, column = size * 1.25 + QUEUE_LABEL + 12;
    const first = Math.max(top, 14) + size * 1.45;
    const perColumn = Math.max(3, Math.floor((Math.min(bottom, viewport.height - 14) - first) / row) + 1);
    const columns = Math.ceil(order.length / perColumn);
    const beside = right + 26 + size * 0.6;
    const x0 = Math.max(14 + size * 0.6, Math.min(beside, viewport.width - CONTROLS - columns * column + size * 0.6));
    // Over the map: from the bubbles on the left (they face the map) to the labels on the right.
    const rows = Math.min(order.length, perColumn);
    const backdrop = x0 < beside - 0.5 ? { x0: x0 - size - 8, y0: first - size * 1.6 - 6, x1: x0 + (columns - 1) * column + size * 0.62 + QUEUE_LABEL + 10, y1: first + (rows - 1) * row + 10 } : undefined;
    const places = new Map<string, { x: number; y: number }>();
    let moving = false;
    order.forEach((actor, i) => {
      const goal = { x: Math.floor(i / perColumn) * column, y: (i % perColumn) * row };
      const was = this.lanes.get(actor.key), k = Math.min(1, dt / 140);
      const at = was ? { x: was.x + (goal.x - was.x) * k, y: was.y + (goal.y - was.y) * k } : goal;
      if (Math.abs(at.x - goal.x) > 0.5 || Math.abs(at.y - goal.y) > 0.5) moving = true; else { at.x = goal.x; at.y = goal.y; }
      this.lanes.set(actor.key, at);
      places.set(actor.key, { x: x0 + at.x, y: first + at.y });
    });
    for (const key of this.lanes.keys()) if (!this.cast.actors.has(key)) this.lanes.delete(key);
    return { places, moving, ...(backdrop ? { backdrop } : {}) };
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
  const height = Math.min(90, s * 0.4 + Math.hypot(end.x - start.x, end.y - start.y) * 0.18);
  return { x, y: ground - Math.sin(p * Math.PI) * height, ground, dx: end.x - start.x, moving: true };
}
