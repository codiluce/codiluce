'use client';
// The files a highlight lights on the map, as a list in the middle of the
// screen: a feature's code files, a data family's files, a coverage category,
// the files a person changed. Grouped by folder, filterable, and copied as
// paths; the overview map keeps the same files lit.
import { useMemo, useState } from 'react';
import type { CoverageCategory, FileListResult } from '@engine/projection/dto';
import { COVERAGE_TEXT } from '../lib/coverage';
import type { FilesState } from '../lib/store';
import { useAtlas, useStore } from './context';
import { windowText } from './PeoplePanel';

const KIND_TEXT: Record<FilesState['kind'], string> = { feature: 'Feature', family: 'Data family', coverage: 'Coverage', person: 'Changed by' };
/** The name of a list of files: what it is of. */
export function filesTitle(files: Pick<FilesState, 'kind' | 'key'>, data?: FileListResult): string {
  const name = files.kind === 'coverage' ? COVERAGE_TEXT[files.key as CoverageCategory] ?? files.key : data?.title ?? '…';
  return `${KIND_TEXT[files.kind]}: ${name}`;
}
/** Copy text to the clipboard (computed on click), saying so for a moment. */
export function CopyButton({ text, label = 'Copy', title, disabled }: { text: () => string; label?: string; title?: string; disabled?: boolean }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = async () => {
    const value = text();
    try { await navigator.clipboard.writeText(value); setState('copied'); }
    catch {
      // Without the clipboard API (an insecure origin), select the text in a hidden field and copy that.
      const field = document.createElement('textarea');
      field.value = value; field.setAttribute('readonly', ''); field.style.position = 'fixed'; field.style.opacity = '0';
      document.body.appendChild(field); field.select();
      const done = document.execCommand?.('copy') ?? false;
      field.remove();
      setState(done ? 'copied' : 'failed');
    }
    setTimeout(() => setState('idle'), 1600);
  };
  return <button className="button small" onClick={() => void copy()} disabled={disabled} title={title} aria-live="polite">{state === 'copied' ? 'Copied ✓' : state === 'failed' ? 'Copy failed' : label}</button>;
}
const folderOf = (path: string) => { const at = path.lastIndexOf('/'); return at < 0 ? '' : path.slice(0, at); };

export function FilesView() {
  const store = useStore();
  const files = useAtlas(state => state.files);
  const window = useAtlas(state => state.files?.kind === 'person' ? state.people.person?.data?.window : undefined);
  const selected = useAtlas(state => state.selection?.id);
  const [query, setQuery] = useState('');
  const data = files?.status !== 'error' ? files?.data : undefined;
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const listed = useMemo(() => (data?.files ?? []).filter(file => words.every(word => file.path.toLowerCase().includes(word))), [data, words.join(' ')]);
  const folders = useMemo(() => {
    const byFolder = new Map<string, typeof listed>();
    for (const file of listed) { const folder = folderOf(file.path); byFolder.set(folder, [...byFolder.get(folder) ?? [], file]); }
    return [...byFolder];
  }, [listed]);
  if (!files) return null;
  const title = filesTitle(files, data);
  return (
    <section className="tool-view files-view" role="region" aria-label={`Files lit: ${title}`}>
      <header className="tool-head">
        <div className="tool-title">
          <h2>{title}</h2>
          <span className="absent">
            {data ? `${data.files.length} file${data.files.length === 1 ? '' : 's'} lit on the map` : 'Listing the files…'}
            {window ? ` · ${windowText(window)}` : ''}
          </span>
        </div>
        <div className="tool-actions">
          <CopyButton text={() => listed.map(file => file.path).join('\n')} disabled={!listed.length} label={words.length ? `Copy ${listed.length} paths` : 'Copy paths'} title="Copy the paths of the files listed, one per line" />
          <button className="button small primary" onClick={() => store.setCenter('map')} title="Back to the map, with these files lit">Show on map</button>
          <button className="icon-button small" onClick={() => store.closeFiles()} aria-label="Close the list of files">✕</button>
        </div>
      </header>
      <div className="tool-body">
        {files.status === 'error' && <p className="note error">{files.error}</p>}
        {files.status === 'loading' && !data && <div className="rf-loading"><span className="rf-spark" />Listing the files…</div>}
        {data && data.files.length === 0 && <p className="absent">No file of this view is lit.</p>}
        {data && data.files.length > 0 && (
          <>
            <label className="sr-only" htmlFor="files-query">Filter files</label>
            <input id="files-query" className="text-input" placeholder="Filter by path…" value={query} onChange={event => setQuery(event.target.value)} />
            {words.length > 0 && <p className="absent">{listed.length} of {data.files.length} shown</p>}
            <ul className="files-folders" aria-label="Files by folder">
              {folders.map(([folder, items]) => (
                <li key={folder}>
                  <div className="files-folder"><span className="mono">{folder || '(top level)'}</span><span className="count">{items.length}</span></div>
                  <ul className="files-list">
                    {items.map(file => (
                      <li key={file.id} className={selected === file.id ? 'selected' : undefined}>
                        <button className="files-file" onClick={() => void store.select(file.id, { fly: false })} title={`${file.path}: select it (the inspector shows it)`}><span className="mono">{file.name}</span></button>
                        <button className="button tiny" onClick={() => { store.setCenter('map'); void store.select(file.id, { fly: true }); }} aria-label={`Go to ${file.path} on the map`}>Go</button>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}
