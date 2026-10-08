import type { Metadata } from 'next';
import { CodeBlock } from '../../../components/CodeBlock';
import { DocsPager } from '../../../components/DocsNav';

export const metadata: Metadata = { title: 'CLI & API', description: 'Every Codiluce command, its options, exit codes and the read-only HTTP API.' };

const COMMANDS = [
  { cmd: 'start [PATH]', what: 'Detect, index, serve and open the map. PATH defaults to the current directory.' },
  { cmd: 'init', what: 'Detect applications and write the configuration. Keeps an existing configuration and graph.' },
  { cmd: 'index', what: 'Analyze the repository into the graph. Reuses the cache for applications that did not change.' },
  { cmd: 'serve', what: 'Serve the read-only API and the map for an existing index.' },
  { cmd: 'inspect …', what: 'Query the graph from the terminal, as JSON: summary, entities, entity, relations, relation, diagnostics.' },
  { cmd: 'history index', what: 'Index past commits of a branch into the history store.' },
  { cmd: 'history status', what: 'Show what history is indexed.' },
  { cmd: 'annotate', what: 'Describe the code with a language model, after a cost estimate.' },
];

const OPTIONS = [
  { opt: '--repo PATH', what: 'The repository. Defaults to the current directory.' },
  { opt: '--state-dir PATH', what: 'Where the analysis lives. Defaults to <repo>/.codiluce.' },
  { opt: '--port N', what: 'Server port. start tries 4300 and then the next free one; 0 asks the system.' },
  { opt: '--no-open', what: 'start: print the URL instead of opening a browser.' },
  { opt: '--no-cache', what: 'Analyze everything again instead of replaying unchanged applications.' },
  { opt: '--history-indexing', what: 'Let the map index commits on demand. The only route that writes.' },
  { opt: '--read-only', what: 'serve: refuse on-demand history indexing, even with --history-indexing.' },
  { opt: '--ui PATH | none', what: 'serve another build of the map, or only the API.' },
];

export default function CliDocs() {
  return (
    <>
      <p className="eyebrow">Docs</p>
      <h1>CLI &amp; API</h1>
      <p className="lede">
        <code>codiluce start</code> is all most people need. The other commands give you each step on its own, for scripts,
        CI or a shared server.
      </p>

      <h2 id="commands" className="anchor">Commands</h2>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Command</th><th>What it does</th></tr></thead>
          <tbody>{COMMANDS.map(row => <tr key={row.cmd}><td><code>{row.cmd}</code></td><td>{row.what}</td></tr>)}</tbody>
        </table>
      </div>
      <p>
        Run them as <code>npx codiluce &lt;command&gt;</code>, <code>codiluce &lt;command&gt;</code> after a global install, or
        {' '}<code>npm run codiluce -- &lt;command&gt;</code> from a source checkout.
      </p>

      <h2 id="options" className="anchor">Common options</h2>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Option</th><th>Meaning</th></tr></thead>
          <tbody>{OPTIONS.map(row => <tr key={row.opt}><td><code>{row.opt}</code></td><td>{row.what}</td></tr>)}</tbody>
        </table>
      </div>

      <h2 id="step-by-step" className="anchor">Step by step</h2>
      <CodeBlock
        prompt
        code={[
          'npx codiluce init --repo /path/to/repository',
          'npx codiluce index --repo /path/to/repository',
          'npx codiluce inspect summary --repo /path/to/repository',
          'npx codiluce serve --repo /path/to/repository --port 4300',
        ].join('\n')}
      />
      <p>
        <code>index</code> exits with <strong>0</strong> when no analyzer reported an error, <strong>2</strong> when parse or
        configuration errors were recorded (the graph is still written), and <strong>1</strong> for fatal failures. A failed
        run keeps the previous graph. Reindexing while <code>serve</code> runs is picked up within about 30 seconds, and the
        map offers a reload.
      </p>

      <h2 id="inspect" className="anchor">Inspect the graph</h2>
      <CodeBlock
        prompt
        code={[
          'npx codiluce inspect entities --search /auth/login --type api_endpoint',
          'npx codiluce inspect entities --type database_table',
          'npx codiluce inspect diagnostics --code unresolved-http-call',
          'npx codiluce inspect relations --id ID --direction outgoing --type handles',
        ].join('\n')}
      />
      <p>
        Lists are paginated (100 by default, 500 at most) and leave out evidence. Details of one entity or relation include
        all of its evidence. The graph is plain SQLite, so you can also query <code>.codiluce/codiluce.db</code> directly.
      </p>

      <h2 id="api" className="anchor">HTTP API</h2>
      <p>
        <code>serve</code> binds to loopback and is read-only: it opens the graph read-only and only accepts GET, except for
        on-demand history indexing when you allow it. Open <code>/api</code> for the full directory. The main routes:
      </p>
      <CodeBlock
        code={[
          'GET /api/summary                         counts and diagnostics of the index',
          'GET /api/entities?search=&type=          entity search (paginated)',
          'GET /api/entities/:id/relations          relationships with evidence',
          'GET /api/projection/flows?kind=page      every flow by entry point',
          'GET /api/projection/impact/:id?depth=4   blast radius',
          'GET /api/projection/steps/:id            what happens from here',
          'GET /api/projection/coverage             coverage category of every file',
          'GET /api/projection/families             data families',
          'GET /api/history                         the timeline',
          'GET /api/history/changes?snapshot=&compareTo=',
          'GET /api/source?entity=ID                a bounded window of source',
        ].join('\n')}
      />
      <p>
        Projection, source and detail routes accept <code>snapshot=ID</code> and <code>compareTo=ID</code> to read any indexed
        commit. Source is addressed by entity, evidence or finding, never by path, and is limited to 400 lines per request.
      </p>

      <DocsPager current="/docs/cli/" />
    </>
  );
}
