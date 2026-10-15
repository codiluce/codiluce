// What an agent connected over MCP is doing right now, so the map shows an
// explanation on its way long before it is saved. `codiluce mcp` keeps one
// small JSON file per session in `<state>/explanations/activity/`: written when
// the client connects, on every prompt and tool call (before the tool runs),
// and when it publishes; removed when the session ends. `serve` reads the
// folder: a session whose process ended is left out, and work quiet for long
// (the agent stopped, or used the tools for something else) is no longer shown
// as working.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentActivity, AgentWork, SubjectKind } from './model.js';
import { EXPLANATIONS_DIRECTORY } from './store.js';

export const ACTIVITY_DIRECTORY = 'activity';
/** Tool calls kept per piece of work (the latest). */
const STEP_LIMIT = 12;
/** Work with no step for this long is no longer shown (writing a long answer can keep an agent quiet for minutes). */
export const WORK_TIMEOUT_MS = 5 * 60_000;
const SESSION = /^[a-z0-9-]{1,64}$/;

interface ActivityRecord extends Omit<AgentActivity, 'state'> { pid: number }
export interface WorkStart { title?: string; question?: string; subject?: { kind: SubjectKind; ref?: string } }

export function activityDirectory(stateDirectory: string): string { return path.join(stateDirectory, EXPLANATIONS_DIRECTORY, ACTIVITY_DIRECTORY); }

/** One MCP session's file. Writing never fails the protocol: activity is only shown, never needed. */
export class ActivityWriter {
  private readonly record: ActivityRecord;
  private readonly file: string;
  private written = false;
  constructor(private readonly stateDirectory: string, private readonly now: () => Date = () => new Date()) {
    const at = now().toISOString();
    this.record = { session: `${process.pid}-${randomBytes(3).toString('hex')}`, pid: process.pid, connectedAt: at, updatedAt: at };
    this.file = path.join(activityDirectory(stateDirectory), `${this.record.session}.json`);
  }
  get session(): string { return this.record.session; }

  /** The client said who it is: the map shows it connected (and sessions of ended processes are cleared). */
  connect(agent: string | undefined): void {
    if (agent) this.record.agent = agent;
    if (!this.written) pruneEnded(this.stateDirectory);
    this.write();
  }
  /** It was asked to explain something. An MCP prompt (`fresh`) starts new work; `start_explanation` names the work under way, whose steps so far stay. */
  begin(start: WorkStart, options: { fresh?: boolean } = {}): void {
    const at = this.now().toISOString();
    const current = options.fresh ? undefined : this.current();
    this.record.work = current ? { ...current, ...clean(start), updatedAt: at } : { startedAt: at, updatedAt: at, ...clean(start), steps: [], count: 0 };
    this.write();
  }
  /** A tool call, as one line (`flow POST /api/orders`). After publishing, or a long pause, it starts new work. */
  step(text: string): void {
    const at = this.now().toISOString();
    const work = this.current() ?? { startedAt: at, updatedAt: at, steps: [], count: 0 };
    work.steps = [...work.steps, { text: text.length > 160 ? `${text.slice(0, 159)}…` : text, at }].slice(-STEP_LIMIT);
    work.count++;
    work.updatedAt = at;
    this.record.work = work;
    this.write();
  }
  /** It saved an explanation: the work is done (the map opens what it saved). */
  published(explanation: { id: string; title: string }): void {
    this.record.published = { id: explanation.id, title: explanation.title, at: this.now().toISOString() };
    delete this.record.work;
    this.write();
  }
  /** The work under way, if any (what `publish_explanation` falls back on for the question and subject). */
  get work(): AgentWork | undefined { return this.current(); }
  close(): void { if (this.written) { try { rmSync(this.file, { force: true }); } catch { /* already gone */ } } }

  private current(): AgentWork | undefined {
    const work = this.record.work;
    return work && this.now().getTime() - Date.parse(work.updatedAt) < WORK_TIMEOUT_MS ? work : undefined;
  }
  private write(): void {
    // Only where Codiluce already keeps state: an agent in a repository that was never indexed leaves no folder behind.
    if (!existsSync(this.stateDirectory)) return;
    this.record.updatedAt = this.now().toISOString();
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomBytes(3).toString('hex')}.tmp`;
      writeFileSync(temporary, JSON.stringify(this.record));
      renameSync(temporary, this.file);
      this.written = true;
    } catch { /* the map just shows less */ }
  }
}

/** The sessions of running agents, newest first: what `GET /api/explanations/activity` returns. */
export function readActivity(stateDirectory: string, now = Date.now()): AgentActivity[] {
  const directory = activityDirectory(stateDirectory);
  const items: AgentActivity[] = [];
  for (const { record } of sessions(directory)) {
    if (!alive(record.pid)) continue;
    const { pid: _pid, work, ...rest } = record;
    const working = !!work && now - Date.parse(work.updatedAt) < WORK_TIMEOUT_MS;
    items.push({ ...rest, state: working ? 'working' : 'connected', ...(working ? { work } : {}) });
  }
  return items.sort((a, b) => (a.state === b.state ? (a.updatedAt < b.updatedAt ? 1 : -1) : a.state === 'working' ? -1 : 1));
}

function sessions(directory: string): { file: string; record: ActivityRecord }[] {
  let names: string[];
  try { names = readdirSync(directory).filter(name => name.endsWith('.json') && SESSION.test(name.slice(0, -5))); } catch { return []; }
  const found: { file: string; record: ActivityRecord }[] = [];
  for (const name of names) {
    const file = path.join(directory, name);
    try {
      const record = JSON.parse(readFileSync(file, 'utf8')) as ActivityRecord;
      if (record && typeof record === 'object' && typeof record.session === 'string' && typeof record.connectedAt === 'string') found.push({ file, record });
    } catch { /* being replaced, or not ours */ }
  }
  return found;
}
/** Files left by agents that were killed before they could remove theirs. */
function pruneEnded(stateDirectory: string): void {
  for (const { file, record } of sessions(activityDirectory(stateDirectory))) if (!alive(record.pid)) { try { rmSync(file, { force: true }); } catch { /* another session pruned it */ } }
}
function alive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (failure) { return (failure as NodeJS.ErrnoException).code === 'EPERM'; }
}
function clean(start: WorkStart): WorkStart {
  const text = (value: string | undefined, max: number) => value?.trim() ? value.trim().slice(0, max) : undefined;
  const title = text(start.title, 200), question = text(start.question, 2000);
  return { ...(title ? { title } : {}), ...(question ? { question } : {}), ...(start.subject ? { subject: start.subject } : {}) };
}
