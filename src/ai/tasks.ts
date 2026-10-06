// What the models are asked, and with what. Every request is built from the
// index only (symbols, effects, relationships, flows, coverage, history) plus
// a bounded excerpt of a file's own source; answers are JSON validated by a
// strict schema and keyed back to what they describe. Tasks run in order,
// later ones reading earlier answers:
//
//   files (low) → folders (low) → domains (high) → overview (high)
//   flows (low) · commits (low) → chapters (high)
//
// A `content_key` digests each item's request text, so only new or changed
// items are sent again.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { CODE_LANGUAGES } from '../core/languages.js';
import type { ProjectionService } from '../projection/service.js';
import type { CoverageResult, FlowSummary, TimelineEntry } from '../projection/dto.js';
import type { GraphStore } from '../storage/sqlite.js';
import type { AnnotationStore } from './store.js';
import { STE_RULES } from './ste.js';

export type TaskName = 'files' | 'folders' | 'flows' | 'commits' | 'domains' | 'overview' | 'chapters';
export const TASK_ORDER: TaskName[] = ['files', 'flows', 'commits', 'folders', 'domains', 'overview', 'chapters'];
export const ROLES = ['page', 'layout', 'component', 'hook', 'state', 'api-client', 'route-file', 'controller', 'request-validation', 'middleware', 'service', 'model', 'job', 'command', 'scheduler', 'migration', 'seeder', 'test', 'types', 'config', 'utility', 'style', 'script', 'other'] as const;
export const ACTORS = ['visitor', 'user', 'admin', 'scheduler', 'developer', 'external-system', 'system'] as const;
export const INTENTS = ['feature', 'fix', 'refactor', 'style', 'content', 'data', 'test', 'docs', 'build', 'chore'] as const;

/** One thing to describe: its key in the annotation store, and its part of a request. */
export interface TaskItem { target: string; text: string; contentKey: string; label: string; meta?: Record<string, unknown> }
export interface TaskRequest { items: TaskItem[]; instructions: string; input: string; schema: Record<string, unknown>; schemaName: string; maxOutputTokens: number }
/** What a task stores per item, and the prose to score against ASD-STE100. */
export interface Parsed { target: string; value: Record<string, unknown>; prose: string[] }
export interface TaskSpec {
  name: TaskName; tier: 'high' | 'low'; kind: string; promptVersion: string;
  /** Items per request; 0: all items in one request. */
  batch: number;
  /** Expected output tokens per item (before the pilot measures it). */
  outputPerItem: number;
  collect(input: AnnotationInput): Promise<TaskItem[]>;
  request(items: TaskItem[], input: AnnotationInput): TaskRequest;
  parse(value: unknown, items: TaskItem[]): Parsed[];
}
export interface EntityRecord { id: string; type: string; name: string; path?: string; language?: string; parentId?: string; metadata: Record<string, unknown>; loc?: number }
/** The index, loaded once for every task. */
export interface AnnotationInput {
  root: string; repository: EntityRecord;
  entities: Map<string, EntityRecord>;
  children: Map<string, string[]>;
  outgoing: Map<string, { to: string; type: string }[]>; incoming: Map<string, { from: string; type: string }[]>;
  projection: ProjectionService; annotations: AnnotationStore;
  catalog: FlowSummary[]; coverage: CoverageResult;
  /** First-parent commits with snapshots, oldest first (when history is indexed). */
  history?: { entries: TimelineEntry[]; message(sha: string): Promise<string | undefined> };
  /** Estimates: earlier answers stand in at this length when they do not exist yet. */
  placeholder?: boolean;
}
const EXCERPT_CHARS = 3200;
const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 32);
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
const list = (items: string[], max: number) => items.length > max ? `${items.slice(0, max).join(', ')} and ${items.length - max} more` : items.join(', ');

export async function loadAnnotationInput(store: GraphStore, projection: ProjectionService, annotations: AnnotationStore, root: string, history?: AnnotationInput['history']): Promise<AnnotationInput> {
  const entities = new Map<string, EntityRecord>();
  const children = new Map<string, string[]>();
  for (const row of store.db.prepare('SELECT e.id, e.type, e.name, e.path, e.language, e.parent_id, e.metadata, m.data AS metrics FROM entities e LEFT JOIN metrics m ON m.entity_id = e.id ORDER BY e.id').all()) {
    const loc = row.metrics ? (JSON.parse(String(row.metrics)) as { loc?: number }).loc : undefined;
    const entity: EntityRecord = { id: String(row.id), type: String(row.type), name: String(row.name), ...(row.path ? { path: String(row.path) } : {}), ...(row.language ? { language: String(row.language) } : {}), ...(row.parent_id ? { parentId: String(row.parent_id) } : {}), metadata: JSON.parse(String(row.metadata)) as Record<string, unknown>, ...(typeof loc === 'number' ? { loc } : {}) };
    entities.set(entity.id, entity);
    if (entity.parentId) children.set(entity.parentId, [...children.get(entity.parentId) ?? [], entity.id]);
  }
  const outgoing = new Map<string, { to: string; type: string }[]>(), incoming = new Map<string, { from: string; type: string }[]>();
  for (const row of store.db.prepare("SELECT from_id, to_id, type FROM relations WHERE type != 'contains'").all()) {
    const from = String(row.from_id), to = String(row.to_id), type = String(row.type);
    outgoing.set(from, [...outgoing.get(from) ?? [], { to, type }]);
    incoming.set(to, [...incoming.get(to) ?? [], { from, type }]);
  }
  const repository = [...entities.values()].find(entity => entity.type === 'repository')!;
  return { root, repository, entities, children, outgoing, incoming, projection, annotations, catalog: projection.flows().items, coverage: projection.coverage(), ...(history ? { history } : {}) };
}

function fileOf(input: AnnotationInput, id: string): EntityRecord | undefined {
  for (let entity = input.entities.get(id); entity; entity = entity.parentId ? input.entities.get(entity.parentId) : undefined) if (entity.type === 'file') return entity;
  const entity = input.entities.get(id);
  return entity?.path ? [...input.entities.values()].find(item => item.type === 'file' && item.path === entity.path) : undefined;
}
function descendants(input: AnnotationInput, id: string): EntityRecord[] {
  const result: EntityRecord[] = [];
  const visit = (current: string) => { for (const child of input.children.get(current) ?? []) { const entity = input.entities.get(child); if (entity) { result.push(entity); visit(child); } } };
  visit(id);
  return result;
}
function appOf(input: AnnotationInput, id: string): string | undefined {
  for (let entity = input.entities.get(id); entity; entity = entity.parentId ? input.entities.get(entity.parentId) : undefined) if (entity.type === 'application') return entity.name;
  return undefined;
}
/** Short display of an entity in a request: `Class::method` or `name (path)`. */
function display(input: AnnotationInput, id: string): string {
  const entity = input.entities.get(id);
  if (!entity) return id;
  if (entity.type === 'method' && typeof entity.metadata.qualifiedName === 'string') return entity.metadata.qualifiedName.split('\\').at(-1)!;
  if (['api_endpoint', 'route', 'command', 'database_table', 'scheduled_task'].includes(entity.type)) return `${entity.type === 'database_table' ? 'table ' : entity.type === 'command' ? 'command ' : ''}${entity.name}`;
  return entity.name;
}
function summaryOf(input: AnnotationInput, kind: string, target: string, fallback = ''): string {
  if (input.placeholder) return 'A short description of what this code does, with about twenty words, as the earlier task writes it.';
  const value = input.annotations.get<{ summary?: string }>(kind, target)?.value;
  return value?.summary ?? fallback;
}

// Files ---------------------------------------------------------------------------------
const FILE_INSTRUCTIONS = `You describe source files of a software repository for engineers who are new to it.
For each file, write "summary": one or two sentences (at most 40 words in total) that say what the file does and why it exists in the application. Name the main things it does, with the names from the code. Do not list every function. Do not repeat the file name at the start.
Choose "role" from the list in the schema. Use "other" only when no role fits.
Each file starts with a key in square brackets. Return one entry for each key, with the same key.

${STE_RULES}`;
function fileBlock(input: AnnotationInput, file: EntityRecord, excerpt: string): string {
  const symbols = descendants(input, file.id).filter(item => ['class', 'controller', 'model', 'component', 'function', 'method'].includes(item.type));
  const facts: string[] = [];
  const own = [file, ...symbols];
  const effects = own.flatMap(item => Array.isArray(item.metadata.effects) ? item.metadata.effects as { category: string; operation: string; tableName?: string; status?: number; page?: string; targetName?: string }[] : []);
  const reads = new Set<string>(), writes = new Set<string>(), other = new Set<string>();
  for (const effect of effects) {
    if (effect.category === 'database' && effect.tableName) (effect.operation === 'write' ? writes : reads).add(effect.tableName);
    else if (effect.category === 'response') other.add(effect.page ? `renders Inertia page ${effect.page}` : `responds ${effect.status ?? ''} ${effect.operation}`.trim());
    else if (effect.category !== 'database' && effect.category !== 'network') other.add(`${effect.category} ${effect.operation}`);
  }
  if (reads.size) facts.push(`reads tables ${list([...reads], 6)}`);
  if (writes.size) facts.push(`writes tables ${list([...writes], 6)}`);
  const ownIds = new Set(own.map(item => item.id));
  const out = own.flatMap(item => input.outgoing.get(item.id) ?? []).filter(edge => !ownIds.has(edge.to));
  const named = (types: string[], max: number) => [...new Set(out.filter(edge => types.includes(edge.type)).map(edge => display(input, edge.to)))].slice(0, max);
  const requests = named(['requests'], 6), calls = named(['calls'], 8), renders = named(['renders'], 8), runs = named(['invokes'], 4);
  if (requests.length) facts.push(`sends requests ${requests.join(', ')}`);
  if (runs.length) facts.push(`runs ${runs.join(', ')}`);
  if (renders.length) facts.push(`renders ${renders.join(', ')}`);
  if (calls.length) facts.push(`calls ${calls.join(', ')}`);
  if (other.size) facts.push(list([...other], 5));
  const users = [...new Set(own.flatMap(item => input.incoming.get(item.id) ?? []).filter(edge => !ownIds.has(edge.from) && edge.type !== 'exports').map(edge => fileOf(input, edge.from)?.name).filter((name): name is string => !!name && name !== file.name))];
  const entries = [...input.entities.values()].filter(item => ['route', 'command', 'scheduled_task'].includes(item.type) && item.path === file.path).map(item => `${item.type === 'route' ? 'page' : item.type === 'scheduled_task' ? 'scheduled task' : 'Artisan command'} ${item.name}`);
  const coverage = input.coverage.files[file.id];
  const lines = [
    `${file.path} (${file.language ?? 'unknown'}${file.loc ? `, ${file.loc} lines` : ''}; app ${appOf(input, file.id) ?? 'none'}${coverage ? `; ${coverage.flows} flows touch it` : ''})`,
    ...(entries.length ? [`entry points: ${list(entries, 4)}`] : []),
    ...(symbols.length ? [`symbols: ${list(symbols.map(item => `${item.type === 'method' || item.type === 'function' ? '' : `${item.type} `}${item.name}${item.type === 'method' || item.type === 'function' ? '()' : ''}`), 14)}`] : []),
    ...(facts.length ? [`does: ${facts.join('; ')}`] : []),
    ...(users.length ? [`used by: ${list(users, 5)}`] : []),
    'source excerpt:', excerpt,
  ];
  return lines.join('\n');
}
async function excerptOf(root: string, relative: string): Promise<string> {
  try {
    const text = (await readFile(path.join(root, relative))).toString('utf8');
    // Drop license headers and blank runs; keep the start of the file, where its imports and declarations are.
    return clip(text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').replace(/^\/\*[\s\S]*?\*\/\s*/, ''), EXCERPT_CHARS);
  } catch { return '(source not readable)'; }
}
const filesTask: TaskSpec = {
  name: 'files', tier: 'low', kind: 'file', promptVersion: 'files-1', batch: 6, outputPerItem: 75,
  async collect(input) {
    const files = [...input.entities.values()].filter(entity => entity.type === 'file' && CODE_LANGUAGES.has(entity.language ?? '') && !entity.metadata.analysisSkipped).sort((a, b) => (a.path ?? '') < (b.path ?? '') ? -1 : 1);
    const items: TaskItem[] = [];
    for (const file of files) {
      const text = fileBlock(input, file, await excerptOf(input.root, file.path!));
      items.push({ target: file.id, text, contentKey: digest(text), label: file.path!, ...(typeof file.metadata.contentHash === 'string' ? { meta: { hash: file.metadata.contentHash } } : {}) });
    }
    return items;
  },
  request(items) {
    return {
      items, instructions: FILE_INSTRUCTIONS, schemaName: 'file_summaries',
      input: items.map((item, index) => `[f${index + 1}] ${item.text}`).join('\n\n---\n\n'),
      schema: object({ files: array(object({ key: string(), summary: string(), role: { type: 'string', enum: [...ROLES] } })) }),
      maxOutputTokens: 900 + items.length * 260,
    };
  },
  parse(value, items) {
    return keyed(value, 'files', 'f', items).map(({ item, entry }) => ({ target: item.target, value: { summary: String(entry.summary ?? ''), role: String(entry.role ?? 'other'), ...(item.meta?.hash ? { hash: item.meta.hash } : {}) }, prose: [String(entry.summary ?? '')] }));
  },
};

// Folders ------------------------------------------------------------------------------
const FOLDER_INSTRUCTIONS = `You describe folders of a software repository for engineers who are new to it.
Each folder lists its code files with a short description of each file (written earlier).
For each folder, write "summary": one or two sentences (at most 40 words) that say what the folder holds and what part of the application it serves. Describe the folder as a whole; do not list its files.
Each folder starts with a key in square brackets. Return one entry for each key, with the same key.

${STE_RULES}`;
const foldersTask: TaskSpec = {
  name: 'folders', tier: 'low', kind: 'folder', promptVersion: 'folders-1', batch: 10, outputPerItem: 70,
  async collect(input) {
    const items: TaskItem[] = [];
    const folders = [...input.entities.values()].filter(entity => entity.type === 'directory' || entity.type === 'application').sort((a, b) => (a.path ?? a.name) < (b.path ?? b.name) ? -1 : 1);
    for (const folder of folders) {
      const files = descendants(input, folder.id).filter(entity => entity.type === 'file' && CODE_LANGUAGES.has(entity.language ?? ''));
      if (!files.length) continue;
      // Direct files first, then the most connected files deeper inside.
      const direct = files.filter(file => file.parentId === folder.id);
      const deeper = files.filter(file => file.parentId !== folder.id).sort((a, b) => (input.coverage.files[b.id]?.flows ?? 0) - (input.coverage.files[a.id]?.flows ?? 0));
      const shown = [...direct, ...deeper].slice(0, 28);
      const subfolders = (input.children.get(folder.id) ?? []).map(id => input.entities.get(id)).filter((entity): entity is EntityRecord => entity?.type === 'directory');
      const text = [
        `${folder.path ?? folder.name} (${folder.type === 'application' ? `application, ${String(folder.metadata.framework ?? '')}` : `app ${appOf(input, folder.id) ?? 'none'}`}; ${files.length} code files${subfolders.length ? `; folders ${list(subfolders.map(item => item.name), 12)}` : ''})`,
        ...shown.map(file => `- ${path.posix.relative(folder.path ?? '', file.path ?? '') || file.name}: ${clip(summaryOf(input, 'file', file.id, '(no description)'), 220)}`),
      ].join('\n');
      items.push({ target: folder.id, text, contentKey: digest(text), label: folder.path ?? folder.name });
    }
    return items;
  },
  request(items) {
    return {
      items, instructions: FOLDER_INSTRUCTIONS, schemaName: 'folder_summaries',
      input: items.map((item, index) => `[d${index + 1}] ${item.text}`).join('\n\n---\n\n'),
      schema: object({ folders: array(object({ key: string(), summary: string() })) }),
      maxOutputTokens: 900 + items.length * 220,
    };
  },
  parse(value, items) { return keyed(value, 'folders', 'd', items).map(({ item, entry }) => ({ target: item.target, value: { summary: String(entry.summary ?? '') }, prose: [String(entry.summary ?? '')] })); },
};

// Flows ----------------------------------------------------------------------------------
const FLOW_INSTRUCTIONS = `You name the flows of a software application for engineers and product people.
A flow starts at an entry point (a page, an HTTP request, an Artisan command or a scheduled task) and lists what it reaches, from the index of the code.
For each flow, write:
- "title": what the flow lets someone do or what it does, as a short verb phrase of 2 to 7 words, for example "Save a word to favorites" or "Import news from Berria". Do not use the HTTP method or the path in the title.
- "goal": one sentence (at most 25 words) that says what happens, from the start to the data.
- "actor": who or what starts it, from the list in the schema ("visitor" for pages without login, "user" for a signed-in person, "admin" for back-office pages and their requests).
Each flow starts with a key in square brackets. Return one entry for each key, with the same key.

${STE_RULES}`;
async function flowBlock(input: AnnotationInput, flow: FlowSummary): Promise<string> {
  const head = `${flow.kind} ${flow.kind === 'request' || flow.kind === 'unmatched' ? `${flow.method ?? ''} ${flow.path ?? ''}` : flow.name}${flow.app ? ` (app ${flow.app})` : ''}${flow.cadence ? ` · runs ${flow.cadence}` : ''}${flow.handler ? ` · handler ${flow.handler}` : ''}`;
  const parts: string[] = [];
  try {
    if (flow.detail === 'lanes') {
      const detail = await input.projection.requestFlow(flow.id, { maxFileBytes: 1 << 20 });
      const labels = (...kinds: string[]) => [...new Set(detail.nodes.filter(node => kinds.includes(node.kind)).map(node => node.label))];
      const entries = labels('page', 'entry', 'schedule'), triggers = labels('trigger'), callers = labels('caller'), services = labels('method'), tables = labels('table'), responses = labels('response'), returns = labels('page').filter(label => detail.nodes.some(node => node.kind === 'page' && node.lane === 'return' && node.label === label));
      if (entries.length) parts.push(`starts at ${list(entries, 4)}`);
      if (triggers.length) parts.push(`triggers ${list(triggers, 4)}`);
      if (callers.length) parts.push(`called by ${list(callers, 4)}`);
      if (services.length) parts.push(`then ${list(services, 6)}`);
      if (tables.length) parts.push(`tables ${list(tables, 6)}`);
      if (responses.length) parts.push(`responses ${list(responses, 5)}`);
      if (returns.length) parts.push(`shows page ${list(returns, 2)}`);
    } else {
      const steps = await input.projection.steps(flow.id, { maxFileBytes: 1 << 20 });
      const nodes = steps.steps.filter(step => step.node).map(step => step.node!);
      const named = (types: string[], max: number) => list([...new Set(nodes.filter(node => types.includes(node.type)).map(node => node.name))], max);
      parts.push(`page component ${named(['component'], 6) || 'unknown'}`);
      const endpoints = named(['api_endpoint'], 8);
      if (endpoints) parts.push(`requests ${endpoints}`);
      const effects = [...new Set(steps.steps.flatMap(step => step.effect ? [`${step.effect.category} ${step.effect.operation}`] : []))];
      if (effects.length) parts.push(`effects ${list(effects, 6)}`);
    }
  } catch { /* the summary line alone */ }
  return `${head}\n${parts.join('; ')}`;
}
const flowsTask: TaskSpec = {
  name: 'flows', tier: 'low', kind: 'flow', promptVersion: 'flows-1', batch: 15, outputPerItem: 70,
  async collect(input) {
    const items: TaskItem[] = [];
    for (const flow of input.catalog) {
      if (flow.kind === 'unmatched') continue;
      const text = await flowBlock(input, flow);
      items.push({ target: flow.id, text, contentKey: digest(text), label: flow.name });
    }
    return items;
  },
  request(items) {
    return {
      items, instructions: FLOW_INSTRUCTIONS, schemaName: 'flow_titles',
      input: items.map((item, index) => `[w${index + 1}] ${item.text}`).join('\n\n'),
      schema: object({ flows: array(object({ key: string(), title: string(), goal: string(), actor: { type: 'string', enum: [...ACTORS] } })) }),
      maxOutputTokens: 900 + items.length * 200,
    };
  },
  parse(value, items) { return keyed(value, 'flows', 'w', items).map(({ item, entry }) => ({ target: item.target, value: { title: String(entry.title ?? ''), goal: String(entry.goal ?? ''), actor: String(entry.actor ?? 'system') }, prose: [String(entry.goal ?? '')] })); },
};

// Commits --------------------------------------------------------------------------------
const COMMIT_INSTRUCTIONS = `You explain commits of a software repository for engineers who were not there.
Each commit gives its message and what changed in the code index: files, symbols, routes and endpoints, tables, and relationships, compared with the commit before it.
For each commit, write:
- "intent": the kind of change, from the list in the schema.
- "title": what the commit does, as a short phrase of 3 to 10 words.
- "summary": one to three sentences (at most 60 words) that say what changed and where. Use the changes in the index, not only the message.
- "areas": the 1 to 4 main parts of the code that changed (folder paths or feature names from the input).
Each commit starts with a key in square brackets. Return one entry for each key, with the same key.

${STE_RULES}`;
async function commitBlock(input: AnnotationInput, entry: TimelineEntry, previous: TimelineEntry | undefined): Promise<string> {
  const message = (await input.history!.message(entry.sha)) ?? entry.subject;
  const head = `${entry.sha.slice(0, 10)} · ${entry.authoredAt.slice(0, 10)} · ${entry.authorName}${entry.merge ? ' · merge' : ''}\nmessage: ${clip(message.trim().replace(/\n{2,}/g, '\n'), 600)}`;
  if (!previous?.snapshot || !entry.snapshot) return `${head}\nchanges: the first indexed commit (${entry.snapshot?.stats.entities ?? '?'} entities)`;
  const view = { snapshot: entry.snapshot.id, compareTo: previous.snapshot.id };
  try {
    await input.projection.prepare(view);
    const summary = input.projection.meta(view).comparison?.summary;
    if (!summary) return head;
    const counts = (type: string) => summary.byType.find(item => item.type === type);
    // Per status, symbols and interfaces first (what changed inside), then files.
    const describe = (status: string) => {
      const items = input.projection.changes(view, { status, limit: 60 }).items.filter(item => item.type !== 'directory');
      const ordered = [...items.filter(item => item.type !== 'file'), ...items.filter(item => item.type === 'file')];
      return list(ordered.map(item => `${item.type === 'file' ? 'file' : item.type.replace('_', ' ')} ${item.type === 'file' ? item.path : item.qualifiedName?.split('\\').at(-1) ?? item.name}`), 14);
    };
    const lines = [
      head,
      `files: +${summary.files.added} −${summary.files.removed} ~${summary.files.modified} →${summary.files.moved}; lines ${summary.files.locBefore} → ${summary.files.locAfter}`,
      `entities: ${['added', 'removed', 'modified', 'moved'].map(status => `${status} ${summary.entities[status as keyof typeof summary.entities]}`).join(', ')}${['api_endpoint', 'route', 'database_table', 'command'].map(type => counts(type)).filter(Boolean).map(item => `; ${item!.type}: +${item!.added} −${item!.removed} ~${item!.modified}`).join('')}`,
      ...(describe('added') ? [`added: ${describe('added')}`] : []),
      ...(describe('modified') ? [`modified: ${describe('modified')}`] : []),
      ...(describe('removed') ? [`removed: ${describe('removed')}`] : []),
      ...(describe('moved') ? [`moved: ${describe('moved')}`] : []),
      ...(summary.relations.byType.length ? [`relationships: ${summary.relations.byType.slice(0, 8).map(item => `${item.type} +${item.added}/−${item.removed}`).join(', ')}`] : []),
      ...(summary.interfaces.length ? [`routes and endpoints: ${list(summary.interfaces.map(item => `${item.status} ${item.name}`), 10)}`] : []),
    ];
    return lines.join('\n');
  } catch (error) { return `${head}\nchanges: not available (${error instanceof Error ? error.message : String(error)})`; }
}
const commitsTask: TaskSpec = {
  name: 'commits', tier: 'low', kind: 'commit', promptVersion: 'commits-1', batch: 6, outputPerItem: 120,
  async collect(input) {
    if (!input.history) return [];
    const items: TaskItem[] = [];
    let previous: TimelineEntry | undefined;
    for (const entry of input.history.entries) {
      if (!entry.snapshot) continue;
      const text = await commitBlock(input, entry, previous);
      items.push({ target: entry.sha, text, contentKey: digest(text), label: `${entry.sha.slice(0, 8)} ${entry.subject}` });
      previous = entry;
    }
    return items;
  },
  request(items) {
    return {
      items, instructions: COMMIT_INSTRUCTIONS, schemaName: 'commit_explanations',
      input: items.map((item, index) => `[c${index + 1}] ${item.text}`).join('\n\n---\n\n'),
      schema: object({ commits: array(object({ key: string(), intent: { type: 'string', enum: [...INTENTS] }, title: string(), summary: string(), areas: array(string()) })) }),
      maxOutputTokens: 1000 + items.length * 320,
    };
  },
  parse(value, items) { return keyed(value, 'commits', 'c', items).map(({ item, entry }) => ({ target: item.target, value: { intent: String(entry.intent ?? 'chore'), title: String(entry.title ?? ''), summary: String(entry.summary ?? ''), areas: Array.isArray(entry.areas) ? (entry.areas as unknown[]).map(String).slice(0, 4) : [] }, prose: [String(entry.summary ?? '')] })); },
};

// Domains (high) --------------------------------------------------------------------------
const DOMAIN_INSTRUCTIONS = `You find the domains of a software repository: the features or areas of the product that its code serves, across the frontend and the backend.
The input lists the folders that hold code, each with a description, and the pages, requests and commands of the product.
Return 6 to 16 "domains". For each domain:
- "key": a short identifier in lowercase letters and hyphens.
- "name": a name of 1 to 3 words that a product person understands (for example "Vocabulary", "News reading", "Admin back office").
- "summary": two or three sentences (at most 50 words) that say what the domain does for its users and which parts of the code serve it.
- "include": the folder or file paths that belong to the domain, from the input. A path includes everything below it. When a folder holds code of several domains, give its subfolders or files instead. The longest matching path wins.
Put code that serves every domain (shared UI parts, the framework setup, configuration, utilities) in one domain with the key "platform". Give "platform" only the folders that every domain uses, never a whole application folder such as "backend/app" or "frontend/src".
You do not have to cover every folder: a file that no path covers goes to the domain of the code it is connected to (its imports, calls, requests and tables).

${STE_RULES}`;
const domainsTask: TaskSpec = {
  name: 'domains', tier: 'high', kind: 'domains', promptVersion: 'domains-2', batch: 0, outputPerItem: 2600,
  async collect(input) {
    const folders = [...input.entities.values()].filter(entity => entity.type === 'directory').map(entity => ({ entity, files: descendants(input, entity.id).filter(item => item.type === 'file' && CODE_LANGUAGES.has(item.language ?? '')) })).filter(item => item.files.length);
    folders.sort((a, b) => (a.entity.path ?? '') < (b.entity.path ?? '') ? -1 : 1);
    const lines = [
      `Repository ${input.repository.name}. Applications: ${[...input.entities.values()].filter(entity => entity.type === 'application').map(app => `${app.name} (${String(app.metadata.framework ?? '')}, ${app.path ?? ''})`).join(', ')}.`,
      'Folders (code files, description):',
      ...folders.map(item => `- ${item.entity.path} (${item.files.length}): ${clip(summaryOf(input, 'folder', item.entity.id, ''), 260)}`),
      'Pages:', list(input.catalog.filter(flow => flow.kind === 'page').map(flow => flow.name), 120),
      'Requests (first path segments):', list([...new Set(input.catalog.filter(flow => flow.kind === 'request').map(flow => flow.group))], 80),
      'Commands:', list(input.catalog.filter(flow => flow.kind === 'command').map(flow => flow.name), 80),
    ];
    const text = lines.join('\n');
    return [{ target: 'repository', text, contentKey: digest(text), label: 'domains' }];
  },
  request(items) {
    return {
      items, instructions: DOMAIN_INSTRUCTIONS, schemaName: 'domains', input: items[0]!.text,
      schema: object({ domains: array(object({ key: string(), name: string(), summary: string(), include: array(string()) })) }),
      maxOutputTokens: 60_000,
    };
  },
  parse(value, items) {
    const domains = (value as { domains?: { key?: string; name?: string; summary?: string; include?: string[] }[] }).domains ?? [];
    const clean = domains.filter(item => item.key && item.name).map(item => ({ key: String(item.key).toLowerCase().replace(/[^a-z0-9-]+/g, '-'), name: String(item.name), summary: String(item.summary ?? ''), include: (item.include ?? []).map(String).map(entry => entry.replace(/\/+$/, '')).filter(Boolean) }));
    return [{ target: items[0]!.target, value: { domains: clean }, prose: clean.map(item => item.summary) }];
  },
};

// Overview (high) -----------------------------------------------------------------------
const OVERVIEW_INSTRUCTIONS = `You write the overview of a software repository for an engineer on the first day.
Write "summary": one paragraph of four to six sentences that says what the product does, for whom, and how the code is organized.
Write "applications": for each application of the input, one or two sentences about what it does and how it connects to the others.
Write "start": three to five short tips about where to start reading the code (each one sentence, with names from the input).

${STE_RULES}`;
const overviewTask: TaskSpec = {
  name: 'overview', tier: 'high', kind: 'overview', promptVersion: 'overview-1', batch: 0, outputPerItem: 900,
  async collect(input) {
    const domains = input.placeholder ? [] : input.annotations.get<{ domains: { name: string; summary: string; include: string[] }[] }>('domains', 'repository')?.value.domains ?? [];
    const apps = [...input.entities.values()].filter(entity => entity.type === 'application');
    const counts = (kind: string) => input.catalog.filter(flow => flow.kind === kind).length;
    const lines = [
      `Repository ${input.repository.name}.`,
      'Applications:', ...apps.map(app => `- ${app.name} (${String(app.metadata.framework ?? '')}, path ${app.path ?? ''}): ${clip(summaryOf(input, 'folder', app.id, ''), 300)}`),
      `Flows: ${counts('page')} pages, ${counts('request')} requests, ${counts('command')} commands, ${counts('schedule')} scheduled tasks.`,
      `Coverage: ${input.coverage.totals.entry + input.coverage.totals.flow} of ${input.coverage.codeFiles} code files are entry points or in flows; ${input.coverage.totals.unreached} are not reached.`,
      'Domains:', ...(domains.length ? domains.map(domain => `- ${domain.name}: ${clip(domain.summary, 260)} (${list(domain.include, 6)})`) : ['(not described yet)']),
      'Main folders:', ...[...input.entities.values()].filter(entity => entity.type === 'directory' && (entity.path ?? '').split('/').length <= 3).slice(0, 60).map(entity => `- ${entity.path}: ${clip(summaryOf(input, 'folder', entity.id, ''), 160)}`),
    ];
    const text = lines.join('\n');
    return [{ target: 'repository', text, contentKey: digest(text), label: 'overview' }];
  },
  request(items, input) {
    const apps = [...input.entities.values()].filter(entity => entity.type === 'application');
    return {
      items, instructions: OVERVIEW_INSTRUCTIONS, schemaName: 'overview', input: items[0]!.text,
      schema: object({ summary: string(), applications: array(object({ name: { type: 'string', enum: apps.length ? apps.map(app => app.name) : ['none'] }, summary: string() })), start: array(string()) }),
      maxOutputTokens: 30_000,
    };
  },
  parse(value, items) {
    const answer = value as { summary?: string; applications?: { name: string; summary: string }[]; start?: string[] };
    return [{ target: items[0]!.target, value: { summary: String(answer.summary ?? ''), applications: answer.applications ?? [], start: (answer.start ?? []).map(String) }, prose: [String(answer.summary ?? ''), ...(answer.applications ?? []).map(item => item.summary), ...(answer.start ?? [])] }];
  },
};

// Chapters (high) -----------------------------------------------------------------------
const CHAPTER_INSTRUCTIONS = `You divide the history of a software repository into chapters, for engineers who want to know how the code got to where it is.
The input lists the commits, oldest first, each with its date, author, kind of change and a short explanation.
Return 4 to 20 "chapters" in time order. A chapter is a run of consecutive commits with one main theme (a feature, a migration, a redesign, a cleanup).
For each chapter, write:
- "title": the theme, in 2 to 7 words.
- "summary": two or three sentences (at most 60 words) about what the chapter added or changed and why it matters.
- "from" and "to": the short SHA of its first and last commit, exactly as in the input.
- "areas": 1 to 4 main parts of the code that the chapter changed.
Every commit must be in exactly one chapter.

${STE_RULES}`;
const chaptersTask: TaskSpec = {
  name: 'chapters', tier: 'high', kind: 'chapters', promptVersion: 'chapters-1', batch: 0, outputPerItem: 3000,
  async collect(input) {
    if (!input.history) return [];
    const commits = input.placeholder ? new Map() : input.annotations.map<{ intent: string; title: string; summary: string }>('commit');
    const entries = input.history.entries.filter(entry => entry.snapshot);
    if (!entries.length) return [];
    const lines = entries.map(entry => { const note = commits.get(entry.sha)?.value; return `${entry.sha.slice(0, 8)} ${entry.authoredAt.slice(0, 10)} ${entry.authorName} [${note?.intent ?? '?'}] ${note ? `${note.title}: ${clip(note.summary, 200)}` : entry.subject}`; });
    const text = lines.join('\n');
    return [{ target: 'repository', text, contentKey: digest(text), label: 'chapters' }];
  },
  request(items) {
    return {
      items, instructions: CHAPTER_INSTRUCTIONS, schemaName: 'chapters', input: items[0]!.text,
      schema: object({ chapters: array(object({ title: string(), summary: string(), from: string(), to: string(), areas: array(string()) })) }),
      maxOutputTokens: 60_000,
    };
  },
  parse(value, items) {
    const chapters = ((value as { chapters?: { title: string; summary: string; from: string; to: string; areas: string[] }[] }).chapters ?? []).map(item => ({ title: String(item.title), summary: String(item.summary), from: String(item.from), to: String(item.to), areas: (item.areas ?? []).map(String).slice(0, 4) }));
    return [{ target: items[0]!.target, value: { chapters }, prose: chapters.map(item => item.summary) }];
  },
};

export const TASKS: Record<TaskName, TaskSpec> = { files: filesTask, folders: foldersTask, flows: flowsTask, commits: commitsTask, domains: domainsTask, overview: overviewTask, chapters: chaptersTask };

// JSON Schema helpers (strict mode: every property required, no others) ---------------------
function object(properties: Record<string, unknown>): Record<string, unknown> { return { type: 'object', additionalProperties: false, required: Object.keys(properties), properties }; }
function array(items: unknown): Record<string, unknown> { return { type: 'array', items }; }
function string(): Record<string, unknown> { return { type: 'string' }; }
/** Entries of a batched answer, matched to the items by key (`f1`, `f2`…); unknown and duplicate keys are dropped. */
function keyed(value: unknown, field: string, prefix: string, items: TaskItem[]): { item: TaskItem; entry: Record<string, unknown> }[] {
  const entries = (value as Record<string, unknown>)?.[field];
  if (!Array.isArray(entries)) return [];
  const seen = new Set<number>();
  const result: { item: TaskItem; entry: Record<string, unknown> }[] = [];
  for (const entry of entries as Record<string, unknown>[]) {
    const match = new RegExp(`^\\[?${prefix}(\\d+)\\]?$`).exec(String(entry?.key ?? '').trim());
    const index = match ? Number(match[1]) - 1 : -1;
    if (index < 0 || index >= items.length || seen.has(index)) continue;
    seen.add(index);
    result.push({ item: items[index]!, entry });
  }
  return result;
}
