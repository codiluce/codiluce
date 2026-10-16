'use client';
import { useEffect, useRef, useState } from 'react';
import type { ActivitySnapshot, AgentConnection, AgentProvider, AgentSetup } from '@engine/activity/model';
import { providerName } from '../lib/activity';
import { useAtlas, useStore } from './context';
import { AgentSessionsView } from './AgentSessionsView';
import type { LiveSession } from '@engine/conversations/model';

/** One connection for the map, independent of whether the panel is open. */
export function ActivityConnection() {
  const store = useStore();
  useEffect(() => {
    const controller = new AbortController(); let busy = false, checked = 0;
    const refresh = async () => {
      if (busy || document.visibilityState !== 'visible' || Date.now() - checked < 1500) return;
      if (!store.getState().agents.snapshot?.sessions.some(session => Date.now() - session.lastSeen <= 300_000)) { store.setActivity({ live: [] }); return; }
      busy = true; checked = Date.now();
      try {
        const response = await fetch('/api/conversations/live', { signal: controller.signal });
        if (response.ok) { const data = await response.json() as { items: LiveSession[] }; if (!controller.signal.aborted) store.setActivity({ live: data.items }); }
      } catch { /* The hook connection already reports server availability. */ }
      finally { busy = false; }
    };
    let source: EventSource | undefined;
    const connect = () => {
      if (document.visibilityState !== 'visible') { source?.close(); source = undefined; store.setActivity({ connected: false }); return; }
      if (source) return;
      const current = source = new EventSource('/api/agents/stream');
      current.onmessage = message => {
        if (source !== current) return;
        try { store.setActivity({ snapshot: JSON.parse(message.data) as ActivitySnapshot, connected: true, now: Date.now() }); void refresh(); } catch { /* wait for the next snapshot */ }
      };
      current.onerror = () => { if (source === current) store.setActivity({ connected: false }); };
      void refresh();
    };
    document.addEventListener('visibilitychange', connect); connect();
    const timer = setInterval(() => { const agents = store.getState().agents; if (agents.snapshot?.sessions.length) store.setActivity({ now: Date.now() }); }, 1000);
    const updates = setInterval(() => void refresh(), 3000);
    return () => { controller.abort(); source?.close(); source = undefined; document.removeEventListener('visibilitychange', connect); clearInterval(timer); clearInterval(updates); };
  }, [store]);
  return null;
}

export function AgentsPanel({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const agents = useAtlas(state => state.agents);
  const expanded = useAtlas(state => !!state.journal.expanded);
  const historical = useAtlas(state => state.meta?.snapshot.kind === 'commit' || state.timeline.preview !== undefined);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const snapshot = agents.snapshot;
  return <>
    <div className="panel-header"><h2>Agents</h2><div className="agents-panel-actions"><button className="button small" onClick={() => store.expandAgents(!expanded)} aria-label={expanded ? 'Dock Agents beside the map' : 'Expand Agents'}>{expanded ? 'Dock beside map' : 'Expand'}</button><button className="icon-button small" onClick={onClose} aria-label="Hide the agents panel">⇤</button></div></div>
    <div className="agents-toolbar">
      <div className="agents-status-row">
        <div className="agents-connection" role="status"><span className={`agents-live-dot${agents.connected && snapshot?.enabled ? ' on' : ''}`} />{agents.connected ? snapshot?.enabled ? 'Live activity' : 'Activity disabled' : 'Connecting to activity…'}</div>
        <details className="agents-info" onKeyDown={event => { if (event.key === 'Escape') event.currentTarget.open = false; }}>
          <summary aria-label="About agent activity" title="About agent activity">ⓘ</summary>
          <p className="note">Observed actions from Codex and Claude Code. Map badges fade after 30 seconds. Agent sessions refresh while recently observed sessions are active; messages may arrive after tool activity. Live activity confirms server updates; check Agent connections for hook configuration and delivery.</p>
        </details>
      </div>
      <label className="agents-toggle"><input type="checkbox" checked={agents.show} onChange={event => store.setActivity({ show: event.target.checked })} /> Show activity on the map</label>
      {historical && <p className="note">Activity belongs to the working tree. Return to the live map to see its badges.</p>}
    </div>
    <AgentSessionsView compact={!expanded} />
    <div className="agents-footer"><button className="button" onClick={() => setConnectionsOpen(true)} aria-haspopup="dialog">Agent connections<span aria-hidden="true">⚙</span></button></div>
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
