'use client';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { ConversationDetail, ConversationMessage, ConversationQuery, ConversationPath, ConversationReplay, ImportResult } from '@engine/conversations/model';
import type { SessionPage } from '../lib/session-cache';
import { useAtlas, useStore } from './context';
import { Markdown } from './Markdown';
import { agentColor, providerName } from '../lib/activity';
import { agentConversations } from '../lib/agent-conversations';
import { ObservedActivity, SessionActivity } from './AgentSessionActivity';
import { isSessionSetup } from '@engine/conversations/presentation';
import { HARNESSES, sessionKey } from '@engine/harnesses/registry';

const plainLinks = { resolve: () => undefined, hover: () => {}, follow: () => {}, pending: true };
async function request<T>(url: string, options: { signal?: AbortSignal; method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(url, { signal: options.signal, method: options.method, headers: options.method ? { 'Content-Type': 'application/json', 'X-Codiluce-Request': 'journal' } : undefined, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error ?? 'Request failed'); return value as T;
}
function date(value?: string) { return value ? new Date(value).toLocaleString() : 'Date unavailable'; }

export function AgentSessionsView({ compact = false }: { compact?: boolean }) {
  const store = useStore(), journal = useAtlas(state => state.journal);
  const agents = useAtlas(state => state.agents);
  const scope = useAtlas(state => state.meta?.sessionScope);
  const [query, setQuery] = useState(''), [provider, setProvider] = useState('');
  const [path, setPath] = useState(journal.path ?? '');
  const [offset, setOffset] = useState(0), [revision, setRevision] = useState(0);
  const listQuery = useMemo<ConversationQuery>(() => ({ query, provider: provider ? provider as ConversationQuery['provider'] : undefined, path, offset }), [query, provider, path, offset]);
  const key = `${scope ?? ''}:${store.sessions.key(listQuery)}`;
  const [loaded, setLoaded] = useState<{ key: string; page: SessionPage }>();
  const page = store.sessions.peek(listQuery) ?? (loaded?.key === key ? loaded.page : undefined);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(''), [syncing, setSyncing] = useState(false), [report, setReport] = useState<ImportResult>();
  useEffect(() => { setPath(journal.path ?? ''); setOffset(0); }, [journal.path]);
  useEffect(() => {
    if (!scope) return;
    let cancelled = false; setError('');
    const timer = setTimeout(() => {
      setChecking(true);
      void store.sessions.refresh(listQuery, revision > 0).then(page => {
        if (!cancelled) setLoaded({ key, page });
      }).catch(error => { if (!cancelled) setError(error.message); }).finally(() => { if (!cancelled) setChecking(false); });
    }, query || path || provider ? 200 : 0);
    // A request can finish and populate the cache after the panel closes.
    return () => { cancelled = true; clearTimeout(timer); };
  }, [store, scope, key, listQuery, revision]);
  // Polling only imports recently observed sessions, and never moves the reading position.
  useEffect(() => {
    if (!page) return;
    const controller = new AbortController(); let busy = false;
    const refresh = async () => {
      if (busy || document.visibilityState !== 'visible') return;
      busy = true;
      try {
        const live = store.getState().agents.snapshot?.sessions.some(session => Date.now() - session.lastSeen <= 300_000);
        if (live && !page.readOnly) {
          const result = await request<ImportResult>('/api/conversations/sync?live=1', { method: 'POST', signal: controller.signal });
          if (result.errors.length) setError(`Live transcript refresh: ${result.errors[0]}`);
        }
        if (!controller.signal.aborted) setRevision(value => value + 1);
      } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : String(error)); }
      finally { busy = false; }
    };
    const timer = setInterval(() => void refresh(), 10_000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [store, !!page, page?.readOnly]);
  const threads = agentConversations(page?.items ?? [], (agents.snapshot?.sessions ?? []).filter(session => !provider || session.provider === provider), agents.now, !query.trim() && !path && offset === 0);
  // Live sessions whose transcript is not imported yet are listed too, but not counted in the page.
  const unsaved = threads.filter(item => !item.saved).length;
  const selectedSessions = agents.snapshot?.sessions.filter(session => sessionKey(session.provider, session.sessionId) === journal.conversationId) ?? [];
  const events = [...agents.snapshot?.events ?? []].reverse().filter(event => event.sessionId && sessionKey(event.provider, event.sessionId) === journal.conversationId);
  const open = (id?: string) => { if (agents.replay && agents.replay.id !== id) store.stopReplay(); store.openJournal('conversations', { id, path }); };
  const sync = async () => {
    setSyncing(true); setError('');
    try { setReport(await request<ImportResult>('/api/conversations/sync', { method: 'POST' })); setRevision(value => value + 1); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); } finally { setSyncing(false); }
  };
  return <section className={`journal-view agents-history${compact ? ' compact' : ''}`} aria-label="Agent sessions">
    <header className="journal-heading"><div><h3>Agent sessions</h3><p>Live sessions and the discussions behind your code.</p></div><button className="button" disabled={syncing || !page || page.readOnly} onClick={() => void sync()}>{syncing ? 'Importing history…' : 'Import / refresh history'}</button></header>
    <div className="journal-filters">
      <input className="text-input" aria-label="Search agent sessions" placeholder="Search messages and titles…" value={query} onChange={event => { setQuery(event.target.value); setOffset(0); }} />
      <select className="select" aria-label="Agents filter" value={provider} onChange={event => { setProvider(event.target.value); setOffset(0); }}><option value="">All agents</option>{HARNESSES.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
      <input className="text-input mono" aria-label="Filter agent sessions by file or folder" placeholder="File or folder…" value={path} onChange={event => { setPath(event.target.value); setOffset(0); }} />

    </div>
    {error && <p className="note error" role="alert">{error}</p>}
    {report && <div className="note" role="status">Imported {report.imported} agent sessions · {report.unchanged} unchanged.{report.errors.length > 0 && <details><summary>{report.errors.length} import issues</summary>{report.errors.map((error, i) => <p key={i}>{error}</p>)}</details>}</div>}
    <div className={`journal-columns${journal.conversationId ? ' has-reader' : ''}`}>
      <aside className="journal-list" aria-label="Saved agent sessions">
        <p className="note">{page ? <><span>{`${page.total} agent session${page.total === 1 ? '' : 's'}`}</span>{unsaved > 0 && <span>{` · ${unsaved} live, not imported yet`}</span>}</> : 'Loading history…'}{page && checking && <small className="sessions-refresh" role="status">Checking for updates…</small>}</p>
        {page?.total === 0 && !threads.length && <p className="absent">{query || path || provider ? 'No agent sessions match these filters.' : 'Import available local session history for this repository. Refresh again to include new messages. Imports stay on this machine.'}</p>}
        {threads.map(item => <div key={item.id} className={['running', 'waiting'].includes(item.status ?? '') ? 'agent-work agent-session-block' : 'agent-session-block'} onMouseEnter={() => store.hoverSession(item.id)} onMouseLeave={() => store.hoverSession(undefined)} onFocus={() => store.hoverSession(item.id)} onBlur={() => store.hoverSession(undefined)}><button className={`journal-card${item.sessions.length ? ' agent-session' : ''}`} aria-pressed={journal.conversationId === item.id} onClick={() => open(item.id)}>
          <span className="agent-conversation-title"><i className="agent-swatch" style={{ '--swatch': agentColor(item.id) } as CSSProperties} aria-hidden="true" /><strong>{item.title}</strong>{item.status && <span className={`agent-status ${item.status}`}>{item.status}</span>}</span>
          <small>{providerName(item.provider)} · {date(item.saved?.updatedAt ?? (item.lastSeen ? new Date(item.lastSeen).toISOString() : undefined))}{item.sessions.length > 1 ? ` · ${item.sessions.length} agents` : ''}</small>
          {!['running', 'waiting'].includes(item.status ?? '') && <span>{item.saved?.excerpt ?? 'Messages will appear when the local transcript is available.'}</span>}
          <small>{item.saved ? `${item.saved.messages} messages · ${item.saved.paths} observed paths` : 'Live session · transcript pending'}</small>
        </button><SessionActivity id={item.id} /></div>)}
        {page && page.total > page.limit && <div className="journal-pagination"><button className="button small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - page.limit))}>Previous results</button><span>{offset + 1}–{Math.min(page.total, offset + page.limit)}</span><button className="button small" disabled={offset + page.limit >= page.total} onClick={() => setOffset(offset + page.limit)}>Next results</button></div>}
      </aside>
      {journal.conversationId ? <div className="agents-conversation-pane">
        {compact && <button className="button small agents-back" onClick={() => open()}>← All agent sessions</button>}
        <ConversationReader key={journal.conversationId} id={journal.conversationId} query={query} revision={revision} messageId={journal.messageId} live={selectedSessions.length > 0} running={selectedSessions.some(session => ['running', 'waiting'].includes(session.status) && agents.now - session.lastSeen <= 300_000)} events={events} />
      </div> : <div className="journal-empty"><h3>Keep the discussion with the code</h3><p>Open an agent session to read its messages and inspect file activity beside the map.</p></div>}

    </div>
  </section>;
}

function ConversationReader({ id, query, revision, messageId, live, running, events }: { id: string; query: string; revision: number; messageId?: string; live: boolean; running: boolean; events: import('@engine/activity/model').ActivityEvent[] }) {
  const expanded = useAtlas(state => !!state.journal.expanded);
  const [detail, setDetail] = useState<ConversationDetail>(), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState<number>(), [jump, setJump] = useState(messageId);
  const reader = useRef<HTMLDivElement>(null), position = useRef('');
  useEffect(() => { setOffset(undefined); setJump(messageId); }, [id, messageId]);
  useEffect(() => { setOffset(undefined); }, [query]);
  useEffect(() => {
    const controller = new AbortController(); setError(''); setLoading(true);
    const params = new URLSearchParams({ q: query });
    if (offset !== undefined) params.set('offset', String(offset)); if (jump) params.set('message', jump);
    void request<ConversationDetail>(`/api/conversations/${encodeURIComponent(id)}?${params}`, { signal: controller.signal }).then(value => {
      setDetail(value);
      const next = JSON.stringify([id, query, offset, jump]);
      if (position.current !== next) {
        position.current = next;
        setTimeout(() => {
          if (controller.signal.aborted) return;
          const target = jump ?? value.matches.find(item => value.messages.some(message => message.id === item));
          if (target) {
            const element = document.getElementById(`message-${target}`);
            let parent = element?.parentElement;
            while (parent && parent !== reader.current) { if (parent.tagName === 'DETAILS') (parent as HTMLDetailsElement).open = true; parent = parent.parentElement; }
            element?.scrollIntoView({ block: 'center' });
          } else reader.current?.scrollTo(0, 0);
        }, 0);
      }
    }).catch(error => { if (!controller.signal.aborted) { setError(error.message); setDetail(undefined); } }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [id, query, revision, offset, jump]);
  const navigate = (next: number) => { setJump(undefined); setOffset(next); };
  // Consecutive tool calls stay underneath one compact disclosure.
  const groups: [ConversationMessage, ...ConversationMessage[]][] = [];
  for (const message of detail?.messages ?? []) {
    if (detail && isSessionSetup(message, detail.provider)) continue;
    if (message.role === 'tool' && groups.at(-1)?.[0].role === 'tool') groups.at(-1)!.push(message);
    else groups.push([message]);
  }
  const messageBody = (message: ConversationDetail['messages'][number]) => <>
    <div className="journal-message-meta"><strong>{message.role === 'tool' ? message.tool : message.role === 'user' ? 'You' : 'Assistant'}</strong><time>{date(message.at)}</time>{detail?.matches.includes(message.id) && <mark>Search match</mark>}</div>
    {message.role === 'tool' ? <details open={detail?.matches.includes(message.id) || jump === message.id || undefined}><summary>Tool output · {message.status === 'unknown' ? 'unconfirmed' : message.status}</summary><pre>{message.text || 'No tool result was recorded.'}</pre></details> : <Markdown text={message.text} links={plainLinks} />}
    {message.truncated && <p className="note">This tool output was shortened to 100,000 characters for the archive. The original transcript remains in your agent’s history.</p>}
    {detail?.paths.filter(target => target.messageId === message.id).map((target, index) => <div className="journal-call-path" key={index}><span>{target.action} · {target.status === 'unknown' ? 'unconfirmed' : target.status}</span><PathButton target={target} /></div>)}
  </>;
  return <div className="journal-reader" ref={reader} aria-label="Agent session reader" aria-busy={loading}>
    {!expanded && <SessionActivity id={id} />}
    {error && <p className={`note${live && !detail ? '' : ' error'}`} role={live && !detail ? 'status' : 'alert'}>{live && !detail ? 'The local transcript is not available yet. Observed tool activity is available below.' : error}</p>}
    {detail?.id === id && <>
      <div className="journal-reader-head"><div><h3><i className="agent-swatch" style={{ '--swatch': agentColor(id) } as CSSProperties} aria-hidden="true" />{detail.title}</h3><p className="note">{providerName(detail.provider)} · {date(detail.startedAt)} · <code title={detail.sessionId}>{detail.sessionId.slice(0, 12)}</code></p></div>{!running && <ReplayButton id={id} />}</div>
      <details className="journal-footprint"><summary>Files and folders · {detail.footprint.length} associations</summary><p className="note">From literal tool arguments. Unconfirmed calls and failed attempts are labelled; scripts and dynamic paths may have no association.</p><div className="journal-paths">{detail.footprint.map((target, index) => <div key={index}><PathButton target={target} /><span>{target.action} · {target.status === 'unknown' ? 'unconfirmed' : target.status} · {target.count} calls</span><button className="button small" onClick={() => { setJump(target.messageId); setOffset(undefined); }}>Show call</button></div>)}</div></details>
      <div className="journal-pagination"><button className="button small" disabled={detail.offset === 0 || loading} onClick={() => navigate(Math.max(0, detail.offset - detail.limit))}>Earlier messages</button><span>{detail.totalMessages ? detail.offset + 1 : 0}–{Math.min(detail.offset + detail.messages.length, detail.totalMessages)} of {detail.totalMessages}{query && detail.matches.length > 0 ? ` · ${detail.matches.length} matching messages` : ''}</span><button className="button small" disabled={loading || detail.offset + detail.limit >= detail.totalMessages} onClick={() => navigate(detail.offset + detail.limit)}>Later messages</button></div>
      {detail.offset + detail.limit < detail.totalMessages && <button className="button small" onClick={() => navigate(Math.max(0, detail.totalMessages - detail.limit))}>Latest messages</button>}
      <ol className="journal-messages">{groups.map(group => group[0].role === 'tool' ? <li key={group[0].id} className="journal-tool-group"><details open={group.some(message => detail.matches.includes(message.id) || jump === message.id) || undefined}><summary>{group.length} tool call{group.length === 1 ? '' : 's'} · {[...new Set(group.map(message => message.tool))].join(', ')}</summary>{group.map(message => <div id={`message-${message.id}`} key={message.id} className={`journal-message tool${detail.matches.includes(message.id) ? ' match' : ''}`}>{messageBody(message)}</div>)}</details></li> : <li id={`message-${group[0].id}`} key={group[0].id} className={`journal-message ${group[0].role}${detail.matches.includes(group[0].id) ? ' match' : ''}`}>{messageBody(group[0])}</li>)}</ol>
    </>}
    <ObservedActivity events={events} />
  </div>;
}

/** A finished session played again on the map: its character hops through the files it read and edited; the map's replay bar plays, pauses and steps it. */
function ReplayButton({ id }: { id: string }) {
  const store = useStore(), playing = useAtlas(state => state.agents.replay?.id === id);
  const historical = useAtlas(state => state.meta?.snapshot.kind === 'commit' || state.timeline.preview !== undefined);
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const replay = async () => {
    setLoading(true); setError('');
    try {
      const data = await request<ConversationReplay>(`/api/conversations/${encodeURIComponent(id)}/replay`);
      if (!data.steps.length) throw new Error('This session has no steps to replay.');
      store.replaySession(id, data);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); } finally { setLoading(false); }
  };
  return <div className="session-replay">
    <button className="button small" disabled={loading || historical} aria-pressed={playing} onClick={() => (playing ? store.stopReplay() : void replay())} title={historical ? 'Replays play on the live map. Return to it from History.' : 'Play this session again on the map, step by step: its character hops to the files it read, edited and searched, labeled with each step'}>{playing ? '■ Stop replay' : loading ? 'Loading…' : '▶ Replay on the map'}</button>
    {error && <small className="error" role="alert">{error}</small>}
  </div>;
}

function PathButton({ target }: { target: Pick<ConversationPath, 'path' | 'scope'> }) {
  const store = useStore(), [error, setError] = useState('');
  const reveal = async () => {
    setError('');
    try {
      const page = await store.api.search(target.path === '.' ? '' : target.path, undefined);
      const item = target.path === '.' ? store.getState().meta?.root : page.items.find(item => item.path === target.path && (target.scope === 'file' ? item.type === 'file' : ['directory', 'application'].includes(item.type)));
      if (!item) throw new Error('This path is not in the current map. Its historical association is preserved.');
      store.expandAgents(false); store.setCenter('map'); await store.select(item.id, { fly: false }); if (target.scope === 'file') store.openCode();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  };
  return <span className="journal-path"><button className="button link mono" onClick={() => void reveal()} title="Open this path in the inspector">{target.path}{target.scope === 'directory' && target.path !== '.' && !target.path.endsWith('/') ? '/' : ''}</button>{error && <small className="error" role="status">{error}</small>}</span>;
}
