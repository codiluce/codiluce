// Agents at work as characters: hook observations turned into actors that hop
// between the files they were reported at. What is about no file (thinking,
// writing the reply, planning, the web, a command, waiting for permission,
// resting) happens outside: the actor leaves the map for a mat beside the map
// edge nearest its last file, does it there, and comes back for the next file.
// Hooks observe tools, not the model: thinking is inferred from a prompt or a
// quiet gap, and writing the reply only in a replay (the gap before a turn
// ends). Pure (no DOM): the Agents at work tool draws it, tests run it.
import type { ActivityEvent, AgentSession } from '@engine/activity/model';
import type { Rect } from '@engine/projection/dto';
import { providerOf, PROVIDER, type Pose, type Provider } from './pixel-crew';
import { sessionKey } from '../../src/harnesses/registry';

export type CrewKind = 'read' | 'edit' | 'search' | 'command' | 'test' | 'status' | 'spawn' | 'done' | 'think' | 'reply' | 'plan' | 'web';
export interface CrewEvent {
  /** Clock time (ms) the event plays at. */
  t: number;
  id: string; actor: string; provider: Provider; title: string;
  kind: CrewKind; phase: 'started' | 'completed' | 'failed' | 'status';
  /** Map IDs of what it names, and for each the areas holding it (root first). */
  targets: string[]; ancestors: Record<string, string[]>;
  status?: string; tool?: string; parent?: string; label: string;
  /** When it was observed (epoch ms), for the ledger. */
  at: number;
}
export interface Move { from?: string; to: string; start: number; dur: number }
export interface Clone { target: string; tool?: string; start: number; end?: number; move: Move }
export interface Actor {
  key: string; provider: Provider; title: string; color: string; parent?: string; mini: boolean; slot: number;
  target?: string; move?: Move; pose: Pose; poseAt: number; last: number; status: string; open: Set<string>; lastFile?: string;
  result?: 'ok' | 'fail'; resultAt?: number; clones: Clone[];
  born: number; gone?: number; facing: 1 | -1; seed: number;
}
/** Targets that are a mat outside the map. */
export const YARD = 'yard:';
/** Thinking is inferred when a running agent has had nothing in flight for this long (live). */
export const THINK_AFTER = 2500;
const PLAN_TOOLS = /^(TodoWrite|update_plan|ExitPlanMode|EnterPlanMode)$/;
const WEB_TOOLS = /^(WebSearch|WebFetch|web_search|web_fetch|web\.run)$/i;

/** An actor's parent session (a subagent's actor is `provider:session:agent`). */
export function parentActor(event: Pick<ActivityEvent, 'provider' | 'sessionId' | 'agentId'>): string | undefined {
  return event.agentId && event.sessionId ? sessionKey(event.provider, event.sessionId) : undefined;
}
export function sessionTitle(actor: string, sessions: readonly AgentSession[], event?: Pick<ActivityEvent, 'sessionTitle' | 'provider'>): string {
  const session = sessions.find(item => item.actor === actor);
  const provider = providerOf(session?.provider ?? event?.provider ?? 'other');
  return session?.title || event?.sessionTitle || `${PROVIDER[provider].label} ${(session?.sessionId ?? actor.split(':')[1] ?? '').slice(0, 6)}`;
}
/** One observation as the cast reads it; undefined when it shows nothing (a read whose file is not on the map). */
export function crewEvent(event: ActivityEvent, t: number, sessions: readonly AgentSession[]): CrewEvent | undefined {
  const targets = event.paths.flatMap(path => (path.id ? [path.id] : []));
  const ancestors = Object.fromEntries(event.paths.flatMap(path => (path.id ? [[path.id, path.ancestors ?? []] as const] : [])));
  const parent = parentActor(event);
  const base = { t, id: event.id, at: event.at, actor: event.actor, provider: providerOf(event.provider), title: sessionTitle(event.actor, sessions, event), targets, ancestors, ...(parent ? { parent } : {}), ...(event.toolId ? { tool: event.toolId } : {}), ...(event.status ? { status: event.status } : {}) };
  const phase = event.phase;
  if (event.lifecycle === 'turn-start' || event.label === 'UserPromptSubmit') return { ...base, kind: 'think', phase: 'status', label: 'prompt: thinking (illustrative)' };
  if (event.lifecycle === 'child-start' || event.label === 'SubagentStart') return { ...base, kind: 'spawn', phase: 'status', label: 'subagent starts' };
  if (event.lifecycle === 'child-end' || event.label === 'SubagentStop') return { ...base, kind: 'done', phase: 'status', label: 'subagent returns' };
  if (event.status === 'waiting') return { ...base, kind: 'status', phase: 'status', status: 'waiting', label: `asks for permission${event.tool ? ` (${event.tool})` : ''}` };
  if ((event.kind === 'read' || event.kind === 'edit' || event.kind === 'search') && phase === 'started' && !targets.length) return undefined;
  const tool = event.tool ?? '';
  const kind: CrewKind = event.kind === 'command' && PLAN_TOOLS.test(tool) ? 'plan' : event.kind === 'command' && WEB_TOOLS.test(tool) ? 'web' : event.kind;
  const names = event.paths.map(path => path.path.split('/').filter(Boolean).pop() ?? path.path).slice(0, 3);
  const what = kind === 'plan' ? 'updates the plan' : kind === 'web' ? 'on the web' : event.label;
  return { ...base, kind, phase, label: `${what}${names.length ? ` ${names.join(', ')}${event.paths.length > 3 ? ` +${event.paths.length - 3}` : ''}` : ''}${phase === 'completed' ? ' · done' : phase === 'failed' ? ' · failed' : ''}` };
}
/**
 * Recent observations for a replay, on a compressed clock starting at
 * `start`. Looking ahead, a long gap after a tool reads as thinking, and the
 * gap before a turn ends as writing the reply (only a replay can tell).
 */
export function replayEvents(events: readonly ActivityEvent[], sessions: readonly AgentSession[], start: number): CrewEvent[] {
  const sorted = [...events].sort((a, b) => a.at - b.at);
  let t = start, previous: number | undefined;
  const out: CrewEvent[] = [];
  sorted.forEach((event, i) => {
    t += previous === undefined ? 300 : Math.min(1400, Math.max(160, (event.at - previous) * 0.2));
    previous = event.at;
    const ev = crewEvent(event, t, sessions);
    if (!ev) return;
    out.push(ev);
    if (ev.phase === 'started') return;
    const next = sorted.slice(i + 1).find(other => other.actor === event.actor);
    if (!next || next.at - event.at < 4000) return;
    const reply = next.label === 'Stop';
    out.push({ ...ev, id: `${ev.id}:gap`, t: t + 120, kind: reply ? 'reply' : 'think', phase: 'status', targets: [], ancestors: {}, label: reply ? 'writes the reply' : 'thinking' });
  });
  return out;
}

/** A mat outside the map: beside the edge nearest `rect`, `out` units out, actors side by side. */
export function yardFor(root: Rect, rect: Rect, slot: number, out = 240): { x: number; y: number } {
  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
  const gaps: [number, number][] = [[0, root.x + root.w - cx], [1, cx - root.x], [2, root.y + root.h - cy], [3, cy - root.y]];
  const side = gaps.reduce((best, next) => (next[1] < best[1] ? next : best))[0];
  const spread = [0, 1, -1, 2, -2, 3][slot % 6]! * 170;
  const along = (v: number, lo: number, hi: number) => Math.max(lo + 60, Math.min(hi - 60, v + spread));
  if (side === 0) return { x: root.x + root.w + out, y: along(cy, root.y, root.y + root.h) };
  if (side === 1) return { x: root.x - out, y: along(cy, root.y, root.y + root.h) };
  if (side === 2) return { x: along(cx, root.x, root.x + root.w), y: root.y + root.h + out };
  return { x: along(cx, root.x, root.x + root.w), y: root.y - out };
}

/** Actors driven by events on a clock (ms). */
export class Cast {
  readonly actors = new Map<string, Actor>();
  readonly applied: CrewEvent[] = [];
  readonly yards = new Map<string, { x: number; y: number }>();
  private queue: CrewEvent[] = [];
  private slots = 0;
  /**
   * `place`: where a map block is (undefined while unknown); `root`: the map's
   * rect; `color`: a session's color; `infer`: thinking from quiet gaps (live).
   */
  constructor(private readonly place: (id: string) => Rect | undefined, private readonly root: () => Rect | undefined, private readonly color: (actor: string) => string, private readonly infer: boolean) {}
  /** Events to play, in clock order. */
  push(events: CrewEvent[]): void { this.queue.push(...events); this.queue.sort((a, b) => a.t - b.t); }
  get pending(): number { return this.queue.length; }
  reset(): void { this.actors.clear(); this.applied.length = 0; this.queue = []; this.slots = 0; this.yards.clear(); }
  /** A target's rect: a block, or a small square around a mat. */
  rectOf(id: string): Rect | undefined {
    const yard = this.yards.get(id);
    return yard ? { x: yard.x - 20, y: yard.y - 20, w: 40, h: 40 } : this.place(id);
  }
  advance(now: number): void {
    while (this.queue.length && this.queue[0]!.t <= now) this.apply(this.queue.shift()!);
    for (const actor of this.actors.values()) {
      const working = actor.pose === 'read' || actor.pose === 'edit' || actor.pose === 'search';
      const busy = actor.open.size > 0 || actor.clones.some(clone => !clone.end);
      // Nothing in flight for a while: the model is thinking (live), or the agent went quiet.
      if (this.infer && working && !busy && actor.status === 'running' && now - actor.last > THINK_AFTER) this.outside(actor, 'think', now);
      else if (working && !busy && now - actor.last > 3600) this.pose(actor, 'idle', now);
      if (actor.pose === 'sit' && now - actor.poseAt > 3200) this.pose(actor, 'sleep', now);
      actor.clones = actor.clones.filter(clone => !clone.end || now - clone.end < 900);
      for (const clone of actor.clones) if (!clone.end && now - clone.start > 4200) clone.end = now;
    }
    for (const [key, actor] of this.actors) if (actor.gone !== undefined && now > actor.gone) this.actors.delete(key);
  }
  /** Where an actor will be: its target, or its first file (to frame the camera). */
  targets(): string[] { return [...this.actors.values()].flatMap(actor => (actor.target ? [actor.target] : [])); }
  private pose(actor: Actor, pose: Pose, now: number) { if (actor.pose !== pose) { actor.pose = pose; actor.poseAt = now; } }
  private yardOf(actor: Actor): string { return `${YARD}${actor.key}`; }
  /** Step outside (to the mat beside the map edge nearest its last file) and do `pose` there. */
  private outside(actor: Actor, pose: Pose, now: number) {
    const id = this.yardOf(actor);
    if (actor.target !== id) {
      const near = actor.lastFile ? this.place(actor.lastFile) : actor.target ? this.rectOf(actor.target) : undefined;
      const root = this.root();
      if (near && root) this.yards.set(id, yardFor(root, near, actor.slot));
      if (this.yards.has(id)) this.moveTo(actor, id, now);
    }
    this.pose(actor, pose, now);
  }
  private moveTo(actor: Actor, to: string, now: number) {
    if (actor.target === to) return;
    const from = actor.target;
    const a = from ? this.rectOf(from) : undefined, b = this.rectOf(to);
    const distance = a && b ? Math.hypot(a.x + a.w / 2 - b.x - b.w / 2, a.y + a.h / 2 - b.y - b.h / 2) : 0;
    actor.move = { ...(from ? { from } : {}), to, start: now, dur: Math.max(380, Math.min(1150, 330 + distance * 0.32)) };
    actor.target = to;
    if (!to.startsWith(YARD)) actor.lastFile = to;
  }
  private apply(ev: CrewEvent) {
    const now = ev.t;
    this.applied.push(ev);
    if (this.applied.length > 400) this.applied.splice(0, this.applied.length - 400);
    let actor = this.actors.get(ev.actor);
    if (!actor) {
      const parent = ev.parent ? this.actors.get(ev.parent) : undefined;
      actor = { key: ev.actor, provider: ev.provider, title: ev.title, color: this.color(ev.actor), mini: !!ev.parent, slot: this.slots++, ...(ev.parent ? { parent: ev.parent } : {}), pose: 'idle', poseAt: now, last: now, status: 'running', open: new Set(), clones: [], born: now, facing: 1, seed: this.actors.size * 7 + 3 };
      const start = parent?.target ?? ev.targets[0];
      if (start?.startsWith(YARD)) { this.yards.set(this.yardOf(actor), this.yards.get(start)!); actor.target = this.yardOf(actor); if (parent?.lastFile) actor.lastFile = parent.lastFile; }
      else if (start) { actor.target = start; actor.lastFile = start; }
      else {
        // Nothing to stand on yet: start outside, by the files this actor will touch first.
        const first = this.queue.find(other => other.actor === ev.actor && other.targets.length)?.targets[0];
        const rect = first ? this.place(first) : undefined, root = this.root();
        if (rect && root) { this.yards.set(this.yardOf(actor), yardFor(root, rect, actor.slot)); actor.target = this.yardOf(actor); actor.lastFile = first; }
      }
      this.actors.set(ev.actor, actor);
    }
    actor.title = ev.title || actor.title;
    actor.last = now;
    if (ev.kind !== 'status' && ev.status === 'running') actor.status = 'running';
    if (actor.gone !== undefined && ev.kind !== 'done' && ev.status !== 'finished') delete actor.gone;
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
      // Several files at once (a batched read, parallel calls): a copy goes to each.
      for (const target of ev.targets.slice(1, 6)) {
        const from = origin ?? ev.targets[0]!;
        const a = this.rectOf(from), b = this.rectOf(target);
        const distance = a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
        actor.clones.push({ target, ...(ev.tool ? { tool: ev.tool } : {}), start: now, move: { from, to: target, start: now + 80, dur: Math.max(380, Math.min(1100, 330 + distance * 0.32)) } });
      }
      return;
    }
    if (ev.phase === 'completed' || ev.phase === 'failed') {
      for (const clone of actor.clones) if (!clone.end && (!ev.tool || clone.tool === ev.tool)) clone.end = now;
      if (ev.kind === 'test' || (ev.kind === 'command' && ev.phase === 'failed')) { actor.result = ev.phase === 'failed' ? 'fail' : 'ok'; actor.resultAt = now; }
      return;
    }
    if (ev.kind === 'command' || ev.kind === 'test') {
      // On a file when the command names one, outside otherwise.
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
