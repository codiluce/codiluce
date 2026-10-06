'use client';
// History's split map: an overview of the whole repository (each view's frame
// drawn on it, so its size tells the view's zoom) and one view on each place
// where the compared code changed, five to a page.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ChangeCounts, ChangeRegion, ChangeRegionsResult, RegionLevel } from '@engine/projection/dto';
import { MapController } from '../lib/controller';
import { DEFAULT_LOD, type LodConfig } from '../lib/lod';
import { displayName } from '../lib/renderer';
import { REGION_PAGE, sceneRegions, splitGrid, SplitCoordinator, timelapseRegions } from '../lib/split';
import { useAtlas, useStore } from './context';
import { CoverageLegend, HoverCard, Legend } from './MapView';

/** A view is a fraction of the screen: areas open, and labels show, at smaller sizes than on the single map. */
const REGION_LOD: LodConfig = { ...DEFAULT_LOD, openPx: 150, summaryPx: 80, detailPx: 130, sourcePx: 460, budget: 3000 };
const OVERVIEW_LOD: LodConfig = { ...DEFAULT_LOD, openPx: 150, labelPx: 40, budget: 3000 };
/** While the time-lapse plays, the places follow the frames at most this often. */
const PLAY_REGIONS_MS = 1200;
const LEVELS: { level: RegionLevel; label: string; title: string }[] = [
  { level: 'auto', label: 'Auto', title: 'Places adapt to where the changes are: each view as close as it can be, five views to a page' },
  { level: 'application', label: 'Apps', title: 'One view per application with changes' },
  { level: 'directory', label: 'Folders', title: 'One view per folder holding changed files' },
  { level: 'file', label: 'Files', title: 'One view per changed file' },
];
const STATUS = [['added', '+'], ['modified', '~'], ['moved', '→'], ['removed', '−']] as const;
/** Level names short enough for a view's header. */
const SHORT_LEVEL: Record<string, string> = { Applications: 'Apps', 'Directories & modules': 'Folders' };
const EMPTY: ChangeRegion[] = [];

/**
 * The places on screen: the settled comparison's (from the server), those of
 * the time-lapse frame while scrubbing (grouped here, the same way), or while
 * it plays those of the frames until the next update (the views wait where
 * changes are about to flash). What was last shown stays until the next places
 * are known.
 */
function useShownRegions(): { data?: ChangeRegionsResult; loading: boolean; error?: string } {
  const store = useStore();
  const preview = useAtlas(state => state.timeline.preview);
  const playing = useAtlas(state => state.timeline.playing);
  const level = useAtlas(state => state.timeline.regionLevel);
  const settled = useAtlas(state => state.timeline.regions);
  const [framed, setFramed] = useState<ChangeRegionsResult>();
  const last = useRef(0);
  useEffect(() => {
    if (preview === undefined) { setFramed(undefined); return; }
    const compute = () => {
      const scene = store.previewScene, evolution = store.evolution;
      if (!scene) return;
      last.current = performance.now();
      const ahead = Math.ceil(store.playbackRate() * PLAY_REGIONS_MS / 1000);
      setFramed(playing && evolution ? timelapseRegions(evolution, preview, preview + ahead, level) : sceneRegions(scene, level));
    };
    const wait = playing ? Math.max(0, PLAY_REGIONS_MS - (performance.now() - last.current)) : 0;
    if (!wait) { compute(); return; }
    const timer = setTimeout(compute, wait);
    return () => clearTimeout(timer);
  }, [store, preview, playing, level]);
  const held = useRef<ChangeRegionsResult>(undefined);
  const data = preview !== undefined ? framed ?? held.current : settled.status === 'ready' ? settled.data : held.current ?? settled.data;
  if (data) held.current = data;
  return { data, loading: preview === undefined && settled.status === 'loading', ...(settled.error ? { error: settled.error } : {}) };
}
function usePortrait(element: React.RefObject<HTMLElement | null>): boolean {
  const [portrait, setPortrait] = useState(false);
  useEffect(() => {
    if (!element.current) return;
    const observer = new ResizeObserver(entries => { const box = entries[0]!.contentRect; setPortrait(box.width < box.height * 0.95); });
    observer.observe(element.current);
    return () => observer.disconnect();
  }, [element]);
  return portrait;
}

export function SplitMap() {
  const store = useStore();
  const coordinator = useMemo(() => new SplitCoordinator(store), [store]);
  useEffect(() => { coordinator.attach(); return () => coordinator.detach(); }, [coordinator]);
  const shown = useShownRegions();
  const regions = shown.data?.regions ?? EMPTY;
  useLayoutEffect(() => coordinator.setRegions(regions), [coordinator, regions]);
  const { page, active } = useSyncExternalStore(coordinator.subscribe, coordinator.getState, coordinator.getState);
  const pages = Math.max(1, Math.ceil(regions.length / REGION_PAGE));
  const first = Math.min(page, pages - 1) * REGION_PAGE;
  const onPage = regions.slice(first, first + REGION_PAGE);
  const stage = useRef<HTMLDivElement>(null);
  const grid = splitGrid(onPage.length, usePortrait(stage));
  const [enter, setEnter] = useState<'next' | 'prev'>();
  const go = (next: number) => { if (next < 0 || next >= pages || next === page) return; setEnter(next > page ? 'next' : 'prev'); coordinator.setPage(next); };
  const stale = useAtlas(state => state.staleIndex);
  return (
    <div ref={stage} className="map-stage split-stage" onKeyDown={event => { if (event.key === 'PageDown') { event.preventDefault(); go(page + 1); } if (event.key === 'PageUp') { event.preventDefault(); go(page - 1); } }}>
      <SplitBar data={shown.data} loading={shown.loading} error={shown.error} page={page} pages={pages} first={first} shown={onPage.length} go={go} />
      <div className="split-grid" style={{ gridTemplateColumns: `repeat(${grid.columns}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${grid.rows}, minmax(0, 1fr))` }}>
        <OverviewTile coordinator={coordinator} style={grid.overview} />
        {onPage.map((region, offset) => <RegionTile key={first + offset} index={first + offset} region={region} coordinator={coordinator} active={active === first + offset} enter={enter} />)}
      </div>
      {!regions.length && !shown.loading && shown.data && <div className="split-empty note" role="status">Nothing changed between these two snapshots.</div>}
      {stale && <div className="banner" role="status">A newer analysis run is available. <button className="button small primary" onClick={() => void store.reload()}>Reload map</button></div>}
      <Legend />
      <CoverageLegend />
      <HoverCard />
    </div>
  );
}
function SplitBar({ data, loading, error, page, pages, first, shown, go }: { data?: ChangeRegionsResult; loading: boolean; error?: string; page: number; pages: number; first: number; shown: number; go: (page: number) => void }) {
  const store = useStore();
  const level = useAtlas(state => state.timeline.regionLevel);
  const switching = useAtlas(state => state.timeline.switching);
  const count = data?.regions.length ?? 0;
  return (
    <div className="split-bar" role="toolbar" aria-label="Split map">
      <div className="segmented compact" role="group" aria-label="One view per">
        {LEVELS.map(item => <button key={item.level} aria-pressed={level === item.level} onClick={() => store.setRegionLevel(item.level)} title={item.title}>{item.label}</button>)}
      </div>
      {data && <span className="split-summary">{count} place{count === 1 ? '' : 's'}{data.truncated ? ` (${data.truncated} more left out)` : ''} · {data.changed} change{data.changed === 1 ? '' : 's'}</span>}
      {(loading || switching) && <span className="switching inline" role="status"><span className="spinner tiny" />{switching ? 'Loading snapshot…' : 'Finding the places…'}</span>}
      {error && <span className="note error inline">{error}</span>}
      {pages > 1 && (
        <div className="split-pager" role="group" aria-label="Pages of views">
          <button className="icon-button small" onClick={() => go(page - 1)} disabled={page === 0} aria-label="Previous views" title="Previous views (Page Up)">‹</button>
          <span className="split-range">{first + 1}–{first + shown} of {count}</span>
          {Array.from({ length: pages }, (_, index) => <button key={index} className={`split-dot${index === page ? ' on' : ''}`} onClick={() => go(index)} aria-label={`Views ${index * REGION_PAGE + 1}–${Math.min(count, (index + 1) * REGION_PAGE)}`} aria-current={index === page} />)}
          <button className="icon-button small" onClick={() => go(page + 1)} disabled={page >= pages - 1} aria-label="Next views" title="Next views (Page Down)">›</button>
        </div>
      )}
      <button className="button small split-single" onClick={() => store.setSplit(false)} title="Compare in a single map of the whole repository">Single map</button>
    </div>
  );
}
function OverviewTile({ coordinator, style }: { coordinator: SplitCoordinator; style: React.CSSProperties }) {
  const store = useStore();
  const canvas = useRef<HTMLCanvasElement>(null);
  const controller = useRef<MapController>(undefined);
  useEffect(() => {
    const view = new MapController(canvas.current!, store, {
      role: 'overview', lod: OVERVIEW_LOD,
      extra: () => ({ key: String(coordinator.getState().revision), force: coordinator.forced(), frames: coordinator.frames() }),
      onClick: point => coordinator.hitFrame(point),
    });
    controller.current = view;
    coordinator.setOverview(view);
    return () => { coordinator.setOverview(undefined); view.destroy(); };
  }, [store, coordinator]);
  return (
    <section className="split-tile overview" style={style} aria-label="Overview of the whole repository">
      <canvas ref={canvas} className="map-canvas" tabIndex={0} role="application" aria-roledescription="code map overview" aria-label="Overview of the whole repository. Numbered frames show what each view shows; click a frame to use that view." />
      <header className="split-head">
        <span className="split-label" title="The whole repository. Each numbered frame is what a view shows: the smaller the frame, the closer the view. Click a frame to use that view.">
          <strong>Overview</strong><span className="split-context">whole repository</span>
        </span>
        <span className="split-actions"><button className="icon-button small" onClick={() => controller.current?.goHome()} aria-label="Fit the whole repository" title="Fit the whole repository (F)">⤢</button></span>
      </header>
    </section>
  );
}
/** What a place is called: its name, with the folder or areas it is in. */
function placeName(region: ChangeRegion): { name: string; context?: string; title: string } {
  const node = region.node, name = displayName(node);
  const trail = region.ancestors.filter(ancestor => ancestor.type !== 'repository').map(displayName);
  if (node.path && (node.type === 'file' || node.type === 'directory')) {
    const cut = node.path.lastIndexOf('/');
    return { name, ...(cut > 0 ? { context: node.path.slice(0, cut + 1) } : {}), title: node.path };
  }
  return { name, ...(trail.length ? { context: trail.slice(-2).join(' › ') } : {}), title: [...trail, name].join(' › ') };
}
function Counts({ counts }: { counts: ChangeCounts }) {
  const parts = STATUS.filter(([key]) => counts[key] > 0);
  return <span className="split-counts" title={parts.map(([key]) => `${counts[key]} ${key}`).join(', ')}>{parts.map(([key, glyph]) => <span key={key} className={`split-count ${key}`}>{glyph}{counts[key]}</span>)}</span>;
}
function RegionTile({ coordinator, index, region, active, enter }: { coordinator: SplitCoordinator; index: number; region: ChangeRegion; active: boolean; enter?: 'next' | 'prev' }) {
  const store = useStore();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [controller, setController] = useState<MapController>();
  const [report, setReport] = useState<{ level: string; zoom: number }>();
  const place = useRef(region);
  place.current = region;
  useEffect(() => {
    const view = new MapController(canvas.current!, store, {
      role: 'region', lod: REGION_LOD,
      home: () => ({ node: place.current.node, frame: place.current.frame }),
      onCamera: () => coordinator.moved(),
      onReport: next => setReport(current => current?.level === next.level && current.zoom === next.zoom ? current : { level: next.level, zoom: next.zoom }),
      onActivate: () => coordinator.activate(index),
    });
    coordinator.register(index, view);
    setController(view);
    return () => { coordinator.unregister(index, view); view.destroy(); };
  }, [store, coordinator, index]);
  // Another place in this slot (another commit): the view flies there, or cuts while the time-lapse plays (places change faster than a flight).
  const { x, y, w, h } = region.frame;
  const key = `${region.node.id}|${x}|${y}|${w}|${h}`;
  const framed = useRef(key);
  useEffect(() => { if (controller && framed.current !== key) { framed.current = key; controller.goHome(!store.getState().timeline.playing); } }, [controller, key, store]);
  const { name, context, title } = placeName(region);
  return (
    <section className={`split-tile region${active ? ' active' : ''}${enter ? ` enter-${enter}` : ''}`} aria-label={`View ${index + 1}: ${title}`}>
      <canvas ref={canvas} className="map-canvas" tabIndex={0} role="application" aria-roledescription="code map view" aria-label={`View ${index + 1} on ${title}. Drag or use arrow keys to pan, wheel or plus/minus to zoom, F to frame the place again.`} />
      <header className="split-head">
        <span className="split-label" title={title}>
          <span className="split-number" aria-hidden>{index + 1}</span>
          {context && <span className="split-context">{context}</span>}
          <strong className="split-name">{name}</strong>
          <Counts counts={region.counts} />
          {report && <span className="split-level" title={`What this view shows at its zoom${coordinator.zoomOf(report.zoom) ? `: ${coordinator.zoomOf(report.zoom)} times closer than the overview` : ''}`}>{SHORT_LEVEL[report.level] ?? report.level}{coordinator.zoomOf(report.zoom) ? ` ×${coordinator.zoomOf(report.zoom)}` : ''}</span>}
        </span>
        <span className="split-actions">
          <button className="icon-button small" onClick={() => controller?.goHome()} aria-label={`Frame ${name} again`} title="Frame the place again (F)">⤢</button>
          <button className="icon-button small" onClick={() => store.setSplit(false, { node: region.node, frame: region.frame })} aria-label={`Open ${name} in the single map`} title="Open in the single map">↗</button>
        </span>
      </header>
    </section>
  );
}
