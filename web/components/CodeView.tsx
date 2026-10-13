'use client';
// The code of the selection in the middle of the screen: a file whole, a
// symbol in its file with its lines marked, beside the file's outline; an
// area lists what it holds, to go down into it. It follows the selection
// while it is in front (the map, search, the inspector, a call mark or the
// outline), and the overview map keeps the selection and what it is
// connected to lit.
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { NodeSummary } from '@engine/projection/dto';
import { typeLabel } from '../lib/format';
import { highlightLines } from '../lib/highlight';
import { isContainer } from '../lib/store';
import { themeById } from '../lib/themes';
import { useAtlas, useStore } from './context';
import { CopyButton } from './FilesView';
import { CallMark, useCallMarks, where } from './SourcePanel';
import { TypeBadge } from './TypeBadge';

export function CodeView() {
  const store = useStore();
  const code = useAtlas(state => state.code);
  const selected = useAtlas(state => state.selection?.id);
  if (!code) return null;
  const node = code.node;
  const area = !!node && (isContainer(node) || !node.path);
  return (
    <section className="tool-view code-view" role="region" aria-label={node ? `Code of ${node.name}` : 'Code'}>
      <header className="tool-head">
        <div className="tool-title">
          {node ? <h2><TypeBadge type={node.type} role={node.role} kind={node.kind} /> {node.name}</h2> : <h2>Code</h2>}
          <span className="absent mono code-path">
            {code.data ? `${code.data.file.path} · ${code.data.totalLines} lines${code.data.snapshot?.kind === 'commit' ? ` ${where(code.data.snapshot)}` : ''}`
              : node?.path ?? (node ? `${typeLabel(node.type, node.role)}: choose a file inside to read it` : 'Select a file or a symbol to read its code')}
          </span>
        </div>
        <div className="tool-actions">
          {code.status === 'loading' && <span className="absent">reading…</span>}
          {code.data && <CopyButton text={() => code.data!.file.path} label="Copy path" title="Copy the path of the file" />}
          {node && <button className="button small primary" onClick={() => { store.setCenter('map'); store.navigator?.flyTo(node, { mode: isContainer(node) ? 'enter' : 'focus' }); }} title="Back to the map, on this">Show on map</button>}
          <button className="icon-button small" onClick={() => store.closeCode()} aria-label="Close the code">✕</button>
        </div>
      </header>
      {code.status === 'error' && <p className="note error" style={{ margin: '10px 16px' }}>{code.error}</p>}
      {!node && <div className="tool-body"><p className="absent">Select a file or a symbol — on the map, in search, in the inspector — and its code shows here. Select a folder to list what it holds.</p></div>}
      {area && <AreaList id={code.forId!} selected={selected} />}
      {!area && node && <CodeBody />}
    </section>
  );
}

/** What an area holds, folders first, to go down into it. */
function AreaList({ id, selected }: { id: string; selected?: string }) {
  const store = useStore();
  useAtlas(state => state.sceneRevision);
  const list = store.scene.children.get(id);
  const items = (list?.ids ?? []).flatMap(child => { const node = store.scene.nodes.get(child); return node ? [node] : []; })
    .sort((a, b) => Number(isContainer(b)) - Number(isContainer(a)) || a.name.localeCompare(b.name));
  return (
    <div className="tool-body">
      {!list?.complete && !items.length && <div className="rf-loading"><span className="rf-spark" />Listing…</div>}
      {list?.complete && !items.length && <p className="absent">Nothing indexed inside.</p>}
      {items.length > 0 && (
        <ul className="code-area" aria-label="Inside">
          {items.map(item => (
            <li key={item.id} className={selected === item.id ? 'selected' : undefined}>
              <button onClick={() => void store.select(item.id, { fly: true })} title={item.path ?? item.name}>
                <span className="code-area-icon" aria-hidden>{isContainer(item) ? '▸' : ''}</span>
                <span className="mono">{item.name}{isContainer(item) ? '/' : ''}</span>
                <span className="absent">{isContainer(item) ? `${item.stats.files} file${item.stats.files === 1 ? '' : 's'}` : item.loc !== undefined ? `${item.loc} lines` : typeLabel(item.type, item.role)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {list && !list.complete && items.length > 0 && <p className="absent">{items.length} of {list.total} listed.</p>}
    </div>
  );
}

function CodeBody() {
  const store = useStore();
  const code = useAtlas(state => state.code)!;
  const data = code.data;
  const body = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const html = useMemo(() => data ? highlightLines(data.lines, data.file.language) : [], [data?.lines, data?.file.language]);
  const marks = useCallMarks(data?.file.path);
  const focus = data?.focus;
  // A new entity (or the same file read again): bring its lines into view.
  const shownFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!data || !body.current || code.status !== 'ready') return;
    const key = `${code.stamp}|${focus?.startLine ?? 0}`;
    if (shownFor.current === key) return;
    shownFor.current = key;
    const target = body.current.querySelector<HTMLElement>('tr.focus');
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // The symbol's first line a few lines below the top, as an editor opens it (centered when it is short).
    const at = target ? target.getBoundingClientRect().top - body.current.getBoundingClientRect().top + body.current.scrollTop : 0;
    const top = !target ? 0 : focus && (focus.endLine - focus.startLine + 1) * target.offsetHeight < body.current.clientHeight / 2
      ? at - body.current.clientHeight / 3 : at - 4 * target.offsetHeight;
    body.current.scrollTo({ top: Math.max(0, top), behavior: smooth && target ? 'smooth' : 'auto' });
  }, [data, code.stamp, code.status, focus?.startLine]);
  // Lines read above those shown: keep the same lines under the eye.
  const before = useRef<{ start: number; height: number; top: number } | undefined>(undefined);
  useLayoutEffect(() => {
    const element = body.current, previous = before.current;
    if (element && data && previous && data.start < previous.start) element.scrollTop = previous.top + (element.scrollHeight - previous.height);
    before.current = undefined;
  }, [data?.start]);
  const readEarlier = () => {
    if (body.current && data) before.current = { start: data.start, height: body.current.scrollHeight, top: body.current.scrollTop };
    void store.codeMore('earlier');
  };
  // Reading down to the end of what is shown reads on.
  useEffect(() => {
    const element = end.current, root = body.current;
    if (!element || !root || !data || data.end >= data.totalLines) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) void store.codeMore('later'); }, { root, rootMargin: '0px 0px 400px 0px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [store, data?.end, data?.totalLines]);
  return (
    <div className="code-layout">
      <Outline />
      <div className="code-main">
        {data && (data.changedSinceIndex || data.notices.length > 0) && (
          <div className="code-notes">{data.notices.map(notice => <p key={notice} className={`note ${data.changedSinceIndex ? 'warning' : ''}`}>{notice}</p>)}</div>
        )}
        {!data && code.status === 'loading' && <div className="rf-loading" style={{ margin: 16 }}><span className="rf-spark" />Reading the file…</div>}
        {data && (
          <div className="source-body code-body" ref={body} tabIndex={0} aria-label={`Source of ${data.file.path}`}>
            {data.start > 1 && <button className="source-more" onClick={readEarlier} disabled={!!code.more}>{code.more === 'earlier' ? 'Reading…' : `Read lines ${Math.max(1, data.start - 400)}–${data.start - 1}`}</button>}
            <table className="source-table">
              <tbody>
                {html.map((line, index) => {
                  const number = data.start + index;
                  const inFocus = !!focus && number >= focus.startLine && number <= focus.endLine;
                  return (
                    <tr key={number} className={inFocus ? `focus${number === focus!.startLine ? ' focus-edge' : ''}` : undefined} data-line={number}>
                      <td className="ln">{number}</td>
                      <td className="mark-cell">{marks.get(number) && <CallMark targets={marks.get(number)!} />}</td>
                      <td className="code" dangerouslySetInnerHTML={{ __html: line || ' ' }} />
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div ref={end} />
            {data.end < data.totalLines && <button className="source-more" onClick={() => void store.codeMore('later')} disabled={!!code.more}>{code.more === 'later' ? 'Reading…' : `Read lines ${data.end + 1}–${Math.min(data.totalLines, data.end + 400)} of ${data.totalLines}`}</button>}
            {data.truncated && data.end >= data.totalLines && <p className="absent" style={{ padding: '4px 12px' }}>Very long lines are cut short.</p>}
          </div>
        )}
      </div>
    </div>
  );
}

/** The symbols of the file shown, in source order; the one selected (or holding the marked lines) is current. */
function Outline() {
  const store = useStore();
  const code = useAtlas(state => state.code)!;
  const theme = themeById(useAtlas(state => state.themeId));
  const outline = code.outline?.fileId === code.data?.file.id ? code.outline : undefined;
  const file = code.data?.file;
  if (!file) return <nav className="code-outline" aria-label="Outline" />;
  const current = code.forId;
  const dot = (node: NodeSummary) => { const base = theme.entity[node.type] ?? theme.fallbackEntity; return `hsl(${base.h} ${base.s}% ${base.l}%)`; };
  return (
    <nav className="code-outline" aria-label={`Outline of ${file.path}`}>
      <button className={`code-outline-item file${current === file.id ? ' current' : ''}`} onClick={() => void store.select(file.id, { fly: true })} title={`${file.path}: the whole file`}>
        <span className="mono">{file.path.split('/').at(-1)}</span>
      </button>
      {outline?.status === 'loading' && <p className="absent">…</p>}
      {outline?.items.map(item => (
        <button key={item.id} className={`code-outline-item level-${item.level}${current === item.id ? ' current' : ''}`} onClick={() => void store.select(item.id, { fly: true })} title={`${typeLabel(item.type, item.role)} ${item.name}${item.sourceRange ? ` · lines ${item.sourceRange.startLine}–${item.sourceRange.endLine}` : ''}`}>
          <span className="type-dot" style={{ background: dot(item) }} aria-hidden />
          <span className="mono code-outline-name">{item.name}</span>
          {item.sourceRange && <span className="code-outline-line">{item.sourceRange.startLine}</span>}
        </button>
      ))}
      {outline?.status === 'ready' && outline.items.length === 0 && <p className="absent">No symbols indexed in this file.</p>}
    </nav>
  );
}
