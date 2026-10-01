'use client';
import { useEffect, useRef, useState } from 'react';
import type { SearchPage } from '@engine/projection/dto';
import { isAbort } from '../lib/api';
import { typeLabel } from '../lib/format';
import { useStore } from './context';
import { TypeBadge } from './TypeBadge';

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
    void store.select(item.id, { fly: true });
  };
  // Enter pressed while results for the typed query are still loading picks the first fresh result.
  useEffect(() => { if (fresh && pendingChoice.current) choose(0); });
  const onKeyDown = (event: React.KeyboardEvent) => {
    const count = results?.items.length ?? 0;
    if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); setActive(index => Math.min(count - 1, index + 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(0, index - 1)); }
    else if (event.key === 'Enter') { event.preventDefault(); if (fresh) choose(active); else if (query.trim()) pendingChoice.current = true; }
    else if (event.key === 'Escape') { setOpen(false); input.current?.blur(); }
  };
  const showPanel = open && query.trim().length > 0;
  return (
    <div className="search" role="search">
      <span className="search-icon" aria-hidden>⌕</span>
      <input
        ref={input} type="search" value={query} placeholder="Search files, symbols, routes, controllers…" aria-label="Search the indexed graph"
        role="combobox" aria-expanded={showPanel} aria-controls="search-results" aria-autocomplete="list" aria-activedescendant={showPanel && results?.items[active] ? `result-${active}` : undefined}
        onChange={event => { setQuery(event.target.value); setOpen(true); pendingChoice.current = false; }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} onKeyDown={onKeyDown}
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
                <span className="name">{item.name}</span>
                <span className="where">{item.qualifiedName && item.qualifiedName !== item.name ? `${item.qualifiedName} · ` : ''}{item.breadcrumb || item.path}</span>
              </div>
            ))}
          </div>
          {results && results.total > results.items.length && <div className="search-empty">Showing {results.items.length} of {results.total}. Refine the query or filter by type.</div>}
        </div>
      )}
    </div>
  );
}
