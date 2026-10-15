'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HttpAtlasApi } from '../lib/api';
import { HttpExplanationsApi } from '../lib/explanations';
import { agentLabel } from '@engine/explanations/model';
import { shortSha, relativeTime } from '../lib/format';
import { AtlasStore, workingAgents } from '../lib/store';
import { themeById, UI_PROPERTIES } from '../lib/themes';
import { Breadcrumbs } from './Breadcrumbs';
import { CodeView } from './CodeView';
import { ColorBy } from './ColorBy';
import { AtlasContext, useAtlas, useStore } from './context';
import { EclipseMark } from './EclipseMark';
import { ExplanationsPanel } from './ExplanationsPanel';
import { FeaturesPanel } from './FeaturesPanel';
import { FlowsPanel } from './FlowsPanel';
import { PeoplePanel } from './PeoplePanel';
import { PullsPanel } from './PullsPanel';
import { Inspector } from './Inspector';
import { MapVisibilityUI } from './MapVisibility';
import { SettingsDialog } from './SettingsDialog';
import { SearchBox } from './SearchBox';
import { Timeline } from './Timeline';
import { Workbench } from './Workbench';
import { ArchetypeLegend } from './ArchetypeMark';

function createStore(): AtlasStore {
  const storage = (() => { try { return window.localStorage; } catch { return undefined; } })();
  return new AtlasStore(new HttpAtlasApi(''), {
    storage, explanations: new HttpExplanationsApi(''),
    location: { get hash() { return window.location.hash; }, replace: hash => history.replaceState(null, '', hash === '#' ? window.location.pathname + window.location.search : hash) },
  });
}
export function AtlasApp() {
  const [store, setStore] = useState<AtlasStore | null>(null);
  useEffect(() => {
    const instance = createStore();
    setStore(instance);
    void instance.init();
    instance.startPolling();
    // Back on the page: what an agent did meanwhile shows at once (hidden pages have their timers slowed).
    const shown = () => { if (document.visibilityState === 'visible') void instance.refreshActivity(); };
    document.addEventListener('visibilitychange', shown);
    return () => { document.removeEventListener('visibilitychange', shown); instance.dispose(); };
  }, []);
  if (!store) return null;
  return (
    <AtlasContext.Provider value={store}>
      <Shell />
    </AtlasContext.Provider>
  );
}
function usePanelWidth(key: string, initial: number): [number, (width: number) => void] {
  const [width, setWidth] = useState(initial);
  useEffect(() => { try { const saved = Number(localStorage.getItem(key)); if (saved >= 240 && saved <= 720) setWidth(saved); } catch { /* optional */ } }, [key]);
  return [width, (next: number) => { const clamped = Math.max(240, Math.min(720, next)); setWidth(clamped); try { localStorage.setItem(key, String(clamped)); } catch { /* optional */ } }];
}
const CODE_SHARE_KEY = 'codiluce:code-share';
/** The code panel's width: 30% of the window at first, then the share it was resized to (18–60%), following the window as it resizes. */
function useCodeWidth(): [number, (width: number) => void] {
  const [share, setShare] = useState(() => { try { const saved = Number(localStorage.getItem(CODE_SHARE_KEY)); if (saved >= 0.18 && saved <= 0.6) return saved; } catch { /* optional */ } return 0.3; });
  const [viewport, setViewport] = useState(() => window.innerWidth);
  useEffect(() => { const onResize = () => setViewport(window.innerWidth); window.addEventListener('resize', onResize); return () => window.removeEventListener('resize', onResize); }, []);
  return [Math.max(280, Math.round(share * viewport)), (next: number) => {
    const value = Math.max(0.18, Math.min(0.6, next / window.innerWidth));
    setShare(value); try { localStorage.setItem(CODE_SHARE_KEY, value.toFixed(4)); } catch { /* optional */ }
  }];
}
function ResizeHandle({ side, width, onResize, label }: { side: 'left' | 'right'; width: number; onResize: (width: number) => void; label: string }) {
  const start = useRef<{ x: number; width: number } | null>(null);
  return (
    <div
      className="resize-handle" style={side === 'right' ? { left: -3 } : { right: -3 }} role="separator" aria-orientation="vertical" aria-label={label} aria-valuenow={width} tabIndex={0}
      onPointerDown={event => { start.current = { x: event.clientX, width }; (event.target as HTMLElement).setPointerCapture(event.pointerId); }}
      onPointerMove={event => { if (start.current) onResize(start.current.width + (side === 'right' ? start.current.x - event.clientX : event.clientX - start.current.x)); }}
      onPointerUp={() => { start.current = null; }}
      onKeyDown={event => { if (event.key === 'ArrowLeft') onResize(width + (side === 'right' ? 24 : -24)); if (event.key === 'ArrowRight') onResize(width + (side === 'right' ? -24 : 24)); }}
    />
  );
}
function Shell() {
  const store = useStore();
  const themeId = useAtlas(state => state.themeId);
  const meta = useAtlas(state => state.meta);
  const history = useAtlas(state => state.history);
  const timelineOpen = useAtlas(state => state.timeline.open);
  const timeline = useAtlas(state => state.timeline.data);
  const theme = themeById(themeId);
  const [inspectorWidth, setInspectorWidth] = usePanelWidth('codiluce:inspector-width', 380);
  const [flowWidth, setFlowWidth] = usePanelWidth('codiluce:flow-width', 300);
  const [codeWidth, setCodeWidth] = useCodeWidth();
  const [explainWidth, setExplainWidth] = usePanelWidth('codiluce:explain-width', 400);
  const explainOpen = useAtlas(state => state.explain.open);
  const unseen = useAtlas(state => state.explain.unseen.length);
  // An agent connected over MCP is working on an explanation: the button says so before anything is saved.
  const working = useAtlas(state => { const agents = workingAgents(state.explain); return agents.length === 1 ? agentLabel(agents[0]!.agent) : agents.length ? `${agents.length} agents` : ''; });
  const explanations = useAtlas(state => state.explain.list.data?.items.length ?? 0);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [leftOpen, setLeftOpen] = useState(false);
  // The left panel holds the features (once described), every flow (pages, requests, console), the people who changed the code and the pull requests.
  const [leftTab, setLeftTab] = useState<LeftTab>('flows');
  const reveal = useAtlas(state => state.catalog.reveal);
  useEffect(() => { if (reveal) { setLeftOpen(true); setLeftTab('flows'); } }, [reveal]);
  const featureReveal = useAtlas(state => state.features.reveal);
  useEffect(() => { if (featureReveal) { setLeftOpen(true); setLeftTab('features'); } }, [featureReveal]);
  const peopleReveal = useAtlas(state => state.people.reveal);
  useEffect(() => { if (peopleReveal) { setLeftOpen(true); setLeftTab('people'); } }, [peopleReveal]);
  const pullsReveal = useAtlas(state => state.pulls.reveal);
  useEffect(() => { if (pullsReveal) { setLeftOpen(true); setLeftTab('pulls'); } }, [pullsReveal]);
  const features = useAtlas(state => state.annotations.data?.domains.length ?? 0);
  // Comparing in History: one view per place that changed, around an overview (unless the single map is chosen).
  const split = useAtlas(state => state.timeline.open && state.timeline.compare && state.timeline.split && (!!state.meta?.comparison || state.timeline.preview !== undefined));
  const showLeft = (tab: LeftTab) => { if (leftOpen && leftTab === tab) setLeftOpen(false); else { setLeftOpen(true); setLeftTab(tab); } };
  const tabs = [...(features > 0 ? ['features' as const] : []), 'flows' as const, 'people' as const, 'pulls' as const];
  const impactOpen = useAtlas(state => state.impact.open && state.center === 'impact');
  const codeOpen = useAtlas(state => !!state.code);
  const [help, setHelp] = useState(false);
  const [settings, setSettings] = useState(false);
  const closeSettings = useCallback(() => setSettings(false), []);
  // Floating themes paint a backdrop behind panels held apart by the theme's gap; the others dock panels on a flat background.
  const style = useMemo(() => ({ ...theme.ui, background: theme.style?.floating ? theme.ui['--app-bg'] ?? theme.ui['--bg'] : theme.ui['--bg'] }) as React.CSSProperties, [theme]);
  useEffect(() => {
    // Clear what the previous theme set and this one does not (a font, radii, a backdrop).
    for (const key of UI_PROPERTIES) { const value = theme.ui[key]; if (value === undefined) document.body.style.removeProperty(key); else document.body.style.setProperty(key, value); }
    document.documentElement.style.colorScheme = theme.dark ? 'dark' : 'light';
  }, [theme]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); void store.back(); }
      if (event.altKey && event.key === 'ArrowRight') { event.preventDefault(); void store.forward(); }
      const target = event.target as HTMLElement;
      if (store.getState().timeline.open && !event.altKey && !event.ctrlKey && !event.metaKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) {
        if (event.key === '[') { event.preventDefault(); void store.stepTarget(-1); }
        if (event.key === ']') { event.preventDefault(); void store.stepTarget(1); }
        // Space plays the time-lapse from the map or the page (focused controls keep their own Space).
        if (event.key === ' ' && ['BODY', 'CANVAS', 'MAIN'].includes(target.tagName)) { event.preventDefault(); store.togglePlay(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store]);
  const run = meta?.run;
  const snapshot = meta?.snapshot, baseline = meta?.comparison?.baseline;
  const when = (iso: string | undefined) => iso ? new Date(iso).toLocaleDateString() : '';
  const commitDate = (sha: string | undefined) => when(timeline?.entries.find(entry => entry.sha === sha)?.authoredAt);
  return (
    <div className="codiluce" style={style} data-theme={theme.id} data-dark={String(theme.dark)} data-floating={String(!!theme.style?.floating)}>
      <header className="topbar">
        <div className="brand">
          <EclipseMark />
          <div className="brand-words">
            <strong>Codiluce</strong>
            <small>Bring your code to light</small>
          </div>
        </div>
        {run && (
          <div className="run-info" title={snapshot?.kind === 'commit' ? `Snapshot ${snapshot.id}` : `Analysis run ${run.id}`}>
            <span>{run.repositoryName}</span>
            {snapshot?.kind === 'commit'
              ? <small>commit {shortSha(snapshot.commitSha)} ({commitDate(snapshot.commitSha)}){baseline ? ` compared with ${baseline.kind === 'commit' ? shortSha(baseline.commitSha) : 'the working tree'}` : ''}</small>
              : <small>working tree{run.commitSha ? ` at HEAD ${shortSha(run.commitSha)}` : ''}{run.dirty ? ' + uncommitted changes' : ''} · indexed {relativeTime(run.analyzedAt)}{baseline ? ` · compared with ${shortSha(baseline.commitSha)}` : ''}</small>}
          </div>
        )}
        <SearchBox />
        <div className="top-actions">
          <div className="top-action-group" role="group" aria-label="Selection navigation">
            <button className="icon-button" onClick={() => void store.back()} disabled={history.index <= 0} aria-label="Back to previous selection" title="Back (Alt+←)">←</button>
            <button className="icon-button" onClick={() => void store.forward()} disabled={history.index >= history.entries.length - 1} aria-label="Forward" title="Forward (Alt+→)">→</button>
          </div>
          <div className="top-action-group" role="group" aria-label="Timeline" title="Opens the history timeline below the map">
            <button className="button" onClick={() => void (timelineOpen ? store.closeTimeline() : store.openTimeline())} aria-pressed={timelineOpen} title={meta?.history.available ? `Browse ${meta.history.snapshots} indexed commits` : 'No history indexed yet'}>History</button>
          </div>
          <div className="top-action-group" role="group" aria-label="Sidebar panels" title="Opens in the left sidebar">
            {features > 0 && <button className="button" onClick={() => showLeft('features')} aria-pressed={leftOpen && leftTab === 'features'} aria-controls="left-panel" title={`The ${features} features of the product, as the model described them: select one to light its files and see its flows`}>Features</button>}
            <button className="button" onClick={() => showLeft('flows')} aria-pressed={leftOpen && leftTab === 'flows'} aria-controls="left-panel" title="Flows by CLI, HTTP, UI, MCP and worker entry points, with source scope and evidence coverage">Flows</button>
            <button className="button" onClick={() => showLeft('people')} aria-pressed={leftOpen && leftTab === 'people'} aria-controls="left-panel" title="Who changed which code, from the Git history: select a person to light the files they changed">People</button>
            <button className="button" onClick={() => showLeft('pulls')} aria-pressed={leftOpen && leftTab === 'pulls'} aria-controls="left-panel" title="Pull requests, open and merged: select one to light the files it changes">PRs</button>
          </div>
          <div className="top-action-group" role="group" aria-label="Center tools" title="Opens in a center tab">
            <button className="button" onClick={() => impactOpen ? store.setCenter('map') : void store.openImpactTool()} aria-pressed={impactOpen} title="What depends on the selection, or on your uncommitted changes, hop by hop">Impact</button>
          </div>
          <div className="top-action-group" role="group" aria-label="Additional columns" title="Opens an additional column beside the map">
            <button className={`button explain-top${working ? ' working' : ''}`} onClick={() => store.toggleExplanations()} aria-pressed={explainOpen} aria-controls="explain-panel" title={`${working ? `${working} ${working.endsWith(' agents') ? 'are' : 'is'} working on an explanation. ` : ''}Explanations: ask about the code, or read what your agent explained (${explanations} saved); their links light the code on the map`}>Explain{working && <span className="agent-pulse" role="status" aria-label={`${working} working`} />}{unseen > 0 && <span className="badge" aria-label={`${unseen} new`}>{unseen}</span>}</button>
            <button className="button" onClick={() => codeOpen ? store.closeCode() : store.openCode()} aria-pressed={codeOpen} title="The code of the selection beside the inspector: a file, or a symbol in its file, with the file's outline">Code</button>
          </div>
          <div className="top-action-group" role="group" aria-label="Map overlays" title="Changes the colors on the map">
            <ColorBy />
          </div>
          <div className="top-action-group" role="group" aria-label="Settings and help">
            <button className="icon-button" onClick={() => setSettings(open => !open)} aria-expanded={settings} aria-label="Settings" title="Settings">⚙</button>
            <button className="icon-button" onClick={() => setHelp(open => !open)} aria-expanded={help} aria-label="Keyboard shortcuts">?</button>
          </div>
        </div>
      </header>
      <Breadcrumbs />
      <main className={`workspace${codeOpen ? ' with-code' : ''}${explainOpen ? ' with-explain' : ''}`}>
        {leftOpen ? (
          <aside id="left-panel" className="panel left" style={{ width: Math.max(flowWidth, 340) }} aria-label={TAB_TEXT[leftTab]}>
            {tabs.length > 1 && (
              <div className="segmented panel-tabs" role="tablist" aria-label="Left panel">
                {tabs.map(tab => <button key={tab} role="tab" aria-selected={leftTab === tab} aria-pressed={leftTab === tab} onClick={() => setLeftTab(tab)}>{TAB_TEXT[tab]}</button>)}
              </div>
            )}
            {leftTab === 'features' && features > 0 ? <FeaturesPanel onClose={() => setLeftOpen(false)} />
              : leftTab === 'people' ? <PeoplePanel onClose={() => setLeftOpen(false)} />
              : leftTab === 'pulls' ? <PullsPanel onClose={() => setLeftOpen(false)} />
              : <FlowsPanel onClose={() => setLeftOpen(false)} />}
            <ResizeHandle side="left" width={flowWidth} onResize={setFlowWidth} label="Resize the left panel" />
          </aside>
        ) : <div />}
        {explainOpen && (
          <aside id="explain-panel" className="panel left explain-panel" style={{ width: explainWidth }} aria-label="Explanations">
            <ExplanationsPanel onClose={() => store.closeExplanations()} />
            <ResizeHandle side="left" width={explainWidth} onResize={setExplainWidth} label="Resize the explanations" />
          </aside>
        )}
        <Workbench split={split} />
        {codeOpen && (
          <aside className="panel code-panel" style={{ width: codeWidth }} aria-label="Code">
            <ResizeHandle side="right" width={codeWidth} onResize={setCodeWidth} label="Resize the code panel" />
            <CodeView />
          </aside>
        )}
        {inspectorOpen ? (
          <aside className="panel" style={{ width: inspectorWidth }} aria-label="Inspector">
            <ResizeHandle side="right" width={inspectorWidth} onResize={setInspectorWidth} label="Resize inspector" />
            <Inspector onClose={() => setInspectorOpen(false)} />
          </aside>
        ) : <button className="panel-collapsed right" onClick={() => setInspectorOpen(true)}>Inspector</button>}
      </main>
      {timelineOpen && <Timeline />}
      {help && <HelpDialog onClose={() => setHelp(false)} />}
      {settings && <SettingsDialog onClose={closeSettings} />}
      <MapVisibilityUI />
    </div>
  );
}
type LeftTab = 'features' | 'flows' | 'people' | 'pulls';
const TAB_TEXT: Record<LeftTab, string> = { features: 'Features', flows: 'Flows', people: 'People', pulls: 'PRs' };
function HelpDialog({ onClose }: { onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => { close.current?.focus(); const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, [onClose]);
  const rows: [string, string][] = [
    ['/', 'Search entities'], ['↑ ↓ Enter', 'Choose a search result'], ['Drag · wheel · pinch', 'Pan and zoom the map'],
    ['Arrow keys · + −', 'Pan and zoom (map focused)'], ['F', 'Fit the whole repository'], ['Enter', 'Zoom to the selection'],
    ['Double-click', 'Zoom into an area'], ['Esc', 'Clear selection / close'], ['Backspace · Alt+←', 'Previous selection'], ['Alt+→', 'Next selection'],
    ['[ ]', 'Previous / next indexed commit (History open)'], ['Space', 'Play / pause the history time-lapse (History open)'], ['Shift + ← →', 'Move the comparison baseline (timeline focused)'], ['Page Up · Page Down', 'Previous / next views of the split map (History, Compare)'],
  ];
  return (
    <div className="center-state" style={{ pointerEvents: 'auto', background: 'rgba(0,0,0,0.35)', zIndex: 30 }} onClick={onClose}>
      <div className="card" role="dialog" aria-modal="true" aria-labelledby="help-title" onClick={event => event.stopPropagation()} style={{ textAlign: 'left', maxHeight: 'calc(100vh - 120px)', overflowY: 'auto' }}>
        <h2 id="help-title" style={{ marginTop: 0, fontSize: 15 }}>Keyboard and pointer</h2>
        <dl className="facts">{rows.map(([key, text]) => [<dt key={`k${key}`}><kbd>{key}</kbd></dt>, <dd key={`d${key}`}>{text}</dd>])}</dl>
        <p className="note">The map is a projection of the indexed graph: positions come from a deterministic layout. Hiding or restoring paths repacks the map to reclaim space; selection and search keep positions stable. In History, every commit is laid out against one shared slot registry, so areas stay put while you move through time; removed entities remain as translucent ghosts when comparing. Dragging the timeline or pressing play shows each commit at once as a time-lapse; the full view of a commit loads when you let go or pause. When comparing, the split map shows one view on each place that changed around an overview of the whole repository, where numbered frames show what each view shows. Flows, steps, a blast radius (<strong>Impact</strong>, also of your uncommitted changes), and the files a highlight lights open in the middle of the screen as tabs beside <strong>Map</strong>; the map then stays in a corner as an overview of what they light, and a click on it brings it back. Search results offer the same: a flow on the map or in lanes, what happens from it, its impact (<kbd>Tab</kbd> reaches them). <strong>Code</strong> opens the code of the selection in a panel beside the inspector (drag its edge to resize it) and follows what you select; selecting a file, folder or symbol keeps what it is connected to lit and lets the rest of the map recede. <strong>Features</strong> (once the code is described) lists what the product does: selecting a feature lights its files on the map, with the flows that start in it; a folder's inspector shows which data families its files belong to. <strong>People</strong> lists who changed the code, from the Git history (authors and co-authors, agents and bots told apart), in a window of time ending at the commit shown: selecting a person lights the files they changed, and every inspector says who changed its selection and when. <strong>PRs</strong> lists pull requests: open work (branches not merged yet, and with <code>--pr-metadata github</code> the open pull requests on GitHub) and what was merged into the branch in the same window. Selecting one lights the files it changes, with its commits, people and blast radius; every inspector lists the open pull requests changing its selection.</p>

        <h2 style={{ fontSize: 15 }}>Building shapes</h2>
        <p className="note">Each kind of block has a shape, the same in every language and framework. It comes from the index where it can (a controller class, endpoints declared in a file, a page route) and from folder and name conventions otherwise; the inspector says which. Small blocks show it as a mark on their roof, and a closed folder shows the kinds it holds most, each with its count (its inspector lists them all). Blocks stand a little inside their places, so streets run between them. Settings turns shapes and streets off.</p>
        <ArchetypeLegend />
        <button ref={close} className="button" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
