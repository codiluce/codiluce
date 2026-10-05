'use client';
// The Flows panel: one list of every flow of the index (pages, requests,
// console commands and scheduled tasks), filtered by kind, completeness and
// text, and grouped by area. Choosing one shows it on the map; "through" an
// entity lists only the flows touching it. Everything listed is derived from
// indexed relationships.
import { useEffect, useMemo, type CSSProperties } from 'react';
import type { FlowSummary } from '@engine/projection/dto';
import { CATALOG_TABS, completenessOf, KIND_HINT, KIND_TEXT, kindsOf, visibleCatalog, type CatalogTab } from '../lib/catalog';
import { STATUS_HINT, STATUS_TEXT } from '../lib/request-flows';
import { useAtlas, useStore } from './context';
import { MethodBadge, StagePips } from './RequestFlows';

const EMPTY: Record<CatalogTab, string> = { all: 'No flows were indexed.', page: 'No pages were indexed.', request: 'No endpoints or HTTP requests were indexed.', command: 'No Artisan commands or scheduled tasks were indexed.', schedule: 'No scheduled tasks were indexed.', unmatched: 'Every indexed request has an endpoint.' };
export function FlowsPanel({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const catalog = useAtlas(state => state.catalog);
  const active = useAtlas(state => state.tour?.key);
  const stamp = useAtlas(state => `${state.meta?.snapshot.id ?? ''}|${state.meta?.comparison?.baseline.id ?? ''}|${state.timeline.open ? 'folders' : state.lens}`);
  useEffect(() => { if (catalog.status === 'idle' || (catalog.status === 'ready' && catalog.viewStamp !== stamp)) void store.loadCatalog(); }, [store, catalog.status, catalog.viewStamp, stamp]);
  const data = catalog.data;
  const tab = catalog.kind;
  const items = useMemo(() => data ? data.items.filter(item => kindsOf(tab).includes(item.kind)) : [], [data, tab]);
  // Completeness applies to HTTP flows; the tiles show when the list has any.
  const statusCounts = useMemo(() => { const counts = { complete: 0, partial: 0, headless: 0, unmatched: 0 }; for (const item of items) { const status = completenessOf(item); if (status) counts[status]++; } return counts; }, [items]);
  const tiles = Object.values(statusCounts).some(Boolean);
  const groups = useMemo(() => data ? visibleCatalog(data.items, { tab, query: catalog.query, status: catalog.filter }) : [], [data, tab, catalog.query, catalog.filter]);
  const shown = groups.reduce((sum, group) => sum + group.items.length, 0);
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
            {shown !== items.length && <p className="absent" style={{ margin: '6px 2px' }}>{shown} of {items.length} shown</p>}
            {!items.length && <p className="absent">{catalog.entity ? `No flow${tab === 'all' ? '' : ' of this kind'} touches it.` : EMPTY[tab]}</p>}
            <div className="rf-groups">
              {groups.map(group => (
                <section key={group.key} className="rf-group" aria-label={`${group.app ?? ''} ${group.group}`}>
                  <h4>{group.label}{group.app && <span className="chip app-chip">{group.app}</span>}<span className="count">{group.items.length}</span></h4>
                  <ul className="rf-list">{group.items.map(item => <CatalogRow key={item.id} item={item} active={active === `${item.detail}:${item.id}`} />)}</ul>
                </section>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}
function CatalogRow({ item, active }: { item: FlowSummary; active: boolean }) {
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
