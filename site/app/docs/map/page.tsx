import type { Metadata } from 'next';
import Link from 'next/link';
import { CodeBlock } from '../../../components/CodeBlock';
import { DocsPager } from '../../../components/DocsNav';
import { Shot } from '../../../components/Shot';

export const metadata: Metadata = { title: 'Using the map', description: 'Zoom levels, the inspector, flows, coverage, blast radius, data families and descriptions.' };

export default function MapDocs() {
  return (
    <>
      <p className="eyebrow">Docs</p>
      <h1>Using the map</h1>
      <p className="lede">
        The map draws the repository in isometric 3D: applications, folders, files and symbols nested inside each other,
        each sized by its code.
      </p>

      <h2 id="zoom" className="anchor">Zoom levels</h2>
      <p>
        A container opens when it is large enough on screen, and its children load on demand. The status bar names the
        level you are at: <strong>Applications → Directories &amp; modules → Files → Symbols → Source</strong>. Labels change
        with the level: an application shows its framework, a folder its files and lines, a file its language and symbols,
        a symbol its signature. At the deepest level a selected file or symbol draws its source on its own face.
      </p>
      <p>
        Routes and endpoints are drawn in a <strong>Routes &amp; endpoints</strong> district inside their application,
        commands and scheduled tasks in a <strong>Console</strong> district, and tables in a <strong>Database</strong>
        district.
      </p>
      <p>
        The layout comes from the server and is deterministic. Selecting, searching or filtering never moves anything, and
        new files take new slots instead of pushing the others around.
      </p>

      <h2 id="inspector" className="anchor">The inspector and evidence</h2>
      <Shot
        src="/shots/map.webp"
        alt="A file-level view with the PageRepo class selected and its facts listed in the inspector."
        caption="Selecting a class: its canonical path, source range, flows, facts and relationships."
      />
      <p>
        Select anything to see its type, canonical path, source range and metrics. Incoming and outgoing relationships are
        drawn as arcs and listed with filters. Every relationship has <strong>Why?</strong>: the analyzer and version, the
        file and line, and an explanation. It opens the source with the evidence lines highlighted.
      </p>
      <p>
        A symbol also lists its <strong>effects</strong> (database reads and writes, responses with their HTTP status,
        network, storage, navigation, queue, mail, events) and its <strong>call sites</strong>: how many were linked, how many
        belong to the framework or packages, and which stayed unresolved and why.
      </p>
      <p>
        What the analyzers cannot prove is never guessed. It stays a <strong>finding</strong>, listed per entity and per
        area, and you can show findings as markers on the map.
      </p>

      <h2 id="flows" className="anchor">Flows</h2>
      <p>
        <strong>Flows</strong> in the header is one list of every flow the index can follow, filtered by where it starts:
      </p>
      <ul>
        <li><strong>Pages</strong>: a page of the interface, or an endpoint that serves one. Its flow is what it renders, the requests it makes and what they reach, down to the tables.</li>
        <li><strong>Requests</strong>: one per endpoint, plus requests that no endpoint answers, with their completeness: <em>complete</em>, <em>partial</em>, <em>no caller</em> or <em>unmatched</em>.</li>
        <li><strong>Console</strong>: commands, with what runs them, and scheduled tasks with their cadence.</li>
      </ul>
      <p>
        Choose a flow and it plays <strong>on the map</strong>: what it touches stays lit, the rest dims, and a pulse runs
        along its links branch by branch, in waves. <strong>Lanes</strong> shows the same flow as a diagram, left to right,
        with conditions and evidence on every step. The inspector of any file or folder lists the flows that touch it.
      </p>

      <h2 id="coverage" className="anchor">Coverage</h2>
      <p>
        <strong>Coverage</strong> colors every file by what the flows say about it: <em>entry point</em>, <em>in
        flows</em>, <em>supports flows</em>, <em>possibly reached</em>, <em>not reached</em> (candidate dead code), tests and
        tooling, configuration, and files in languages whose calls are not analyzed yet. A file’s inspector says why it is
        where it is.
      </p>

      <h2 id="impact" className="anchor">Blast radius and steps</h2>
      <p>
        <strong>Impact</strong> on any entity or area walks what depends on it, hop by hop, over calls, renders, references,
        handlers, routes, requests and inheritance. The map tints what it reaches by distance; the inspector lists the
        endpoints, pages and applications reached, each with the chain that reaches it. The result is a lower bound and says
        so: it tells you which unresolved calls might reach further.
      </p>
      <p>
        <strong>What happens from here</strong> opens the <strong>Steps</strong> of a page, endpoint, component or function:
        the triggers it binds, the actions with effects, the endpoints it reaches, the handlers they run, and every way a
        handler answers, with the conditions read from the source.
      </p>

      <h2 id="data" className="anchor">Data families</h2>
      <p>
        Without any language model, tables group into <strong>data families</strong>: tables joined by foreign keys, tables
        named after another, and tables that share a prefix. A table that many others reference, such as <code>users</code>,
        is a hub of its own. Files take the family of the tables they map, migrate, read or write.
      </p>
      <ul>
        <li><strong>▦</strong> in the map controls colors files, endpoints, commands and tables by family.</li>
        <li>The inspector of a folder shows <strong>Data in this folder</strong>: its files per family. Select one to light its files on the map.</li>
      </ul>

      <h2 id="descriptions" className="anchor">Descriptions and the Features panel</h2>
      <p>
        Optionally, a language model can describe files, folders, flows, domains and commits. Descriptions are written in
        ASD-STE100 Simplified Technical English, scored against its rules, and kept apart from the indexed facts. They add
        a <strong>Features</strong> panel: what the product does, feature by feature. Select a feature to light its files on
        the map and see the flows that start in it.
      </p>
      <CodeBlock
        prompt
        code={[
          '# an OpenAI key in the Codiluce workspace or the state directory, never read from your repository',
          'echo "OPENAI_API_KEY=…" >> .codiluce/.env',
          '# estimate the cost first, with one real request per task',
          'npx codiluce annotate --estimate --pilot',
          '# then run it, with a spending cap in US dollars',
          'npx codiluce annotate --max-cost 10',
        ].join('\n')}
      />
      <p>
        <code>annotate</code> always estimates first and does not run when the estimate exceeds <code>--max-cost</code>.
        It sends paths, names and short excerpts of the source (about 3 KB per file) to the OpenAI API. Nothing else ever
        leaves your machine. Only what changed is described again on later runs.
      </p>

      <h2 id="themes" className="anchor">Themes and keyboard</h2>
      <p>
        Pick a theme in the header: Codiluce Dusk and Dawn, Midnight, Paper, Sorbet and others. Useful keys:
        <kbd>/</kbd> search, <kbd>F</kbd> fit, <kbd>Alt</kbd> + <kbd>←</kbd> / <kbd>→</kbd> back and forward,
        double-click to zoom into an area. Links carry the view (<code>#id=…</code>), so you can share an exact place.
        History has its own keys: see <Link href="/docs/history/">History</Link>.
      </p>

      <DocsPager current="/docs/map/" />
    </>
  );
}
