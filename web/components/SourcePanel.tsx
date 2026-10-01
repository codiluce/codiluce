'use client';
import { useEffect, useMemo, useRef } from 'react';
import { highlightLines } from '../lib/highlight';
import { useAtlas, useStore } from './context';

const WINDOW = 400;
export function SourcePanel() {
  const store = useStore();
  const source = useAtlas(state => state.source);
  const body = useRef<HTMLDivElement>(null);
  const data = source?.data;
  const html = useMemo(() => data ? highlightLines(data.lines, data.file.language) : [], [data]);
  useEffect(() => {
    if (!data || !body.current) return;
    const target = body.current.querySelector<HTMLElement>('tr.focus');
    if (target) target.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    else body.current.scrollTop = 0;
  }, [data]);
  if (!source) return null;
  const focus = data?.focus;
  return (
    <section className="source-panel" aria-label="Source" onKeyDown={event => { if (event.key === 'Escape') store.closeSource(); }}>
      <div className="source-header">
        <span className="title">{source.title}</span>
        {data && <span className="path mono">{data.file.path} · lines {data.start}–{data.end} of {data.totalLines}</span>}
        {source.status === 'loading' && <span className="absent">loading…</span>}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {data && <button className="button small" onClick={() => void store.select(data.file.id, { fly: true })}>Show file on map</button>}
          <button className="icon-button small" onClick={() => store.closeSource()} aria-label="Close source" autoFocus>✕</button>
        </span>
      </div>
      {source.status === 'error' && <p className="note error" style={{ margin: 12 }}>{source.error}</p>}
      {data && (data.changedSinceIndex || data.notices.length > 0 || data.truncated) && (
        <div style={{ padding: '0 12px' }}>
          {data.notices.map(notice => <p key={notice} className={`note ${data.changedSinceIndex ? 'warning' : ''}`}>{notice}</p>)}
          {data.truncated && <p className="note">This window is bounded; use the buttons to read further.</p>}
        </div>
      )}
      {data && (
        <div className="source-body" ref={body} tabIndex={0} aria-label={`Source of ${data.file.path}`}>
          {data.start > 1 && <button className="source-more" onClick={() => void store.sourceWindow(Math.max(1, data.start - WINDOW), data.start - 1 + Math.min(40, data.lines.length))}>Load earlier lines</button>}
          <table className="source-table">
            <tbody>
              {html.map((line, index) => {
                const number = data.start + index;
                const inFocus = !!focus && number >= focus.startLine && number <= focus.endLine;
                return (
                  <tr key={number} className={inFocus ? `focus${number === focus!.startLine ? ' focus-edge' : ''}` : undefined} data-line={number}>
                    <td className="ln">{number}</td>
                    <td className="code" dangerouslySetInnerHTML={{ __html: line || ' ' }} />
                  </tr>
                );
              })}
            </tbody>
          </table>
          {data.end < data.totalLines && <button className="source-more" onClick={() => void store.sourceWindow(Math.max(1, data.end - 40), Math.min(data.totalLines, data.end + WINDOW - 40))}>Load later lines</button>}
          {focus && <p className="absent" style={{ padding: '4px 12px' }}>Highlighted: {focus.kind} — {focus.label} (lines {focus.startLine}–{focus.endLine})</p>}
        </div>
      )}
    </section>
  );
}
