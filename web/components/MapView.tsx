'use client';
import { useEffect, useRef, useState } from 'react';
import { MapController } from '../lib/controller';
import { typeLabel } from '../lib/format';
import { LEVELS } from '../lib/lod';
import { coverageCss, familyCss, familyHues, featureHues, personHue, themeById } from '../lib/themes';
import { KindTag, PersonDot, windowText } from './PeoplePanel';
import { COVERAGE_HINT, COVERAGE_ORDER, COVERAGE_TEXT, NOT_MEASURED } from '../lib/coverage';
import { impactColors } from '../lib/renderer';
import { NO_FAMILY } from '../lib/store';
import { useAtlas, useStore } from './context';

export function MapView() {
  const store = useStore();
  const canvas = useRef<HTMLCanvasElement>(null);
  const status = useAtlas(state => state.status);
  const error = useAtlas(state => state.error);
  const stale = useAtlas(state => state.staleIndex);
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
      <CoverageLegend />
      <FamiliesLegend />
      <FeatureLegend />
      <PeopleLegend />
      <PersonLegend />
      <HoverCard />
      <VisibleList />
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
                <p className="note">Start the API with <code>npm run codiluce -- serve --repo PATH --state-dir PATH</code> after indexing.</p>
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
  const coverage = useAtlas(state => state.coverage.show);
  const families = useAtlas(state => state.families.show);
  const tables = useAtlas(state => state.meta?.coverage.databaseTables ?? 0);
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
        <button onClick={() => void store.toggleCoverage()} aria-pressed={coverage} aria-label="Color files by flow coverage" title="Coverage: which files flows touch">◑</button>
        {tables > 0 && <button onClick={() => void store.toggleFamilies()} aria-pressed={families} aria-label="Color files by data family" title="Data families: color files by the tables they use">▦</button>}
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
export function Legend() {
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
/** While the coverage lens is on: what each color means, how many files, and how much of the code flows touch. */
export function CoverageLegend() {
  const store = useStore();
  const coverage = useAtlas(state => state.coverage);
  const dark = themeById(useAtlas(state => state.themeId)).dark;
  const [exporting, setExporting] = useState<'idle' | 'busy' | 'error'>('idle');
  if (!coverage.show) return null;
  /** Download what no flow is proven to use as JSON, to review (e.g. with a language model). */
  const exportUnused = async () => {
    setExporting('busy');
    try {
      const result = await store.api.coverageExport();
      const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url; link.download = `${result.repository || 'repository'}-unused-code.json`;
      link.click();
      URL.revokeObjectURL(url);
      setExporting('idle');
    } catch { setExporting('error'); }
  };
  const data = coverage.data;
  const touched = data ? data.totals.entry + data.totals.flow : 0;
  return (
    <div className="coverage-legend" role="region" aria-label="Coverage lens">
      <div className="coverage-legend-head">
        <strong>Coverage by flows</strong>
        <button className="icon-button small" onClick={() => void store.toggleCoverage(false)} aria-label="Hide coverage">✕</button>
      </div>
      {coverage.status === 'loading' && !data && <p className="absent">Following every flow…</p>}
      {coverage.status === 'error' && <p className="note error">{coverage.error}</p>}
      {data && (
        <>
          <p className="coverage-headline"><span className="big">{data.codeFiles ? Math.round((touched / data.codeFiles) * 100) : 0}%</span> of {data.codeFiles} code files are entry points or in one of {data.flows} flows</p>
          <div className="coverage-bar wide">{COVERAGE_ORDER.filter(key => !NOT_MEASURED.has(key) && data.totals[key]).map(key => <span key={key} style={{ flexGrow: data.totals[key], background: coverageCss(key, dark) }} />)}</div>
          <ul className="coverage-keys">
            {COVERAGE_ORDER.filter(key => data.totals[key]).map(key => <li key={key} title={COVERAGE_HINT[key]}><span className="type-dot" style={{ background: coverageCss(key, dark) }} />{COVERAGE_TEXT[key]}<span className="count">{data.totals[key]}</span></li>)}
          </ul>
          <p className="absent">Closed areas show the share of their code files in flows. Select a file to see why.</p>
          <div className="coverage-export">
            <button className="button" onClick={() => void exportUnused()} disabled={exporting === 'busy'} title="Download the files no flow reaches and the unused symbols of reached files, with the reasons, as JSON to review">{exporting === 'busy' ? 'Exporting…' : 'Export unused (JSON)'}</button>
            {exporting === 'error' && <span className="note error">Export failed</span>}
          </div>
        </>
      )}
    </div>
  );
}
/** While data families are shown: each family (select one to light it on the map), its tables and its files. */
export function FamiliesLegend() {
  const store = useStore();
  const families = useAtlas(state => state.families);
  const dark = themeById(useAtlas(state => state.themeId)).dark;
  if (!families.show) return null;
  const data = families.data;
  const listed = data?.families.filter(family => family.files > 0) ?? [];
  const hues = familyHues(data?.families.map(family => family.key) ?? []);
  const tablesOnly = (data?.families.length ?? 0) - listed.length;
  return (
    <div className="coverage-legend families-legend" role="region" aria-label="Data families">
      <div className="coverage-legend-head">
        <strong>Data families</strong>
        <button className="icon-button small" onClick={() => void store.toggleFamilies(false)} aria-label="Hide data families">✕</button>
      </div>
      {families.status === 'loading' && !data && <p className="absent">Grouping the tables…</p>}
      {families.status === 'error' && <p className="note error">{families.error}</p>}
      {data && (
        <>
          <p className="absent">Tables joined by foreign keys, with the code that maps, writes or reads them, or uses code that does. Select a family to light it on the map.</p>
          <ul className="coverage-keys family-keys">
            {listed.map(family => (
              <li key={family.key}>
                <button aria-pressed={families.focus === family.key} onClick={() => store.focusFamily(family.key)} title={`Tables: ${family.tables.join(', ')}${family.hub ? '. Referenced by many tables, so it does not join their families.' : ''}`}>
                  <span className="type-dot" style={{ background: familyCss(hues.get(family.key)!, dark) }} />{family.name}{family.hub ? <span className="absent"> · hub</span> : null}<span className="count">{family.files}</span>
                </button>
              </li>
            ))}
            <li>
              <button aria-pressed={families.focus === NO_FAMILY} onClick={() => store.focusFamily(NO_FAMILY)} title="Code files that use no table, directly or through the code they are connected to">
                <span className="type-dot" style={{ background: familyCss('none', dark) }} />No tables<span className="count">{data.without}</span>
              </button>
            </li>
          </ul>
          {tablesOnly > 0 && <p className="absent">{tablesOnly} more famil{tablesOnly === 1 ? 'y has' : 'ies have'} tables but no code using them.</p>}
          <p className="absent">Closed areas show their main family. Files placed through the code they use are counted with it.</p>
        </>
      )}
    </div>
  );
}
/** Shown while a feature is lit (the Features panel): which one, and a way back to every file. A flow on the map takes over. */
function FeatureLegend() {
  const store = useStore();
  const data = useAtlas(state => state.features.data);
  const focus = useAtlas(state => state.tour ? undefined : state.features.focus);
  const dark = themeById(useAtlas(state => state.themeId)).dark;
  const feature = focus ? data?.features.find(item => item.key === focus) : undefined;
  if (!data || !feature) return null;
  return (
    <div className="feature-legend" role="status">
      <span className="domain-dot" style={{ background: familyCss(featureHues(data.features.map(item => item.key)).get(feature.key) ?? 'none', dark) }} />
      <button className="feature-legend-name" onClick={() => void store.revealFeature()} title="Show it in the Features panel"><strong>{feature.name}</strong></button>
      <span className="absent">{feature.files} code file{feature.files === 1 ? '' : 's'} lit</span>
      <button className="icon-button small" onClick={() => void store.focusFeature(undefined)} aria-label="Show every file again" title="Show every file again">✕</button>
    </div>
  );
}
/** People listed in the legend before "Show all". */
const LEGEND_PEOPLE = 12;
/** While files are colored by person: who changed most of the files (select one to light every file they changed), and the files nobody changed. */
export function PeopleLegend() {
  const store = useStore();
  const people = useAtlas(state => state.people);
  const rootId = useAtlas(state => state.meta?.root.id);
  const dark = themeById(useAtlas(state => state.themeId)).dark;
  const [all, setAll] = useState(false);
  const stamp = useAtlas(() => store.peopleStamp());
  useEffect(() => { if (people.show) void store.ensurePeople(); }, [store, people.show, stamp]);
  if (!people.show) return null;
  const data = people.data;
  const counts = (rootId && data?.areas[rootId]) || {};
  const ranked = (data?.people ?? []).filter(person => counts[person.key]).sort((a, b) => counts[b.key]! - counts[a.key]! || a.order - b.order);
  return (
    <div className="coverage-legend families-legend" role="region" aria-label="Who changed the files most">
      <div className="coverage-legend-head">
        <strong>Who changed it most</strong>
        <button className="icon-button small" onClick={() => void store.togglePeopleColors(false)} aria-label="Stop coloring files by person">✕</button>
      </div>
      {people.status === 'loading' && !data && <p className="absent">Reading the Git history…</p>}
      {people.status === 'error' && <p className="note error">{people.error}</p>}
      {data && !data.available && <p className="absent">{data.reason}</p>}
      {data?.available && (
        <>
          <p className="absent">{windowText(data.window)}. Each file takes the color of the person with the most lines changed in it.</p>
          <ul className="coverage-keys family-keys">
            {(all ? ranked : ranked.slice(0, LEGEND_PEOPLE)).map(person => (
              <li key={person.key}>
                <button aria-pressed={people.focus === person.key} onClick={() => void store.focusPerson(person.key)} title={`${person.name}: changed most of ${counts[person.key]} files, and ${person.files} files in all. Select to light every file they changed.`}>
                  <PersonDot order={person.order} />{person.name}<KindTag kind={person.kind} /><span className="count">{counts[person.key]}</span>
                </button>
              </li>
            ))}
            {data.unchanged > 0 && <li title="Files nobody changed in this window"><span className="type-dot" style={{ background: familyCss('none', dark) }} />Not changed<span className="count">{data.unchanged}</span></li>}
          </ul>
          {ranked.length > LEGEND_PEOPLE && <button className="button tiny" onClick={() => setAll(value => !value)}>{all ? 'Show fewer' : `Show all ${ranked.length}`}</button>}
          <p className="absent">Closed areas show who changed most of their files.</p>
        </>
      )}
    </div>
  );
}
/** Shown while a person is lit: who, and a way back to every file. A flow on the map takes over. */
function PersonLegend() {
  const store = useStore();
  const person = useAtlas(state => state.tour || !state.people.focus || state.people.person?.key !== state.people.focus ? undefined : state.people.person);
  const dark = themeById(useAtlas(state => state.themeId)).dark;
  const summary = person?.data?.person;
  if (!person || !summary) return null;
  return (
    <div className="feature-legend" role="status">
      <span className="domain-dot" style={{ background: familyCss(personHue(summary.order), dark) }} />
      <button className="feature-legend-name" onClick={() => void store.revealPeople()} title="Show them in the People panel"><strong>{summary.name}</strong></button>
      <KindTag kind={summary.kind} />
      <span className="absent">{Object.keys(person.data!.files).length} file{Object.keys(person.data!.files).length === 1 ? '' : 's'} they changed lit · {summary.commits} commit{summary.commits === 1 ? '' : 's'}</span>
      <button className="icon-button small" onClick={() => void store.focusPerson(undefined)} aria-label="Show every file again" title="Show every file again">✕</button>
    </div>
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
export function HoverCard() {
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
      <FamilyHover id={hover.id} />
      <PeopleHover id={hover.id} />
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
function FamilyHover({ id }: { id: string }) {
  const data = useAtlas(state => state.families.show ? state.families.data : undefined);
  const key = data?.of[id];
  if (!data || !key) return null;
  const family = data.families.find(item => item.key === key);
  return <div className="hover-change">data family: {family?.name ?? key}{data.inferred.includes(id) ? ' (from the code it is connected to)' : ''}</div>;
}
function PeopleHover({ id }: { id: string }) {
  const main = useAtlas(state => state.people.show && state.people.data?.available ? state.people.data.people.find(person => person.key === state.people.data!.of[id])?.name : undefined);
  const lit = useAtlas(state => state.people.focus && state.people.person?.key === state.people.focus ? state.people.person.data : undefined);
  const own = lit?.files[id];
  if (!main && !own) return null;
  return <>
    {main && <div className="hover-change">changed most by {main}</div>}
    {own && <div className="hover-change">{lit!.person.name}: {own.commits} commit{own.commits === 1 ? '' : 's'} · {own.lines} lines</div>}
  </>;
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
