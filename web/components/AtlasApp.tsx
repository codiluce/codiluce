'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { HttpAtlasApi } from '../lib/api';
import { shortSha, relativeTime } from '../lib/format';
import { AtlasStore } from '../lib/store';
import { THEMES, themeById } from '../lib/themes';
import { Breadcrumbs } from './Breadcrumbs';
import { AtlasContext, useAtlas, useStore } from './context';
import { FlowPanel } from './FlowPanel';
import { Inspector } from './Inspector';
import { MapView } from './MapView';
import { SearchBox } from './SearchBox';
import { SourcePanel } from './SourcePanel';

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
  const draft = useAtlas(state => !!state.flows.draft);
  const activeFlow = useAtlas(state => !!state.flows.activeId);
  const theme = themeById(themeId);
  const [inspectorWidth, setInspectorWidth] = usePanelWidth('archipelago:inspector-width', 380);
  const [flowWidth, setFlowWidth] = usePanelWidth('archipelago:flow-width', 300);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [flowsOpen, setFlowsOpen] = useState(false);
  const [help, setHelp] = useState(false);
  const style = useMemo(() => ({ ...theme.ui, background: theme.ui['--bg'] }) as React.CSSProperties, [theme]);
  useEffect(() => { for (const [key, value] of Object.entries(theme.ui)) document.body.style.setProperty(key, value); document.documentElement.style.colorScheme = theme.dark ? 'dark' : 'light'; }, [theme]);
  useEffect(() => { if (draft || activeFlow) setFlowsOpen(true); }, [draft, activeFlow]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); void store.back(); }
      if (event.altKey && event.key === 'ArrowRight') { event.preventDefault(); void store.forward(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store]);
  const run = meta?.run;
  return (
    <div className="archipelago" style={style} data-dark={String(theme.dark)}>
      <header className="topbar">
        <div className="brand">
          <strong><span className="brand-mark" aria-hidden />Archipelago</strong>
          {run && <small title={`Analysis run ${run.id}`}>{run.repositoryName} · working tree{run.commitSha ? ` at HEAD ${shortSha(run.commitSha)}` : ''}{run.dirty ? ' + uncommitted changes' : ''} · indexed {relativeTime(run.analyzedAt)}</small>}
        </div>
        <SearchBox />
        <div className="top-actions">
          <button className="icon-button" onClick={() => void store.back()} disabled={history.index <= 0} aria-label="Back to previous selection" title="Back (Alt+←)">←</button>
          <button className="icon-button" onClick={() => void store.forward()} disabled={history.index >= history.entries.length - 1} aria-label="Forward" title="Forward (Alt+→)">→</button>
          <button className="button" onClick={() => setFlowsOpen(open => !open)} aria-pressed={flowsOpen} aria-controls="flows-panel">Flows</button>
          <label className="sr-only" htmlFor="theme-select">Theme</label>
          <select id="theme-select" className="select" value={themeId} onChange={event => store.setTheme(event.target.value)}>
            {THEMES.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <button className="icon-button" onClick={() => setHelp(open => !open)} aria-expanded={help} aria-label="Keyboard shortcuts">?</button>
        </div>
      </header>
      <Breadcrumbs />
      <main className="workspace">
        {flowsOpen ? (
          <aside id="flows-panel" className="panel left" style={{ width: flowWidth }} aria-label="Flows">
            <FlowPanel onClose={() => setFlowsOpen(false)} />
            <ResizeHandle side="left" width={flowWidth} onResize={setFlowWidth} label="Resize flows panel" />
          </aside>
        ) : <div />}
        <section className="map-area">
          <MapView />
          <SourcePanel />
        </section>
        {inspectorOpen ? (
          <aside className="panel" style={{ width: inspectorWidth }} aria-label="Inspector">
            <ResizeHandle side="right" width={inspectorWidth} onResize={setInspectorWidth} label="Resize inspector" />
            <Inspector onClose={() => setInspectorOpen(false)} />
          </aside>
        ) : <button className="panel-collapsed right" onClick={() => setInspectorOpen(true)}>Inspector</button>}
      </main>
      {help && <HelpDialog onClose={() => setHelp(false)} />}
    </div>
  );
}
function HelpDialog({ onClose }: { onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => { close.current?.focus(); const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, [onClose]);
  const rows: [string, string][] = [
    ['/', 'Search entities'], ['↑ ↓ Enter', 'Choose a search result'], ['Drag · wheel · pinch', 'Pan and zoom the map'],
    ['Arrow keys · + −', 'Pan and zoom (map focused)'], ['F', 'Fit the whole repository'], ['Enter', 'Zoom to the selection'],
    ['Double-click', 'Zoom into an area'], ['Esc', 'Clear selection / close'], ['Backspace · Alt+←', 'Previous selection'], ['Alt+→', 'Next selection'],
  ];
  return (
    <div className="center-state" style={{ pointerEvents: 'auto', background: 'rgba(0,0,0,0.35)', zIndex: 30 }} onClick={onClose}>
      <div className="card" role="dialog" aria-modal="true" aria-labelledby="help-title" onClick={event => event.stopPropagation()} style={{ textAlign: 'left' }}>
        <h2 id="help-title" style={{ marginTop: 0, fontSize: 15 }}>Keyboard and pointer</h2>
        <dl className="facts">{rows.map(([key, text]) => [<dt key={`k${key}`}><kbd>{key}</kbd></dt>, <dd key={`d${key}`}>{text}</dd>])}</dl>
        <p className="note">The map is a projection of the indexed graph: positions come from a deterministic layout and never change with selection, search or filters.</p>
        <button ref={close} className="button" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
