import type { Metadata } from 'next';
import Link from 'next/link';
import { CodeBlock } from '../../../components/CodeBlock';
import { DocsPager } from '../../../components/DocsNav';
import { ShapeGallery } from '../../../components/ShapeGallery';
import { Shot } from '../../../components/Shot';

export const metadata: Metadata = { title: 'Using the map', description: 'Zoom levels, 3D or 2D, the inspector, flows, coverage, blast radius, data families and descriptions.' };

const SHAPES: [string, string, string][] = [
  ['Lighthouse', 'Entry point', 'public/index.php, artisan, main.tsx'], ['Gate', 'Routes', 'routes/web.php, urls.py, route.ts'],
  ['Checkpoint', 'Middleware', 'app/Http/Middleware/, middleware.ts'], ['Rail turntable', 'Controller', 'app/Http/Controllers/, views.py'],
  ['Workshop', 'Service', 'app/Services/, *Service.ts'], ['Tool shed', 'Helper', 'helpers.php, utils/'],
  ['Terminal kiosk', 'Command', 'app/Console/Commands/, management/commands/'], ['Clock tower', 'Scheduled task', 'routes/console.php'],
  ['Conveyor belt', 'Job or listener', 'app/Jobs/, app/Listeners/'], ['Stacked records', 'Model', 'app/Models/, models.py'],
  ['Storage drums', 'Database table', 'database/migrations/'], ['Browser billboard', 'Page', 'app/**/page.tsx, resources/views/'],
  ['Open frame', 'Layout', 'layout.tsx, layouts/'], ['Building block', 'Component', 'components/, *.vue, *.svelte'],
  ['Crane', 'Hook or store', 'use*.ts, composables/, stores/'], ["Painter's palette", 'Style sheet', '*.css, *.scss'],
  ['Control desk', 'Configuration', 'config/, *.config.ts'], ['Lab bench with test tubes', 'Test', 'tests/, *.test.ts'],
];

export default function MapDocs() {
  return (
    <>
      <p className="eyebrow">Docs</p>
      <h1>Using the map</h1>
      <p className="lede">
        The map draws the repository in isometric 3D or as a flat 2D plan: applications, folders, files and symbols nested
        inside each other, each sized by its code.
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
        commands and scheduled tasks in a <strong>Console</strong> district, and tables in a <strong>Database</strong>{' '}
        district.
      </p>
      <p>
        The layout comes from the server and is deterministic. Selecting, searching or filtering never moves anything, and
        new files take new slots instead of pushing the others around.
      </p>
      <p>
        Folders open once they are about 150 pixels across on screen. <strong>Settings → Open folders from</strong> moves
        that point between 60 and 360 pixels: lower opens more of the map from further out, higher keeps it calmer.
      </p>

      <h2 id="projection" className="anchor">3D or 2D</h2>
      <p>
        The <strong>3D</strong> button beside the map switches between the isometric view and a <strong>2D plan</strong>,
        the same map seen from straight above. The place in the middle stays in the middle at about the same size, and
        the choice is remembered. In the plan every block reads at a glance and names never overlap: a name that does not
        fit beside its block moves further out with a leader line, or into a column at the side. Agents, flows, history,
        comparisons and explanation tours work in both.
      </p>
      <Shot
        src="/shots/plan.webp"
        alt="BookStack's map as a 2D plan seen from above: folders as nested rectangles with their names, tests hatched, and three agent characters on the files they work on."
        caption="The 2D plan of BookStack, with three agents at work on it."
      />

      <h2 id="kinds" className="anchor">Kinds of file</h2>
      <p>
        Blocks are plain by default, so color stays free for the lenses. The kinds that matter when you read a flow carry
        a small mark before their name once the block is about 60 pixels across: a page, an endpoint, data (models and
        tables), a job or scheduled task, and a test. Tests, and closed folders that are mostly tests, are hatched so they
        recede. Blocks stand a little inside their places, so streets run between files and wider avenues between folders.
      </p>

      <h3 id="shapes" className="anchor">Building shapes</h3>
      <p>
        <strong>Settings → Building shapes</strong> gives each kind of block its own building in 3D, the same in every
        language and framework: a gate for routes, a rail turntable for a controller, a workshop for a service, storage
        drums for a table, a browser billboard for a page. Far away a block stays plain; once it is a few dozen pixels across
        it shows its kind as a mark on its roof, and closer still it grows into its shape. A closed folder shows the kinds
        of block it holds most on its roof, each with its count, and its inspector lists every kind it holds.
      </p>
      <ShapeGallery />
      <p>
        A file&apos;s kind comes from the index where it can: the endpoints, page routes, commands, scheduled tasks or tables it
        declares, and the controllers, models, components and hooks it contains. Otherwise it comes from folder and name
        conventions shared by most frameworks (<code>Services/</code>, <code>helpers</code>, <code>Jobs/</code>,{' '}
        <code>layouts/</code>…). The inspector names the kind and says which rule gave it. Files no rule claims stay plain
        blocks.
      </p>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Shape</th><th>Kind</th><th>For example</th></tr></thead>
          <tbody>
            {SHAPES.map(([shape, kind, example]) => <tr key={kind}><td>{shape}</td><td>{kind}</td><td><code>{example}</code></td></tr>)}
          </tbody>
        </table>
      </div>
      <p>
        Lenses keep working: coverage, data families and people color the shapes, a comparison tints what changed, and a
        flow on the map lights the stops it reaches. In the 2D plan blocks are always flat. <strong>Settings → Streets
        between blocks</strong> packs the blocks edge to edge again.
      </p>

      <h2 id="inspector" className="anchor">The inspector and evidence</h2>
      <Shot
        src="/shots/map.webp"
        alt="A file-level view of BookStack's views with one folder of Blade views selected and the kinds of block it holds, its flows, data and people in the inspector."
        caption="Selecting a folder: the kinds of block it holds, the flows that reach it, its data, and who changed it and when."
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
        area. The <strong>⚠</strong> button beside the map marks the blocks where a link could not be proven (an
        unresolved request, an unmatched route, a missing import); it is off by default.
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
        along its links branch by branch, in waves. <strong>Lanes</strong> and <strong>Outline</strong> open the same flow in
        the middle of the screen, as a diagram left to right or as an outline of its steps, with conditions and evidence on
        every step; the map stays in a corner as an overview. The inspector of any file or folder lists the flows that touch it.
      </p>
      <p>
        Search offers the same for any result: its flow on the map or in lanes, what happens from it, and its impact.
      </p>

      <h2 id="coverage" className="anchor">Coverage</h2>
      <p>
        <strong>Coverage</strong> colors every file by what the flows say about it: <em>entry point</em>, <em>in
        flows</em>, <em>supports flows</em>, <em>possibly reached</em>, <em>not reached</em> (candidate dead code), tests and
        tooling, configuration, and files in languages whose calls are not analyzed yet. A file’s inspector says why it is
        where it is. Select a category in the legend to list its files, ready to copy. A lit feature, person or data family
        lists its files the same way.
      </p>

      <h2 id="impact" className="anchor">Blast radius and steps</h2>
      <p>
        <strong>Impact</strong> on any entity or area walks what depends on it, hop by hop, over calls, renders, references,
        handlers, routes, requests and inheritance. It opens in the middle of the screen, listed by hops or grouped by
        application, feature or folder, each entity with the chain that reaches it; the map tints what it reaches by distance.
        <strong>Impact</strong> in the header also shows what your <strong>uncommitted changes</strong> affect. The result is a
        lower bound and says so: it tells you which unresolved calls might reach further.
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
        Pick Codiluce Dusk (the default) or Dawn in the header; <strong>More themes</strong> in Settings adds Midnight, Paper,
        Sorbet and others. Useful keys:
        <kbd>/</kbd> search, <kbd>F</kbd> fit, <kbd>Alt</kbd> + <kbd>←</kbd> / <kbd>→</kbd> back and forward,
        double-click to zoom into an area. Links carry the view (<code>#id=…</code>), so you can share an exact place.
        History has its own keys: see <Link href="/docs/history/">History</Link>.
      </p>

      <DocsPager current="/docs/map/" />
    </>
  );
}
