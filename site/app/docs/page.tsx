import type { Metadata } from 'next';
import Link from 'next/link';
import { CodeBlock } from '../../components/CodeBlock';
import { DocsPager } from '../../components/DocsNav';
import { Shot } from '../../components/Shot';

export const metadata: Metadata = { title: 'Getting started', description: 'Install Codiluce and map your first repository.' };

export default function GettingStarted() {
  return (
    <>
      <p className="eyebrow">Docs</p>
      <h1>Getting started</h1>
      <p className="lede">
        Codiluce reads a repository, builds an evidenced graph of it and opens an interactive map in your browser.
        Everything runs on your machine.
      </p>

      <h2 id="requirements" className="anchor">Requirements</h2>
      <ul>
        <li><strong>Node.js 22.12 or newer</strong>, and npm. Codiluce uses Node’s built-in SQLite. On versions that need a startup flag for it, Codiluce adds the flag for you.</li>
        <li><strong>Git</strong> is optional. Without it you get the map, but no Git metrics and no history.</li>
        <li>You do <strong>not</strong> need to install the dependencies of the repository you map. Codiluce never runs its code.</li>
      </ul>

      <h2 id="run" className="anchor">Map a repository</h2>
      <p>Go to the repository you want to see and start Codiluce:</p>
      <CodeBlock prompt code={'cd /path/to/my-repository\nnpx codiluce@latest start .'} />
      <p>
        This detects the applications in the repository, indexes them, starts a local server and opens the map. It tries
        port 4300 first and takes another one if that port is busy. Press <kbd>Ctrl</kbd> + <kbd>C</kbd> to stop.
      </p>

      <h3 id="setup" className="anchor">The first start asks a few questions</h3>
      <p>
        After the first analysis, and before the map opens, Codiluce asks in the terminal. Enter keeps each default, and
        {' '}<code>codiluce setup</code> asks again whenever you like:
      </p>
      <ul>
        <li><strong>History:</strong> the last 50 commits, the last 6 months, everything or nothing, each with the time it takes. It is indexed in the background while you use the map.</li>
        <li><strong>Language models (optional):</strong> an Anthropic or OpenAI key, typed hidden and checked with the provider, for asking questions in the map and describing the code. Keys stay in <code>~/.config/codiluce/credentials</code>, readable only by you.</li>
        <li><strong>Describing the code:</strong> with an OpenAI key, the cost is estimated first and capped; nothing is spent without a yes.</li>
        <li><strong>Your agents:</strong> installed coding harnesses (Claude Code, Codex, Cursor, OpenCode and others) are found and connected to Codiluce&apos;s MCP server, so they can <Link href="/docs/explanations/">explain the code</Link> on the map. Their hooks put them <Link href="/docs/agents/">on the map as characters</Link> while they work.</li>
      </ul>
      <p>
        Without a terminal (CI, scripts) or with <code>--yes</code>, nothing is asked and nothing is spent.
        {' '}<code>--history 200</code> (or <code>all</code>, <code>none</code>, <code>&quot;6 months ago&quot;</code>) sets the
        depth for one start.
      </p>
      <p>
        The npm package includes the compiled CLI and a prebuilt map, so the first run needs no build step. Omit
        the <code>.</code> to scan the current directory, or give the path of another local directory. Remote URLs are not
        supported: clone the repository first.
      </p>

      <h3 id="install" className="anchor">Install it instead</h3>
      <p>For a command that is always available, install Codiluce globally:</p>
      <CodeBlock prompt code={'npm install --global codiluce\ncodiluce start /path/to/my-repository'} />
      <p>For a fixed version in a Node project, add it as a development dependency and commit the lockfile:</p>
      <CodeBlock prompt code={'npm install --save-dev codiluce\nnpx codiluce start .'} />

      <h3 id="options" className="anchor">Useful options</h3>
      <CodeBlock
        prompt
        code={[
          '# keep the analysis outside the repository, and open the browser yourself',
          'npx codiluce start . --state-dir ~/.codiluce/my-repo --no-open',
          '# choose a port (0 asks the system for a free one)',
          'npx codiluce start . --port 4400',
          '# no questions; index the last 200 commits this time',
          'npx codiluce start . --yes --history 200',
          '# ask the setup questions again',
          'npx codiluce setup',
        ].join('\n')}
      />
      <p>
        Run <code>npx codiluce --help</code> for every command, and see <Link href="/docs/cli/">CLI &amp; API</Link> for
        the details.
      </p>

      <h2 id="state" className="anchor">Where the analysis goes</h2>
      <p>
        Codiluce keeps its state in <code>&lt;repository&gt;/.codiluce/</code>: the configuration, the graph
        (<code>codiluce.db</code>), the history, an analysis cache, explanations and the layout of the map. It holds file
        paths, symbols and routes of your code, so it hides itself from Git with its own <code>.gitignore</code>; your
        repository&apos;s <code>.gitignore</code> is never changed.
      </p>
      <p>
        The next start reuses the configuration and the cache. An application whose files did not change is replayed from
        the cache instead of analyzed again, so a re-index of an unchanged repository takes a few seconds.
      </p>

      <h2 id="first-look" className="anchor">Your first look</h2>
      <Shot
        src="/shots/overview.webp"
        alt="The whole BookStack repository as one isometric plate, with folders such as app, resources, tests and lang drawn as districts."
        caption="The whole repository at once. Folders are districts; zoom in and they open into files, then symbols, then source."
      />
      <ul>
        <li><strong>Zoom</strong> with the wheel, a pinch or <kbd>+</kbd> / <kbd>−</kbd>; drag or use the arrow keys to pan; <kbd>F</kbd> fits the view.</li>
        <li><strong>Search</strong> with <kbd>/</kbd>: files, symbols, routes, endpoints, controllers, tables. Choose a result and the map flies there.</li>
        <li><strong>Select</strong> anything to see its relationships drawn on the map and its facts in the inspector. <strong>Why?</strong> on a relationship opens its evidence.</li>
        <li>Open <strong>Flows</strong>, <strong>History</strong>, <strong>Explain</strong>, <strong>Agents</strong> or <strong>Coverage</strong> from the header, and switch between 3D and the 2D plan with the <strong>3D</strong> button beside the map.</li>
      </ul>
      <p>The next page explains the map in detail.</p>

      <div className="callout">
        <p>
          <strong>How deep does it go?</strong> It depends on the stack. TypeScript and JavaScript are analyzed down to
          calls and requests in any application, and supported frameworks down to routes, commands and tables. Every other
          ecosystem is detected and mapped with its files, languages, lines and Git metrics.
          See <Link href="/docs/stacks/">Languages &amp; frameworks</Link>.
        </p>
      </div>

      <DocsPager current="/docs/" />
    </>
  );
}
