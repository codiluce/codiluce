'use client';
// The Features panel: the product's features (the model's domains, applied to
// the index) as a collapsible tree. Selecting a feature lights its files on the
// map, framed by the camera; under it, its description, the flows that start in
// it and the folders holding its code. The folder map itself never changes.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { FeatureSummary, FlowSummary } from '@engine/projection/dto';
import { familyCss, featureHues, themeById } from '../lib/themes';
import { useAtlas, useStore } from './context';
import { CatalogRow } from './FlowsPanel';

/** Rows shown before "Show all" in a feature's flows and folders. */
const ROWS = 10;
export function FeaturesPanel({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const features = useAtlas(state => state.features);
  const catalog = useAtlas(state => state.catalog);
  const stamp = useAtlas(() => store.viewStamp());
  const [query, setQuery] = useState('');
  useEffect(() => { void store.ensureFeatures(); }, [store, stamp]);
  // Flows come from the same list as the Flows panel.
  useEffect(() => { if (catalog.status === 'idle' || (catalog.status === 'ready' && catalog.viewStamp !== stamp)) void store.loadCatalog(); }, [store, catalog.status, catalog.viewStamp, stamp]);
  const data = features.data;
  const flows = useMemo(() => {
    const byFeature = new Map<string, FlowSummary[]>();
    for (const item of catalog.data?.items ?? []) if (item.feature) byFeature.set(item.feature, [...byFeature.get(item.feature) ?? [], item]);
    return byFeature;
  }, [catalog.data]);
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (feature: FeatureSummary) => !words.length || words.every(word => [feature.name, feature.summary, ...feature.folders.map(folder => folder.path), ...(flows.get(feature.key) ?? []).flatMap(item => [item.title ?? '', item.name, item.path ?? ''])].join('\u0000').toLowerCase().includes(word));
  const listed = data?.features.filter(matches) ?? [];
  const focused = data?.features.find(feature => feature.key === features.focus);
  const dark = themeById(useAtlas(state => state.themeId)).dark;
  const hues = useMemo(() => featureHues(data?.features.map(feature => feature.key) ?? []), [data]);
  const color = (key: string) => familyCss(hues.get(key) ?? 'none', dark);
  return (
    <>
      <div className="panel-header">
        <h2>Features</h2>
        <button className="icon-button small" onClick={onClose} aria-label="Hide the features panel">⇤</button>
      </div>
      <div className="panel-body features-panel">
        <p className="note">What the product does, as the model described it. Files belong to a feature by the paths the model gave, or by the code they are connected to; a flow belongs to the feature where it starts. Select a feature to light its files on the map.</p>
        {features.status === 'loading' && !data && <div className="rf-loading" aria-live="polite"><span className="rf-spark" />Placing the files…</div>}
        {features.status === 'error' && <p className="note error">{features.error}</p>}
        {data && !data.features.length && <p className="absent">No features yet: run <code>codiluce annotate</code> to describe them.</p>}
        {focused && (
          <div className="feature-focus" role="status">
            <span className="domain-dot" style={{ background: color(focused.key) }} />
            <span>Lit: <strong>{focused.name}</strong></span>
            <button className="button tiny" onClick={() => void store.focusFeature(undefined)}>✕ Show all</button>
          </div>
        )}
        {catalog.entity && <p className="absent">Flows listed: only those through <strong>{catalog.entity.name}</strong>. <button className="button tiny" onClick={() => void store.loadCatalog(null)}>Show every flow</button></p>}
        {data && data.features.length > 0 && (
          <>
            <label className="sr-only" htmlFor="feature-query">Filter features</label>
            <input id="feature-query" className="text-input rf-query" placeholder="Filter: feature, flow, folder…" value={query} onChange={event => setQuery(event.target.value)} />
            <div className="tree-tools">
              {listed.length !== data.features.length && <span className="absent">{listed.length} of {data.features.length} shown</span>}
              <button className="button tiny" onClick={() => { for (const feature of listed) store.setFeatureOpen(feature.key, true); }}>Expand all</button>
              <button className="button tiny" onClick={() => { for (const feature of data.features) store.setFeatureOpen(feature.key, false); }}>Collapse all</button>
            </div>
            <ul className="tree feature-tree">
              {listed.map(feature => <FeatureItem key={feature.key} feature={feature} color={color(feature.key)} flows={flows.get(feature.key) ?? []} filtering={words.length > 0} />)}
            </ul>
          </>
        )}
      </div>
    </>
  );
}
function FeatureItem({ feature, color, flows, filtering }: { feature: FeatureSummary; color: string; flows: FlowSummary[]; filtering: boolean }) {
  const store = useStore();
  const focus = useAtlas(state => state.features.focus);
  const branches = useAtlas(state => state.features.open);
  const active = useAtlas(state => state.tour?.key);
  const loaded = useAtlas(state => state.catalog.status === 'ready');
  const open = branches[feature.key] ?? filtering;
  const lit = focus === feature.key;
  return (
    <li className={`tree-item${lit ? ' lit' : ''}`}>
      <div className="tree-row">
        <button className="tree-toggle" aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${feature.name}`} onClick={() => store.setFeatureOpen(feature.key, !open)}>{open ? '▾' : '▸'}</button>
        <button className="tree-label" aria-pressed={lit} onClick={() => void store.focusFeature(feature.key, { fit: true })} title={lit ? 'Show every file again' : `Light the ${feature.files} code files of ${feature.name} on the map`}>
          <span className="domain-dot" style={{ background: color }} />
          <span className="label">{feature.name}</span>
          <span className="count">{feature.files} file{feature.files === 1 ? '' : 's'}{flows.length ? ` · ${flows.length} flow${flows.length === 1 ? '' : 's'}` : ''}</span>
        </button>
      </div>
      {open && (
        <div className="tree-children">
          <p className="feature-summary">{feature.summary}</p>
          <Branch id={`${feature.key}:flows`} title="Flows that start here" count={flows.length} initiallyOpen empty={loaded ? 'No flow starts in this feature.' : 'Following every flow…'}>
            {(all: boolean) => <ul className="rf-list">{(all ? flows : flows.slice(0, ROWS)).map(item => <CatalogRow key={item.id} item={item} active={active === `${item.detail}:${item.id}`} />)}</ul>}
          </Branch>
          <Branch id={`${feature.key}:folders`} title="Folders" count={feature.folders.length}>
            {(all: boolean) => (
              <ul className="tree-leaves">
                {(all ? feature.folders : feature.folders.slice(0, ROWS)).map(folder => (
                  <li key={folder.id}>
                    <button className="tree-leaf" onClick={() => void store.select(folder.id, { fly: true })} title={`Select ${folder.path} on the map`}>
                      <span className="mono label">{folder.path}</span><span className="count">{folder.files}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Branch>
        </div>
      )}
    </li>
  );
}
/** A collapsible list under a feature, showing its first rows until "Show all". */
function Branch({ id, title, count, initiallyOpen = false, empty, children }: { id: string; title: string; count: number; initiallyOpen?: boolean; empty?: string; children: (all: boolean) => ReactNode }) {
  const store = useStore();
  const branches = useAtlas(state => state.features.open);
  const open = branches[id] ?? initiallyOpen;
  const all = branches[`${id}:all`] ?? false;
  return (
    <section className="tree-branch">
      <button className="tree-head" aria-expanded={open} onClick={() => store.setFeatureOpen(id, !open)}>
        <span className="tree-chevron" aria-hidden>{open ? '▾' : '▸'}</span>{title}<span className="count">{count}</span>
      </button>
      {open && (count ? children(all) : empty ? <p className="absent">{empty}</p> : null)}
      {open && count > ROWS && <button className="button tiny" onClick={() => store.setFeatureOpen(`${id}:all`, !all)}>{all ? 'Show fewer' : `Show all ${count}`}</button>}
    </section>
  );
}
