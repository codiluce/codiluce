'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { TimelineEntry, TimelineResponse } from '@engine/projection/dto';
import { compactNumber, shortSha } from '../lib/format';
import { entryOf, predecessor, timelineIndex, type AtlasStore } from '../lib/store';
import { useAtlas, useStore } from './context';
import { CommitImpactChip } from './Analysis';

const SCRUB_MS = 140;
const SPEEDS = [0.5, 1, 2, 4];
/** The snapshot on screen: the time-lapse frame while scrubbing or playing, otherwise the viewed one. */
function shownSnapshot(store: AtlasStore, timeline: { preview?: number; target?: string }): string | undefined {
  return timeline.preview !== undefined && store.evolution ? store.evolution.snapshotAt(timeline.preview) : timeline.target;
}
function formatDate(iso: string): string { const date = new Date(iso); return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
function label(data: TimelineResponse | undefined, id: string | undefined): string {
  if (!id || id === data?.workingTree?.id) return 'Working tree';
  const entry = entryOf(data, id);
  return entry ? `${shortSha(entry.sha)} · ${entry.subject}` : 'Snapshot';
}
/** Year (or month, when the range is short) boundaries along the track. */
function axisMarks(entries: TimelineEntry[]): { index: number; text: string }[] {
  if (!entries.length) return [];
  const span = Date.parse(entries.at(-1)!.committedAt) - Date.parse(entries[0]!.committedAt);
  const monthly = span < 400 * 86_400_000;
  const marks: { index: number; text: string }[] = [];
  let previous = '';
  entries.forEach((entry, index) => {
    const date = new Date(entry.committedAt);
    const key = monthly ? `${date.getFullYear()}-${date.getMonth()}` : String(date.getFullYear());
    if (key !== previous) { marks.push({ index, text: monthly ? date.toLocaleDateString(undefined, { month: 'short', year: '2-digit' }) : String(date.getFullYear()) }); previous = key; }
  });
  return marks;
}

export function Timeline() {
  const store = useStore();
  const timeline = useAtlas(state => state.timeline);
  const meta = useAtlas(state => state.meta);
  const data = timeline.data;
  const close = () => void store.closeTimeline();
  if (timeline.status === 'loading' && !data) return <section className="timeline" aria-label="History"><div className="timeline-empty"><div className="spinner small" />Loading history…</div></section>;
  if (timeline.status === 'error' && !data) return <section className="timeline" aria-label="History"><div className="timeline-empty"><span className="note error">{timeline.error}</span><button className="icon-button small" onClick={close} aria-label="Close history">✕</button></div></section>;
  if (!data) return null;
  if (!data.available) return (
    <section className="timeline" aria-label="History">
      <div className="timeline-empty">
        <span><strong>No history indexed yet.</strong> {data.reason}</span>
        <button className="icon-button small" onClick={close} aria-label="Close history">✕</button>
      </div>
    </section>
  );
  const shown = shownSnapshot(store, timeline);
  const target = entryOf(data, shown);
  const comparison = meta?.comparison;
  const summary = comparison?.summary;
  // A time-lapse frame: what that commit changed, until the view settles on it.
  const frameCounts = timeline.preview !== undefined && store.evolution && timeline.preview > 0 ? store.evolution.counts(timeline.preview) : undefined;
  const indexed = data.entries.filter(entry => entry.snapshot).length;
  return (
    <section className="timeline" aria-label="History">
      <div className="timeline-head">
        <PlayButton />
        <div className="timeline-nav" role="group" aria-label="Step through indexed commits">
          <button className="icon-button small" onClick={() => void store.stepTarget(-1)} aria-label="Previous indexed commit" title="Previous indexed commit (←)">◀</button>
          <button className="icon-button small" onClick={() => void store.stepTarget(1)} aria-label="Next indexed commit" title="Next indexed commit (→)">▶</button>
        </div>
        <div className="timeline-target" aria-live="polite">
          {target ? (
            <>
              <span className="mono sha">{shortSha(target.sha)}</span>
              {target.note && <span className={`intent-chip i-${target.note.intent}`} title="Kind of change, from a language model's reading of the commit">{target.note.intent}</span>}
              <span className="subject" title={target.note ? `${target.note.summary}\n\nCommit message: ${target.subject}` : target.subject}>{target.note?.title ?? target.subject}</span>
              <span className="meta">{target.authorName} · {formatDate(target.authoredAt)}</span>
              {target.pullRequest && <PullRequestChip entry={target} />}
              {target.merge && !target.pullRequest && <span className="chip" title="Merge commit. Git does not record whether it came from a pull request.">merge</span>}
              {target.snapshot?.stale && <span className="chip warning" title="This snapshot was analyzed with another configuration or analyzer version. Re-run history index to refresh it.">stale analysis</span>}
            </>
          ) : (
            <>
              <span className="mono sha">live</span>
              <span className="subject">Working tree{data.workingTree?.commitSha ? ` at ${shortSha(data.workingTree.commitSha)}` : ''}{data.workingTree?.dirty ? ' + uncommitted changes' : ''}</span>
            </>
          )}
          {timeline.switching && <span className="spinner tiny" aria-label="Loading snapshot" />}
        </div>
        {timeline.evolution.status === 'ready' && (
          <div className="timeline-play" role="group" aria-label="Time-lapse">
            <button className="chip" onClick={() => store.setSpeed(SPEEDS[(SPEEDS.indexOf(timeline.speed) + 1) % SPEEDS.length]!)} title="Playback speed" aria-label={`Playback speed ${timeline.speed}×`}>{timeline.speed}×</button>
            <button className="chip" aria-pressed={timeline.follow} onClick={() => store.setFollow(!timeline.follow)} title="While playing, the camera follows where the code changes">Follow</button>
          </div>
        )}
        <div className="timeline-compare">
          <div className="segmented" role="group" aria-label="View mode">
            <button aria-pressed={!timeline.compare} onClick={() => void store.setCompare(false)}>Snapshot</button>
            <button aria-pressed={timeline.compare} onClick={() => void store.setCompare(true)} disabled={!data.entries.some(entry => entry.snapshot)}>Compare</button>
          </div>
          {timeline.compare && timeline.baseline && (
            <span className="baseline">
              vs <span className="mono" title={label(data, timeline.baseline)}>{label(data, timeline.baseline).split(' · ')[0]}</span>
              <button className={`chip${timeline.pinned ? ' pinned' : ''}`} aria-pressed={timeline.pinned} onClick={() => void store.setPinned(!timeline.pinned)} title={timeline.pinned ? 'Baseline is pinned: moving the target keeps it. Click to follow the previous commit again.' : 'Baseline follows the previous indexed commit. Click to keep it while you move the target.'}>{timeline.pinned ? 'pinned' : 'previous'}</button>
            </span>
          )}
          {comparison && <button className="chip" aria-pressed={timeline.dimUnchanged} onClick={() => store.toggleDimUnchanged()} title="Fade areas with no changes">Dim unchanged</button>}
        </div>
        <button className="icon-button small" onClick={close} aria-label="Close history" title="Back to the live map">✕</button>
      </div>
      {frameCounts ? (
        <div className="timeline-summary" aria-label="Changes in this commit">
          {(['added', 'modified', 'moved', 'removed'] as const).map(status => (
            <span key={status} className={`change-chip ${status}${frameCounts[status] ? '' : ' none'}`}><span className="glyph" aria-hidden>{({ added: '+', modified: '~', moved: '→', removed: '−' } as const)[status]}</span>{compactNumber(frameCounts[status])} {status}</span>
          ))}
          <span className="sep" />
          <span className="change-stat">commit {timeline.preview! + 1} of {store.evolution!.length}{timeline.playing ? ' · playing' : ''}</span>
        </div>
      ) : summary && (
        <div className="timeline-summary" aria-label="Changes in this comparison">
          {(['added', 'modified', 'moved', 'removed'] as const).map(status => (
            <button key={status} className={`change-chip ${status}`} onClick={() => { store.clearSelection(); void store.loadChanges(status); }} title={`Show ${status} entities in the inspector`} disabled={!summary.entities[status]}>
              <span className="glyph" aria-hidden>{({ added: '+', modified: '~', moved: '→', removed: '−' } as const)[status]}</span>{compactNumber(summary.entities[status])} {status}
            </button>
          ))}
          <span className="sep" />
          <span className="change-stat" title="Relationships added / removed">edges <span className="added">+{summary.relations.added}</span> <span className="removed">−{summary.relations.removed}</span></span>
          <span className="change-stat" title="Unresolved findings added / resolved">findings <span className="added">+{summary.diagnostics.added}</span> <span className="removed">−{summary.diagnostics.removed}</span></span>
          <span className="change-stat" title="Measured lines in files">lines {compactNumber(summary.files.locBefore)} → {compactNumber(summary.files.locAfter)}</span>
          <CommitImpactChip />
          {comparison.analyzerMismatch && <span className="chip warning" title="The two snapshots were analyzed by different analyzer versions; some differences may come from the analysis rather than the code. Reindex to compare like with like.">different analyzer versions</span>}
        </div>
      )}
      <Track data={data} />
      <div className="timeline-foot">
        <span>{data.ref} · first-parent history · {data.entries.length} commits, {indexed} indexed</span>
        {data.indexing.active && <span className="chip"><span className="spinner tiny" /> indexing {shortSha(data.indexing.active)}{data.indexing.queued.length ? ` (+${data.indexing.queued.length} queued)` : ''}</span>}
        {timeline.notice && <span className="note warning inline">{timeline.notice}</span>}
        {timeline.error && <span className="note error inline">{timeline.error}</span>}
      </div>
    </section>
  );
}
function PullRequestChip({ entry }: { entry: TimelineEntry }) {
  const pr = entry.pullRequest!;
  const verified = pr.source === 'github';
  const text = `#${pr.number}${pr.title ? ` ${pr.title}` : ''}`;
  const title = verified ? `Pull request from the GitHub API${pr.author ? ` by ${pr.author}` : ''}` : 'Inferred from the commit message (unverified: Git does not record pull requests)';
  return pr.url ? <a className={`chip pr${verified ? '' : ' unverified'}`} href={pr.url} target="_blank" rel="noreferrer" title={title}>PR {text}</a> : <span className={`chip pr${verified ? '' : ' unverified'}`} title={title}>PR {text}{verified ? '' : '?'}</span>;
}

/** The commit track: ticks per first-parent commit, a size sparkline, target/baseline handles and the compared range. */
function Track({ data }: { data: TimelineResponse }) {
  const store = useStore();
  const timeline = useAtlas(state => state.timeline);
  const svg = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<number>();
  const [picked, setPicked] = useState<number>();
  const scrub = useRef<{ timer?: ReturnType<typeof setTimeout>; dragging: boolean }>({ dragging: false });
  useEffect(() => {
    if (!svg.current) return;
    const observer = new ResizeObserver(entries => setWidth(Math.max(200, Math.round(entries[0]!.contentRect.width))));
    observer.observe(svg.current);
    return () => observer.disconnect();
  }, []);
  const count = data.entries.length + (data.workingTree ? 1 : 0);
  const chapters = data.chapters ?? [];
  const pad = 14, height = chapters.length ? 80 : 64, base = 46;
  const [chapterHover, setChapterHover] = useState<number>();
  const chapterSpan = (chapter: NonNullable<TimelineResponse['chapters']>[number]) => {
    const from = data.entries.findIndex(entry => entry.sha.startsWith(chapter.from)), to = data.entries.findIndex(entry => entry.sha.startsWith(chapter.to));
    return from >= 0 && to >= from ? { from, to } : undefined;
  };
  /** Compare a whole chapter: its last commit against the one before its first. */
  const openChapter = (chapter: NonNullable<TimelineResponse['chapters']>[number]) => {
    const span = chapterSpan(chapter);
    if (!span) return;
    const target = data.entries.slice(span.from, span.to + 1).reverse().find(entry => entry.snapshot)?.snapshot?.id;
    const baseline = data.entries.slice(0, span.from).reverse().find(entry => entry.snapshot)?.snapshot?.id;
    if (!target) return;
    void (async () => { await store.setTarget(target); if (baseline) await store.setBaseline(baseline); })();
  };
  const x = (index: number) => pad + (count <= 1 ? 0 : (index / (count - 1)) * (width - pad * 2));
  const indexAt = (clientX: number) => {
    const box = svg.current!.getBoundingClientRect();
    return Math.max(0, Math.min(count - 1, Math.round(((clientX - box.left - pad) / Math.max(1, box.width - pad * 2)) * (count - 1))));
  };
  /** Nearest snapshot to a track position (unindexed commits cannot be viewed). */
  const nearestIndexed = (index: number): number | undefined => {
    for (let distance = 0; distance < count; distance++) for (const candidate of [index - distance, index + distance]) {
      if (candidate === data.entries.length && data.workingTree) return candidate;
      if (data.entries[candidate]?.snapshot) return candidate;
    }
    return undefined;
  };
  const idAt = (index: number) => index === data.entries.length ? undefined : data.entries[index]?.snapshot?.id;
  const shown = shownSnapshot(store, timeline);
  // A time-lapse frame compares with the previous commit (unless a baseline is pinned).
  const baselineId = timeline.compare ? (timeline.preview !== undefined && !timeline.pinned ? predecessor(data, shown) : timeline.baseline) : undefined;
  const targetIndex = timelineIndex(data, shown), baselineIndex = baselineId ? timelineIndex(data, baselineId) : -1;
  const sparkline = useMemo(() => {
    const points = data.entries.map((entry, index) => ({ index, loc: entry.snapshot?.stats.loc })).filter((point): point is { index: number; loc: number } => point.loc !== undefined);
    const max = Math.max(1, ...points.map(point => point.loc));
    return { points, max };
  }, [data]);
  const marks = useMemo(() => axisMarks(data.entries), [data]);
  /** Dragging shows the time-lapse frame at once when it is loaded (otherwise the commit after a short pause); releasing settles there. */
  const choose = (index: number | undefined, release: boolean) => {
    if (index === undefined) return;
    if (scrub.current.timer) clearTimeout(scrub.current.timer);
    if (store.scrubTo(idAt(index))) { if (release) void store.settle(); return; }
    const apply = () => void store.setTarget(idAt(index));
    if (release) apply(); else scrub.current.timer = setTimeout(apply, SCRUB_MS);
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    const keys: Record<string, () => void> = {
      ArrowLeft: () => void (event.shiftKey ? moveBaseline(-1) : store.stepTarget(-1)), ArrowRight: () => void (event.shiftKey ? moveBaseline(1) : store.stepTarget(1)),
      Home: () => choose(nearestIndexed(0), true), End: () => choose(count - 1 === data.entries.length && data.workingTree ? count - 1 : nearestIndexed(count - 1), true),
      ' ': () => store.togglePlay(),
    };
    const action = keys[event.key];
    if (!action) return;
    event.preventDefault(); action();
  };
  const moveBaseline = (delta: number) => {
    const start = baselineIndex >= 0 ? baselineIndex : targetIndex;
    for (let index = start + delta; index >= 0 && index < data.entries.length; index += delta) if (data.entries[index]!.snapshot && index !== targetIndex) return store.setBaseline(data.entries[index]!.snapshot!.id);
    return Promise.resolve();
  };
  const hovered = hover !== undefined ? (hover === data.entries.length ? undefined : data.entries[hover]) : undefined;
  const pickedEntry = picked !== undefined ? data.entries[picked] : undefined;
  return (
    <div className="timeline-track">
      <svg
        ref={svg} width="100%" height={height} role="slider" tabIndex={0}
        aria-label="Commit timeline. Left and right arrows step through indexed commits; Shift with arrows moves the comparison baseline; Space plays the history."
        aria-valuemin={0} aria-valuemax={count - 1} aria-valuenow={targetIndex} aria-valuetext={label(data, timeline.target)}
        onKeyDown={onKeyDown}
        onPointerDown={event => { (event.target as Element).setPointerCapture?.(event.pointerId); scrub.current.dragging = true; const index = indexAt(event.clientX); setPicked(undefined); if (data.entries[index] && !data.entries[index]!.snapshot) { setPicked(index); scrub.current.dragging = false; return; } choose(nearestIndexed(index), false); }}
        onPointerMove={event => { const index = indexAt(event.clientX); setHover(index); if (scrub.current.dragging) choose(nearestIndexed(index), false); }}
        onPointerUp={event => { if (scrub.current.dragging) choose(nearestIndexed(indexAt(event.clientX)), true); scrub.current.dragging = false; }}
        onPointerLeave={() => { if (!scrub.current.dragging) setHover(undefined); }}
      >
        {sparkline.points.length > 1 && <path className="spark" d={`M ${x(sparkline.points[0]!.index)} ${base} ${sparkline.points.map(point => `L ${x(point.index).toFixed(1)} ${(base - 4 - (point.loc / sparkline.max) * 28).toFixed(1)}`).join(' ')} L ${x(sparkline.points.at(-1)!.index)} ${base} Z`} />}
        {baselineIndex >= 0 && targetIndex >= 0 && <rect className="range" x={Math.min(x(baselineIndex), x(targetIndex))} y={6} width={Math.abs(x(targetIndex) - x(baselineIndex))} height={base - 6} rx={3} />}
        <line className="axis" x1={pad} x2={width - pad} y1={base} y2={base} />
        {timeline.preview !== undefined && targetIndex >= 0 && <line className="played" x1={pad} x2={x(targetIndex)} y1={base} y2={base} />}
        {data.entries.map((entry, index) => {
          const cx = x(index);
          return (
            <g key={entry.sha} className={`tick${entry.snapshot ? ' indexed' : ''}${entry.snapshot?.stale ? ' stale' : ''}${index === hover ? ' hover' : ''}${entry.note ? ` i-${entry.note.intent}` : ''}`}>
              <line x1={cx} x2={cx} y1={entry.snapshot ? base - 12 : base - 5} y2={base} />
              {entry.merge && <rect className="merge" x={cx - 2.5} y={base - 19} width={5} height={5} transform={`rotate(45 ${cx} ${base - 16.5})`} />}
              {entry.pullRequest?.source === 'github' && <circle className="pr" cx={cx} cy={base - 16} r={2.5} />}
            </g>
          );
        })}
        {data.workingTree && <g className="tick now"><line x1={x(data.entries.length)} x2={x(data.entries.length)} y1={base - 14} y2={base} /><text x={x(data.entries.length)} y={base + 13} textAnchor="end">Now</text></g>}
        {marks.map(mark => <text key={mark.index} className="mark" x={x(mark.index)} y={base + 13}>{mark.text}</text>)}
        {baselineIndex >= 0 && <g className="handle baseline" transform={`translate(${x(baselineIndex)} ${base})`}><circle r={5.5} /><title>Baseline: {label(data, timeline.baseline)}</title></g>}
        {targetIndex >= 0 && <g className="handle target" transform={`translate(${x(targetIndex)} ${base})`}><path d="M -6 -22 L 6 -22 L 0 -14 Z" /><circle r={6.5} /><title>Viewing: {label(data, timeline.target)}</title></g>}
        {chapters.map((chapter, index) => {
          const span = chapterSpan(chapter);
          if (!span) return null;
          const x0 = x(span.from) - 2, x1 = x(span.to) + 2;
          return (
            <g key={`${chapter.from}-${index}`} className={`chapter c${index % 6}${chapterHover === index ? ' hover' : ''}`} onPointerEnter={() => setChapterHover(index)} onPointerLeave={() => setChapterHover(undefined)} onPointerDown={event => { event.stopPropagation(); openChapter(chapter); }}>
              <rect x={x0} y={base + 19} width={Math.max(3, x1 - x0)} height={11} rx={3} />
              {x1 - x0 > 46 && <text x={(x0 + x1) / 2} y={base + 27.5} textAnchor="middle">{chapter.title.length * 5.2 > x1 - x0 - 6 ? `${chapter.title.slice(0, Math.max(3, Math.floor((x1 - x0 - 10) / 5.2)))}…` : chapter.title}</text>}
              <title>{`${chapter.title}\n${chapter.summary}\nClick: compare the whole chapter`}</title>
            </g>
          );
        })}
      </svg>
      {(hovered || hover === data.entries.length) && hover !== undefined && (
        <div className="timeline-tooltip" style={{ left: Math.min(Math.max(0, x(hover) - 140), Math.max(0, width - 300)) }} aria-hidden>
          {hovered ? (
            <>
              <div><span className="mono">{shortSha(hovered.sha)}</span> · {formatDate(hovered.authoredAt)} · {hovered.authorName}</div>
              <div className="subject">{hovered.note ? <><span className={`intent-chip i-${hovered.note.intent}`}>{hovered.note.intent}</span> {hovered.note.title}</> : hovered.subject}</div>
              {hovered.note && <div className="meta note-summary">{hovered.note.summary}</div>}
              <div className="meta">{hovered.snapshot ? `${compactNumber(hovered.snapshot.stats.files)} files · ${compactNumber(hovered.snapshot.stats.loc)} lines · ${compactNumber(hovered.snapshot.stats.symbols)} symbols` : 'not indexed'}{hovered.merge ? ' · merge' : ''}{hovered.pullRequest ? ` · PR #${hovered.pullRequest.number}${hovered.pullRequest.source === 'github' ? '' : ' (unverified)'}` : ''}</div>
            </>
          ) : <div>Working tree (live index)</div>}
        </div>
      )}
      {pickedEntry && (
        <div className="timeline-popover" role="dialog" aria-label="Commit not indexed" style={{ left: Math.min(Math.max(0, x(picked!) - 150), Math.max(0, width - 320)) }}>
          <div><span className="mono">{shortSha(pickedEntry.sha)}</span> · {pickedEntry.subject}</div>
          <p className="note">This commit has no snapshot yet.</p>
          {data.indexing.enabled
            ? <button className="button small primary" onClick={() => { void store.indexCommit(pickedEntry.sha); setPicked(undefined); }}>Index this commit</button>
            : <p className="note mono">npm run archipelago -- history index --commits {shortSha(pickedEntry.sha)} --repo … --state-dir …</p>}
          <button className="button small" onClick={() => setPicked(undefined)}>Close</button>
        </div>
      )}
    </div>
  );
}
/** Plays the history as a time-lapse; while the server prepares it, a ring shows how far along it is. */
function PlayButton() {
  const store = useStore();
  const playing = useAtlas(state => state.timeline.playing);
  const evolution = useAtlas(state => state.timeline.evolution);
  const preparing = evolution.status === 'loading' || evolution.status === 'idle';
  const percent = Math.round((evolution.progress ?? 0) * 100);
  const action = playing ? 'Pause the time-lapse' : 'Play the history as a time-lapse';
  const title = evolution.status === 'error' ? `Time-lapse unavailable: ${evolution.error}` : preparing && !playing ? `Preparing the time-lapse… ${percent}%` : `${action} (Space on the timeline)`;
  return (
    <button className={`play-button${playing ? ' playing' : ''}${preparing ? ' preparing' : ''}`} onClick={() => store.togglePlay()} aria-label={action} aria-pressed={playing} title={title} disabled={evolution.status === 'error'} style={{ '--progress': `${percent}%` } as React.CSSProperties}>
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>{playing ? <path d="M4 3h3v10H4zM9 3h3v10H9z" /> : <path d="M5 2.5v11l9-5.5z" />}</svg>
    </button>
  );
}
