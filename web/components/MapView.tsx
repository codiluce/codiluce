'use client';
import { useEffect, useRef, useState } from 'react';
import { MapController } from '../lib/controller';
import { typeLabel } from '../lib/format';
import { LEVELS } from '../lib/lod';
import { themeById } from '../lib/themes';
import { impactColors } from '../lib/renderer';
import { useAtlas, useStore } from './context';

export function MapView() {
  const store = useStore();
  const canvas = useRef<HTMLCanvasElement>(null);
  const status = useAtlas(state => state.status);
  const error = useAtlas(state => state.error);
  const stale = useAtlas(state => state.staleIndex);
  const drafting = useAtlas(state => !!state.flows.draft);
  const switching = useAtlas(state => state.timeline.switching);
  const [failure, setFailure] = useState<string>();
  useEffect(() => {
    if (!canvas.current) return;
    try { const controller = new MapController(canvas.current, store); return () => controller.destroy(); }
    catch (problem) { setFailure(problem instanceof Error ? problem.message : String(problem)); }
  }, [store]);
  return (
    <div className="map-stage">
      <canvas ref={canvas} className="map-canvas" tabIndex={0} role="application" aria-roledescription="code map" aria-label="Isometric map of the repository. Drag or use arrow keys to pan, wheel or plus/minus to zoom, click to select." aria-describedby="map-status" />
      <MapControls />
      <StatusBar />
      <Legend />
      <HoverCard />
      <VisibleList />
      {drafting && <div className="capture-banner" role="status">Recording flow steps: click entities on the map (or use “Add selection”).</div>}
      {stale && <div className="banner" role="status">A newer analysis run is available. <button className="button small primary" onClick={() => void store.reload()}>Reload map</button></div>}
      {switching && <div className="switching" role="status"><span className="spinner tiny" />Loading snapshot…</div>}
      {(status === 'loading' || status === 'error' || failure) && (
        <div className="center-state">
          <div className="card" role={status === 'error' || failure ? 'alert' : 'status'}>
            {status === 'loading' && !failure && <><div className="spinner" />Loading the indexed graph…</>}
            {(status === 'error' || failure) && (
              <>
                <strong>Map unavailable</strong>
                <p>{failure ?? error}</p>
                <p className="note">Start the API with <code>npm run archipelago -- serve --repo PATH --state-dir PATH</code> after indexing.</p>
                {!failure && <button className="button primary" onClick={() => void store.init()}>Retry</button>}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
function MapControls() {
  const store = useStore();
  const diagnostics = useAtlas(state => state.showDiagnostics);
  return (
    <div className="map-controls">
      <div className="control-group" role="group" aria-label="Zoom">
        <button onClick={() => store.navigator?.zoomBy(1.6)} aria-label="Zoom in" title="Zoom in (+)">+</button>
        <button onClick={() => store.navigator?.zoomBy(1 / 1.6)} aria-label="Zoom out" title="Zoom out (−)">−</button>
      </div>
      <div className="control-group" role="group" aria-label="View">
        <button onClick={() => store.navigator?.fitAll()} aria-label="Fit whole repository" title="Fit / reset view (F)">⤢</button>
        <button onClick={() => { const node = store.getState().selection?.node; if (node) store.navigator?.flyTo(node, { mode: node.childCount > 0 ? 'enter' : 'focus' }); }} aria-label="Zoom to selection" title="Zoom to selection (Enter)">◎</button>
        <button onClick={() => store.toggleDiagnostics()} aria-pressed={diagnostics} aria-label="Show unresolved findings on the map" title="Unresolved findings">⚠</button>
      </div>
    </div>
  );
}
function StatusBar() {
  const store = useStore();
  const view = useAtlas(state => state.view);
  const level = LEVELS.indexOf(view.level);
  return (
    <div className="status-bar" id="map-status" aria-live="polite">
      <span className="level-scale" aria-hidden>{LEVELS.map((name, index) => <span key={name} className={index <= level ? 'on' : ''} />)}</span>
      <span className="level">{view.level}</span>
      {view.focus.length > 0 && (
        <span className="focus" aria-label="Area at the center of the map">
          in&nbsp;{view.focus.map((item, index) => <span key={item.id}>{index > 0 && '›'}<button onClick={() => void store.select(item.id, { fly: true })}>{item.name}</button></span>)}
        </span>
      )}
      {view.truncated && <span className="absent" title="The render budget was reached; some areas stay summarized until you zoom in.">simplified</span>}
    </div>
  );
}
function Legend() {
  const meta = useAtlas(state => state.meta);
  const theme = themeById(useAtlas(state => state.themeId));
  if (!meta) return null;
  const present = new Set(meta.entityTypes.map(item => item.type));
  const types = ['application', 'directory', 'file', 'class', 'controller', 'model', 'component', 'function', 'method', 'api_endpoint', 'route', 'database_table'].filter(type => present.has(type));
  const relationTypes = meta.relationTypes.filter(item => item.type !== 'contains');
  // Themes that color files by language list those colors.
  const languages = Object.entries(theme.entity).filter(([key]) => key.startsWith('file:'));
  const coverage = meta.coverage;
  const comparison = meta.comparison;
  const relationCount = (type: string) => meta.relationTypes.find(item => item.type === type)?.count ?? 0;
  const items: { state: 'present' | 'partial' | 'absent'; text: string }[] = [
    { state: 'present', text: 'Hierarchy, files, symbols, routes, imports/exports, inheritance' },
    { state: coverage.resolvedHttpRequests ? 'partial' : 'absent', text: `HTTP request matching: ${coverage.resolvedHttpRequests} resolved, ${coverage.unresolvedHttpCalls} unresolved` },
    { state: coverage.calls ? 'partial' : 'absent', text: coverage.calls ? `Resolved calls, renders and references: ${relationCount('calls')} / ${relationCount('renders')} / ${relationCount('references')} (calls through callbacks, props or untyped values are counted per symbol, not linked)` : 'Function calls and renders: none resolved in this index' },
    { state: coverage.databaseTables ? 'present' : 'absent', text: coverage.databaseTables ? `Database tables: ${coverage.databaseTables} declared by migrations (the intended schema, not the live database); ${relationCount('maps_to')} model mappings, ${relationCount('reads')} reads, ${relationCount('writes')} writes, ${relationCount('foreign_key')} foreign keys` : 'Database tables: no migrations indexed' },
    { state: coverage.gitHistory ? 'present' : 'absent', text: coverage.gitHistory ? `History: ${coverage.gitHistory} indexed commits (History button)` : 'History: no commits indexed (run history index)' },
  ];
  return (
    <details className="legend">
      <summary>Legend &amp; coverage <span aria-hidden>▾</span></summary>
      <div className="legend-body">
        {comparison && (
          <div className="legend-grid" aria-label="Changes">
            {(['added', 'modified', 'moved', 'removed'] as const).map(key => <span key={key} className="legend-item"><span className="change-swatch" style={{ borderColor: theme.change[key], background: `color-mix(in srgb, ${theme.change[key]} 40%, transparent)`, borderStyle: key === 'removed' ? 'dashed' : 'solid' }} />{key === 'removed' ? 'removed (ghost)' : key}</span>)}
            <span className="legend-item"><span className="change-swatch" style={{ borderColor: theme.change.modified, borderStyle: 'dotted' }} />links/findings only</span>
            <span className="legend-item"><span className="line" style={{ background: theme.change.added, height: 5, opacity: 0.6 }} />edge added</span>
          </div>
        )}
        <ImpactLegend />
        <div className="legend-grid">
          {types.map(type => { const c = theme.entity[type]!; return <span key={type} className="legend-item"><span className="type-dot" style={{ background: `hsl(${c.h} ${c.s}% ${c.l}%)` }} />{typeLabel(type)}{type === 'file' && languages.length ? ' (other)' : ''}</span>; })}
        </div>
        {languages.length > 0 && (
          <div className="legend-grid" aria-label="Files by language">
            {languages.map(([key, c]) => <span key={key} className="legend-item"><span className="type-dot" style={{ background: `hsl(${c.h} ${c.s}% ${c.l}%)` }} />{key.slice(5)} files</span>)}
          </div>
        )}
        <div className="legend-grid">
          {relationTypes.map(item => <span key={item.type} className="legend-item"><span className="line" style={{ background: theme.relation[item.type] ?? theme.fallbackRelation }} />{item.type}</span>)}
          <span className="legend-item"><span className="line" style={{ background: `repeating-linear-gradient(90deg, ${theme.text.secondary} 0 4px, transparent 4px 7px)` }} />via hidden endpoint</span>
        </div>
        <div>{items.map(item => <div key={item.text} className={`coverage-item ${item.state}`}><span className="mark">{item.state === 'present' ? '●' : item.state === 'partial' ? '◐' : '○'}</span>{item.text}</div>)}</div>
      </div>
    </details>
  );
}
/** Shown while a blast radius is on the map. */
function ImpactLegend() {
  const theme = themeById(useAtlas(state => state.themeId));
  const depth = useAtlas(state => state.impact.open ? state.impact.data?.depth : state.commitImpact.show ? state.commitImpact.data?.depth : undefined);
  if (!depth) return null;
  const colors = impactColors(theme);
  return (
    <div className="legend-grid" aria-label="Blast radius">
      <span className="legend-item"><span className="change-swatch" style={{ borderColor: colors.origin }} />origin</span>
      <span className="legend-item"><span className="line" style={{ width: 46, height: 6, background: `linear-gradient(90deg, ${colors.near}, ${colors.far})` }} />1 → {depth} hops (number on the block)</span>
      <span className="legend-item"><span className="chip">◎ N affected</span>inside a closed area</span>
    </div>
  );
}
function HoverCard() {
  const hover = useAtlas(state => state.hover);
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const stage = (event.target as HTMLElement).closest?.('.map-stage');
      if (!stage) return;
      const box = stage.getBoundingClientRect();
      setPoint({ x: event.clientX - box.left, y: event.clientY - box.top });
    };
    window.addEventListener('pointermove', onMove);
    return () => window.removeEventListener('pointermove', onMove);
  }, []);
  if (!hover || !point) return null;
  return (
    <div className="hover-card" style={{ left: point.x + 14, top: point.y + 14 }} aria-hidden>
      <div className="name">{hover.name}</div>
      <div className="type-badge">{hover.kind === 'group' ? 'Projection district' : typeLabel(hover.type, hover.role)}{hover.loc !== undefined ? ` · ${hover.loc} lines` : ''}{hover.diagnostics ? ` · ${hover.diagnostics} unresolved` : ''}</div>
      {hover.path && <div className="path">{hover.path}{hover.sourceRange ? `:${hover.sourceRange.startLine}` : ''}</div>}
      {hover.change && <div className={`hover-change ${hover.change.status}`}>{hover.change.status}{hover.change.facets.length ? ` · ${hover.change.facets.join(', ')}` : ''}{hover.change.previousPath ? ` · from ${hover.change.previousPath}` : ''}{hover.change.previousName ? ` · was ${hover.change.previousName}` : ''}</div>}
      {hover.changes && <div className="hover-change">inside: {(['added', 'modified', 'moved', 'removed'] as const).filter(key => hover.changes![key]).map(key => `${hover.changes![key]} ${key}`).join(', ')}</div>}
      <ImpactHover id={hover.id} />
    </div>
  );
}
function ImpactHover({ id }: { id: string }) {
  const data = useAtlas(state => state.impact.open ? state.impact.data : state.commitImpact.show ? state.commitImpact.data : undefined);
  if (!data) return null;
  const distance = data.distances[id], area = data.areas[id];
  if (distance === 0) return <div className="hover-change">blast radius origin</div>;
  if (distance !== undefined) return <div className="hover-change">affected · {distance} hop{distance === 1 ? '' : 's'} away</div>;
  if (area) return <div className="hover-change">{area.count} affected inside · nearest {area.distance} hop{area.distance === 1 ? '' : 's'}</div>;
  return null;
}
/** Screen-reader/keyboard access to the most prominent visible map items. */
function VisibleList() {
  const store = useStore();
  const visible = useAtlas(state => state.view.visible);
  return (
    <div className="sr-only">
      <h2>Visible on the map</h2>
      <ul aria-label="Visible map items">
        {visible.map(item => <li key={item.id}><button onClick={() => void store.select(item.id, { fly: true })}>{typeLabel(item.type)} {item.name}</button></li>)}
      </ul>
    </div>
  );
}
