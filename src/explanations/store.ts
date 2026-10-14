// `<state>/explanations/<id>.md`: one Markdown file per explanation, readable
// and shareable as is. YAML front matter holds what it is about, the commit it
// was written against and the fingerprints of what it links; the body holds
// the turns, each after a `<!-- codiluce:question -->` or
// `<!-- codiluce:answer … -->` marker (a file without markers is one answer,
// so a hand-written note works too). Writes go to a temporary file that is
// renamed, so a reader never sees half a file.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { EXPLANATION_ID, slug, type ExplanationRecord, type ExplanationSubject, type ExplanationTurn } from './model.js';

export const EXPLANATIONS_DIRECTORY = 'explanations';
const MARKER = /^<!-- codiluce:(question|answer)((?:\s+[a-z]+=(?:"[^"]*"|\S+?))*)\s*-->[ \t]*$/gm;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SUBJECT_KINDS = new Set(['overview', 'flow', 'commit', 'pr', 'entity', 'question']);

export class ExplanationStore {
  readonly directory: string;
  private cache = new Map<string, { mtime: number; size: number; record: ExplanationRecord }>();
  constructor(stateDirectory: string) { this.directory = path.join(stateDirectory, EXPLANATIONS_DIRECTORY); }

  /** Every explanation, newest first, re-read only when its file changed. */
  list(): ExplanationRecord[] {
    let names: string[];
    try { names = readdirSync(this.directory).filter(name => name.endsWith('.md')); } catch { return []; }
    const seen = new Set<string>();
    const records: ExplanationRecord[] = [];
    for (const name of names) {
      const id = name.slice(0, -3);
      if (!EXPLANATION_ID.test(id)) continue;
      seen.add(id);
      const record = this.read(id);
      if (record) records.push(record);
    }
    for (const id of this.cache.keys()) if (!seen.has(id)) this.cache.delete(id);
    return records.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id < b.id ? -1 : 1));
  }
  /** A stamp that changes whenever a file is added, removed or changed. */
  version(): string {
    try {
      const names = readdirSync(this.directory).filter(name => name.endsWith('.md'));
      let latest = 0;
      for (const name of names) { try { latest = Math.max(latest, statSync(path.join(this.directory, name)).mtimeMs); } catch { /* removed meanwhile */ } }
      return `${names.length}:${Math.round(latest)}`;
    } catch { return '0:0'; }
  }
  get(id: string): ExplanationRecord | undefined { return EXPLANATION_ID.test(id) ? this.read(id) : undefined; }
  file(id: string): string { if (!EXPLANATION_ID.test(id)) throw new Error('Invalid explanation ID'); return path.join(this.directory, `${id}.md`); }

  private read(id: string): ExplanationRecord | undefined {
    const file = path.join(this.directory, `${id}.md`);
    let stat;
    try { stat = statSync(file); } catch { this.cache.delete(id); return undefined; }
    if (stat.size > MAX_FILE_BYTES) return undefined;
    const cached = this.cache.get(id);
    if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) return cached.record;
    try {
      const record = parseExplanation(id, readFileSync(file, 'utf8'), stat.mtime.toISOString());
      this.cache.set(id, { mtime: stat.mtimeMs, size: stat.size, record });
      return record;
    } catch { return undefined; }
  }
  save(record: ExplanationRecord): ExplanationRecord {
    if (!EXPLANATION_ID.test(record.id)) throw new Error('Invalid explanation ID');
    mkdirSync(this.directory, { recursive: true });
    const file = this.file(record.id);
    const temporary = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
    writeFileSync(temporary, serializeExplanation(record));
    renameSync(temporary, file);
    this.cache.delete(record.id);
    return record;
  }
  remove(id: string): boolean {
    const file = this.file(id);
    try { rmSync(file); this.cache.delete(id); return true; } catch { return false; }
  }
  /** A new ID from the title: the date, its words and a short random part. */
  newId(title: string, now = new Date()): string {
    for (;;) {
      const id = `${now.toISOString().slice(0, 10)}-${slug(title, 60)}-${randomBytes(2).toString('hex')}`;
      if (!this.get(id)) return id;
    }
  }
}

export function serializeExplanation(record: ExplanationRecord): string {
  const { turns, id: _id, ...meta } = record;
  const front: Record<string, unknown> = { title: meta.title, subject: compact(meta.subject), source: meta.source };
  for (const key of ['agent', 'model', 'cost', 'commit', 'dirty', 'createdAt', 'updatedAt'] as const) if (meta[key] !== undefined) front[key] = meta[key];
  if (Object.keys(meta.pins).length) front.pins = meta.pins;
  const body = turns.map(turn => {
    const attributes = turn.role === 'answer'
      ? [['at', turn.at], ['model', turn.model], ['cost', turn.cost?.toFixed(4)], ['commit', turn.commit]].filter(([, value]) => value !== undefined).map(([key, value]) => ` ${key}=${/^[\w.:-]+$/.test(String(value)) ? value : JSON.stringify(value)}`).join('')
      : ` at=${turn.at}`;
    return `<!-- codiluce:${turn.role}${attributes} -->\n${turn.text.trim()}\n`;
  }).join('\n');
  return `---\n${stringify(front, { lineWidth: 0 }).trimEnd()}\n---\n\n${body}`;
}
export function parseExplanation(id: string, text: string, modified: string): ExplanationRecord {
  let front: Record<string, unknown> = {}, body = text.replace(/^﻿/, '');
  const head = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(body);
  if (head) {
    const parsed = parse(head[1]!) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) front = parsed as Record<string, unknown>;
    body = body.slice(head[0].length);
  }
  const turns: ExplanationTurn[] = [];
  const markers = [...body.matchAll(MARKER)];
  const lead = body.slice(0, markers[0]?.index ?? body.length).trim();
  if (lead) turns.push({ role: 'answer', text: lead, at: String(front.updatedAt ?? modified) });
  markers.forEach((marker, index) => {
    const start = marker.index! + marker[0].length, end = markers[index + 1]?.index ?? body.length;
    const attributes = Object.fromEntries([...(marker[2] ?? '').matchAll(/([a-z]+)=("[^"]*"|\S+)/g)].map(match => [match[1]!, match[2]!.startsWith('"') ? JSON.parse(match[2]!) as string : match[2]!]));
    const textOf = body.slice(start, end).trim();
    const turn: ExplanationTurn = { role: marker[1] as ExplanationTurn['role'], text: textOf, at: attributes.at ?? String(front.updatedAt ?? modified) };
    if (attributes.model) turn.model = attributes.model;
    if (attributes.cost && Number.isFinite(Number(attributes.cost))) turn.cost = Number(attributes.cost);
    if (attributes.commit) turn.commit = attributes.commit;
    turns.push(turn);
  });
  const text$ = (key: string) => typeof front[key] === 'string' ? front[key] as string : front[key] instanceof Date ? (front[key] as Date).toISOString() : undefined;
  const subjectValue = front.subject && typeof front.subject === 'object' ? front.subject as Record<string, unknown> : {};
  const subject: ExplanationSubject = { kind: SUBJECT_KINDS.has(String(subjectValue.kind)) ? subjectValue.kind as ExplanationSubject['kind'] : 'question' };
  for (const key of ['target', 'ref', 'label'] as const) if (subjectValue[key] !== undefined && subjectValue[key] !== null) subject[key] = String(subjectValue[key]);
  const pins: Record<string, string> = {};
  if (front.pins && typeof front.pins === 'object') for (const [href, value] of Object.entries(front.pins as Record<string, unknown>)) if (typeof value === 'string') pins[href] = value;
  const firstQuestion = turns.find(turn => turn.role === 'question')?.text;
  const source = front.source === 'agent' || front.source === 'chat' ? front.source : 'manual';
  return {
    id, title: text$('title') ?? firstQuestion?.slice(0, 80) ?? id, subject,
    createdAt: text$('createdAt') ?? modified, updatedAt: text$('updatedAt') ?? modified,
    ...(text$('commit') ? { commit: text$('commit') } : {}), ...(typeof front.dirty === 'boolean' ? { dirty: front.dirty } : {}),
    source, ...(text$('agent') ? { agent: text$('agent') } : {}), ...(text$('model') ? { model: text$('model') } : {}),
    ...(typeof front.cost === 'number' ? { cost: front.cost } : {}), pins, turns,
  };
}
function compact(subject: ExplanationSubject): Record<string, string> {
  return Object.fromEntries(Object.entries(subject).filter(([, value]) => value !== undefined && value !== '')) as Record<string, string>;
}
