'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HttpAtlasApi } from '../lib/api';
import { HttpExplanationsApi } from '../lib/explanations';
import { shortSha, relativeTime } from '../lib/format';
import { AtlasStore } from '../lib/store';
import { tourParam, withoutTourParam, type TourKey } from '../lib/onboarding';
import { themeById, UI_PROPERTIES } from '../lib/themes';
import { Breadcrumbs } from './Breadcrumbs';
import { AtlasContext, useAtlas, useStore } from './context';
import { EclipseMark } from './EclipseMark';
import { ActivityConnection } from './AgentsPanel';
import { Column, Rail } from './Column';
import { MapVisibilityUI } from './MapVisibility';
import { Onboarding } from './Onboarding';
import { SettingsDialog } from './SettingsDialog';
import { SearchBox } from './SearchBox';
import { Timeline } from './Timeline';
import { Workbench } from './Workbench';
import { ArchetypeLegend } from './ArchetypeMark';

/**
 * `?tour` starts the onboarding tour (`?tour=people` a chapter). It is read
 * once (React's development double mount creates the store twice) and leaves
 * the address, so a reload does not start it again.
 */
let askedTour: { tour?: TourKey } | undefined;
function createStore(): AtlasStore {
  const storage = (() => { try { return window.localStorage; } catch { return undefined; } })();
  askedTour ??= (() => {
    const search = window.location.search, tour = tourParam(search);
    if (new URLSearchParams(search).has('tour')) history.replaceState(null, '', window.location.pathname + withoutTourParam(search) + window.location.hash);
    return tour ? { tour } : {};
  })();
  return new AtlasStore(new HttpAtlasApi(''), {
    storage, explanations: new HttpExplanationsApi(''), ...askedTour,
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
    const followJournalLink = () => {
      const params = new URLSearchParams(window.location.hash.slice(1));
      const conversation = params.get('sessions') ?? params.get('conversation');
      if (conversation) instance.openJournal('conversations', { id: conversation === 'list' ? undefined : conversation, messageId: params.get('message') ?? undefined });
    };
    window.addEventListener('hashchange', followJournalLink);
    return () => { document.removeEventListener('visibilitychange', shown); window.removeEventListener('hashchange', followJournalLink); instance.dispose(); };
  }, []);
  if (!store) return null;
  return (
    <AtlasContext.Provider value={store}>
      <Shell />
    </AtlasContext.Provider>
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
  // The layout is the store's (the rail, the column's view), so the onboarding tour can open views and put them back as they were.
  const column = useAtlas(state => state.panels.column);
  const agentsExpanded = useAtlas(state => state.panels.view === 'agents' && !!state.journal.expanded);
  // Comparing in History: one view per place that changed, around an overview (unless the single map is chosen).
  const split = useAtlas(state => state.timeline.open && state.timeline.compare && state.timeline.split && (!!state.meta?.comparison || state.timeline.preview !== undefined));
  const [help, setHelp] = useState(false);
  const settings = useAtlas(state => state.panels.settings);
  const closeSettings = useCallback(() => store.setPanels({ settings: false }), [store]);
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
      <ActivityConnection />
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
            <button className="button" data-onboarding="history" onClick={() => void (timelineOpen ? store.closeTimeline() : store.openTimeline())} aria-pressed={timelineOpen} title="Browse Git file evolution; explore architecture snapshots on demand">History</button>
          </div>
        </div>
      </header>
      <Breadcrumbs />
      <main className={`workspace${column ? ' with-column' : ''}${agentsExpanded ? ' agents-expanded' : ''}`}>
        <Rail onKeyboard={() => setHelp(true)} />
        <Column />
        <Workbench split={split} />
      </main>
      {timelineOpen && <Timeline />}
      {help && <HelpDialog onClose={() => setHelp(false)} />}
      {settings && <SettingsDialog onClose={closeSettings} />}
      <MapVisibilityUI />
      <Onboarding />
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
    ['[ ]', 'Previous / next indexed commit (History open)'], ['Space', 'Play / pause the history time-lapse (History open)'], ['Shift + ← →', 'Move the comparison baseline (timeline focused)'], ['Page Up · Page Down', 'Previous / next views of the split map (History, Compare)'],
  ];
  return (
    <div className="center-state" style={{ pointerEvents: 'auto', background: 'rgba(0,0,0,0.35)', zIndex: 30 }} onClick={onClose}>
      <div className="card" role="dialog" aria-modal="true" aria-labelledby="help-title" onClick={event => event.stopPropagation()} style={{ textAlign: 'left', maxHeight: 'calc(100vh - 120px)', overflowY: 'auto' }}>
        <h2 id="help-title" style={{ marginTop: 0, fontSize: 15 }}>Keyboard and pointer</h2>
        <dl className="facts">{rows.map(([key, text]) => [<dt key={`k${key}`}><kbd>{key}</kbd></dt>, <dd key={`d${key}`}>{text}</dd>])}</dl>
        <p className="note">The map is a projection of the indexed graph: positions come from a deterministic layout. Hiding or restoring paths repacks the map to reclaim space; selection and search keep positions stable. In History, every commit is laid out against one shared slot registry, so areas stay put while you move through time; removed entities remain as translucent ghosts when comparing. Dragging the timeline or pressing play shows each commit at once as a time-lapse; the full view of a commit loads when you let go or pause. When comparing, the split map shows one view on each place that changed around an overview of the whole repository, where numbered frames show what each view shows. The rail on the left picks what the column beside it shows, one view at a time: <strong>Selection</strong> (the inspector), <strong>Code</strong>, <strong>Impact</strong>, <strong>Flows</strong>, <strong>Dependencies</strong>, <strong>People</strong>, <strong>PRs</strong>, <strong>Explain</strong> and <strong>Agents</strong>, with Settings and Help at its foot. Selecting on the map never moves the column; the current view's item hides it, and its edge resizes it. The map draws what the view lights: <strong>Impact</strong> colors what depends on the selection, or on your uncommitted changes, hop by hop; <strong>Dependencies</strong> draws what the selection uses and what uses it as rails to the files at the other ends, each arrow saying what it does (calls, requests, imports…), and pointing at one in its list brings its rail to the front. <strong>Code</strong> shows the code of the selection and follows what you select. Flows, steps and the files a highlight lights open in the middle of the screen as tabs beside <strong>Map</strong>; the map then stays in a corner as an overview of what they light, and a click on it brings it back. Search results offer the same: a flow on the map or in lanes, what happens from it, its impact (<kbd>Tab</kbd> reaches them). <strong>Color by</strong>, at the map's top left, colors its files by type, flow coverage, who changed them, complexity, recent changes or hotspots. <strong>Features</strong> (once the code is described) lists what the product does: selecting a feature lights its files on the map, with the flows that start in it; a folder's inspector shows which data families its files belong to. <strong>People</strong> lists who changed the code, from the Git history (authors and co-authors, agents and bots told apart), in a window of time ending at the commit shown: selecting a person lights the files they changed, and every inspector says who changed its selection and when. <strong>PRs</strong> lists pull requests: open work (branches not merged yet, and with <code>--pr-metadata github</code> the open pull requests on GitHub) and what was merged into the branch in the same window. Selecting one lights the files it changes, with its commits, people and blast radius; every inspector lists the open pull requests changing its selection.</p>

        <h2 style={{ fontSize: 15 }}>Building shapes</h2>
        <p className="note">Each kind of block has a shape, the same in every language and framework. It comes from the index where it can (a controller class, endpoints declared in a file, a page route) and from folder and name conventions otherwise; the inspector says which. Small blocks show it as a mark on their roof, and a closed folder shows the kinds it holds most, each with its count (its inspector lists them all). Blocks stand a little inside their places, so streets run between them. Settings turns shapes and streets off.</p>
        <ArchetypeLegend />
        <button ref={close} className="button" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
