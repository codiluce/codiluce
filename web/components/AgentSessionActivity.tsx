'use client';
import { useState } from 'react';
import type { ActivityEvent, ActivityPath, ActivitySnapshot } from '@engine/activity/model';
import { ACTIVITY_TRAIL_MS } from '@engine/activity/model';
import { activeSessionFiles, agentColor } from '../lib/activity';
import { useAtlas, useStore } from './context';
import { AgentDots } from './AgentDots';

export function SessionActivity({ id }: { id: string }) {
  const agents = useAtlas(state => state.agents), store = useStore();
  const sessions = agents.snapshot?.sessions.filter(session => `${session.provider}:${session.sessionId}` === id && ['running', 'waiting'].includes(session.status) && agents.now - session.lastSeen <= 300_000) ?? [];
  const update = agents.live?.find(session => session.id === id)?.update;
  const files = activeSessionFiles(agents.snapshot, agents.now, id);
  const latest = [...agents.snapshot?.events ?? []].reverse().find(event => `${event.provider}:${event.sessionId}` === id);
  if (!sessions.length) return null;
  return <div className="session-current-activity">
    <div className="rf-loading session-live-update" role="status" aria-label="Current agent update"><AgentDots /><p>{update?.text ?? latest?.label ?? 'Waiting for a public progress update…'}</p></div>
    {files.length > 0 && <div className="session-current-files" aria-label="Current agent files"><small>Observed files and folders · {files.length}</small>{files.slice(0, 6).map(entry => <SessionFile key={`${entry.event.paths[entry.index]!.scope}:${entry.event.paths[entry.index]!.path}`} event={entry.event} index={entry.index} />)}{files.length > 6 && <small>+{files.length - 6} more in session activity</small>}</div>}
    <button className="button small" aria-pressed={sessions.some(session => session.actor === agents.focus)} onClick={() => store.setActivity({ focus: sessions.some(session => session.actor === agents.focus) ? undefined : sessions[0]!.actor })}>Focus map activity</button>
  </div>;
}

function SessionFile({ event, index }: { event: ActivityEvent; index: number }) {
  const store = useStore(), [pending, setPending] = useState(false), [error, setError] = useState('');
  const target = event.paths[index]!;
  const historical = useAtlas(state => state.meta?.snapshot.kind === 'commit' || state.timeline.preview !== undefined);
  return <span className="session-file"><button className="button link mono" disabled={pending || historical || !target.id && target.scope !== 'file'} onClick={() => {
    setPending(true); setError('');
    void revealObservedPath(store, event, index).catch(error => setError(error instanceof Error ? error.message : String(error))).finally(() => setPending(false));
  }}>{target.path}{target.scope === 'directory' && target.path !== '.' ? '/' : ''}</button>{error && <small className="error" role="alert">{error}</small>}</span>;
}

async function revealObservedPath(store: ReturnType<typeof useStore>, event: ActivityEvent, index: number) {
  let path = event.paths[index]!;
  if (path.scope === 'file') {
    const response = await fetch('/api/agents/reveal', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Codiluce-Request': 'activity' }, body: JSON.stringify({ eventId: event.id, index }) });
    const data = await response.json() as { path: ActivityPath; refreshed: boolean; snapshot: ActivitySnapshot; error?: string };
    if (!response.ok) throw new Error(data.error ?? 'Could not reveal this file');
    path = data.path; store.setActivity({ snapshot: data.snapshot, now: Date.now() });
    if (data.refreshed) await store.reload();
  }
  if (!path.id) throw new Error('This path is not available on the map.');
  store.expandAgents(false); store.setCenter('map'); await store.select(path.id, { fly: true });
  const node = store.getState().selection?.node;
  if (node?.hidden) await store.revealOnMap(node);
}

/** Operational details are available inside a conversation, collapsed by default. */
export function ObservedActivity({ events }: { events: ActivityEvent[] }) {
  const store = useStore(), agents = useAtlas(state => state.agents);
  const historical = useAtlas(state => state.meta?.snapshot.kind === 'commit' || state.timeline.preview !== undefined);
  const [pendingPath, setPendingPath] = useState<string>();
  const [pathError, setPathError] = useState<string>();
  const select = async (event: ActivityEvent, index: number) => {
    const target = event.paths[index]; if (!target || historical || pendingPath) return;
    setPendingPath(target.path); setPathError(undefined);
    try {
      await revealObservedPath(store, event, index);
    } catch (error) { setPathError(error instanceof Error ? error.message : 'Could not reveal this file'); }
    finally { setPendingPath(undefined); }
  };
  if (!events.length) return null;
  return <details className="agents-observed"><summary>Observed tool activity · {events.length}</summary>
    {pendingPath && <p className="note" role="status">Revealing {pendingPath}…</p>}
    {pathError && <p className="note error" role="alert">{pathError}</p>}
    <ol className="activity-feed">{events.slice(0, 80).map(event => <li key={event.id} className={agents.now - event.at < ACTIVITY_TRAIL_MS ? 'recent' : ''}>
      <div className="activity-event-head"><span className="domain-dot" style={{ background: agentColor(event.actor) }} /><strong>{event.label}</strong><span className="absent">{event.phase === 'status' ? event.status : event.phase}</span><time dateTime={new Date(event.at).toISOString()}>{Math.max(0, Math.floor((agents.now - event.at) / 1000))}s</time></div>
      {event.query && <p className="activity-query">Search: <code>{event.query}</code></p>}
      {event.paths.map((target, index) => <button key={`${target.path}:${index}`} className="activity-path mono" disabled={!!pendingPath || historical || !target.id && target.scope !== 'file'} onClick={() => void select(event, index)} title="Reveal this path on the map">{target.path}{target.scope === 'directory' && target.path !== '.' ? '/' : ''}{target.exact === false && <span className="absent">{target.scope === 'file' ? ' · reveal file' : ' · nearest folder'}</span>}</button>)}
    </li>)}</ol>
  </details>;
}
