// Explanations: text written by a language model (an agent through MCP, or the
// chat in the map) whose links name code. Pure types and helpers, shared with
// the browser.

/** What an explanation is about; it is shown where that thing is (the timeline, a flow, the inspector). */
export type SubjectKind = 'overview' | 'flow' | 'commit' | 'pr' | 'entity' | 'question';
export interface ExplanationSubject {
  kind: SubjectKind;
  /** flow: the entry point's entity ID; commit: the full SHA; pr: the number; entity: the entity ID. */
  target?: string;
  /** How it was named: a link (`flow:POST /x`, a path) or a title. */
  ref?: string;
  label?: string;
}
export interface ExplanationTurn {
  role: 'question' | 'answer';
  text: string;
  at: string;
  /** answer: the model that wrote it, what it cost, and the commit it was written against. */
  model?: string; cost?: number; commit?: string;
}
export interface ExplanationRecord {
  id: string; title: string; subject: ExplanationSubject;
  createdAt: string; updatedAt: string;
  /** The commit of the index the latest answer was written against, and whether the working tree had uncommitted changes. */
  commit?: string; dirty?: boolean;
  /** Who wrote it: an agent over MCP, the chat in the map, or a person. */
  source: 'agent' | 'chat' | 'manual';
  /** The agent's name, as its MCP client gave it (e.g. `claude-code`). */
  agent?: string;
  /** Model of the latest answer, and the total cost when known (US dollars). */
  model?: string; cost?: number;
  /** What each linked target was when the latest answer was written: href → fingerprint. Changed fingerprints make it stale. */
  pins: Record<string, string>;
  turns: ExplanationTurn[];
}

/** What a link points at, resolved against the live index. */
export interface ResolvedLink {
  href: string;
  kind: import('./links.js').LinkKind;
  /** ok: exists as when written; changed: exists, but its code changed since; missing: nothing indexed has this name. */
  status: 'ok' | 'changed' | 'missing' | 'external';
  /** The entity on the map (files, folders, symbols, entry points, tables). */
  id?: string;
  type?: string; name?: string; path?: string;
  /** Spatial ancestors on the map, outermost first (the areas to light around it). */
  ancestors?: string[];
  /** Lines to show in the code (a symbol's range, or the lines linked). */
  lines?: { start: number; end: number };
  /** Containers, flows and features: what lights when the link does (file and entry IDs, bounded). */
  members?: string[];
  /** Flows: how the flow is drawn (`lanes` for requests, commands and tasks; `steps` for pages). */
  detail?: 'lanes' | 'steps';
  /** Commits and PRs: the commit and its snapshot when indexed; features: the key. */
  sha?: string; snapshot?: string; feature?: string;
  label?: string;
  reason?: string;
}
export interface Staleness {
  /** Linked targets whose code changed since the latest answer, and those that no longer exist. */
  changed: number; missing: number; linked: number;
  /** Commits on the current branch since the commit it was written against (when Git can tell). */
  commitsSince?: number;
  /** The live index is of another commit than the one it was written against. */
  moved: boolean;
}
export interface ExplanationSummary {
  id: string; title: string; subject: ExplanationSubject;
  createdAt: string; updatedAt: string; commit?: string;
  source: ExplanationRecord['source']; agent?: string; model?: string; cost?: number;
  turns: number; links: number;
  /** First words of the latest answer. */
  excerpt: string;
  stale: Staleness;
}
export interface ExplanationDetail extends ExplanationRecord {
  links: ResolvedLink[];
  stale: Staleness;
  /** What lights on the map while it is open: entity IDs, and per area how many of them it holds. */
  footprint: { ids: string[]; areas: Record<string, number> };
  /** The file holding it, relative to the state directory. */
  file: string;
}
export interface ExplanationList {
  items: ExplanationSummary[];
  /** Highest modification time of the folder, for cheap polling. */
  version: string;
}
/** How to reach explanations: whether writing is allowed, which models answer, how to connect an agent. */
export interface ExplanationsSetup {
  readOnly: boolean;
  root?: string;
  /** Command that adds Codiluce to Claude Code (other agents take the same command and arguments). */
  mcp: { command: string; args: string[]; claude: string; codex: string };
  models: ChatModelInfo[];
  /** Where to put keys when none is set. */
  keyFiles: string[];
  maxCost: number;
}
export interface ChatModelInfo { id: string; label: string; provider: 'anthropic' | 'openai'; available: boolean; default?: boolean; note?: string }
/** An agent connected over MCP (one per agent process), as `serve` reports it: what it is explaining while it works, before anything is saved. */
export interface AgentActivity {
  session: string;
  /** The MCP client's name (e.g. `claude-code`). */
  agent?: string;
  /** working: it took a step recently and has not published since; connected: idle. */
  state: 'connected' | 'working';
  connectedAt: string; updatedAt: string;
  /** What it is doing since it last published: what it was asked (a prompt or `start_explanation`) and the tool calls so far. */
  work?: AgentWork;
  /** The explanation it saved last. */
  published?: { id: string; title: string; at: string };
}
export interface AgentWork {
  startedAt: string; updatedAt: string;
  title?: string; question?: string;
  subject?: { kind: SubjectKind; ref?: string };
  /** The latest tool calls, oldest first (`flow POST /api/orders`), and how many there were in all. */
  steps: { text: string; at: string }[];
  count: number;
}
export interface AgentActivityList { items: AgentActivity[] }
/** How a client names itself, as a person reads it. */
export function agentLabel(name: string | undefined): string {
  if (!name) return 'Your agent';
  const known: Record<string, string> = { 'claude-code': 'Claude Code', claude: 'Claude', 'claude-ai': 'Claude', codex: 'Codex', 'codex-mcp-client': 'Codex', cursor: 'Cursor', 'cursor-vscode': 'Cursor', windsurf: 'Windsurf', zed: 'Zed', 'gemini-cli-mcp-client': 'Gemini CLI', vscode: 'VS Code', 'visual-studio-code': 'VS Code' };
  return known[name.toLowerCase()] ?? name;
}

/** One step of an answer being written, streamed to the browser as a line of JSON. */
export type AskEvent =
  | { type: 'start'; id: string; model: string }
  | { type: 'tool'; name: string; detail: string }
  | { type: 'text'; delta: string }
  | { type: 'retry'; reason: string }
  | { type: 'done'; explanation: ExplanationDetail }
  | { type: 'error'; message: string };

/** Lowercase words joined by dashes, for IDs. */
export function slug(text: string, max = 48): string {
  const words = text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return words.slice(0, max).replace(/-+$/, '') || 'explanation';
}
export const EXPLANATION_ID = /^[a-z0-9][a-z0-9-]{0,95}$/;
/** The latest answer of an explanation (what the reader opens on). */
export function latestAnswer(record: Pick<ExplanationRecord, 'turns'>): ExplanationTurn | undefined {
  for (let index = record.turns.length - 1; index >= 0; index--) if (record.turns[index]!.role === 'answer') return record.turns[index];
  return undefined;
}
export function excerptOf(markdown: string, max = 160): string {
  const text = markdown.replace(/^\s*#{1,6}\s+.*(?:\n|$)/, '').replace(/```[\s\S]*?```/g, ' ').replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[#>*_`|-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : text;
}
