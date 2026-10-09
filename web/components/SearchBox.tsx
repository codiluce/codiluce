'use client';
import { useEffect, useRef, useState } from 'react';
import type { NodeSummary, SearchPage } from '@engine/projection/dto';
import { isAbort } from '../lib/api';
import { typeLabel } from '../lib/format';
import { LANES_TYPES, type AtlasStore } from '../lib/store';
import { useStore } from './context';
import { TypeBadge } from './TypeBadge';

/** What a search result can be opened as, besides selecting it on the map: its flow (on the map, in lanes, as steps) and what depends on it. */
interface SearchAction { key: string; text: string; title: string; run: (store: AtlasStore, item: NodeSummary) => void }
const ON_MAP: SearchAction = { key: 'map', text: 'On map', title: 'Play the flow that starts here on the map', run: (store, item) => { store.setCenter('map'); void store.openTour({ id: item.id, detail: item.type === 'route' ? 'steps' : 'lanes', title: item.name }); } };
const LANES: SearchAction = { key: 'lanes', text: 'Lanes', title: 'The flow that starts here in lanes, left to right', run: (store, item) => { void store.select(item.id, { fly: false }); void store.openFlowView({ id: item.id, title: item.name, lanes: true }, 'diagram'); } };
const STEPS: SearchAction = { key: 'steps', text: 'What happens', title: 'What it sets in motion, as an outline of steps', run: (store, item) => { void store.select(item.id, { fly: false }); void store.openFlowView({ id: item.id, title: item.name, lanes: LANES_TYPES.has(item.type) }, 'outline'); } };
const IMPACT: SearchAction = { key: 'impact', text: 'Impact', title: 'What depends on it, hop by hop', run: (store, item) => { void store.select(item.id, { fly: false }); void store.showImpact(item.id); } };
function actionsOf(item: NodeSummary): SearchAction[] {
  if (item.kind !== 'entity') return [];
  if (LANES_TYPES.has(item.type)) return [ON_MAP, LANES, STEPS, IMPACT];
  if (item.type === 'route') return [ON_MAP, STEPS, IMPACT];
  if (['repository', 'application', 'directory', 'file', 'database_table'].includes(item.type)) return [IMPACT];
  return [STEPS, IMPACT];
}

export function SearchBox() {
  const store = useStore();
  const [query, setQuery] = useState('');
  const [type, setType] = useState<string | undefined>();
  const [results, setResults] = useState<SearchPage | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [resultsKey, setResultsKey] = useState('');
  const pendingChoice = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) { event.preventDefault(); input.current?.focus(); input.current?.select(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    const text = query.trim();
    abort.current?.abort();
    if (!text) { setResults(null); setStatus('idle'); return; }
    const controller = new AbortController();
    abort.current = controller;
    setStatus('loading');
    const timer = setTimeout(() => {
      store.api.search(text, type, controller.signal).then(page => { setResults(page); setResultsKey(`${text}\u0000${type ?? ''}`); setActive(0); setStatus('idle'); }).catch(failure => { if (!isAbort(failure)) { setStatus('error'); setError(failure instanceof Error ? failure.message : String(failure)); } });
    }, 140);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, type, store]);
  const currentKey = `${query.trim()}\u0000${type ?? ''}`;
  const fresh = resultsKey === currentKey;
  const choose = (index: number) => {
    const item = results?.items[index];
    if (!item) return;
    pendingChoice.current = false;
    setOpen(false);
    input.current?.blur();
    store.setCenter('map');
    void store.select(item.id, { fly: true });
  };
  const act = (action: SearchAction, index: number) => {
    const item = results?.items[index];
    if (!item) return;
    pendingChoice.current = false;
    setOpen(false);
    input.current?.blur();
    action.run(store, item);
  };
  // Enter pressed while results for the typed query are still loading picks the first fresh result.
  useEffect(() => { if (fresh && pendingChoice.current) choose(0); });
  const showPanel = open && query.trim().length > 0;
  const onKeyDown = (event: React.KeyboardEvent) => {
    const count = results?.items.length ?? 0;
    if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); setActive(index => Math.min(count - 1, index + 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(0, index - 1)); }
    else if (event.key === 'Enter') { event.preventDefault(); if (fresh) choose(active); else if (query.trim()) pendingChoice.current = true; }
    else if (event.key === 'Escape') { setOpen(false); input.current?.blur(); }
    // Tab reaches the actions of the result chosen with the arrows (Escape comes back).
    else if (event.key === 'Tab' && !event.shiftKey && showPanel && fresh && results?.items[active] && actionsOf(results.items[active]!).length) {
      event.preventDefault();
      box.current?.querySelector<HTMLButtonElement>(`#result-${active} .search-action`)?.focus();
    }
  };
  // Leaving the search for one of its own controls (a facet, an action) keeps the results open.
  const onBlur = (event: React.FocusEvent) => { if (!box.current?.contains(event.relatedTarget as Node | null)) setTimeout(() => setOpen(false), 150); };
  return (
    <div className="search" role="search" ref={box} onBlur={onBlur}>
      <span className="search-icon" aria-hidden>⌕</span>
      <input
        ref={input} type="search" value={query} placeholder="Search files, symbols, routes, controllers…" aria-label="Search the indexed graph"
        role="combobox" aria-expanded={showPanel} aria-controls="search-results" aria-autocomplete="list" aria-activedescendant={showPanel && results?.items[active] ? `result-${active}` : undefined}
        onChange={event => { setQuery(event.target.value); setOpen(true); pendingChoice.current = false; }} onFocus={() => setOpen(true)} onKeyDown={onKeyDown}
      />
      {!query && <kbd aria-hidden>/</kbd>}
      {showPanel && (
        <div className="search-results" id="search-results">
          {results && results.typeCounts.length > 1 && (
            <div className="search-facets" role="group" aria-label="Filter by type">
              <button className="chip" aria-pressed={!type} onMouseDown={event => event.preventDefault()} onClick={() => setType(undefined)}>All <span className="count">{results.typeCounts.reduce((sum, item) => sum + item.count, 0)}</span></button>
              {results.typeCounts.map(item => (
                <button key={item.type} className="chip" aria-pressed={type === item.type} onMouseDown={event => event.preventDefault()} onClick={() => setType(type === item.type ? undefined : item.type)}>{typeLabel(item.type)} <span className="count">{item.count}</span></button>
              ))}
            </div>
          )}
          {status === 'error' && <div className="search-empty">Search failed: {error}</div>}
          {status === 'loading' && !results && <div className="search-empty">Searching…</div>}
          {results && results.items.length === 0 && status !== 'loading' && <div className="search-empty">No indexed entity matches “{query.trim()}”{type ? ` with type ${typeLabel(type)}` : ''}.</div>}
          <div role="listbox" aria-label="Search results">
            {results?.items.map((item, index) => (
              <div key={item.id} id={`result-${index}`} role="option" aria-selected={index === active} className="search-result" onMouseDown={event => event.preventDefault()} onClick={() => choose(index)} onMouseEnter={() => setActive(index)}>
                <TypeBadge type={item.type} role={item.role} />
                <span className="name">{item.change && item.change.status !== 'unchanged' && <span className={`change-badge ${item.change.status}`} style={{ marginRight: 6 }}>{item.change.status}</span>}{item.name}</span>
                <span className="where">{item.qualifiedName && item.qualifiedName !== item.name ? `${item.qualifiedName} · ` : ''}{item.breadcrumb || item.path}</span>
                {actionsOf(item).length > 0 && (
                  <span className="search-actions" role="group" aria-label={`Open ${item.name} as`}>
                    {actionsOf(item).map(action => (
                      <button key={action.key} className="search-action" title={action.title} tabIndex={index === active ? 0 : -1}
                        onMouseDown={event => event.preventDefault()} onClick={event => { event.stopPropagation(); act(action, index); }}
                        onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); input.current?.focus(); } }}>{action.text}</button>
                    ))}
                  </span>
                )}
              </div>
            ))}
          </div>
          {results && results.total > results.items.length && <div className="search-empty">Showing {results.items.length} of {results.total}. Refine the query or filter by type.</div>}
        </div>
      )}
    </div>
  );
}
