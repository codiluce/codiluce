import type { Metadata } from 'next';
import Link from 'next/link';
import { DocsPager } from '../../../components/DocsNav';
import { GITHUB_URL } from '../../../lib/site';

export const metadata: Metadata = { title: 'How it works', description: 'The analyzer pipeline, the evidenced graph, the layout and the history store, and what Codiluce cannot see yet.' };

const PIPELINE = [
  { step: 'Filesystem', text: 'The tree of applications, folders and files, with language, lines, bytes and content hashes.' },
  { step: 'Git metrics', text: 'Commits, authors, churn and last change per file, from one bounded git log.' },
  { step: 'TypeScript & JavaScript', text: 'One type-checked program per application: imports, components, functions, calls, renders, references, file-based routes and handlers, HTTP requests.' },
  { step: 'Frameworks', text: 'Classes, methods and inheritance; routes; commands and schedules; migrations replayed into tables; models with their reads and writes; server-driven pages linked to their components.' },
  { step: 'API matcher', text: 'Frontend requests matched to endpoints, with ambiguity, origin, shadowing and constraint checks.' },
];

export default function HowItWorks() {
  return (
    <>
      <p className="eyebrow">Docs</p>
      <h1>How it works</h1>
      <p className="lede">
        A static analysis pipeline writes a canonical graph to SQLite. A read-only server projects that graph onto a stable
        spatial layout, and the browser draws it on a single canvas.
      </p>

      <h2 id="pipeline" className="anchor">The analyzer pipeline</h2>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Analyzer</th><th>What it adds</th></tr></thead>
          <tbody>{PIPELINE.map(row => <tr key={row.step}><td><strong>{row.step}</strong></td><td>{row.text}</td></tr>)}</tbody>
        </table>
      </div>
      <p>
        Nothing in the target repository is executed or installed. The TypeScript program covers the indexed files and the
        compiler’s own library files only, never <code>node_modules</code>, so the live index and every history snapshot
        resolve the same way. Results are cached per application: if no file in an application changed, its analysis is
        replayed.
      </p>

      <h2 id="graph" className="anchor">An evidenced graph</h2>
      <p>
        Entities (applications, files, classes, methods, routes, endpoints, commands, tables…) have stable IDs that do not
        depend on where the repository is checked out. Every relationship must carry at least one piece of
        {' '}<strong>evidence</strong>: the analyzer and its version, a confidence, a file and source range, and an explanation.
      </p>
      <p>
        Where proof is missing, the analyzers record a <strong>diagnostic</strong> instead of an edge: an unresolved import,
        an HTTP call whose base URL cannot be proven, an ambiguous route. Name-only matching never creates an edge. Call
        sites that stay unresolved are counted per symbol, so the gaps are measurable.
      </p>

      <h2 id="layout" className="anchor">A layout that holds still</h2>
      <p>
        Coordinates come from the server, never the browser: integer rectangles from a deterministic packing with bucketed
        sizes. Slot order is saved per state directory in <code>layout.json</code>, so new children are appended and
        removed ones leave holes. The same graph gives the same map, and selection, search or loading order never move
        anything.
      </p>
      <p>
        The map is one <code>&lt;canvas&gt;</code> with Canvas 2D: it loads children on demand, culls what is off screen and
        keeps a budget per frame. On a 5,000-entity application it pans at 60 fps.
      </p>

      <h2 id="history" className="anchor">The history store</h2>
      <p>
        <code>history.db</code> holds content-addressed versions of entities, relationships and findings. A snapshot is a set
        of pointers to them, so an entity that never changes is stored once for the whole history. Comparisons classify
        entities by source hash, facts, signature, kind and parent, and follow identities across renames and moves through a
        separate lineage, without weakening the IDs.
      </p>

      <h2 id="limits" className="anchor">What it cannot see yet</h2>
      <ul>
        <li>No runtime behavior: tables are what migrations declare, not the live database.</li>
        <li>Calls through callbacks, props, untyped values and interface dispatch stay unresolved and are counted.</li>
        <li>Middleware is drawn by name, not followed; events, listeners, observers, notifications and ORM relationships are not linked yet.</li>
        <li>Routes registered inside arbitrary service providers or conditions cannot be proven statically.</li>
        <li>Many ecosystems are detected and mapped, but their calls are not analyzed yet: see <Link href="/docs/stacks/">Languages &amp; frameworks</Link>, and <Link href="/#contribute">tell us which one you need</Link>.</li>
      </ul>
      <p>
        The full architecture document is in the repository: <a href={`${GITHUB_URL}/blob/main/docs/architecture-visualizer.md`} target="_blank" rel="noreferrer">docs/architecture-visualizer.md</a>.
      </p>

      <DocsPager current="/docs/how-it-works/" />
    </>
  );
}
