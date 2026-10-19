// Agents at work as characters: hook observations turned into actors that hop
// between the files they were reported at. Files worked on at the same time
// (parallel calls, a batched read) split the character: a copy goes to each.
// What is about no file (thinking, writing the reply, planning, the web, a
// command, waiting for permission, resting) happens in the queue: every
// session has a place there, in the order the sessions started, and its
// character waits in it between files. Hops are quick, and a visit to a file
// lasts at least DWELL_MS, so the eye can follow where an agent goes: an
// actor's events play in order, and the next place waits for the visit to end.
// Hooks observe tools, not the model: thinking is inferred from a prompt or a
// quiet gap, and writing the reply only in a replay. A finished session can
// be replayed from its saved transcript (`sessionReplay`), step by step.
// Pure (no DOM): the map draws it (crew-map.ts), tests run it.
import type { ActivityEvent, ActivityPath, AgentSession } from '@engine/activity/model';
import type { ConversationReplay, ReplayStep } from '@engine/conversations/model';
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
  /** The paths of `targets`, in the same order (a folder ends with "/"). */
  paths?: string[];
  /** `tool`: the call's ID; `name`: the tool's; `query`: what a search looks for. */
  status?: string; tool?: string; name?: string; query?: string; parent?: string; label: string;
  /** When it was observed (epoch ms), for the ledger. */
  at: number;
  /** Already done when the cast starts: played at once, without waiting for visits to end. */
  instant?: boolean;
}
export interface Move { from?: string; to: string; start: number; dur: number }
export interface Clone { target: string; kind: CrewKind; detail?: string; tool?: string; start: number; end?: number; move: Move }
export interface Actor {
  key: string; provider: Provider; title: string; color: string; parent?: string; mini: boolean; slot: number;
  /** First observed (epoch ms): its place in the queue. */
  since: number;
  target?: string; move?: Move; pose: Pose; poseAt: number; last: number; status: string; open: Set<string>;
  /** What it works on (a path, or a search's quoted pattern) and the tool it uses: its label. */
  detail?: string; name?: string;
  /** Reads, edits and searches in flight: tool id → when it started. */
  files: Map<string, number>;
  /** It stays where it is until `hold`; its latest event played at `cursor` (its events play in order). */
  hold: number; cursor: number;
  result?: 'ok' | 'fail'; resultAt?: number; clones: Clone[];
  born: number; gone?: number; facing: 1 | -1; seed: number;
}
/** Targets that are an actor's place in the queue beside the map. */
export const QUEUE = 'queue:';
export function inQueue(target: string | undefined): boolean { return !!target?.startsWith(QUEUE); }
/** Thinking is inferred when a running agent has had nothing in flight for this long (live). */
export const THINK_AFTER = 2500;
/** Every hop (between files, to and from the queue) takes this long. */
export const HOP_MS = 300;
/** A visit to a file lasts at least this long. */
export const DWELL_MS = 1000;
/** A stop in the queue between files lasts at least this long. */
const QUEUE_DWELL = 450;
/** Live, an agent faster than its character falls behind: past this, visits shorten, and past `LAG_SKIP` they no longer wait. */
const LAG_SHORT = 5000, LAG_SKIP = 12_000;
/** A file tool still in flight after this long no longer makes the next one parallel (its completion was missed). */
const PARALLEL_MS = 8000;
/** Copies of one character at most, besides itself. */
const MAX_COPIES = 7;
/** A copy stays on its file at least this long, however fast the call. */
const COPY_DWELL = 1200;
const PLAN_TOOLS = /^(TodoWrite|update_plan|ExitPlanMode|EnterPlanMode)$/;
const WEB_TOOLS = /^(WebSearch|WebFetch|web_search|web_fetch|web\.run)$/i;
const SEARCH_TOOLS = /grep|glob|search|find|\brg\b|list_dir|ls$/i;
const SHELL_TOOLS = /^(Bash|exec_command|shell_command|shell|run_terminal_cmd|run_shell_command|terminal|execute_command)$/i;
const FILE_KINDS = new Set<CrewKind>(['read', 'edit', 'search']);

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
/** A path as shown: a folder ends with "/". */
function shown(path: Pick<ActivityPath, 'path' | 'scope'>): string { return path.scope === 'directory' && path.path !== '.' && !path.path.endsWith('/') ? `${path.path}/` : path.path; }
/** One observation as the cast reads it; undefined when it shows nothing (a read whose file is not on the map). */
export function crewEvent(event: ActivityEvent, t: number, sessions: readonly AgentSession[]): CrewEvent | undefined {
  const placed = event.paths.filter(path => path.id);
  const targets = placed.map(path => path.id!);
  const ancestors = Object.fromEntries(placed.map(path => [path.id!, path.ancestors ?? []] as const));
  const parent = parentActor(event);
  const base = { t, id: event.id, at: event.at, actor: event.actor, provider: providerOf(event.provider), title: sessionTitle(event.actor, sessions, event), targets, ancestors, paths: placed.map(shown), ...(parent ? { parent } : {}), ...(event.toolId ? { tool: event.toolId } : {}), ...(event.tool ? { name: event.tool } : {}), ...(event.query ? { query: event.query } : {}), ...(event.status ? { status: event.status } : {}) };
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

/** The last part of a path ("crew.ts", "lib/"), or a search's pattern, kept short. */
function short(detail: string, max = 26): string {
  const text = detail.startsWith('"') ? detail : detail.endsWith('/') ? `${detail.split('/').filter(Boolean).pop() ?? detail}/` : detail.split('/').pop() || detail;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
/** What a tool other than a file tool does, in words ("mcp__codiluce__search" is "using codiluce search"). */
function using(name: string | undefined): string {
  if (!name || SHELL_TOOLS.test(name)) return 'running a command';
  if (/^(Task|Agent|spawn_agent)$/i.test(name)) return 'starting a subagent';
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  return `using ${mcp ? `${mcp[1]!.replace(/^claude_ai_/, '').replace(/_/g, ' ')} ${mcp[2]!.replace(/_/g, ' ')}` : name}`;
}
/** What a character is doing, in a few words: its label on the map ("reading crew.ts", "thinking", "idle"). */
export function doing(pose: Pose, detail?: string, name?: string): string {
  switch (pose) {
    case 'read': return detail ? `reading ${short(detail)}` : 'reading';
    case 'edit': return detail ? `editing ${short(detail)}` : 'editing';
    case 'search': return detail ? `searching ${short(detail)}` : 'searching';
    case 'command': return using(name);
    case 'test': return 'running tests';
    case 'think': return 'thinking';
    case 'reply': return 'writing the reply';
    case 'plan': return 'updating the plan';
    case 'web': return name && /fetch/i.test(name) ? 'reading a web page' : 'searching the web';
    case 'wait': return 'waiting for permission';
    case 'wave': return 'finished';
    default: return 'idle';
  }
}
/** An actor's label now. */
export function labelOf(actor: Pick<Actor, 'pose' | 'detail' | 'name'>): string { return doing(actor.pose, actor.detail, actor.name); }
/** What a call works on, for its label: a search's pattern (quoted), or the path of its `i`-th target. */
function detailOf(ev: CrewEvent, i = 0): string | undefined {
  if (ev.kind === 'search' && ev.query) return `"${ev.query}"`;
  return ev.paths?.[i] ?? ev.targets[i];
}

/** A step of a replay: when it plays (cast clock) and what the agent does in it, with full paths. */
export interface ReplayMark { t: number; kind: CrewKind; text: string; failed?: boolean }
export interface ReplayPlan { events: CrewEvent[]; marks: ReplayMark[]; end: number }
/** A run of calls that named no file on the map go by at this pace (in the queue). */
const QUIET_STEP = 250;
/** Calls made together start this far apart (the character splits). */
const TOGETHER_STEP = 120;
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
/** A step in words, with its paths in full ("Reading web/lib/crew.ts", "Reading and editing a.ts and b.ts"). */
function stepText(kinds: CrewKind[], paths: string[], name?: string): string {
  const kind = kinds[0]!;
  const list = paths.length > 2 ? `${paths.slice(0, 2).join(', ')} and ${paths.length - 2} more` : paths.join(' and ');
  const verbs = [...new Set(kinds)].map(each => doing(each as Pose)).join(' and ');
  const text = FILE_KINDS.has(kind) && list ? `${verbs} ${list}` : kind === 'status' ? 'the session ends' : doing(kind as Pose, undefined, name);
  return `${text[0]!.toUpperCase()}${text.slice(1)}`;
}
/**
 * A saved session as the cast plays it, from `start` on the cast's clock:
 * prompts are thinking, replies writing, tool calls hops to the files they
 * named, each step a mark to step to. Calls made together (within a second)
 * stay open together, so the character splits as it did, and are one step
 * (one mark). The clock follows
 * the cast's rules, so nothing waits: a visit to a file lasts a hop and
 * DWELL_MS, a stop in the queue a hop and QUEUE_DWELL; runs of calls that
 * named no file go by quickly, and longer pauses of the session play a
 * little longer.
 */
export function sessionReplay(replay: ConversationReplay, start: number): ReplayPlan {
  // Text between tool calls is a progress note: only the reply that ends a turn is played.
  const steps = replay.steps.filter((step, i, all) => step.role !== 'assistant' || !all[i + 1] || all[i + 1]!.role === 'user');
  if (!steps.length) return { events: [], marks: [], end: start };
  const provider = providerOf(replay.provider);
  const title = replay.title || `${PROVIDER[provider].label} ${replay.sessionId.slice(0, 6)}`;
  // Observed times (a step without one comes a second after the previous).
  const times: number[] = [];
  for (const step of steps) { const at = step.at ? Date.parse(step.at) : NaN; times.push(Number.isFinite(at) ? Math.max(at, times.at(-1) ?? at) : (times.at(-1) ?? 0) + 1000); }
  const placedOf = (step: ReplayStep) => step.paths.filter(target => target.id);
  // Where a step takes the character: a file on the map, the queue, or nowhere (a file tool on paths off the map).
  const place = (step: ReplayStep): 'file' | 'queue' | undefined => {
    if (step.role !== 'tool') return 'queue';
    const kind = stepKind(step);
    return !FILE_KINDS.has(kind) ? 'queue' : placedOf(step).length ? 'file' : undefined;
  };
  const quiet = (step: ReplayStep) => step.role === 'tool' && !step.paths.some(target => target.id);
  // The clock, as the cast will play it (so nothing waits there): where the character is, and until when it stays.
  const clock: number[] = [], together: boolean[] = [];
  let at: 'queue' | 'file' = 'queue', hold = start;
  steps.forEach((step, i) => {
    const prev = i ? clock[i - 1]! : start;
    together.push(i > 0 && place(step) === 'file' && place(steps[i - 1]!) === 'file' && times[i]! - times[i - 1]! <= 1000);
    const gap = !i ? 300 : together[i] ? TOGETHER_STEP : quiet(step) && quiet(steps[i - 1]!) ? QUIET_STEP : Math.min(1500, Math.max(QUIET_STEP, (times[i]! - times[i - 1]!) * 0.05));
    // A call made together with the one before goes as a copy: it waits for nothing.
    const t = together[i] ? prev + gap : Math.max(prev + gap, hold);
    clock.push(t);
    if (together[i]) return;
    const to = place(step);
    if (to === 'file') { hold = t + HOP_MS + DWELL_MS; at = 'file'; }
    else if (to === 'queue' && at === 'file') { hold = t + HOP_MS + QUEUE_DWELL; at = 'queue'; }
  });
  const base = { actor: replay.id, provider, title, ancestors: {} as Record<string, string[]> };
  const events: CrewEvent[] = [], marks: ReplayMark[] = [];
  // What each mark covers (calls made together share one).
  const parts: { kinds: CrewKind[]; paths: string[] }[] = [];
  steps.forEach((step, i) => {
    const t = clock[i]!, id = `replay:${replay.id}:${i}`, observed = times[i]!;
    if (step.role !== 'tool') {
      const kind = step.role === 'user' ? 'think' : 'reply';
      events.push({ ...base, t, id, at: observed, kind, phase: 'status', status: 'running', targets: [], label: step.role === 'user' ? 'prompt: thinking' : 'writes the reply' });
      marks.push({ t, kind, text: stepText([kind], []) }); parts.push({ kinds: [kind], paths: [] });
      return;
    }
    const placed = placedOf(step);
    const targets = [...new Set(placed.map(target => target.id!))];
    const ancestors = Object.fromEntries(placed.map(target => [target.id!, target.ancestors ?? []]));
    const paths = targets.map(id => shown(placed.find(target => target.id === id)!));
    const kind = stepKind(step), tool = step.callId ?? id;
    // Open until the next step that was not made together with it.
    const next = steps.findIndex((_, j) => j > i && times[j]! - observed > 1000);
    const end = next < 0 ? t + HOP_MS + DWELL_MS : Math.max(t + 120, clock[next]! - 60);
    const names = step.paths.map(target => target.path.split('/').filter(Boolean).pop() ?? target.path).slice(0, 3);
    const label = `${step.tool ?? kind}${names.length ? ` ${names.join(', ')}` : ''}`;
    const failed = step.status === 'failed';
    events.push({ ...base, t, id, at: observed, kind, phase: 'started', status: 'running', tool, ...(step.tool ? { name: step.tool } : {}), targets, ancestors, paths, label });
    events.push({ ...base, t: end, id: `${id}:end`, at: observed, kind, phase: failed ? 'failed' : 'completed', status: 'running', tool, targets: [], label: `${label} · done` });
    const mark = together[i] ? marks.at(-1) : undefined, part = together[i] ? parts.at(-1) : undefined;
    if (mark && part) {
      part.kinds.push(kind); part.paths = [...new Set([...part.paths, ...step.paths.map(shown)])];
      mark.text = stepText(part.kinds, part.paths); if (failed) mark.failed = true;
    } else {
      const all = [...new Set(step.paths.map(shown))];
      marks.push({ t, kind, text: stepText([kind], all, step.tool), ...(failed ? { failed } : {}) });
      parts.push({ kinds: [kind], paths: all });
    }
  });
  const last = Math.max(hold, ...events.map(ev => ev.t)) + 400;
  events.push({ ...base, t: last, id: `replay:${replay.id}:end`, at: times.at(-1)!, kind: 'status', phase: 'status', status: 'finished', targets: [], label: 'session ends' });
  marks.push({ t: last, kind: 'status', text: stepText(['status'], []) });
  return { events: events.sort((a, b) => a.t - b.t), marks, end: last + HOP_MS + 2400 };
}

/** Actors driven by events on a clock (ms). */
export class Cast {
  readonly actors = new Map<string, Actor>();
  readonly applied: CrewEvent[] = [];
  private queue: CrewEvent[] = [];
  private slots = 0;
  /** `color`: a session's color; `infer`: thinking from quiet gaps (live). */
  constructor(private readonly color: (actor: string) => string, private readonly infer: boolean) {}
  /** Events to play, in clock order. */
  push(events: CrewEvent[]): void { this.queue.push(...events); this.queue.sort((a, b) => a.t - b.t); }
  get pending(): number { return this.queue.length; }
  reset(): void { this.actors.clear(); this.applied.length = 0; this.queue = []; this.slots = 0; }
  /** An actor's place in the queue. */
  queueOf(actor: Pick<Actor, 'key'>): string { return `${QUEUE}${actor.key}`; }
  advance(now: number): void {
    // Each actor's events play in order, and none takes it elsewhere before its visit is over.
    const waiting: CrewEvent[] = [], blocked = new Set<string>();
    let i = 0;
    for (; i < this.queue.length && this.queue[i]!.t <= now; i++) {
      const ev = this.queue[i]!, actor = this.actors.get(ev.actor);
      const at = !actor ? ev.t : Math.max(ev.t, actor.cursor, !ev.instant && this.holds(actor, ev, Math.max(ev.t, actor.cursor)) ? actor.hold : 0);
      if (blocked.has(ev.actor) || at > now) { blocked.add(ev.actor); waiting.push(ev); continue; }
      this.apply(ev, at);
    }
    if (i) this.queue = waiting.concat(this.queue.slice(i));
    for (const actor of this.actors.values()) {
      const working = actor.pose === 'read' || actor.pose === 'edit' || actor.pose === 'search';
      const busy = actor.open.size > 0 || actor.clones.some(clone => !clone.end);
      // Nothing in flight for a while: the model is thinking (live), or the agent went quiet. Either way, in the queue.
      if (working && !busy && now >= actor.hold && !blocked.has(actor.key)) {
        if (this.infer && actor.status === 'running' && now - actor.last > THINK_AFTER) this.outside(actor, 'think', now);
        else if (now - actor.last > 3600) this.outside(actor, 'idle', now);
      }
      if (actor.pose === 'sit' && now - actor.poseAt > 3200) this.pose(actor, 'sleep', now);
      actor.clones = actor.clones.filter(clone => !clone.end || now - clone.end < 900);
      // A copy whose completion never came goes back after a while.
      for (const clone of actor.clones) if (!clone.end && now - clone.start > PARALLEL_MS) clone.end = now;
    }
    for (const [key, actor] of this.actors) if (actor.gone !== undefined && now > actor.gone) this.actors.delete(key);
  }
  /** Whether an event (played at `at`) takes the actor elsewhere or changes what it does: it waits for the visit to end. A call's end does not, nor a call made beside another (a copy goes). */
  private holds(actor: Actor, ev: CrewEvent, at: number): boolean {
    if (ev.kind === 'spawn') return false;
    if (ev.phase === 'completed' || ev.phase === 'failed') return FILE_KINDS.has(ev.kind) && ev.targets.length > 0 && !(ev.tool && actor.open.has(ev.tool));
    return !(FILE_KINDS.has(ev.kind) && ev.phase === 'started' && this.parallel(actor, ev, at));
  }
  /** Already at work on a file when this call starts (parallel calls): the character stays, a copy goes. */
  private parallel(actor: Actor, ev: CrewEvent, at: number): boolean {
    return !!actor.target && !inQueue(actor.target) && [...actor.files].some(([tool, start]) => tool !== ev.tool && at - start < PARALLEL_MS);
  }
  private pose(actor: Actor, pose: Pose, now: number) { if (actor.pose !== pose) { actor.pose = pose; actor.poseAt = now; } }
  /** It stays at least `dwell` after it arrives (less while it is behind the agent, `lag`). */
  private stay(actor: Actor, now: number, moved: boolean, lag: number, dwell: number) {
    actor.hold = lag > LAG_SKIP ? now : now + (moved ? HOP_MS : 0) + (lag > LAG_SHORT ? dwell * 0.35 : dwell);
  }
  /** To its place in the queue, and do `pose` there. */
  private outside(actor: Actor, pose: Pose, now: number, lag = 0) {
    if (this.moveTo(actor, this.queueOf(actor), now)) { this.stay(actor, now, true, lag, QUEUE_DWELL); delete actor.detail; }
    this.pose(actor, pose, now);
  }
  private moveTo(actor: Actor, to: string, now: number): boolean {
    if (actor.target === to) return false;
    actor.move = { ...(actor.target ? { from: actor.target } : {}), to, start: now, dur: HOP_MS };
    actor.target = to;
    return true;
  }
  private join(ev: CrewEvent, now: number): Actor {
    const parent = ev.parent ? this.actors.get(ev.parent) : undefined;
    // A subagent wears its session's color (the color is how a session is told apart) and comes out where its parent is; anyone else, out of its place in the queue.
    const actor: Actor = { key: ev.actor, provider: ev.provider, title: ev.title, color: this.color(ev.parent ?? ev.actor), mini: !!ev.parent, slot: this.slots++, since: ev.at, ...(ev.parent ? { parent: ev.parent } : {}), pose: 'idle', poseAt: now, last: now, status: 'running', open: new Set(), files: new Map(), hold: now, cursor: now, clones: [], born: now, facing: -1, seed: this.actors.size * 7 + 3 };
    actor.target = parent?.target ?? this.queueOf(actor);
    this.actors.set(ev.actor, actor);
    return actor;
  }
  private apply(ev: CrewEvent, now: number) {
    this.applied.push(ev);
    if (this.applied.length > 400) this.applied.splice(0, this.applied.length - 400);
    const actor = this.actors.get(ev.actor) ?? this.join(ev, now);
    // How far behind the agent its character is (an event already done is not waited for).
    const lag = ev.instant ? Infinity : now - ev.t;
    actor.cursor = now;
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
    if (FILE_KINDS.has(ev.kind) && (ev.phase === 'started' || unseen) && ev.targets.length) {
      const origin = actor.target;
      const parallel = this.parallel(actor, ev, now);
      if (ev.tool && !unseen) actor.files.set(ev.tool, now);
      if (!parallel) {
        const moved = this.moveTo(actor, ev.targets[0]!, now);
        this.pose(actor, ev.kind as Pose, now);
        const detail = detailOf(ev);
        if (detail) actor.detail = detail; else delete actor.detail;
        this.stay(actor, now, moved, lag, DWELL_MS);
      }
      // Several files at once (a batched read, parallel calls): a copy goes to each.
      const taken = new Set([actor.target, ...actor.clones.filter(clone => !clone.end).map(clone => clone.target)]);
      const spread = ev.targets.map((target, j) => ({ target, j })).slice(parallel ? 0 : 1).filter(item => !taken.has(item.target));
      for (const { target, j } of spread.slice(0, Math.max(0, MAX_COPIES - actor.clones.filter(clone => !clone.end).length))) {
        const detail = detailOf(ev, j);
        actor.clones.push({ target, kind: ev.kind, ...(detail ? { detail } : {}), ...(ev.tool ? { tool: ev.tool } : {}), start: now, ...(unseen ? { end: now + COPY_DWELL } : {}), move: { from: origin ?? ev.targets[0]!, to: target, start: now + 60, dur: HOP_MS } });
      }
      return;
    }
    if (ev.phase === 'completed' || ev.phase === 'failed') {
      // A copy stays a moment even for a fast call, so it is seen.
      for (const clone of actor.clones) if (!clone.end && (!ev.tool || clone.tool === ev.tool)) clone.end = Math.max(now, clone.start + COPY_DWELL);
      if (ev.kind === 'test' || (ev.kind === 'command' && ev.phase === 'failed')) { actor.result = ev.phase === 'failed' ? 'fail' : 'ok'; actor.resultAt = now; }
      return;
    }
    if (ev.name) actor.name = ev.name; else delete actor.name;
    if (ev.kind === 'command' || ev.kind === 'test') {
      // On a file when the command names one, in the queue otherwise.
      if (ev.targets.length) { const moved = this.moveTo(actor, ev.targets[0]!, now); this.pose(actor, ev.kind, now); const detail = detailOf(ev); if (detail) actor.detail = detail; this.stay(actor, now, moved, lag, DWELL_MS); }
      else this.outside(actor, ev.kind, now, lag);
      return;
    }
    if (ev.kind === 'think' || ev.kind === 'reply' || ev.kind === 'plan' || ev.kind === 'web') { this.outside(actor, ev.kind, now, lag); return; }
    if (ev.kind === 'status') {
      actor.status = ev.status ?? actor.status;
      if (ev.status === 'waiting') this.outside(actor, 'wait', now, lag);
      else if (ev.status === 'idle' || ev.status === 'interrupted') this.outside(actor, 'sit', now, lag);
      else if (ev.status === 'finished') { this.outside(actor, 'wave', now, lag); actor.gone = now + (actor.move && actor.move.start === now ? actor.move.dur : 0) + 2200; }
      else if (actor.pose === 'wait') this.outside(actor, 'think', now, lag);
    }
  }
}
