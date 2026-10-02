'use client';
import { useEffect, useMemo, useRef } from 'react';
import type { DiffLine, SnapshotRef, SourceDiffResponse } from '@engine/projection/dto';
import { shortSha } from '../lib/format';
import { highlightLines } from '../lib/highlight';
import { useAtlas, useStore } from './context';

const WINDOW = 400;
function where(snapshot: SnapshotRef | undefined): string { return !snapshot ? '' : snapshot.kind === 'commit' ? `@ ${shortSha(snapshot.commitSha)}` : '@ working tree'; }
export function SourcePanel() {
  const store = useStore();
  const source = useAtlas(state => state.source);
  const diff = useAtlas(state => state.diff);
  const body = useRef<HTMLDivElement>(null);
  const data = source?.data;
  const html = useMemo(() => data ? highlightLines(data.lines, data.file.language) : [], [data]);
  useEffect(() => {
    if (!data || !body.current) return;
    const target = body.current.querySelector<HTMLElement>('tr.focus');
    if (target) target.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    else body.current.scrollTop = 0;
  }, [data]);
  if (diff) return <DiffPanel />;
  if (!source) return null;
  const focus = data?.focus;
  return (
    <section className="source-panel" aria-label="Source" onKeyDown={event => { if (event.key === 'Escape') store.closeSource(); }}>
      <div className="source-header">
        <span className="title">{source.title}</span>
        {data && <span className="path mono">{data.file.path} · lines {data.start}–{data.end} of {data.totalLines}{data.snapshot?.kind === 'commit' ? ` ${where(data.snapshot)}` : ''}</span>}
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

type RenderedLine = DiffLine & { html: string };
/** Highlight each hunk per side (old: context + removed, new: context + added) so tokens spanning lines stay correct. */
function renderHunks(data: SourceDiffResponse): RenderedLine[][] {
  return data.hunks.map(hunk => {
    const oldHtml = highlightLines(hunk.lines.filter(line => line.kind !== 'added').map(line => line.text), data.language);
    const newHtml = highlightLines(hunk.lines.filter(line => line.kind !== 'removed').map(line => line.text), data.language);
    let o = 0, n = 0;
    return hunk.lines.map(line => {
      if (line.kind === 'added') return { ...line, html: newHtml[n++] ?? '' };
      if (line.kind === 'removed') return { ...line, html: oldHtml[o++] ?? '' };
      o++; return { ...line, html: newHtml[n++] ?? '' };
    });
  });
}
/** Side-by-side rows: context on both sides; each run of removals is paired with the following run of additions. */
function splitRows(lines: RenderedLine[]): { left?: RenderedLine; right?: RenderedLine }[] {
  const rows: { left?: RenderedLine; right?: RenderedLine }[] = [];
  for (let i = 0; i < lines.length;) {
    if (lines[i]!.kind === 'context') { rows.push({ left: lines[i], right: lines[i] }); i++; continue; }
    const removed: RenderedLine[] = [], added: RenderedLine[] = [];
    while (i < lines.length && lines[i]!.kind === 'removed') removed.push(lines[i++]!);
    while (i < lines.length && lines[i]!.kind === 'added') added.push(lines[i++]!);
    for (let k = 0; k < Math.max(removed.length, added.length); k++) rows.push({ ...(removed[k] ? { left: removed[k] } : {}), ...(added[k] ? { right: added[k] } : {}) });
  }
  return rows;
}
function DiffPanel() {
  const store = useStore();
  const diff = useAtlas(state => state.diff)!;
  const data = diff.data;
  const hunks = useMemo(() => data ? renderHunks(data) : [], [data]);
  const sign = (kind: DiffLine['kind']) => kind === 'added' ? '+' : kind === 'removed' ? '−' : ' ';
  const side = data?.after ?? data?.before;
  const moved = data?.before && data.after && data.before.path !== data.after.path;
  return (
    <section className="source-panel" aria-label="Source diff" onKeyDown={event => { if (event.key === 'Escape') store.closeSource(); }}>
      <div className="source-header">
        <span className="title">Diff · {diff.title}</span>
        {data && <span className="path mono">{moved ? `${data.before!.path} → ${data.after!.path}` : side?.path} {where(data.before?.snapshot) || '(new)'} → {where(data.after?.snapshot) || '(removed)'}</span>}
        {data && !data.identical && !data.tooLarge && <span className="diff-stat"><span className="added">+{data.added}</span> <span className="removed">−{data.removed}</span></span>}
        {diff.status === 'loading' && <span className="absent">loading…</span>}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          <span className="segmented compact" role="group" aria-label="Diff layout">
            <button aria-pressed={diff.layout === 'unified'} onClick={() => store.setDiffLayout('unified')}>Unified</button>
            <button aria-pressed={diff.layout === 'split'} onClick={() => store.setDiffLayout('split')}>Side by side</button>
          </span>
          <button className="chip" aria-pressed={diff.ignoreWhitespace} onClick={() => store.setDiffWhitespace(!diff.ignoreWhitespace)} title="Treat indentation and spacing changes as unchanged">Ignore whitespace</button>
          {side && <button className="button small" onClick={() => void store.select(data!.after?.entityId ?? data!.before!.entityId, { fly: true })}>Show on map</button>}
          <button className="icon-button small" onClick={() => store.closeSource()} aria-label="Close diff" autoFocus>✕</button>
        </span>
      </div>
      {diff.status === 'error' && <p className="note error" style={{ margin: 12 }}>{diff.error}</p>}
      {data && (data.notices.length > 0 || data.identical) && (
        <div style={{ padding: '0 12px' }}>
          {data.identical && <p className="note">No line differences{diff.ignoreWhitespace ? ' (ignoring whitespace)' : ''}: the change is elsewhere (position, metadata, relationships or findings).</p>}
          {data.notices.map(notice => <p key={notice} className="note warning">{notice}</p>)}
        </div>
      )}
      {data && hunks.length > 0 && (
        <div className="source-body" tabIndex={0} aria-label="Changed lines">
          {hunks.map((lines, index) => {
            const hunk = data.hunks[index]!;
            return (
              <div key={index} className="diff-hunk">
                <div className="hunk-header mono">@@ −{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@</div>
                {diff.layout === 'unified' ? (
                  <table className="source-table diff-table">
                    <tbody>
                      {lines.map((line, i) => (
                        <tr key={i} className={`diff-${line.kind}`}>
                          <td className="ln">{line.oldLine ?? ''}</td>
                          <td className="ln">{line.newLine ?? ''}</td>
                          <td className="sign" aria-label={line.kind === 'context' ? undefined : line.kind}>{sign(line.kind)}</td>
                          <td className="code" dangerouslySetInnerHTML={{ __html: line.html || ' ' }} />
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <table className="source-table diff-table split">
                    <tbody>
                      {splitRows(lines).map((row, i) => (
                        <tr key={i}>
                          <td className={`ln ${row.left ? `diff-${row.left.kind}` : 'diff-empty'}`}>{row.left?.oldLine ?? ''}</td>
                          <td className={`code half ${row.left ? `diff-${row.left.kind}` : 'diff-empty'}`} dangerouslySetInnerHTML={{ __html: row.left?.html || ' ' }} />
                          <td className={`ln ${row.right ? `diff-${row.right.kind}` : 'diff-empty'}`}>{row.right?.newLine ?? ''}</td>
                          <td className={`code half ${row.right ? `diff-${row.right.kind}` : 'diff-empty'}`} dangerouslySetInnerHTML={{ __html: row.right?.html || ' ' }} />
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
