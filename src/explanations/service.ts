// Explanations over the live index: listing them with what went stale, one
// with its links resolved and its footprint, the explanations that link an
// entity (the inspector's "Explained in"), and publishing new text after its
// links were checked. The HTTP routes, the MCP server and the chat share it.
import { pullRequestFromMessage } from '../history/pull-requests.js';
import type { HistoryService } from '../history/service.js';
import type { ProjectionService } from '../projection/service.js';
import { parseLink, schemeHref } from './links.js';
import { excerptOf, latestAnswer, type ExplanationDetail, type ExplanationList, type ExplanationRecord, type ExplanationSubject, type ExplanationSummary, type ResolvedLink, type Staleness, type SubjectKind } from './model.js';
import { fingerprintOf, footprintOf, resolveAll, resolveLink, type CommitRef, type ResolveEnvironment } from './resolve.js';
import { ExplanationStore, EXPLANATIONS_DIRECTORY } from './store.js';

export interface ExplanationServiceOptions {
  stateDirectory: string; root?: string;
  projection: ProjectionService; history?: HistoryService;
  /** Refuse every write (serve --read-only). */
  readOnly?: boolean;
}
export interface PublishInput {
  markdown: string; title?: string; question?: string;
  subject?: { kind: SubjectKind; ref?: string };
  source: ExplanationRecord['source']; agent?: string; model?: string; cost?: number;
  /** Add to an existing explanation (a follow-up, a refresh) instead of starting one. */
  id?: string;
  /** With `id`: `append` (default) adds the turns; `replace` keeps only these. */
  mode?: 'append' | 'replace';
  /** Save even when links do not resolve (they are reported as missing). */
  allowUnresolved?: boolean;
}
export class UnresolvedLinksError extends Error {
  constructor(readonly links: ResolvedLink[]) { super(`${links.length} link${links.length === 1 ? '' : 's'} do not resolve: ${links.map(link => `${link.href} (${link.reason ?? 'not found'})`).join('; ')}`); }
}
export class ReadOnlyError extends Error { constructor() { super('Explanations are read-only on this server (serve --read-only)'); } }
export interface EntityExplanations {
  id: string;
  items: (ExplanationSummary & { via: 'subject' | 'link' | 'area'; hrefs: string[] })[];
}

export class ExplanationService {
  readonly store: ExplanationStore;
  private commitCache?: { head: string; commits: CommitRef[] };
  private details = new Map<string, { key: string; detail: ExplanationDetail }>();
  constructor(private readonly options: ExplanationServiceOptions) { this.store = new ExplanationStore(options.stateDirectory); }
  get readOnly(): boolean { return !!this.options.readOnly; }
  get root(): string | undefined { return this.options.root; }

  /** The live index and the branch's commits, as links resolve against them. */
  async environment(): Promise<ResolveEnvironment> {
    const context = this.options.projection.linkContext();
    return { context, commits: await this.commits() };
  }
  private async commits(): Promise<CommitRef[]> {
    const history = this.options.history;
    if (!history) return [];
    try {
      const ref = await history.defaultRef();
      const listed = await history.commits(ref);
      if (!listed) return [];
      const head = listed.head ?? listed.commits.at(-1)?.sha ?? '';
      if (this.commitCache?.head === head && this.commitCache.commits.length === listed.commits.length) return this.commitCache.commits;
      let snapshots = new Map<string, string>();
      try { const timeline = await history.timeline(); snapshots = new Map(timeline.entries.flatMap(entry => entry.snapshot ? [[entry.sha, entry.snapshot.id] as const] : [])); } catch { /* no indexed history */ }
      const commits = listed.commits.map(commit => {
        const pr = pullRequestFromMessage(commit)?.number;
        const snapshot = snapshots.get(commit.sha);
        return { sha: commit.sha, subject: commit.subject, ...(pr !== undefined ? { pr } : {}), ...(snapshot ? { snapshot } : {}) };
      });
      this.commitCache = { head, commits };
      return commits;
    } catch { return []; }
  }

  async list(): Promise<ExplanationList> {
    const records = this.store.list();
    const environment = records.length ? await this.environment() : undefined;
    const items = records.map(record => this.summary(this.detailOf(record, environment!)));
    return { items, version: this.store.version() };
  }
  async detail(id: string): Promise<ExplanationDetail | undefined> {
    const record = this.store.get(id);
    return record ? this.detailOf(record, await this.environment()) : undefined;
  }
  /** Links of a text, resolved (what `check_links` and publishing report). */
  async check(markdown: string): Promise<ResolvedLink[]> { return resolveAll(markdown, await this.environment()); }

  /** Explanations about an entity, linking it (or something inside it), or linking an area holding it. */
  async forEntity(id: string): Promise<EntityExplanations> {
    const environment = await this.environment();
    const index = environment.context.index;
    const node = index.node(id);
    const items: EntityExplanations['items'] = [];
    if (!node) return { id, items };
    for (const record of this.store.list()) {
      const detail = this.detailOf(record, environment);
      let via: 'subject' | 'link' | 'area' | undefined = record.subject.target === id ? 'subject' : undefined;
      const hrefs: string[] = [];
      for (const link of detail.links) {
        const linked = link.id ? index.node(link.id) : undefined;
        if (!linked || link.type === 'repository') continue;
        if (index.contains(node, linked)) { hrefs.push(link.href); via ??= 'link'; }
        else if (link.members && index.contains(linked, node) && !via) { via = 'area'; hrefs.push(link.href); }
        else if (link.members && index.contains(linked, node)) hrefs.push(link.href);
      }
      if (via) items.push({ ...this.summary(detail), via, hrefs });
    }
    const order = { subject: 0, link: 1, area: 2 };
    items.sort((a, b) => order[a.via] - order[b.via] || (a.updatedAt < b.updatedAt ? 1 : -1));
    return { id, items };
  }

  /** Save an answer (and its question) after checking its links; returns it resolved. */
  async publish(input: PublishInput): Promise<ExplanationDetail> {
    if (this.readOnly) throw new ReadOnlyError();
    const markdown = input.markdown.trim();
    if (!markdown) throw new Error('The explanation is empty');
    if (markdown.length > 400_000) throw new Error('The explanation is too long (at most 400 000 characters)');
    const environment = await this.environment();
    const { context } = environment;
    const links = resolveAll(markdown, environment);
    const missing = links.filter(link => link.status === 'missing');
    if (missing.length && !input.allowUnresolved) throw new UnresolvedLinksError(missing);
    const existing = input.id ? this.store.get(input.id) : undefined;
    if (input.id && !existing) throw new Error(`No explanation ${input.id}`);
    const now = new Date().toISOString();
    const pins: Record<string, string> = existing && input.mode !== 'replace' ? { ...existing.pins } : {};
    for (const link of links) { const print = fingerprintOf(link, context); if (print) pins[link.href] = print; else delete pins[link.href]; }
    const turns = existing && input.mode !== 'replace' ? [...existing.turns] : [];
    if (input.question?.trim()) turns.push({ role: 'question', text: input.question.trim(), at: now });
    turns.push({ role: 'answer', text: markdown, at: now, ...(input.model ? { model: input.model } : {}), ...(input.cost !== undefined ? { cost: input.cost } : {}), ...(context.commitSha ? { commit: context.commitSha } : {}) });
    const subject = input.subject ? this.subjectOf(input.subject, environment) : existing?.subject ?? { kind: 'question' as const };
    const title = input.title?.trim() || existing?.title || titleOf(markdown, input.question, subject);
    const cost = input.cost !== undefined ? (existing?.cost ?? 0) + input.cost : existing?.cost;
    const record: ExplanationRecord = {
      id: existing?.id ?? this.store.newId(title), title: title.slice(0, 200), subject,
      createdAt: existing?.createdAt ?? now, updatedAt: now,
      ...(context.commitSha ? { commit: context.commitSha } : {}), ...(context.dirty !== undefined ? { dirty: context.dirty } : {}),
      source: existing?.source ?? input.source, ...(input.agent ?? existing?.agent ? { agent: input.agent ?? existing?.agent } : {}),
      ...(input.model ?? existing?.model ? { model: input.model ?? existing?.model } : {}), ...(cost !== undefined ? { cost: Math.round(cost * 1e4) / 1e4 } : {}),
      pins, turns,
    };
    this.store.save(record);
    return this.detailOf(this.store.get(record.id) ?? record, environment);
  }
  remove(id: string): boolean { if (this.readOnly) throw new ReadOnlyError(); this.details.delete(id); return this.store.remove(id); }
  /** Rename an explanation. */
  rename(id: string, title: string): ExplanationRecord {
    if (this.readOnly) throw new ReadOnlyError();
    const record = this.store.get(id);
    if (!record) throw new Error(`No explanation ${id}`);
    const clean = title.trim().slice(0, 200);
    if (!clean) throw new Error('A title is required');
    return this.store.save({ ...record, title: clean });
  }

  /** What an explanation is about, named by a link or a reference the tools gave. */
  subjectOf(input: { kind: SubjectKind; ref?: string }, environment: ResolveEnvironment): ExplanationSubject {
    const ref = input.ref?.trim();
    const { context } = environment;
    if (input.kind === 'overview') return { kind: 'overview', label: context.index.node(context.index.rootId)?.name };
    if (input.kind === 'question') return { kind: 'question' };
    if (!ref) return { kind: input.kind };
    const href = input.kind === 'flow' && !ref.startsWith('flow:') ? schemeHref('flow', ref) : input.kind === 'commit' && !ref.startsWith('commit:') ? `commit:${ref}` : input.kind === 'pr' && !ref.startsWith('pr:') ? `pr:${ref.replace(/^#/, '')}` : ref;
    const parsed = parseLink(href);
    const link = parsed ? resolveLink(parsed, environment) : undefined;
    if (!link || link.status === 'missing') return { kind: input.kind, ref };
    if (input.kind === 'commit') return { kind: 'commit', target: link.sha, ref, label: link.label };
    if (input.kind === 'pr') return { kind: 'pr', target: parsed!.target, ref, label: link.label };
    return { kind: input.kind, ...(link.id ? { target: link.id } : {}), ref: link.href, label: link.label ?? link.path ?? link.name };
  }

  private detailOf(record: ExplanationRecord, environment: ResolveEnvironment): ExplanationDetail {
    const { context } = environment;
    const key = `${record.updatedAt}|${record.turns.length}|${context.runId}|${environment.commits.length}|${this.commitCache?.head ?? ''}`;
    const cached = this.details.get(record.id);
    if (cached?.key === key) return cached.detail;
    const cache = new Map<string, ResolvedLink>();
    const links: ResolvedLink[] = [];
    for (const turn of record.turns) if (turn.role === 'answer') for (const link of resolveAll(turn.text, environment, cache)) if (!links.some(item => item.href === link.href)) links.push(link);
    let changed = 0, missing = 0, linked = 0;
    const resolved = links.map(link => {
      if (link.status === 'external') return link;
      linked++;
      if (link.status === 'missing') { missing++; return link; }
      const pin = record.pins[link.href];
      if (pin && fingerprintOf(link, context) !== pin) { changed++; return { ...link, status: 'changed' as const }; }
      return link;
    });
    const stale: Staleness = { changed, missing, linked, moved: !!record.commit && !!context.commitSha && record.commit !== context.commitSha };
    if (record.commit) {
      const at = environment.commits.findIndex(commit => commit.sha === record.commit);
      if (at >= 0) stale.commitsSince = environment.commits.length - 1 - at;
    }
    const detail: ExplanationDetail = { ...record, links: resolved, stale, footprint: footprintOf(resolved, context), file: `${EXPLANATIONS_DIRECTORY}/${record.id}.md` };
    this.details.set(record.id, { key, detail });
    return detail;
  }
  private summary(detail: ExplanationDetail): ExplanationSummary {
    const answer = latestAnswer(detail);
    return {
      id: detail.id, title: detail.title, subject: detail.subject, createdAt: detail.createdAt, updatedAt: detail.updatedAt,
      ...(detail.commit ? { commit: detail.commit } : {}), source: detail.source, ...(detail.agent ? { agent: detail.agent } : {}),
      ...(detail.model ? { model: detail.model } : {}), ...(detail.cost !== undefined ? { cost: detail.cost } : {}),
      turns: detail.turns.filter(turn => turn.role === 'question').length || 1, links: detail.links.filter(link => link.status !== 'external').length,
      excerpt: answer ? excerptOf(answer.text) : '', stale: detail.stale,
    };
  }
}
/** A title from the text's first heading, else the question, else the subject. */
export function titleOf(markdown: string, question: string | undefined, subject: ExplanationSubject): string {
  const heading = /^#{1,3}\s+(.+?)\s*#*\s*$/m.exec(markdown)?.[1];
  const plain = (text: string) => text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_]/g, '').trim();
  if (heading) return plain(heading).slice(0, 120);
  if (question?.trim()) { const text = plain(question.trim().split('\n')[0]!); return text.length > 90 ? `${text.slice(0, 89)}…` : text; }
  if (subject.label) return subject.label;
  return plain(markdown.split('\n').find(line => line.trim()) ?? 'Explanation').slice(0, 90);
}
