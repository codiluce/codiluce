import type { ConversationPage, ConversationQuery, ConversationSummary } from '../../src/conversations/model';

export type SessionPage = ConversationPage & { readOnly: boolean; scope: string };
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
type Fetch = (url: string, options?: RequestInit) => Promise<Response>;
interface CachedPage { value: SessionPage; etag?: string; savedAt: number }
const MAX_PAGES = 24, MAX_SAVED_BYTES = 128_000, MAX_AGE = 7 * 24 * 60 * 60_000;
const parameters = (query: ConversationQuery = {}) => new URLSearchParams({ q: query.query?.trim() ?? '', provider: query.provider ?? '', path: query.path ?? '', action: query.action ?? '', offset: String(query.offset ?? 0), limit: String(query.limit ?? 30) }).toString();
const DEFAULT_PAGE = parameters();

/** Summaries survive panel unmounts; only the default list is persisted, never full transcripts. */
export class SessionListCache {
  private pages = new Map<string, CachedPage>();
  private pending = new Map<string, { promise: Promise<SessionPage>; controller: AbortController }>();
  private currentScope?: string;
  constructor(private readonly storage?: StorageLike, private readonly fetcher: Fetch = (url, options) => fetch(url, options)) {}
  get scope(): string | undefined { return this.currentScope; }
  key(query: ConversationQuery = {}): string { return `${this.currentScope ?? ''}:${parameters(query)}`; }
  setScope(scope: string | undefined): void {
    if (scope === this.currentScope) return;
    this.close(); this.pages.clear(); this.currentScope = scope;
    if (!scope) return;
    try {
      const raw = this.storage?.getItem(this.storageKey(scope));
      if (!raw || raw.length > MAX_SAVED_BYTES) return;
      const saved = JSON.parse(raw) as CachedPage & { version?: number };
      if (saved.version === 1 && validPage(saved.value, scope) && saved.value.offset === 0 && saved.value.limit === 30 && Number.isFinite(saved.savedAt) && Date.now() - saved.savedAt < MAX_AGE && saved.savedAt <= Date.now() + 60_000 && (saved.etag === undefined || typeof saved.etag === 'string')) this.pages.set(DEFAULT_PAGE, saved);
    } catch { /* A missing or corrupt browser cache never prevents loading the archive. */ }
  }
  peek(query: ConversationQuery = {}): SessionPage | undefined { return this.pages.get(parameters(query))?.value; }
  refresh(query: ConversationQuery = {}, force = false): Promise<SessionPage> {
    const scope = this.currentScope;
    if (!scope) return Promise.reject(new Error('The session archive is not ready yet'));
    const params = parameters(query), existing = this.pending.get(params);
    if (existing) return force ? existing.promise.catch(() => undefined).then(() => this.refresh(query)) : existing.promise;
    const controller = new AbortController();
    const promise = (async () => {
      const cached = this.pages.get(params);
      const response = await this.fetcher(`/api/conversations?${params}`, { signal: controller.signal, headers: cached?.etag ? { 'If-None-Match': cached.etag } : undefined });
      if (controller.signal.aborted || this.currentScope !== scope) throw new DOMException('Aborted', 'AbortError');
      if (response.status === 304 && cached) { this.remember(params, { ...cached, savedAt: Date.now() }); return cached.value; }
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? 'Could not refresh agent sessions');
      if (value.scope !== scope) { this.setScope(undefined); throw new Error('The session archive changed. Reload this page.'); }
      if (!validPage(value, scope)) throw new Error('The session archive returned an invalid list');
      if (controller.signal.aborted || this.currentScope !== scope) throw new DOMException('Aborted', 'AbortError');
      this.remember(params, { value, etag: response.headers.get('ETag') ?? undefined, savedAt: Date.now() });
      return value;
    })().finally(() => { if (this.pending.get(params)?.controller === controller) this.pending.delete(params); });
    this.pending.set(params, { promise, controller });
    return promise;
  }
  close(): void { for (const item of this.pending.values()) item.controller.abort(); this.pending.clear(); }
  private storageKey(scope: string): string { return `codiluce:agent-sessions:v1:${scope}`; }
  private remember(params: string, page: CachedPage): void {
    this.pages.delete(params); this.pages.set(params, page);
    while (this.pages.size > MAX_PAGES) this.pages.delete(this.pages.keys().next().value!);
    if (params === DEFAULT_PAGE && this.currentScope) {
      try { const saved = JSON.stringify({ version: 1, ...page }); if (saved.length <= MAX_SAVED_BYTES) this.storage?.setItem(this.storageKey(this.currentScope), saved); } catch { /* Private mode and storage quotas still allow an in-memory cache. */ }
    }
  }
}

function validPage(value: unknown, scope: string): value is SessionPage {
  if (!value || typeof value !== 'object') return false;
  const page = value as SessionPage;
  return page.scope === scope && typeof page.readOnly === 'boolean' && Number.isSafeInteger(page.total) && page.total >= 0 && Number.isSafeInteger(page.limit) && page.limit > 0 && page.limit <= 100 && Number.isSafeInteger(page.offset) && page.offset >= 0 && Array.isArray(page.items) && page.items.length <= page.limit && page.items.every(validSummary);
}
function validSummary(value: unknown): value is ConversationSummary {
  if (!value || typeof value !== 'object') return false;
  const item = value as ConversationSummary;
  return ['codex', 'claude-code'].includes(item.provider) && ['id', 'sessionId', 'title', 'excerpt', 'cwd'].every(key => typeof item[key as keyof ConversationSummary] === 'string') && Number.isSafeInteger(item.messages) && item.messages >= 0 && Number.isSafeInteger(item.paths) && item.paths >= 0 && (item.startedAt === undefined || typeof item.startedAt === 'string') && (item.updatedAt === undefined || typeof item.updatedAt === 'string');
}
