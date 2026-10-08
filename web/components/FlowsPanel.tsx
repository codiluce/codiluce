'use client';
// The Flows panel: one list of every flow of the index (pages, requests,
// console commands and scheduled tasks), filtered by kind, completeness and
// text, and grouped by application and area in collapsible branches (long
// lists start collapsed). Choosing one shows it on the map; "through" an entity
// lists only the flows touching it. Everything listed is derived from indexed
// relationships.
import { useEffect, useMemo, type CSSProperties } from 'react';
import type { FlowSummary } from '@engine/projection/dto';
import { CATALOG_TABS, completenessOf, KIND_HINT, KIND_TEXT, kindsOf, visibleCatalog, type CatalogGroup, type CatalogTab } from '../lib/catalog';
import { STATUS_HINT, STATUS_TEXT } from '../lib/request-flows';
import { useAtlas, useStore } from './context';
import { MethodBadge, StagePips } from './RequestFlows';

/** Above this many flows shown (and without a filter), area groups start collapsed. */
const COLLAPSE_ABOVE = 40;
const EMPTY: Record<CatalogTab, string> = { all: 'No flows were indexed.', page: 'No pages were indexed.', request: 'No endpoints or HTTP requests were indexed.', command: 'No Artisan commands or scheduled tasks were indexed.', schedule: 'No scheduled tasks were indexed.', unmatched: 'Every indexed request has an endpoint.' };
export function FlowsPanel({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const catalog = useAtlas(state => state.catalog);
  const active = useAtlas(state => state.tour?.key);
  // Use the same identity as catalog loads, including live folder grouping.
  const stamp = useAtlas(() => store.viewStamp());
  useEffect(() => { if (catalog.status === 'idle' || (catalog.status === 'ready' && catalog.viewStamp !== stamp)) void store.loadCatalog(); }, [store, catalog.status, catalog.viewStamp, stamp]);
  const data = catalog.data;
  const tab = catalog.kind;
  const items = useMemo(() => data ? data.items.filter(item => kindsOf(tab).includes(item.kind)) : [], [data, tab]);
  // Completeness applies to HTTP flows; the tiles show when the list has any.
  const statusCounts = useMemo(() => { const counts = { complete: 0, partial: 0, headless: 0, unmatched: 0 }; for (const item of items) { const status = completenessOf(item); if (status) counts[status]++; } return counts; }, [items]);
  const tiles = Object.values(statusCounts).some(Boolean);
  const groups = useMemo(() => data ? visibleCatalog(data.items, { tab, query: catalog.query, status: catalog.filter }) : [], [data, tab, catalog.query, catalog.filter]);
  const shown = groups.reduce((sum, group) => sum + group.items.length, 0);
  // Applications, then their area groups; the group holding the flow on the map starts open.
  const apps = useMemo(() => { const byApp = new Map<string, CatalogGroup[]>(); for (const group of groups) byApp.set(group.app ?? '', [...byApp.get(group.app ?? '') ?? [], group]); return [...byApp]; }, [groups]);
  const nested = apps.length > 1;
  const collapsedFirst = shown > COLLAPSE_ABOVE && !catalog.query.trim();
  const isOpen = (key: string, fallback: boolean) => catalog.open[key] ?? fallback;
  const groupOpen = (group: CatalogGroup) => isOpen(group.key, !collapsedFirst || group.items.some(item => active === `${item.detail}:${item.id}`));
  const branchKeys = [...(nested ? apps.map(([app]) => `app:${app}`) : []), ...groups.map(group => group.key)];
  const count = (kind: CatalogTab) => data ? kindsOf(kind).reduce((sum, item) => sum + data.counts[item], 0) : undefined;
  return (
    <>
      <div className="panel-header">
        <h2>Flows</h2>
        <button className="icon-button small" onClick={onClose} aria-label="Hide the flows panel">⇤</button>
      </div>
      <div className="panel-body rf-panel">
        <div className="segmented flow-kinds" role="tablist" aria-label="Kinds of flows">
          {CATALOG_TABS.map(kind => (
            <button key={kind} role="tab" aria-selected={tab === kind} aria-pressed={tab === kind} onClick={() => store.setCatalogKind(kind)} title={KIND_HINT[kind]}>
              {KIND_TEXT[kind]}{count(kind) !== undefined && <span className="count">{count(kind)}</span>}
            </button>
          ))}
        </div>
        {catalog.entity && (
          <div className="rf-through">
            <span className="absent">Through</span><strong className="label">{catalog.entity.name}</strong>
            <button className="button tiny" onClick={() => void store.loadCatalog(null)} aria-label="Show every flow">✕ all</button>
          </div>
        )}
        <p className="note">{KIND_HINT[tab]} Choose one to see it on the map: what it touches stays lit, and it plays branch by branch, a pulse flowing along its links.</p>
        {catalog.status === 'loading' && !data && <div className="rf-loading" aria-live="polite"><span className="rf-spark" />Following every flow…</div>}
        {catalog.status === 'error' && <p className="note error">{catalog.error}</p>}
        {data && tiles && (
          <div className="rf-tiles" role="group" aria-label="Filter by completeness">
            {(['complete', 'partial', 'headless', 'unmatched'] as const).map(item => (
              <button key={item} className={`rf-tile s-${item}`} aria-pressed={catalog.filter === item} onClick={() => store.setCatalogFilter(item)} title={STATUS_HINT[item]}>
                <span className="rf-tile-count">{statusCounts[item]}</span>
                <span className="rf-tile-text">{STATUS_TEXT[item]}</span>
              </button>
            ))}
          </div>
        )}
        {data && (
          <>
            <label className="sr-only" htmlFor="flow-query">Filter flows</label>
            <input id="flow-query" className="text-input rf-query" placeholder={tab === 'command' ? 'Filter: command, schedule, handler…' : 'Filter: path, handler, caller, command…'} value={catalog.query} onChange={event => store.setCatalogQuery(event.target.value)} />
            {(shown !== items.length || groups.length > 1) && (
              <div className="tree-tools">
                {shown !== items.length && <span className="absent">{shown} of {items.length} shown</span>}
                {groups.length > 1 && <>
                  <button className="button tiny" onClick={() => store.setFlowGroupsOpen(branchKeys, true)}>Expand all</button>
                  <button className="button tiny" onClick={() => store.setFlowGroupsOpen(branchKeys, false)}>Collapse all</button>
                </>}
              </div>
            )}
            {!items.length && <p className="absent">{catalog.entity ? `No flow${tab === 'all' ? '' : ' of this kind'} touches it.` : EMPTY[tab]}</p>}
            <div className="rf-groups">
              {apps.map(([app, list]) => {
                const appOpen = !nested || isOpen(`app:${app}`, true);
                const body = list.map(group => {
                  const open = groupOpen(group);
                  return (
                    <section key={group.key} className="rf-group" aria-label={`${group.app ?? ''} ${group.group}`}>
                      <h4>
                        <button className="tree-head" aria-expanded={open} onClick={() => store.setFlowGroupsOpen([group.key], !open)}>
                          <span className="tree-chevron" aria-hidden>{open ? '▾' : '▸'}</span>{group.label}{group.app && !nested && <span className="chip app-chip">{group.app}</span>}<span className="count">{group.items.length}</span>
                        </button>
                      </h4>
                      {open && <ul className="rf-list">{group.items.map(item => <CatalogRow key={item.id} item={item} active={active === `${item.detail}:${item.id}`} />)}</ul>}
                    </section>
                  );
                });
                if (!nested) return body;
                const count = list.reduce((sum, group) => sum + group.items.length, 0);
                return (
                  <section key={`app:${app}`} className="rf-app" aria-label={app || 'Repository'}>
                    <h3>
                      <button className="tree-head" aria-expanded={appOpen} onClick={() => store.setFlowGroupsOpen([`app:${app}`], !appOpen)}>
                        <span className="tree-chevron" aria-hidden>{appOpen ? '▾' : '▸'}</span>{app || 'Repository'}<span className="count">{count}</span>
                      </button>
                    </h3>
                    {appOpen && <div className="tree-children">{body}</div>}
                  </section>
                );
              })}
            </div>
          </>
        )}
      </div>
    </>
  );
}
export function CatalogRow({ item, active }: { item: FlowSummary; active: boolean }) {
  const store = useStore();
  const size = `${item.files} file${item.files === 1 ? '' : 's'}`;
  let top: React.ReactNode, sub: string;
  if (item.kind === 'command') { top = <><span className="flow-glyph" aria-hidden>⌘</span><span className="rf-row-path mono">{item.name}</span></>; sub = `${item.callers ? `started from ${item.callers} place${item.callers === 1 ? '' : 's'}` : 'run by hand'} · ${size}`; }
  else if (item.kind === 'schedule') { top = <><span className="flow-glyph" aria-hidden>⏱</span><span className="rf-row-path">{item.cadence}</span></>; sub = `${item.name} · ${size}`; }
  else if (item.kind === 'page') { top = <><span className="flow-glyph" aria-hidden>▦</span><span className="rf-row-path mono">{item.entry.type === 'route' ? item.name : item.path}</span></>; sub = `${item.entry.type === 'route' ? 'Next.js page' : 'Inertia page'} · ${size}`; }
  else { top = <><MethodBadge method={item.method ?? ''} /><span className="rf-row-path mono">{item.path}</span></>; sub = `${item.kind === 'unmatched' ? `requested by ${item.entry.name}` : item.handler ?? 'no handler resolved'} · ${size}`; }
  const status = completenessOf(item);
  return (
    <li>
      <button className={`rf-row k-${item.kind}${status ? ` s-${status}` : ''}${active ? ' active' : ''}`} onClick={() => void store.openCatalogFlow(item)} aria-current={active ? 'true' : undefined} title={[item.goal, status ? STATUS_HINT[status] : 'Show on the map'].filter(Boolean).join('\n')} style={{ '--flow-kind': `var(--kind-${item.kind})` } as CSSProperties}>
        {item.title && <span className="rf-row-title">{item.title}{item.actor && <span className="flow-actor">{item.actor}</span>}</span>}
        <span className="rf-row-top">
          {top}
          {(item.gaps ?? 0) > 0 && <span className="rf-gaps" title={`${item.gaps} gap${item.gaps === 1 ? '' : 's'}: what the index could not see`}>{item.gaps}?</span>}
        </span>
        <span className="rf-row-bottom">
          <span className="rf-row-sub">{sub}</span>
          {item.stages && status && <StagePips stages={item.stages} />}
        </span>
      </button>
    </li>
  );
}
