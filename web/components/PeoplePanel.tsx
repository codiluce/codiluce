'use client';
// The People panel: who changed which code, from the Git history, in a window
// of time. Selecting a person lights the files they changed (the camera frames
// the folders holding them); under them, their folders and their commits. The
// map itself never moves: files can also be colored by who changed each most.
import { useEffect, useState, type ReactNode } from 'react';
import type { AuthorshipCommit, AuthorshipWindow, AuthorshipWindowKey, PersonKind, PersonSummary } from '@engine/projection/dto';
import { compactNumber, shortSha } from '../lib/format';
import { familyCss, personHue, themeById } from '../lib/themes';
import { useAtlas, useStore } from './context';

/** Rows shown before "Show all" in a person's folders and commits. */
const ROWS = 10;
const WINDOWS: { key: AuthorshipWindowKey; label: string; title: string }[] = [
  { key: 'all', label: 'All', title: 'Every commit up to the one the map shows' },
  { key: '365d', label: 'Year', title: 'The year up to the commit the map shows' },
  { key: '90d', label: '90 days', title: 'The 90 days up to the commit the map shows' },
  { key: '30d', label: '30 days', title: 'The 30 days up to the commit the map shows' },
  { key: 'range', label: 'Compared', title: 'The commits between the two compared snapshots' },
];
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
/** What the figures cover, in words. */
export function windowText(window: AuthorshipWindow | undefined): string {
  if (!window) return '';
  const commits = `${compactNumber(window.commits)} commit${window.commits === 1 ? '' : 's'}`;
  if (window.key === 'range') return `${commits} between the compared snapshots (${shortSha(window.baseline)} → ${shortSha(window.anchor)})`;
  return window.since ? `${commits} from ${day(window.since)} to ${day(window.until)} (commit ${shortSha(window.anchor)})` : `${commits} up to ${day(window.until)} (commit ${shortSha(window.anchor)})`;
}
/** The window of every authorship figure: all of the history, the last year / 90 / 30 days, or (comparing) the compared commits. */
export function WindowPicker() {
  const store = useStore();
  const window = useAtlas(() => store.peopleWindow());
  const comparing = useAtlas(state => !!state.meta?.comparison);
  return (
    <div className="segmented people-window" role="group" aria-label="Time window">
      {WINDOWS.filter(item => item.key !== 'range' || comparing).map(item => <button key={item.key} aria-pressed={window === item.key} onClick={() => void store.setPeopleWindow(item.key)} title={item.title}>{item.label}</button>)}
    </div>
  );
}
export function PersonDot({ order }: { order: number }) {
  const dark = themeById(useAtlas(state => state.themeId)).dark;
  return <span className="domain-dot" style={{ background: familyCss(personHue(order), dark) }} />;
}
const KIND_TEXT: Record<PersonKind, string> = { human: '', agent: 'agent', bot: 'bot' };
const KIND_HINT: Record<PersonKind, string> = { human: '', agent: 'A coding agent, recognized by its name or address (for example a Co-authored-by trailer)', bot: 'An automation account (dependency updates, CI…), recognized by its name or address' };
export function KindTag({ kind }: { kind: PersonKind }) {
  return kind === 'human' ? null : <span className={`person-kind ${kind}`} title={KIND_HINT[kind]}>{KIND_TEXT[kind]}</span>;
}
/** Commits, newest first: subject, who, when, what they changed; those indexed open in History. */
export function CommitList({ commits, names }: { commits: AuthorshipCommit[]; names?: Map<string, string> }) {
  const store = useStore();
  const historyOpen = useAtlas(state => state.timeline.open);
  return (
    <ul className="commit-list">
      {commits.map(commit => (
        <li key={commit.sha} className="commit-row">
          <div className="commit-subject" title={commit.subject}>{commit.subject || <span className="absent">(no message)</span>}</div>
          <div className="commit-meta">
            <span className="mono">{shortSha(commit.sha)}</span>
            <span>{day(commit.authoredAt)}</span>
            {names && <span className="commit-people">{commit.people.map(key => names.get(key) ?? key).join(' + ')}</span>}
            <span className="commit-lines"><span className="added">+{compactNumber(commit.added)}</span> <span className="removed">−{compactNumber(commit.deleted)}</span>{commit.files > 1 ? ` · ${commit.files} files` : ''}</span>
            {commit.snapshot && <button className="button tiny" onClick={() => void store.showCommit(commit.snapshot!)} title={historyOpen ? 'View this commit, compared with the one before' : 'Open History on this commit, compared with the one before'}>History</button>}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function PeoplePanel({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const people = useAtlas(state => state.people);
  const stamp = useAtlas(() => store.peopleStamp());
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<PersonKind | 'all'>('all');
  useEffect(() => { void store.ensurePeople(); }, [store, stamp]);
  const data = people.data;
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const kinds = new Set(data?.people.map(person => person.kind));
  const listed = (data?.people ?? []).filter(person => (kind === 'all' || person.kind === kind) && (!words.length || words.every(word => [person.name, ...person.emails].join('\u0000').toLowerCase().includes(word))));
  const focused = data?.people.find(person => person.key === people.focus) ?? (people.person?.key === people.focus ? people.person?.data?.person : undefined);
  const most = Math.max(1, ...(data?.people.map(person => person.commits) ?? []));
  return (
    <>
      <div className="panel-header">
        <h2>People</h2>
        <button className="icon-button small" onClick={onClose} aria-label="Hide the people panel">⇤</button>
      </div>
      <div className="panel-body people-panel">
        <p className="note">Who changed which code, from the Git history: the author and co-authors of every commit, with the lines they added and deleted. Select a person to light the files they changed.</p>
        <WindowPicker />
        {data?.window && <p className="absent people-window-text">{windowText(data.window)}</p>}
        {people.status === 'loading' && !data && <div className="rf-loading" aria-live="polite"><span className="rf-spark" />Reading the Git history…</div>}
        {people.status === 'error' && <p className="note error">{people.error}</p>}
        {data && !data.available && <p className="note">{data.reason}</p>}
        {data?.available && (
          <>
            <label className="people-colors">
              <input type="checkbox" checked={people.show} onChange={event => void store.togglePeopleColors(event.target.checked)} />
              Color files by who changed them most
            </label>
            {focused && (
              <div className="feature-focus" role="status">
                <PersonDot order={focused.order} />
                <span>Lit: <strong>{focused.name}</strong></span>
                <button className="button tiny" onClick={() => void store.openFiles({ kind: 'person', key: focused.key })} title="The files they changed in this window, as a list">List files</button>
                <button className="button tiny" onClick={() => void store.focusPerson(undefined)}>✕ Show all</button>
              </div>
            )}
            {!data.people.length && <p className="absent">No commit changed files in this window.</p>}
            {data.people.length > 0 && (
              <>
                {data.people.length > 6 && (
                  <>
                    <label className="sr-only" htmlFor="people-query">Filter people</label>
                    <input id="people-query" className="text-input rf-query" placeholder="Filter: name or address…" value={query} onChange={event => setQuery(event.target.value)} />
                  </>
                )}
                {kinds.size > 1 && (
                  <div className="segmented compact people-kinds" role="group" aria-label="Kind">
                    {(['all', 'human', 'agent', 'bot'] as const).filter(item => item === 'all' || kinds.has(item)).map(item => (
                      <button key={item} aria-pressed={kind === item} onClick={() => setKind(item)}>{item === 'all' ? 'Everyone' : item === 'human' ? 'Humans' : item === 'agent' ? 'Agents' : 'Bots'} <span className="count">{item === 'all' ? data.people.length : data.people.filter(person => person.kind === item).length}</span></button>
                    ))}
                  </div>
                )}
                <ul className="tree people-tree">
                  {listed.map(person => <PersonItem key={person.key} person={person} share={person.commits / most} />)}
                </ul>
                {listed.length < data.people.length && <p className="absent">{listed.length} of {data.people.length} shown</p>}
              </>
            )}
            <p className="absent">{data.unchanged ? `${compactNumber(data.unchanged)} files of this view did not change in this window. ` : ''}People with several addresses are merged by address (GitHub no-reply addresses by login) and by full name; the repository's .mailmap is applied.{data.dirty ? ' Uncommitted changes are in no commit, so they are not counted.' : ''}{data.truncated ? ' Only the newest commits were read; older history is left out.' : ''}</p>
          </>
        )}
      </div>
    </>
  );
}
function PersonItem({ person, share }: { person: PersonSummary; share: number }) {
  const store = useStore();
  const focus = useAtlas(state => state.people.focus);
  const open = useAtlas(state => state.people.open[person.key] ?? false);
  const detail = useAtlas(state => state.people.person?.key === person.key ? state.people.person : undefined);
  const lit = focus === person.key;
  return (
    <li className={`tree-item${lit ? ' lit' : ''}`}>
      <div className="tree-row">
        <button className="tree-toggle" aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${person.name}`} onClick={() => store.setPeopleOpen(person.key, !open)}>{open ? '▾' : '▸'}</button>
        <button className="tree-label person-label" aria-pressed={lit} onClick={() => void store.focusPerson(person.key, { fit: true })} title={lit ? 'Show every file again' : `Light the ${person.files} files ${person.name} changed in this window`}>
          <PersonDot order={person.order} />
          <span className="label">{person.name}</span>
          <KindTag kind={person.kind} />
          <span className="count">{compactNumber(person.commits)} commit{person.commits === 1 ? '' : 's'} · {compactNumber(person.files)} file{person.files === 1 ? '' : 's'}</span>
          <span className="person-share" aria-hidden><span style={{ width: `${Math.max(2, share * 100)}%` }} /></span>
        </button>
      </div>
      {open && (
        <div className="tree-children">
          <dl className="facts person-facts">
            {person.emails.length > 0 && <><dt>Address{person.emails.length === 1 ? '' : 'es'}</dt><dd className="mono">{person.emails.join(', ')}</dd></>}
            <dt>Active</dt><dd>{day(person.first)}{person.first !== person.last ? ` – ${day(person.last)}` : ''}</dd>
            <dt>Lines changed</dt><dd title="Lines added plus deleted in the commits they took part in">{compactNumber(person.lines)}</dd>
            {person.coauthored > 0 && <><dt>Co-authored</dt><dd title="Commits naming them in a Co-authored-by trailer">{person.coauthored} of {person.commits} commits</dd></>}
          </dl>
          {!lit && <button className="button tiny" onClick={() => void store.focusPerson(person.key, { fit: true })}>Light their files · list folders and commits</button>}
          {lit && detail?.status === 'loading' && !detail.data && <p className="absent">Following their commits…</p>}
          {lit && detail?.status === 'error' && <p className="note error">{detail.error}</p>}
          {lit && detail?.data && (
            <>
              <Branch id={`${person.key}:folders`} title="Folders" count={detail.data.folders.length} initiallyOpen>
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
              <Branch id={`${person.key}:commits`} title="Commits" count={detail.data.commits.length} total={person.commits} initiallyOpen>
                {(all: boolean) => <CommitList commits={all ? detail.data!.commits : detail.data!.commits.slice(0, ROWS)} />}
              </Branch>
            </>
          )}
        </div>
      )}
    </li>
  );
}
/** A collapsible list under a person, showing its first rows until "Show all". */
function Branch({ id, title, count, total, initiallyOpen = false, children }: { id: string; title: string; count: number; total?: number; initiallyOpen?: boolean; children: (all: boolean) => ReactNode }) {
  const store = useStore();
  const branches = useAtlas(state => state.people.open);
  const open = branches[id] ?? initiallyOpen;
  const all = branches[`${id}:all`] ?? false;
  return (
    <section className="tree-branch">
      <button className="tree-head" aria-expanded={open} onClick={() => store.setPeopleOpen(id, !open)}>
        <span className="tree-chevron" aria-hidden>{open ? '▾' : '▸'}</span>{title}<span className="count">{total !== undefined && total > count ? `latest ${count} of ${total}` : count}</span>
      </button>
      {open && (count ? children(all) : <p className="absent">None in this view.</p>)}
      {open && count > ROWS && <button className="button tiny" onClick={() => store.setPeopleOpen(`${id}:all`, !all)}>{all ? 'Show fewer' : `Show all ${count}`}</button>}
    </section>
  );
}
