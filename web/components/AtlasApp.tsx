'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { HttpAtlasApi } from '../lib/api';
import { shortSha, relativeTime } from '../lib/format';
import { AtlasStore } from '../lib/store';
import { THEMES, themeById, UI_PROPERTIES } from '../lib/themes';
import { Breadcrumbs } from './Breadcrumbs';
import { AtlasContext, useAtlas, useStore } from './context';
import { EclipseMark } from './EclipseMark';
import { FeaturesPanel } from './FeaturesPanel';
import { FlowBar } from './FlowBar';
import { FlowsPanel } from './FlowsPanel';
import { PeoplePanel } from './PeoplePanel';
import { RequestFlowTheater } from './RequestFlows';
import { StepsPanel } from './StepsPanel';
import { Inspector } from './Inspector';
import { MapView } from './MapView';
import { SearchBox } from './SearchBox';
import { SourcePanel } from './SourcePanel';
import { SplitMap } from './SplitMap';
import { Timeline } from './Timeline';

function createStore(): AtlasStore {
  const storage = (() => { try { return window.localStorage; } catch { return undefined; } })();
  return new AtlasStore(new HttpAtlasApi(''), {
    storage,
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
    return () => instance.dispose();
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
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [leftOpen, setLeftOpen] = useState(false);
  // The left panel holds the features (once described), every flow (pages, requests, console), the people who changed the code and, once opened, Steps.
  const stepsAnchor = useAtlas(state => state.steps?.anchor);
  const [leftTab, setLeftTab] = useState<'features' | 'flows' | 'people' | 'steps'>('flows');
  useEffect(() => { if (stepsAnchor) { setLeftOpen(true); setLeftTab('steps'); } else setLeftTab(tab => tab === 'steps' ? 'flows' : tab); }, [stepsAnchor]);
  const reveal = useAtlas(state => state.catalog.reveal);
  useEffect(() => { if (reveal) { setLeftOpen(true); setLeftTab('flows'); } }, [reveal]);
  const featureReveal = useAtlas(state => state.features.reveal);
  useEffect(() => { if (featureReveal) { setLeftOpen(true); setLeftTab('features'); } }, [featureReveal]);
  const peopleReveal = useAtlas(state => state.people.reveal);
  useEffect(() => { if (peopleReveal) { setLeftOpen(true); setLeftTab('people'); } }, [peopleReveal]);
  const coverage = useAtlas(state => state.coverage.show);
  const features = useAtlas(state => state.annotations.data?.domains.length ?? 0);
  // Comparing in History: one view per place that changed, around an overview (unless the single map is chosen).
  const split = useAtlas(state => state.timeline.open && state.timeline.compare && state.timeline.split && (!!state.meta?.comparison || state.timeline.preview !== undefined));
  const showLeft = (tab: 'features' | 'flows' | 'people') => { if (leftOpen && leftTab === tab) setLeftOpen(false); else { setLeftOpen(true); setLeftTab(tab); } };
  const tabs = [...(features > 0 ? ['features' as const] : []), 'flows' as const, 'people' as const, ...(stepsAnchor ? ['steps' as const] : [])];
  const [help, setHelp] = useState(false);
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
          <button className="icon-button" onClick={() => void store.back()} disabled={history.index <= 0} aria-label="Back to previous selection" title="Back (Alt+←)">←</button>
          <button className="icon-button" onClick={() => void store.forward()} disabled={history.index >= history.entries.length - 1} aria-label="Forward" title="Forward (Alt+→)">→</button>
          <button className="button" onClick={() => void (timelineOpen ? store.closeTimeline() : store.openTimeline())} aria-pressed={timelineOpen} title={meta?.history.available ? `Browse ${meta.history.snapshots} indexed commits` : 'No history indexed yet'}>History</button>
          {features > 0 && <button className="button" onClick={() => showLeft('features')} aria-pressed={leftOpen && leftTab === 'features'} aria-controls="left-panel" title={`The ${features} features of the product, as the model described them: select one to light its files and see its flows`}>Features</button>}
          <button className="button rf-top" onClick={() => showLeft('flows')} aria-pressed={leftOpen && leftTab === 'flows'} aria-controls="left-panel" title="Every flow of the code in one list: pages, requests, console commands and scheduled tasks">Flows</button>
          <button className="button" onClick={() => showLeft('people')} aria-pressed={leftOpen && leftTab === 'people'} aria-controls="left-panel" title="Who changed which code, from the Git history: select a person to light the files they changed">People</button>
          <button className="button" onClick={() => void store.toggleCoverage()} aria-pressed={coverage} title="Color every file by whether flows touch it: entry points, in flows, supporting, not reached">Coverage</button>
          <label className="sr-only" htmlFor="theme-select">Theme</label>
          <select id="theme-select" className="select" value={themeId} onChange={event => store.setTheme(event.target.value)}>
            {THEMES.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <button className="icon-button" onClick={() => setHelp(open => !open)} aria-expanded={help} aria-label="Keyboard shortcuts">?</button>
        </div>
      </header>
      <Breadcrumbs />
      <main className="workspace">
        {leftOpen ? (
          <aside id="left-panel" className="panel left" style={{ width: Math.max(flowWidth, 340) }} aria-label={TAB_TEXT[leftTab]}>
            {tabs.length > 1 && (
              <div className="segmented panel-tabs" role="tablist" aria-label="Left panel">
                {tabs.map(tab => <button key={tab} role="tab" aria-selected={leftTab === tab} aria-pressed={leftTab === tab} onClick={() => setLeftTab(tab)}>{TAB_TEXT[tab]}</button>)}
              </div>
            )}
            {leftTab === 'steps' && stepsAnchor ? <StepsPanel onClose={() => setLeftTab('flows')} />
              : leftTab === 'features' && features > 0 ? <FeaturesPanel onClose={() => setLeftOpen(false)} />
              : leftTab === 'people' ? <PeoplePanel onClose={() => setLeftOpen(false)} />
              : <FlowsPanel onClose={() => setLeftOpen(false)} />}
            <ResizeHandle side="left" width={flowWidth} onResize={setFlowWidth} label="Resize the left panel" />
          </aside>
        ) : <div />}
        <section className="map-area">
          {split ? <SplitMap /> : <MapView />}
          <FlowBar />
          <SourcePanel />
        </section>
        {inspectorOpen ? (
          <aside className="panel" style={{ width: inspectorWidth }} aria-label="Inspector">
            <ResizeHandle side="right" width={inspectorWidth} onResize={setInspectorWidth} label="Resize inspector" />
            <Inspector onClose={() => setInspectorOpen(false)} />
          </aside>
        ) : <button className="panel-collapsed right" onClick={() => setInspectorOpen(true)}>Inspector</button>}
        <RequestFlowTheater />
      </main>
      {timelineOpen && <Timeline />}
      {help && <HelpDialog onClose={() => setHelp(false)} />}
    </div>
  );
}
const TAB_TEXT = { features: 'Features', flows: 'Flows', people: 'People', steps: 'Steps' } as const;
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
      <div className="card" role="dialog" aria-modal="true" aria-labelledby="help-title" onClick={event => event.stopPropagation()} style={{ textAlign: 'left' }}>
        <h2 id="help-title" style={{ marginTop: 0, fontSize: 15 }}>Keyboard and pointer</h2>
        <dl className="facts">{rows.map(([key, text]) => [<dt key={`k${key}`}><kbd>{key}</kbd></dt>, <dd key={`d${key}`}>{text}</dd>])}</dl>
        <p className="note">The map is a projection of the indexed graph: positions come from a deterministic layout and never change with selection, search or filters. In History, every commit is laid out against one shared slot registry, so areas stay put while you move through time; removed entities remain as translucent ghosts when comparing. Dragging the timeline or pressing play shows each commit at once as a time-lapse; the full view of a commit loads when you let go or pause. When comparing, the split map shows one view on each place that changed around an overview of the whole repository, where numbered frames show what each view shows. <strong>Features</strong> (once the code is described) lists what the product does: selecting a feature lights its files on the map, with the flows that start in it; a folder's inspector shows which data families its files belong to. <strong>People</strong> lists who changed the code, from the Git history (authors and co-authors, agents and bots told apart), in a window of time ending at the commit shown: selecting a person lights the files they changed, and every inspector says who changed its selection and when.</p>
        <button ref={close} className="button" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
