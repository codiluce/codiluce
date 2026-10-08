import type { Metadata } from 'next';
import { CodeBlock } from '../../../components/CodeBlock';
import { DocsPager } from '../../../components/DocsNav';
import { Shot } from '../../../components/Shot';

export const metadata: Metadata = { title: 'History', description: 'Index the commits of a branch and browse, compare and replay them on the map.' };

export default function HistoryDocs() {
  return (
    <>
      <p className="eyebrow">Docs</p>
      <h1>History</h1>
      <p className="lede">
        Codiluce can index every commit of a branch as a snapshot of the architecture. The map then shows any commit, compares
        any two, and replays the branch as a time-lapse.
      </p>

      <h2 id="index" className="anchor">Index the history</h2>
      <CodeBlock
        prompt
        code={[
          '# first-parent history of the checked-out branch',
          'npx codiluce history index',
          '# or only part of it',
          'npx codiluce history index --limit 200',
          'npx codiluce history index --since "6 months ago"',
          '# what is indexed',
          'npx codiluce history status',
        ].join('\n')}
      />
      <p>
        Options: <code>--ref BRANCH</code>, <code>--limit N</code>, <code>--since DATE</code>, <code>--commits SHA,SHA</code>,
        {' '}<code>--jobs N</code> (parallel processes, up to 6 by default), <code>--all-parents</code> and <code>--pr-metadata
        github</code>. Commits that already have a snapshot are skipped, so running it again only analyzes new commits. On a
        production app, 315 commits take about 3 minutes with 6 processes.
      </p>
      <p>
        Commits are read from Git objects into scratch directories. Codiluce never checks out, never adds a worktree and never
        writes to your Git index. Start the map with <code>--history-indexing</code> to index single commits on demand from
        the timeline.
      </p>

      <h2 id="timeline" className="anchor">The timeline</h2>
      <p>
        Open <strong>History</strong> in the header. The timeline lists the commits of the branch over a sparkline of measured
        lines, and ends in your working tree. Solid ticks are indexed, diamonds are merges. Drag it, click it, or use
        {' '}<kbd>[</kbd> and <kbd>]</kbd> anywhere; <kbd>Home</kbd> and <kbd>End</kbd> jump to the ends.
      </p>
      <ul>
        <li><strong>Snapshot</strong> shows the system exactly as it was indexed at that commit.</li>
        <li><strong>Compare</strong> (the default) compares the commit with the one before it: <em>added</em> in green, <em>removed</em> as red ghosts where they used to be, <em>modified</em> in amber, <em>moved</em> in violet. Labels carry +, −, ~ and → as well, so color is never the only signal.</li>
        <li><strong>Pin</strong> the baseline to compare any two commits.</li>
      </ul>
      <p>
        The layout reserves a place for everything that ever existed, so stepping between commits never moves anything.
      </p>

      <h2 id="split" className="anchor">Split view</h2>
      <Shot
        src="/shots/history.webp"
        alt="History compare in split view: an overview of the repository with numbered frames, and four zoomed views on the places that changed."
        caption="Compare in split view: an overview with numbered frames, and a zoomed view on each place that changed."
      />
      <p>
        In Compare, the map splits into an <strong>overview</strong> of the whole repository and a <strong>view on each place
        where the code changed</strong>, five to a page. Each view frames its changed files; the overview draws each view’s
        frame, numbered. Places are grouped <em>Auto</em>, or one per app, folder or file. Every view is a full map: pan,
        zoom, select, or open it in the single map.
      </p>

      <h2 id="timelapse" className="anchor">Time-lapse</h2>
      <p>
        Drag the timeline and every commit shows as you pass it. <strong>▶</strong> (or <kbd>Space</kbd>) plays the history
        at 0.5× to 4×: new areas rise into place, changed blocks flash in their status color, and with <em>Follow</em> the
        camera drifts toward the changes.
      </p>

      <h2 id="diffs" className="anchor">Diffs and entity history</h2>
      <p>
        For a selected entity, the inspector shows its architectural diff: what changed (source, signature, facts, size, name,
        place), its relationships and findings added or removed, with evidence. <strong>Source diff</strong> opens a unified
        or side-by-side diff of its own source. <strong>History of this entity</strong> lists every commit where it appeared,
        changed, moved or disappeared. Identities are followed across renames and moves.
      </p>
      <p>
        Merge and squash messages give inferred pull request markers. <code>--pr-metadata github</code> records merged pull
        requests from the GitHub API as verified markers (set <code>GITHUB_TOKEN</code> for private repositories).
      </p>

      <DocsPager current="/docs/history/" />
    </>
  );
}
