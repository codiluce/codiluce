'use client';
import { useEffect, useRef, useState } from 'react';
import type { ActivityEvent, ActivityPath, ActivitySnapshot, AgentConnection, AgentProvider, AgentSetup } from '@engine/activity/model';
import { ACTIVITY_TRAIL_MS } from '@engine/activity/model';
import { agentColor, providerName } from '../lib/activity';
import { useAtlas, useStore } from './context';

/** One connection for the map, independent of whether the panel is open. */
export function ActivityConnection() {
  const store = useStore();
  useEffect(() => {
    const source = new EventSource('/api/agents/stream');
    source.onmessage = message => {
      try { store.setActivity({ snapshot: JSON.parse(message.data) as ActivitySnapshot, connected: true, now: Date.now() }); } catch { /* wait for the next snapshot */ }
    };
    source.onerror = () => store.setActivity({ connected: false });
    const timer = setInterval(() => { const agents = store.getState().agents; if (agents.snapshot?.sessions.length) store.setActivity({ now: Date.now() }); }, 1000);
    return () => { source.close(); clearInterval(timer); };
  }, [store]);
  return null;
}

export function AgentsPanel({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const agents = useAtlas(state => state.agents);
  const historical = useAtlas(state => state.meta?.snapshot.kind === 'commit' || state.timeline.preview !== undefined);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [pendingPath, setPendingPath] = useState<string>();
  const [pathError, setPathError] = useState<string>();
  const snapshot = agents.snapshot;
  const events = [...snapshot?.events ?? []].reverse().filter(event => !agents.focus || event.actor === agents.focus).slice(0, 80);
  const sessions = [...snapshot?.sessions ?? []].reverse();
  const titles = new Map(sessions.map(session => [session.actor, session.title]));
  const lastEvent = Math.max(0, ...sessions.map(session => session.lastSeen));
  const select = async (event: ActivityEvent, index: number) => {
    const target = event.paths[index]; if (!target || historical || pendingPath) return;
    setPendingPath(target.path); setPathError(undefined);
    try {
      let path = target;
      if (target.scope === 'file') {
        const response = await fetch('/api/agents/reveal', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Codiluce-Request': 'activity' }, body: JSON.stringify({ eventId: event.id, index }) });
        const data = await response.json() as { path: ActivityPath; refreshed: boolean; snapshot: ActivitySnapshot; error?: string };
        if (!response.ok) throw new Error(data.error ?? 'Could not reveal this file');
        path = data.path; store.setActivity({ snapshot: data.snapshot, now: Date.now() });
        if (data.refreshed) await store.reload();
      }
      if (!path.id) throw new Error('This path is not available on the map.');
      store.setCenter('map');
      await store.select(path.id, { fly: true });
      const node = store.getState().selection?.node;
      if (node?.hidden) await store.revealOnMap(node);
    } catch (error) { setPathError(error instanceof Error ? error.message : 'Could not reveal this file'); }
    finally { setPendingPath(undefined); }
  };
  return <>
    <div className="panel-header"><h2>Agents</h2><button className="icon-button small" onClick={onClose} aria-label="Hide the agents panel">⇤</button></div>
    <div className="panel-body agents-panel">
      <div className="agents-status-row">
        <div className="agents-connection" role="status"><span className={`agents-live-dot${agents.connected && snapshot?.enabled ? ' on' : ''}`} />{agents.connected ? snapshot?.enabled ? 'Live activity' : 'Activity disabled' : 'Connecting to activity…'}</div>
        <details className="agents-info" onKeyDown={event => { if (event.key === 'Escape') event.currentTarget.open = false; }}>
          <summary aria-label="About agent activity" title="About agent activity">ⓘ</summary>
          <p className="note">Observed actions from Codex and Claude Code. Map badges fade after 30 seconds; they show recent actions, not what an agent is thinking about. Live activity indicates that the map is receiving updates from the server; check Agent connections for hook configuration and delivery.</p>
        </details>
      </div>
      <label className="agents-toggle"><input type="checkbox" checked={agents.show} onChange={event => store.setActivity({ show: event.target.checked })} /> Show activity on the map</label>
      {historical && <p className="note">Activity belongs to the working tree. Return to the live map to see its badges.</p>}
      <section aria-label="Agent sessions"><h3>Sessions <span className="count">{sessions.length}</span></h3>
        {!sessions.length && <p className="absent">No sessions observed yet. Open Agent connections below to check your setup.</p>}
        {sessions.map(session => <button key={session.actor} className="agent-session" aria-pressed={agents.focus === session.actor} onClick={() => store.setActivity({ focus: agents.focus === session.actor ? undefined : session.actor })}>
          <span className="domain-dot" style={{ background: agentColor(session.actor) }} /><span className="agent-name"><strong title={session.title}>{session.title ?? `${providerName(session.provider)} session`}</strong><small>{providerName(session.provider)} · <span className="mono" title={session.sessionId}>{session.agentId ? `agent ${session.agentId.slice(0, 12)}` : session.sessionId.slice(0, 12)}</span></small></span><span className={`agent-status ${session.status}`}>{agents.now - session.lastSeen > 300_000 && ['running', 'waiting'].includes(session.status) ? 'unknown' : session.status}</span>
        </button>)}
        {agents.focus && <button className="button small" onClick={() => store.setActivity({ focus: undefined })}>Show every agent</button>}
      </section>
      <section aria-label="Recent activity"><h3>Recent activity</h3>
        {pendingPath && <p className="note" role="status">Revealing {pendingPath}…{events.some(event => event.paths.some(path => path.path === pendingPath && path.exact === false)) ? ' Updating the map index to include this file.' : ''}</p>}
        {pathError && <p className="note error" role="alert">{pathError}</p>}
        {!events.length && <p className="absent">Waiting for observed activity…</p>}
        <ol className="activity-feed">{events.map(event => <li key={event.id} className={agents.now - event.at < ACTIVITY_TRAIL_MS ? 'recent' : ''}>
          <div className="activity-event-head"><span className="domain-dot" style={{ background: agentColor(event.actor) }} /><strong>{event.label}</strong><span className="absent">{event.phase === 'status' ? event.status : event.phase}</span><time dateTime={new Date(event.at).toISOString()} title={new Date(event.at).toLocaleString()}>{Math.max(0, Math.floor((agents.now - event.at) / 1000))}s</time></div>
          <small className="absent">{titles.get(event.actor) ? `${titles.get(event.actor)} · ` : ''}{providerName(event.provider)} · {event.agentId?.slice(0, 8) ?? event.sessionId?.slice(0, 8)}</small>
          {event.query && <p className="activity-query">Search: <code>{event.query}</code></p>}
          {event.paths.map((target, index) => <button key={`${target.path}:${index}`} className="activity-path mono" disabled={!!pendingPath || historical || !target.id && target.scope !== 'file'} onClick={() => void select(event, index)} title={target.scope === 'file' ? target.exact === false ? 'Update the index and reveal this file on the map' : 'Reveal this file on the map' : 'Select this search scope on the map'}>{target.path}{target.scope === 'directory' && target.path !== '.' ? '/' : ''}{target.exact === false && <span className="absent">{target.scope === 'file' ? ' · reveal file' : ' · nearest folder'}</span>}</button>)}
        </li>)}</ol>
      </section>
    </div>
    <div className="agents-footer"><button className="button" onClick={() => setConnectionsOpen(true)} aria-haspopup="dialog"><span className={`agents-live-dot${lastEvent && agents.connected ? ' on' : ''}`} />Agent connections<span aria-hidden="true">⚙</span></button></div>
    {connectionsOpen && <AgentConnectionsDialog onClose={() => setConnectionsOpen(false)} />}
  </>;
}

function connectionState(connection: AgentConnection | undefined, observed: boolean): string {
  if (connection?.disabled) return 'Hooks disabled';
  if (connection?.trust === 'modified') return 'Hooks changed · review needed';
  if (connection?.trust === 'needs-review') return 'Installed · trust needed';
  if (observed) return 'Hook delivery confirmed';
  if (connection?.trust === 'trusted') return 'Installed and trusted · awaiting activity';
  if (connection?.configured) return 'Configured · awaiting activity';
  return connection ? 'Setup needed' : 'Checking configuration…';
}
function AgentConnectionsDialog({ onClose }: { onClose: () => void }) {
  const agents = useAtlas(state => state.agents);
  const [setup, setSetup] = useState<AgentSetup>();
  const [setupError, setSetupError] = useState<string>();
  const [provider, setProvider] = useState<AgentProvider>('codex');
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);
  const [revision, setRevision] = useState(0);
  const dialog = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const dismiss = useRef(onClose); dismiss.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    close.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss.current(); }
      if (event.key === 'Tab') {
        const buttons = [...dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), summary, [tabindex="0"]') ?? []];
        const first = buttons[0], last = buttons.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); previous?.focus(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController(); setChecking(true); setSetupError(undefined);
    fetch('/api/agents/setup', { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Connection setup is unavailable');
      setSetup(await response.json());
    }).catch(error => { if (!controller.signal.aborted) setSetupError(error.message); }).finally(() => { if (!controller.signal.aborted) setChecking(false); });
    return () => controller.abort();
  }, [revision]);
  const connection = setup?.connections?.find(item => item.provider === provider);
  const sessions = agents.snapshot?.sessions.filter(session => session.provider === provider) ?? [];
  const lastSeen = Math.max(0, ...sessions.map(session => session.lastSeen));
  const observed = lastSeen > 0;
  const needsSetup = !connection?.configured && !observed;
  const snippet = JSON.stringify(provider === 'codex' ? setup?.codex : setup?.claude, null, 2) ?? '';
  return <div className="agent-connections-backdrop" onClick={onClose}>
    <section ref={dialog} className="card agent-connections-dialog" role="dialog" aria-modal="true" aria-labelledby="agent-connections-title" onClick={event => event.stopPropagation()}>
      <div className="hidden-paths-heading"><h2 id="agent-connections-title">Agent connections</h2><button ref={close} className="icon-button small" aria-label="Close agent connections" onClick={onClose}>×</button></div>
      <div className="segmented" role="group" aria-label="Agent setup">{(['codex', 'claude-code'] as const).map(item => <button key={item} aria-pressed={provider === item} onClick={() => { setProvider(item); setCopied(false); }}>{providerName(item)}</button>)}</div>
      <div className="agents-connection-summary" role="status"><span className={`agents-live-dot${observed && agents.connected && !connection?.disabled && !['needs-review', 'modified'].includes(connection?.trust ?? '') ? ' on' : ''}`} /><strong>{connectionState(connection, observed)}</strong></div>
      {observed && <p className="note">Last hook received <time dateTime={new Date(lastSeen).toISOString()}>{Math.max(0, Math.floor((agents.now - lastSeen) / 1000))}s ago</time>. Idle sessions do not send a heartbeat.</p>}
      {!observed && connection?.configured && <p className="note">Run a read or another action in your agent to confirm delivery to this map.</p>}
      {connection?.trust === 'trusted' && <p className="note">Codex reports the installed hook definitions as trusted. This check reads saved configuration; a running session may need to reload changes.</p>}
      {connection?.trust === 'needs-review' || connection?.trust === 'modified' ? <p className="note">Open <code>/hooks</code> in Codex to review and trust the current Codiluce hooks, then run an action.</p> : provider === 'codex' && connection?.trust === 'unknown' && connection?.configured && <p className="note">Trust status is unavailable. Check <code>/hooks</code> in Codex. Receiving an event confirms delivery, not the saved trust setting.</p>}
      {connection?.disabled && <p className="note">Hooks are disabled in the saved configuration. Enable them in your agent before checking delivery.</p>}
      {!agents.connected && <p className="note">The map's live connection is interrupted. Hook delivery status will update when it reconnects.</p>}
      {!!connection?.sources.length && <details><summary>Configuration sources</summary>{connection.sources.map(source => <p className="mono agents-source" key={source}>{source}</p>)}</details>}
      {setupError && <p className="note error" role="alert">{setupError}</p>}
      {setup?.available === false && <p className="note">Agent observation is unavailable on this server.</p>}
      {setup?.available && snippet && <details className="agents-setup" open={needsSetup} key={provider + String(needsSetup)}><summary>{needsSetup ? 'Connect this agent' : 'View or update hook configuration'}</summary>
        <p className="note">Merge these entries into your existing hooks.</p>
        <p className="note">{provider === 'codex' ? <>Use <code>.codex/hooks.json</code>, then review and trust the hooks with <code>/hooks</code>.</> : <>Use <code>.claude/settings.local.json</code>. Restart Claude Code if the running session does not pick up the settings.</>}</p>
        <button className="button small" onClick={() => { void navigator.clipboard.writeText(snippet).then(() => setCopied(true), () => setSetupError('Copy failed. Select and copy the configuration below.')); }}>{copied ? 'Copied' : 'Copy hook configuration'}</button><pre className="agents-config" tabIndex={0}>{snippet}</pre>
      </details>}
      <div className="inspector-actions"><button className="button" disabled={checking} onClick={() => setRevision(value => value + 1)}>{checking ? 'Checking…' : 'Check again'}</button><button className="button" onClick={onClose}>Done</button></div>
    </section>
  </div>;
}
