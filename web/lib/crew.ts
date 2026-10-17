// Agents at work as characters: hook observations turned into actors that hop
// between the files they were reported at. Files worked on at the same time
// (parallel calls, a batched read) split the character: a copy goes to each.
// What is about no file (thinking, writing the reply, planning, the web, a
// command, waiting for permission, resting) happens outside: the actor leaves
// the map for a spot beside the map edge nearest its last file, does it there,
// and comes back for the next file. Hooks observe tools, not the model:
// thinking is inferred from a prompt or a quiet gap, and writing the reply
// only in a replay. A finished session can be replayed from its saved
// transcript (`sessionReplay`). Pure (no DOM): the map draws it (crew-map.ts),
// tests run it.
import type { ActivityEvent, AgentSession } from '@engine/activity/model';
import type { ConversationReplay, ReplayStep } from '@engine/conversations/model';
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
  /** Reads, edits and searches in flight: tool id → when it started. */
  files: Map<string, number>;
  result?: 'ok' | 'fail'; resultAt?: number; clones: Clone[];
  born: number; gone?: number; facing: 1 | -1; seed: number;
}
/** Targets that are a mat outside the map. */
export const YARD = 'yard:';
/** Thinking is inferred when a running agent has had nothing in flight for this long (live). */
export const THINK_AFTER = 2500;
/** A file tool still in flight after this long no longer makes the next one parallel (its completion was missed). */
const PARALLEL_MS = 8000;
/** Copies of one character at most, besides itself. */
const MAX_COPIES = 7;
/** A copy stays on its file at least this long, however fast the call. */
const COPY_DWELL = 1200;
const PLAN_TOOLS = /^(TodoWrite|update_plan|ExitPlanMode|EnterPlanMode)$/;
const WEB_TOOLS = /^(WebSearch|WebFetch|web_search|web_fetch|web\.run)$/i;
const SEARCH_TOOLS = /grep|glob|search|find|\brg\b|list_dir|ls$/i;

/** The session an actor belongs to: its own key, or its parent's for a subagent. */
export function sessionOf(actor: Pick<Actor, 'key' | 'parent'>): string { return actor.parent ?? actor.key; }
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
/** A replay lasts at most this long (ms on the cast's clock); a longer session plays its latest steps. */
export const REPLAY_MS = 90_000;
const REPLAY_STEP = 160;
/** A call in a run of calls that named no file on the map. */
const QUIET_STEP = 60;
/** What a saved tool call did, for the cast. */
function stepKind(step: ReplayStep): CrewKind {
  const tool = step.tool ?? '';
  if (PLAN_TOOLS.test(tool)) return 'plan';
  if (WEB_TOOLS.test(tool)) return 'web';
  if (step.paths.some(target => target.action !== 'read')) return 'edit';
  if (step.paths.some(target => target.scope === 'file')) return 'read';
  if (step.paths.length || SEARCH_TOOLS.test(tool)) return 'search';
  return 'command';
}
/**
 * A saved session as the cast plays it, on a compressed clock from `start`:
 * prompts are thinking, replies writing, tool calls hops to the files they
 * named. Calls made together (within a second) stay open together, so the
 * character splits as it did. Runs of calls that named no file go by quickly,
 * so the time goes to the files. At most `REPLAY_MS` long: the latest steps.
 */
export function sessionReplay(replay: ConversationReplay, start: number): CrewEvent[] {
  // Text between tool calls is a progress note: only the reply that ends a turn is played.
  const steps = replay.steps.filter((step, i, all) => step.role !== 'assistant' || !all[i + 1] || all[i + 1]!.role === 'user').slice(-Math.floor(REPLAY_MS / REPLAY_STEP));
  if (!steps.length) return [];
  const provider = providerOf(replay.provider);
  const title = replay.title || `${PROVIDER[provider].label} ${replay.sessionId.slice(0, 6)}`;
  // Observed times (a step without one comes a second after the previous).
  const times: number[] = [];
  for (const step of steps) { const at = step.at ? Date.parse(step.at) : NaN; times.push(Number.isFinite(at) ? Math.max(at, times.at(-1) ?? at) : (times.at(-1) ?? 0) + 1000); }
  const quiet = (step: ReplayStep) => step.role === 'tool' && !step.paths.some(target => target.id);
  const gaps = times.map((at, i) => (!i ? 300 : quiet(steps[i]!) && quiet(steps[i - 1]!) ? QUIET_STEP : Math.min(1400, Math.max(REPLAY_STEP, (at - times[i - 1]!) * 0.2))));
  const total = gaps.reduce((sum, gap) => sum + gap, 0), k = total > REPLAY_MS ? REPLAY_MS / total : 1;
  const clock: number[] = [];
  gaps.forEach((gap, i) => clock.push((clock[i - 1] ?? start) + gap * k));
  const base = { actor: replay.id, provider, title, ancestors: {} as Record<string, string[]> };
  const out: CrewEvent[] = [];
  steps.forEach((step, i) => {
    const t = clock[i]!, id = `replay:${replay.id}:${i}`, at = times[i]!;
    if (step.role !== 'tool') {
      out.push({ ...base, t, id, at, kind: step.role === 'user' ? 'think' : 'reply', phase: 'status', status: 'running', targets: [], label: step.role === 'user' ? 'prompt: thinking' : 'writes the reply' });
      return;
    }
    const placed = step.paths.filter(target => target.id);
    const targets = [...new Set(placed.map(target => target.id!))];
    const ancestors = Object.fromEntries(placed.map(target => [target.id!, target.ancestors ?? []]));
    const kind = stepKind(step), tool = step.callId ?? id;
    // Open until the next step that was not made together with it.
    const next = steps.findIndex((_, j) => j > i && times[j]! - at > 1000);
    const end = next < 0 ? t + 900 : Math.max(t + 120, clock[next]! - 60);
    const names = step.paths.map(target => target.path.split('/').filter(Boolean).pop() ?? target.path).slice(0, 3);
    const label = `${step.tool ?? kind}${names.length ? ` ${names.join(', ')}` : ''}`;
    out.push({ ...base, t, id, at, kind, phase: 'started', status: 'running', tool, targets, ancestors, label });
    out.push({ ...base, t: end, id: `${id}:end`, at, kind, phase: step.status === 'failed' ? 'failed' : 'completed', status: 'running', tool, targets: [], label: `${label} · done` });
  });
  const last = Math.max(...out.map(ev => ev.t));
  out.push({ ...base, t: last + 900, id: `replay:${replay.id}:end`, at: times.at(-1)!, kind: 'status', phase: 'status', status: 'finished', targets: [], label: 'session ends' });
  return out.sort((a, b) => a.t - b.t);
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
      // Activity can arrive before the map loads. Place the actor once its
      // boundary is available, even if no further event arrives.
      if (!actor.target) this.outside(actor, actor.pose, now);
      const working = actor.pose === 'read' || actor.pose === 'edit' || actor.pose === 'search';
      const busy = actor.open.size > 0 || actor.clones.some(clone => !clone.end);
      // Nothing in flight for a while: the model is thinking (live), or the agent went quiet.
      if (this.infer && working && !busy && actor.status === 'running' && now - actor.last > THINK_AFTER) this.outside(actor, 'think', now);
      else if (working && !busy && now - actor.last > 3600) this.pose(actor, 'idle', now);
      if (actor.pose === 'sit' && now - actor.poseAt > 3200) this.pose(actor, 'sleep', now);
      actor.clones = actor.clones.filter(clone => !clone.end || now - clone.end < 900);
      // A copy whose completion never came goes back after a while.
      for (const clone of actor.clones) if (!clone.end && now - clone.start > PARALLEL_MS) clone.end = now;
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
      const root = this.root();
      const near = (actor.lastFile ? this.place(actor.lastFile) : actor.target ? this.rectOf(actor.target) : undefined) ?? root;
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
      // A subagent wears its session's color: the color is how a session is told apart.
      actor = { key: ev.actor, provider: ev.provider, title: ev.title, color: this.color(ev.parent ?? ev.actor), mini: !!ev.parent, slot: this.slots++, ...(ev.parent ? { parent: ev.parent } : {}), pose: 'idle', poseAt: now, last: now, status: 'running', open: new Set(), files: new Map(), clones: [], born: now, facing: 1, seed: this.actors.size * 7 + 3 };
      const start = parent?.target ?? ev.targets[0];
      if (start?.startsWith(YARD)) { this.yards.set(this.yardOf(actor), this.yards.get(start)!); actor.target = this.yardOf(actor); if (parent?.lastFile) actor.lastFile = parent.lastFile; }
      else if (start) { actor.target = start; actor.lastFile = start; }
      else {
        // Start outside, by its first file when known, otherwise by the map.
        const first = this.queue.find(other => other.actor === ev.actor && other.targets.length)?.targets[0];
        const root = this.root(), rect = (first ? this.place(first) : undefined) ?? root;
        if (rect && root) { this.yards.set(this.yardOf(actor), yardFor(root, rect, actor.slot)); actor.target = this.yardOf(actor); actor.lastFile = first; }
      }
      this.actors.set(ev.actor, actor);
    }
    actor.title = ev.title || actor.title;
    actor.last = now;
    if (ev.kind !== 'status' && ev.status === 'running') actor.status = 'running';
    if (actor.gone !== undefined && ev.kind !== 'done' && ev.status !== 'finished') delete actor.gone;
    // Some harnesses report only completed calls (Cursor): a completion whose start was never seen is the visit itself.
    const unseen = ev.phase === 'completed' && !(ev.tool && actor.open.has(ev.tool));
    if (ev.tool && ev.phase === 'started') actor.open.add(ev.tool);
    if (ev.tool && ev.phase !== 'started') { actor.open.delete(ev.tool); actor.files.delete(ev.tool); }
    if (ev.kind === 'spawn') return;
    if (ev.kind === 'done') {
      const parent = actor.parent ? this.actors.get(actor.parent) : undefined;
      if (parent?.target) this.moveTo(actor, parent.target, now);
      actor.gone = now + (actor.move?.dur ?? 0) + 150;
      return;
    }
    if ((ev.kind === 'read' || ev.kind === 'edit' || ev.kind === 'search') && (ev.phase === 'started' || unseen) && ev.targets.length) {
      const origin = actor.target;
      // Already at work on a file when this call starts (parallel calls): the character stays, a copy goes to the new file.
      const parallel = !!origin && !origin.startsWith(YARD) && [...actor.files].some(([tool, at]) => tool !== ev.tool && now - at < PARALLEL_MS);
      if (ev.tool && !unseen) actor.files.set(ev.tool, now);
      if (!parallel) { this.moveTo(actor, ev.targets[0]!, now); this.pose(actor, ev.kind, now); }
      // Several files at once (a batched read, parallel calls): a copy goes to each.
      const taken = new Set([actor.target, ...actor.clones.filter(clone => !clone.end).map(clone => clone.target)]);
      const spread = (parallel ? ev.targets : ev.targets.slice(1)).filter(target => !taken.has(target));
      for (const target of spread.slice(0, Math.max(0, MAX_COPIES - actor.clones.filter(clone => !clone.end).length))) {
        const from = origin ?? ev.targets[0]!;
        const a = this.rectOf(from), b = this.rectOf(target);
        const distance = a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
        actor.clones.push({ target, ...(ev.tool ? { tool: ev.tool } : {}), start: now, ...(unseen ? { end: now + COPY_DWELL } : {}), move: { from, to: target, start: now + 80, dur: Math.max(380, Math.min(1100, 330 + distance * 0.32)) } });
      }
      return;
    }
    if (ev.phase === 'completed' || ev.phase === 'failed') {
      // A copy stays a moment even for a fast call, so it is seen.
      for (const clone of actor.clones) if (!clone.end && (!ev.tool || clone.tool === ev.tool)) clone.end = Math.max(now, clone.start + COPY_DWELL);
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
