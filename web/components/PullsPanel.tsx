'use client';
// The Pull requests panel: open work (the provider's open pull requests, and
// branches not merged yet), what was merged into the branch up to the commit
// the map shows (in the people window), and what was closed unmerged.
// Selecting one lights the files it changes (the camera frames the folders
// holding them); under it, its folders, the files not on the map, its commits
// and people, its blast radius and its list of files. The map never moves.
import { useEffect, useState, type ReactNode } from 'react';
import type { PullPerson, PullSource, PullState, PullSummary, PullsResult } from '@engine/projection/dto';
import { compactNumber, relativeTime, shortSha } from '../lib/format';
import type { PullsState } from '../lib/store';
import { familyCss, personHue, pullHue, themeById } from '../lib/themes';
import { useAtlas, useStore } from './context';
import { CommitList, KindTag, WindowPicker, windowText } from './PeoplePanel';

/** Rows shown before "Show all" in a pull request's folders, files and commits. */
const ROWS = 10;
const TABS: { key: PullsState['tab']; label: string; title: string }[] = [
  { key: 'open', label: 'Open', title: 'Open pull requests, and branches not merged yet' },
  { key: 'merged', label: 'Merged', title: 'Merged into the branch up to the commit the map shows, in the time window' },
  { key: 'closed', label: 'Closed', title: 'Closed without merging (GitHub only)' },
];
const STATE_TEXT: Record<PullState, string> = { open: 'open', merged: 'merged', closed: 'closed' };
const SOURCE_TAG: Partial<Record<PullSource, { text: string; title: string }>> = {
  'merge-message': { text: 'unverified', title: 'The number comes from the merge commit message. Git does not record pull requests: only the provider can confirm it.' },
  'squash-message': { text: 'unverified', title: 'The number comes from the "(#123)" at the end of the commit message, as GitHub writes it on a squash merge. Git does not record pull requests: only the provider can confirm it.' },
  merge: { text: 'merge', title: 'A merge commit that names no pull request: a branch merged into this one.' },
  branch: { text: 'branch', title: 'A branch not merged into the base yet. No pull request is known for it (start serve with --pr-metadata github to ask GitHub).' },
};
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
export function PullDot({ state }: { state: PullState }) {
  const dark = themeById(useAtlas(state => state.themeId)).dark;
  return <span className="domain-dot pull-dot" style={{ background: familyCss(pullHue(state), dark) }} title={STATE_TEXT[state]} />;
}
/** How a pull request is named: its number and title, or a branch's name. */
export function pullName(pull: Pick<PullSummary, 'number' | 'title' | 'source'>): string {
  return pull.number !== undefined ? `#${pull.number} ${pull.title}` : pull.source === 'branch' ? `Branch ${pull.title}` : `Merged ${pull.title}`;
}
export function SourceTag({ pull }: { pull: Pick<PullSummary, 'source' | 'draft'> }) {
  const tag = SOURCE_TAG[pull.source];
  return (
    <>
      {pull.draft && <span className="person-kind" title="A draft pull request">draft</span>}
      {tag && <span className={`person-kind pull-source ${pull.source}`} title={tag.title}>{tag.text}</span>}
    </>
  );
}
/** When it happened, in words: merged, closed, or last updated. */
export function pullWhen(pull: PullSummary): string {
  if (pull.state === 'merged' && pull.mergedAt) return `merged ${relativeTime(pull.mergedAt)}`;
  if (pull.state === 'closed' && pull.closedAt) return `closed ${relativeTime(pull.closedAt)}`;
  return pull.updatedAt ? `updated ${relativeTime(pull.updatedAt)}` : '';
}
/** Files and lines, or that they are not known yet. */
export function pullSize(pull: PullSummary): string {
  if (pull.files === undefined) return 'files not read yet';
  return `${compactNumber(pull.files)} file${pull.files === 1 ? '' : 's'} (+${compactNumber(pull.added ?? 0)} −${compactNumber(pull.deleted ?? 0)})`;
}
function ProviderLine({ data }: { data: PullsResult }) {
  const store = useStore();
  const refreshing = useAtlas(state => state.pulls.refreshing);
  const provider = data.provider;
  if (provider.status === 'off') return <p className="absent pulls-provider">From Git only. To list the open pull requests on GitHub too, start the server with <code>--pr-metadata github</code> (set <code>GITHUB_TOKEN</code> for a private repository).</p>;
  if (provider.status === 'unsupported') return <p className="absent pulls-provider">{provider.error ?? 'The origin remote is not on GitHub.'} From Git only.</p>;
  return (
    <div className={`pulls-provider${provider.status === 'error' ? ' error' : ''}`}>
      <span className="absent">GitHub {provider.repository}{provider.fetchedAt ? ` · read ${relativeTime(provider.fetchedAt)}` : ''}{provider.token ? '' : ' · no token'}</span>
      <button className="button tiny" onClick={() => void store.loadPulls({ refresh: true })} disabled={refreshing} title="Ask GitHub again">{refreshing ? 'Asking…' : 'Refresh'}</button>
      {provider.error && <p className="note error">{provider.error}</p>}
    </div>
  );
}

export function PullsPanel({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const pulls = useAtlas(state => state.pulls);
  const stamp = useAtlas(() => store.peopleStamp());
  const [query, setQuery] = useState(pulls.query);
  useEffect(() => { void store.ensurePulls(); }, [store, stamp]);
  // The merged ones are searched on the server: wait for a pause in typing.
  useEffect(() => { const timer = setTimeout(() => store.setPullsQuery(query.trim()), 250); return () => clearTimeout(timer); }, [store, query]);
  const data = pulls.data;
  const lists = { open: data?.open ?? [], merged: data?.merged ?? [], closed: data?.closed ?? [] };
  const counts = { open: lists.open.length, merged: data?.mergedTotal ?? 0, closed: lists.closed.length };
  const listed = lists[pulls.tab];
  const focused = data && pulls.focus ? [...lists.open, ...lists.merged, ...lists.closed].find(item => item.id === pulls.focus) ?? (pulls.pull?.id === pulls.focus ? pulls.pull.data?.pull : undefined) : undefined;
  return (
    <>
      <div className="panel-header">
        <h2>Pull requests</h2>
        <button className="icon-button small" onClick={onClose} aria-label="Hide the pull requests panel">⇤</button>
      </div>
      <div className="panel-body pulls-panel">
        <p className="note">What each pull request changes, on the map. Merged ones are read from the Git history (merge commits, and GitHub's and GitLab's merge and squash messages); open work from branches not merged into {data?.base ? <strong>{data.base.ref}</strong> : 'the branch'}. Select one to light the files it changes.</p>
        <div className="segmented pulls-tabs" role="tablist" aria-label="Pull requests">
          {TABS.filter(tab => tab.key !== 'closed' || counts.closed > 0 || data?.provider.status === 'ok').map(tab => (
            <button key={tab.key} role="tab" aria-selected={pulls.tab === tab.key} aria-pressed={pulls.tab === tab.key} onClick={() => store.setPullsTab(tab.key)} title={tab.title}>{tab.label} <span className="count">{data ? compactNumber(counts[tab.key]) : ''}</span></button>
          ))}
        </div>
        {pulls.tab === 'merged' && <WindowPicker />}
        {pulls.tab === 'merged' && data?.window && <p className="absent people-window-text">{windowText(data.window)}</p>}
        {pulls.status === 'loading' && !data && <div className="rf-loading" aria-live="polite"><span className="rf-spark" />Reading the Git history…</div>}
        {pulls.status === 'error' && <p className="note error">{pulls.error}</p>}
        {data && !data.available && <p className="note">{data.reason}</p>}
        {data?.available && (
          <>
            <ProviderLine data={data} />
            {focused && (
              <div className="feature-focus" role="status">
                <PullDot state={focused.state} />
                <span className="pull-focus-name">Lit: <strong>{pullName(focused)}</strong></span>
                <button className="button tiny" onClick={() => void store.openFiles({ kind: 'pull', key: focused.id })} title="The files of this view it changes, as a list">List files</button>
                <button className="button tiny" onClick={() => void store.showPullImpact(focused.id)} title="What depends on the code it changes, hop by hop">Impact</button>
                <button className="button tiny" onClick={() => void store.focusPull(undefined)}>✕ Show all</button>
              </div>
            )}
            <label className="sr-only" htmlFor="pulls-query">Filter pull requests</label>
            <input id="pulls-query" className="text-input rf-query" placeholder="Filter: #number, title, branch or author…" value={query} onChange={event => setQuery(event.target.value)} />
            {!listed.length && <p className="absent">{pulls.query ? 'None matches.' : pulls.tab === 'open' ? `No open work: every branch is merged into ${data.base?.ref ?? 'the base'}${data.provider.status === 'ok' ? ', and GitHub lists no open pull request' : ''}.` : pulls.tab === 'merged' ? 'Nothing was merged in this window.' : 'GitHub lists no pull request closed without merging lately.'}</p>}
            <ul className="tree pulls-tree">
              {listed.map(pull => <PullItem key={pull.id} pull={pull} />)}
            </ul>
            {pulls.tab === 'merged' && data.mergedTotal > lists.merged.length && <p className="absent">The latest {lists.merged.length} of {compactNumber(data.mergedTotal)} shown: filter to find older ones.</p>}
            {pulls.tab === 'open' && data.branchesTruncated && <p className="absent">Only the most recently committed branches are listed.</p>}
            {pulls.tab === 'open' && data.branchError && <p className="note error">Git could not list the branches: {data.branchError}</p>}
            {data.truncated && pulls.tab === 'merged' && <p className="absent">Only the newest commits were read; older pull requests are left out.</p>}
          </>
        )}
      </div>
    </>
  );
}
function PersonChip({ person }: { person: PullPerson }) {
  const dark = themeById(useAtlas(state => state.themeId)).dark;
  return (
    <span className="pull-person" title={person.login && person.login !== person.name ? `${person.name} (GitHub ${person.login})` : person.name}>
      <span className="domain-dot" style={{ background: person.order !== undefined ? familyCss(personHue(person.order), dark) : familyCss('none', dark) }} />{person.name}<KindTag kind={person.kind} />
    </span>
  );
}
function PullItem({ pull }: { pull: PullSummary }) {
  const store = useStore();
  const focus = useAtlas(state => state.pulls.focus);
  const open = useAtlas(state => state.pulls.open[pull.id] ?? false);
  const detail = useAtlas(state => state.pulls.pull?.id === pull.id ? state.pulls.pull : undefined);
  const historyOpen = useAtlas(state => state.timeline.open);
  const lit = focus === pull.id;
  const names = new Map(detail?.data?.people.flatMap(person => person.key ? [[person.key, person.name] as const] : []) ?? []);
  return (
    <li className={`tree-item${lit ? ' lit' : ''}`}>
      <div className="tree-row">
        <button className="tree-toggle" aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${pullName(pull)}`} onClick={() => store.setPullsOpen(pull.id, !open)}>{open ? '▾' : '▸'}</button>
        <button className="tree-label pull-label" aria-pressed={lit} onClick={() => void store.focusPull(pull.id, { fit: true })} title={lit ? 'Show every file again' : `Light the files ${pullName(pull)} changes`}>
          <PullDot state={pull.state} />
          <span className="label">{pull.number !== undefined && <span className="pull-number">#{pull.number}</span>}{pull.title}</span>
          <SourceTag pull={pull} />
          <span className="pull-meta">{[pull.author?.name, pullWhen(pull), pullSize(pull), pull.inView !== undefined && pull.files !== undefined && pull.inView < pull.files ? `${pull.inView} on the map` : ''].filter(Boolean).join(' · ')}</span>
        </button>
      </div>
      {open && (
        <div className="tree-children">
          <dl className="facts person-facts">
            {pull.headRef && <><dt>Branch</dt><dd className="mono">{pull.headRef}{pull.baseRef ? ` → ${pull.baseRef}` : ''}</dd></>}
            {pull.commit && <><dt>{pull.state === 'merged' ? 'Merged as' : 'Head'}</dt><dd className="mono">{shortSha(pull.commit)}</dd></>}
            {pull.createdAt && <><dt>Opened</dt><dd>{day(pull.createdAt)}</dd></>}
            {pull.mergedAt && <><dt>Merged</dt><dd>{day(pull.mergedAt)}</dd></>}
            {pull.closedAt && pull.state === 'closed' && <><dt>Closed</dt><dd>{day(pull.closedAt)}</dd></>}
            <dt>Commits</dt><dd>{pull.commits}{pull.state !== 'merged' && pull.source === 'github' && pull.commits === 0 ? ' (not in this repository)' : ''}</dd>
          </dl>
          <div className="pull-actions">
            {!lit && <button className="button tiny" onClick={() => void store.focusPull(pull.id, { fit: true })}>Light its files</button>}
            <button className="button tiny" onClick={() => void store.showPullImpact(pull.id)} title="What depends on the code it changes, hop by hop">Impact</button>
            <button className="button tiny" onClick={() => void store.openFiles({ kind: 'pull', key: pull.id })} title="The files of this view it changes, as a list">List files</button>
            {pull.snapshot && <button className="button tiny" onClick={() => void store.showCommit(pull.snapshot!)} title={historyOpen ? 'View its merge commit, compared with the one before' : 'Open History on its merge commit, compared with the one before'}>History</button>}
            {pull.url && <a className="button tiny" href={pull.url} target="_blank" rel="noreferrer" title="Open it on GitHub">GitHub ↗</a>}
          </div>
          {lit && detail?.status === 'loading' && !detail.data && <p className="absent">{pull.files === undefined ? 'Asking GitHub for its files…' : 'Placing its files on the map…'}</p>}
          {lit && detail?.status === 'error' && <p className="note error">{detail.error}</p>}
          {lit && detail?.data && (
            <>
              {detail.data.unknownReason && <p className="note">{detail.data.unknownReason}</p>}
              {detail.data.people.length > 0 && <div className="pull-people">{detail.data.people.map(person => <PersonChip key={person.key ?? person.name} person={person} />)}</div>}
              <Branch id={`${pull.id}:folders`} title="Folders" count={detail.data.folders.length} initiallyOpen>
                {(all: boolean) => (
                  <ul className="tree-leaves">
                    {(all ? detail.data!.folders : detail.data!.folders.slice(0, ROWS)).map(folder => (
                      <li key={folder.id}>
                        <button className="tree-leaf" onClick={() => void store.select(folder.id, { fly: true })} title={`Select ${folder.path} on the map: ${folder.files} file${folder.files === 1 ? '' : 's'} changed, ${folder.lines} lines`}>
                          <span className="mono label">{folder.path}</span><span className="count">{folder.files}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </Branch>
              {detail.data.outsideTotal > 0 && (
                <Branch id={`${pull.id}:outside`} title="Not on the map" count={detail.data.outside.length} total={detail.data.outsideTotal}>
                  {(all: boolean) => (
                    <ul className="tree-leaves">
                      {(all ? detail.data!.outside : detail.data!.outside.slice(0, ROWS)).map(file => (
                        <li key={file.path} className="tree-leaf pull-outside">
                          <span className="mono label" title={file.from ? `${file.from} → ${file.path}` : file.path}>{file.path.split('/').at(-1)}<span className="absent">{file.path.split('/').slice(0, -1).join('/')}</span></span><span className="count" title={file.status === 'added' ? 'A file it adds: not on the map of this commit' : 'Not on the map: gone since, or not analyzed'}>{file.status === 'added' ? 'new · ' : file.status === 'removed' ? 'deleted · ' : ''}+{file.added} −{file.deleted}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Branch>
              )}
              <Branch id={`${pull.id}:commits`} title="Commits" count={detail.data.commits.length} total={pull.commits} initiallyOpen>
                {(all: boolean) => <CommitList commits={all ? detail.data!.commits : detail.data!.commits.slice(0, ROWS)} names={names} />}
              </Branch>
            </>
          )}
        </div>
      )}
    </li>
  );
}
/** A collapsible list under a pull request, showing its first rows until "Show all". */
function Branch({ id, title, count, total, initiallyOpen = false, children }: { id: string; title: string; count: number; total?: number; initiallyOpen?: boolean; children: (all: boolean) => ReactNode }) {
  const store = useStore();
  const branches = useAtlas(state => state.pulls.open);
  const open = branches[id] ?? initiallyOpen;
  const all = branches[`${id}:all`] ?? false;
  return (
    <section className="tree-branch">
      <button className="tree-head" aria-expanded={open} onClick={() => store.setPullsOpen(id, !open)}>
        <span className="tree-chevron" aria-hidden>{open ? '▾' : '▸'}</span>{title}<span className="count">{total !== undefined && total > count ? `${count} of ${total}` : count}</span>
      </button>
      {open && (count ? children(all) : <p className="absent">None in this view.</p>)}
      {open && count > ROWS && <button className="button tiny" onClick={() => store.setPullsOpen(`${id}:all`, !all)}>{all ? 'Show fewer' : `Show all ${count}`}</button>}
    </section>
  );
}
