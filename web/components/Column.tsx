'use client';
// The left of the screen: the rail picks what the column shows, one view at a
// time (the selection, its code, its impact, flows, dependencies, people, pull
// requests, explanations, agents), with Settings and Help at its foot. The map
// draws what the view lights (a blast radius, dependencies); a click on the map
// selects without moving the column. The column hides from its rail item and
// is resized by its edge, one width for every view.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { agentLabel } from '@engine/explanations/model';
import { workingAgents, type ColumnView } from '../lib/store';
import { useAtlas, useStore } from './context';
import { AgentDots } from './AgentDots';
import { AgentsPanel } from './AgentsPanel';
import { CodeView } from './CodeView';
import { DependenciesView } from './Dependencies';
import { ExplanationsPanel } from './ExplanationsPanel';
import { FeaturesPanel } from './FeaturesPanel';
import { FlowsPanel } from './FlowsPanel';
import { ImpactView } from './ImpactView';
import { EvidenceView, Inspector } from './Inspector';
import { HelpMenu } from './Onboarding';
import { PeoplePanel } from './PeoplePanel';
import { PullsPanel } from './PullsPanel';

/** The column's name for each view (its landmark label). */
export const VIEW_LABEL: Record<ColumnView, string> = {
  selection: 'Inspector', code: 'Code', impact: 'Impact', features: 'Features', flows: 'Flows', dependencies: 'Dependencies',
  people: 'People', pulls: 'PRs', explain: 'Explanations', agents: 'Agents',
};
const WIDTH_KEY = 'codiluce:column-width', WIDTH = 400, MIN = 280, MAX = 760;

/** The rail, in the order a selection is looked at: itself, its code and impact, then the lists, then the conversations. */
export function Rail({ onKeyboard }: { onKeyboard: () => void }) {
  const store = useStore();
  const panels = useAtlas(state => state.panels);
  const features = useAtlas(state => (state.annotations.data?.domains.length ?? 0) > 0);
  const selected = useAtlas(state => !!state.selection);
  const unseen = useAtlas(state => state.explain.unseen.length);
  const explanations = useAtlas(state => state.explain.list.data?.items.length ?? 0);
  // An agent connected over MCP is working on an explanation: Explain says so before anything is saved.
  const working = useAtlas(state => { const agents = workingAgents(state.explain); return agents.length === 1 ? agentLabel(agents[0]!.agent) : agents.length ? `${agents.length} agents` : ''; });
  const running = useAtlas(state => state.agents.connected && state.agents.snapshot?.enabled
    ? state.agents.snapshot.sessions.filter(session => session.status === 'running' && state.agents.now - session.lastSeen <= 300_000).length : 0);
  const settings = panels.settings;
  const item = (view: ColumnView, label: string, title: string, icon: ReactNode, extra?: ReactNode, onboarding?: string) => (
    <button
      key={view} className={`rail-item${view === 'explain' && working ? ' working' : ''}${view === 'agents' && running ? ' has-running' : ''}`}
      aria-label={label} aria-pressed={panels.column && panels.view === view} aria-controls="column" data-current={panels.view === view || undefined}
      title={title} data-onboarding={onboarding} onClick={() => store.toggleView(view)}
    >
      <span className="rail-icon" aria-hidden>{icon}</span><span className="rail-label" aria-hidden>{label}</span>{extra}
    </button>
  );
  return (
    <nav className="rail" aria-label="Views">
      {item('selection', 'Selection', selected ? 'The inspector: what is selected' : 'The inspector: the repository, until something is selected', ICONS.selection)}
      {item('code', 'Code', 'The code of the selection: a file, or a symbol in its file with its outline; it follows what you select', ICONS.code, undefined, 'code')}
      {item('impact', 'Impact', 'What depends on the selection, or on your uncommitted changes, hop by hop (colored on the map while shown)', ICONS.impact, undefined, 'impact')}
      {features && item('features', 'Features', 'The features of the product, as the model described them: select one to light its files and see its flows', ICONS.features, undefined, 'features')}
      {item('flows', 'Flows', 'Flows by CLI, HTTP, UI, MCP and worker entry points, with source scope and evidence coverage', ICONS.flows, undefined, 'flows')}
      {item('dependencies', 'Dependencies', 'What the selection uses and what uses it (calls, requests, imports…), drawn on the map as labeled rails to each file while shown', ICONS.dependencies, undefined, 'dependencies')}
      {item('people', 'People', 'Who changed which code, from the Git history: select a person to light the files they changed', ICONS.people, undefined, 'people')}
      {item('pulls', 'PRs', 'Pull requests, open and merged: select one to light the files it changes', ICONS.pulls, undefined, 'pulls')}
      {item('explain', 'Explain', `${working ? `${working} ${working.endsWith(' agents') ? 'are' : 'is'} working on an explanation. ` : ''}Explanations: ask about the code, or read what your agent explained (${explanations} saved); their links light the code on the map`, ICONS.explain,
        <>{working && <span className="agent-pulse" role="status" aria-label={`${working} working`} />}{unseen > 0 && <span className="badge" aria-label={`${unseen} new`}>{unseen}</span>}</>, 'explain')}
      {item('agents', 'Agents', `${running ? `${running} agent${running === 1 ? '' : 's'} running · ` : ''}Live and searchable agent sessions`, running > 0 ? <AgentDots /> : ICONS.agents,
        running > 0 && <span className="badge" aria-label={`${running} agent${running === 1 ? '' : 's'} running`}>{running}</span>, 'agents')}
      <span className="rail-spacer" />
      <button className="rail-item" aria-label="Settings" aria-expanded={settings} title="Settings" data-onboarding="settings" onClick={() => store.setPanels({ settings: !settings })}>
        <span className="rail-icon" aria-hidden>{ICONS.settings}</span><span className="rail-label" aria-hidden>Settings</span>
      </button>
      <HelpMenu onKeyboard={onKeyboard} rail={<><span className="rail-icon" aria-hidden>{ICONS.help}</span><span className="rail-label" aria-hidden>Help</span></>} />
    </nav>
  );
}

/** The column: the view the rail picked, at the width it was given (one for every view). */
export function Column() {
  const store = useStore();
  const panels = useAtlas(state => state.panels);
  const expanded = useAtlas(state => !!state.journal.expanded);
  const evidence = useAtlas(state => !!state.evidence);
  const [width, setWidth] = useColumnWidth();
  if (!panels.column) return null;
  const view = panels.view, hide = () => store.setPanels({ column: false });
  return (
    <aside
      id="column" className={`panel left column${view === 'agents' ? ' agents-host' : ''}${view === 'explain' ? ' explain-panel' : ''}`}
      style={{ width }} aria-label={VIEW_LABEL[view]} data-view={view} data-onboarding={view === 'selection' ? 'inspector' : undefined}
    >
      {view === 'selection' ? <Inspector onClose={hide} />
        : view === 'code' ? <CodeView />
        : view === 'impact' ? <div className="column-tool"><ImpactView /></div>
        : view === 'features' ? <FeaturesPanel onClose={hide} />
        : view === 'flows' ? <FlowsPanel onClose={hide} />
        : view === 'dependencies' ? <DependenciesView onClose={hide} />
        : view === 'people' ? <PeoplePanel onClose={hide} />
        : view === 'pulls' ? <PullsPanel onClose={hide} />
        : view === 'explain' ? <ExplanationsPanel onClose={hide} />
        : <AgentsPanel onClose={hide} />}
      {evidence && <EvidenceView />}
      {!(view === 'agents' && expanded) && <ResizeHandle width={width} onResize={setWidth} label="Resize the column" />}
    </aside>
  );
}
function useColumnWidth(): [number, (width: number) => void] {
  const [width, setWidth] = useState(WIDTH);
  useEffect(() => { try { const saved = Number(localStorage.getItem(WIDTH_KEY)); if (saved >= MIN && saved <= MAX) setWidth(saved); } catch { /* optional */ } }, []);
  return [width, (next: number) => {
    const clamped = Math.round(Math.max(MIN, Math.min(MAX, next, window.innerWidth - 200)));
    setWidth(clamped); try { localStorage.setItem(WIDTH_KEY, String(clamped)); } catch { /* optional */ }
  }];
}
/** The column's right edge: drag it, or use the arrow keys; a double click gives the usual width back. */
function ResizeHandle({ width, onResize, label }: { width: number; onResize: (width: number) => void; label: string }) {
  const start = useRef<{ x: number; width: number } | null>(null);
  return (
    <div
      className="resize-handle" style={{ right: -3 }} role="separator" aria-orientation="vertical" aria-label={label} aria-valuenow={width} aria-valuemin={MIN} aria-valuemax={MAX} tabIndex={0}
      onPointerDown={event => { start.current = { x: event.clientX, width }; (event.target as HTMLElement).setPointerCapture(event.pointerId); }}
      onPointerMove={event => { if (start.current) onResize(start.current.width + event.clientX - start.current.x); }}
      onPointerUp={() => { start.current = null; }}
      onDoubleClick={() => onResize(WIDTH)}
      onKeyDown={event => { if (event.key === 'ArrowLeft') onResize(width - 24); if (event.key === 'ArrowRight') onResize(width + 24); }}
    />
  );
}

const svg = (children: ReactNode) => <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{children}</svg>;
const ICONS = {
  selection: svg(<><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M9 4v16" /><path d="M12.5 9h5M12.5 12.5h5M12.5 16h3" /></>),
  code: svg(<><path d="m8.5 7-5 5 5 5" /><path d="m15.5 7 5 5-5 5" /></>),
  impact: svg(<><circle cx="12" cy="12" r="2.2" /><circle cx="12" cy="12" r="5.8" /><path d="M3.6 9.5a9 9 0 0 0 0 5M20.4 9.5a9 9 0 0 1 0 5M9.5 3.6a9 9 0 0 1 5 0M9.5 20.4a9 9 0 0 0 5 0" /></>),
  features: svg(<><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" /></>),
  flows: svg(<><circle cx="5" cy="6" r="2" /><circle cx="19" cy="18" r="2" /><path d="M7 6h8.5a3 3 0 0 1 0 6h-7a3 3 0 0 0 0 6H17" /></>),
  dependencies: svg(<><circle cx="12" cy="4.5" r="2" /><circle cx="5" cy="19" r="2" /><circle cx="19" cy="19" r="2" /><path d="M12 6.5V11m0 0-5.6 6.4M12 11l5.6 6.4" /></>),
  people: svg(<><circle cx="9" cy="8" r="3.2" /><path d="M3 20a6 6 0 0 1 12 0" /><circle cx="17" cy="9" r="2.5" /><path d="M16.3 14a5 5 0 0 1 4.7 6" /></>),
  pulls: svg(<><circle cx="6" cy="5.5" r="2" /><circle cx="6" cy="18.5" r="2" /><circle cx="18" cy="18.5" r="2" /><path d="M6 7.5v9" /><path d="M18 16.5V10a3 3 0 0 0-3-3h-4" /><path d="m13 4.5-2.5 2.5L13 9.5" /></>),
  explain: svg(<><path d="M11 3.5 12.9 9l5.6 1.9-5.6 1.9L11 18.3l-1.9-5.5-5.6-1.9L9.1 9z" /><path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" /></>),
  agents: svg(<><rect x="4" y="8" width="16" height="12" rx="3" /><path d="M12 4.5V8" /><circle cx="12" cy="3.5" r="1" /><circle cx="9" cy="14" r="1.1" /><circle cx="15" cy="14" r="1.1" /></>),
  settings: svg(<><circle cx="12" cy="12" r="3" /><path d="M12 2.5v2.6M12 18.9v2.6M2.5 12h2.6M18.9 12h2.6M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8" /></>),
  help: svg(<><circle cx="12" cy="12" r="9" /><path d="M9.6 9.3a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.7" /><path d="M12 17h.01" /></>),
} as const;
