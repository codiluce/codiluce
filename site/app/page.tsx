import Link from 'next/link';
import { EclipseMark } from '../components/EclipseMark';
import { FlowChain } from '../components/FlowChain';
import { HeroShader } from '../components/HeroShader';
import { InstallCommand } from '../components/InstallCommand';
import { Shot } from '../components/Shot';
import { GitHubIcon } from '../components/SiteChrome';
import { GITHUB_URL, ISSUES_URL, VERSION } from '../lib/site';

const QUESTIONS = [
  { q: 'What does this code do?', a: 'Every file, symbol, route and table sits in one zoomable map, from the whole repository down to a line of source.' },
  { q: 'Which flow is it part of?', a: 'Pages, requests, commands and scheduled tasks are traced end to end, so each file says which flows reach it.' },
  { q: 'Who changed it, and when?', a: 'Every commit is a snapshot on a timeline. Compare any two and see what moved, with authors and churn per file.' },
];

const PRINCIPLES = [
  { title: 'Evidenced, not guessed', text: 'Every relationship carries its evidence: analyzer, file and line. What the analyzers cannot prove stays a visible finding, never a silent guess.' },
  { title: 'Local and read-only', text: 'Codiluce reads your repository and Git objects. It never runs your application, installs its dependencies or writes to your checkout.' },
  { title: 'A layout that holds still', text: 'Coordinates are deterministic and slots persist, so the map you learned stays the map you know, from commit to commit.' },
  { title: 'Models are optional', text: 'Language models can describe files, flows and commits on request. The cost is estimated and capped first, and the text stays apart from the facts.' },
];

const STACKS = {
  deep: ['Next.js (App Router)', 'Laravel', 'Inertia', 'TypeScript & JavaScript in any app'],
  mapped: ['Python', 'Go', 'Rust', 'Java & Kotlin', 'C# & F#', 'Ruby', 'Swift', 'C & C++', 'Vue', 'Svelte', 'Astro', 'Liquid'],
};

const ROADMAP = [
  {
    stage: 'Done',
    tone: 'done',
    items: [
      'Evidenced graph for Next.js + Laravel: calls, renders, HTTP requests across stacks, tables from migrations',
      'Isometric map with semantic zoom, inspector and evidence to source',
      'Flows from pages, requests, Artisan commands and scheduled tasks, with coverage',
      'Git history: snapshots, compare, split view and time-lapse',
      'Blast radius and “what happens from here”',
      'Data families, grouped folders and the Data view',
      'Optional model descriptions and the Features view',
      'Application detection across 12 ecosystems',
    ],
  },
  {
    stage: 'Now',
    tone: 'now',
    items: ['First npm release: npx codiluce with a prebuilt map', 'Website and documentation'],
  },
  {
    stage: 'Next',
    tone: 'next',
    items: [
      'Tree-sitter structure for more languages',
      'Import resolution per language',
      'Framework packs: Express/Nest, Vue/Svelte/Astro, Django/FastAPI/Flask, Rails, Spring, ASP.NET, Go and Rust routers',
    ],
  },
  {
    stage: 'Later',
    tone: 'later',
    items: [
      'More split views: a flow across stacks, blast radius, before and after',
      'Laravel events, listeners, observers and Eloquent relationships',
      'Optional runtime ingestion',
    ],
  },
];

export default function Home() {
  return (
    <>
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-backdrop" aria-hidden="true"><HeroShader /></div>
        <div className="container hero-content">
          <p className="hero-badge"><span className="pulse-dot" aria-hidden="true" />v{VERSION} · early preview · MIT</p>
          <h1 id="hero-title">Bring your code to light</h1>
          <p className="hero-lede">
            Codiluce maps your repository like a city: every page, request, command and table, linked by evidence,
            through its whole Git history.
          </p>
          <InstallCommand />
          <div className="hero-actions">
            <Link href="/docs/" className="button primary">Read the docs</Link>
            <a href={GITHUB_URL} className="button ghost" target="_blank" rel="noreferrer"><GitHubIcon />View on GitHub</a>
          </div>
          <p className="hero-note">Node.js 22.12 or newer. Run it in the repository you want to see.</p>
        </div>
      </section>

      <section className="showcase" aria-label="The map">
        <div className="container">
          <Shot
            src="/shots/map.webp"
            alt="Codiluce map of the BookStack repository at file level: isometric blocks for PHP files in app/Entities, with the PageRepo class selected and its details in the inspector."
            caption="BookStack, an open-source Laravel app, at file level. Blocks are files sized by their code; the inspector shows the selected class."
            priority
          />
        </div>
      </section>

      <section className="section" id="goal" aria-labelledby="goal-title">
        <div className="container">
          <p className="eyebrow">Goal</p>
          <h2 id="goal-title" className="section-title">A codebase is a city nobody has a map of.</h2>
          <p className="section-lede">
            Codiluce exists to make three questions answerable from one picture, for the person who joined last week
            and for the one who wrote half of it.
          </p>
          <div className="questions">
            {QUESTIONS.map((item, index) => (
              <article key={item.q} className="question">
                <span className="question-index">0{index + 1}</span>
                <h3>{item.q}</h3>
                <p>{item.a}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section features" aria-label="Features">
        <div className="container">
          <div className="feature">
            <div className="feature-text">
              <p className="eyebrow">Flows</p>
              <h2 className="section-title">From the click to the table.</h2>
              <p>
                Codiluce resolves calls across both stacks. It follows a frontend request through axios instances and wrapper
                functions, even when the base URL is built in code, to the Laravel handler and the tables it reads.
              </p>
              <ul className="ticks">
                <li>One list of every flow: pages, requests, commands, scheduled tasks</li>
                <li>A flow plays on the map itself, branch by branch</li>
                <li>Coverage shows the code that no flow reaches</li>
              </ul>
            </div>
            <FlowChain />
          </div>

          <div className="feature reverse">
            <div className="feature-text">
              <p className="eyebrow">History</p>
              <h2 className="section-title">Watch the architecture change.</h2>
              <p>
                Codiluce indexes every commit of a branch as a snapshot. Scrub the timeline and nothing jumps: the layout keeps
                each entity in its place. Compare any two commits and the map splits into an overview plus a view on each place
                that changed.
              </p>
              <ul className="ticks">
                <li>Added, removed, modified and moved, drawn in place</li>
                <li>Source diffs and the history of any entity</li>
                <li>A time-lapse of the whole branch</li>
              </ul>
            </div>
            <Shot src="/shots/history.webp" alt="History compare view: an overview of the repository plus four zoomed views on the places a commit changed, with the timeline below." />
          </div>

          <div className="feature">
            <div className="feature-text">
              <p className="eyebrow">Data</p>
              <h2 className="section-title">See the code by the data it touches.</h2>
              <p>
                Codiluce reads the schema from your migrations. Tables group into families by their foreign keys, and code takes
                the family of the tables it reads and writes. The Data view arranges the whole map that way, with no model
                required.
              </p>
              <ul className="ticks">
                <li>Blast radius of any entity, hop by hop</li>
                <li>Steps: what a page or function sets in motion</li>
                <li>Large folders grouped by data or by name</li>
              </ul>
            </div>
            <Shot src="/shots/data.webp" alt="The Data view: BookStack's code arranged by data family, such as Roles, Entities, Images and Attachments, each in its own color." />
          </div>
        </div>
      </section>

      <section className="section principles-section" aria-labelledby="principles-title">
        <div className="container">
          <p className="eyebrow">Principles</p>
          <h2 id="principles-title" className="section-title">Correct first, then useful.</h2>
          <div className="principles">
            {PRINCIPLES.map(item => (
              <article key={item.title} className="principle">
                <h3>{item.title}</h3>
                <p>{item.text}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section" id="status" aria-labelledby="status-title">
        <div className="container">
          <p className="eyebrow">Status</p>
          <h2 id="status-title" className="section-title">Early, and already useful.</h2>
          <p className="section-lede">
            Version {VERSION} is the first public release. It is built and measured against a production Next.js + Laravel
            app, so the depth is there. The breadth is still growing.
          </p>
          <div className="status-grid">
            <div className="status-card">
              <h3>Analyzed in depth</h3>
              <p>Symbols, calls, routes, requests, effects, tables.</p>
              <ul className="chips">{STACKS.deep.map(item => <li key={item} className="chip strong">{item}</li>)}</ul>
            </div>
            <div className="status-card">
              <h3>Detected and mapped</h3>
              <p>Files, languages, lines and Git metrics. Calls come next.</p>
              <ul className="chips">{STACKS.mapped.map(item => <li key={item} className="chip">{item}</li>)}</ul>
            </div>
            <div className="status-card metrics">
              <h3>On a 5,000-entity app</h3>
              <dl>
                <div><dt>~10 s</dt><dd>first index, with type-checked calls</dd></div>
                <div><dt>~3.5 s</dt><dd>re-index from cache</dd></div>
                <div><dt>~3 min</dt><dd>315 commits of history, 6 processes</dd></div>
                <div><dt>60 fps</dt><dd>while panning the map</dd></div>
              </dl>
            </div>
          </div>
        </div>
      </section>

      <section className="section" id="roadmap" aria-labelledby="roadmap-title">
        <div className="container">
          <p className="eyebrow">Roadmap</p>
          <h2 id="roadmap-title" className="section-title">Where it goes next.</h2>
          <p className="section-lede">
            Depth first, then breadth: the next steps bring other languages and frameworks to the same level of evidence that
            Next.js and Laravel have today. Later items are ideas, not commitments.
          </p>
          <ol className="roadmap">
            {ROADMAP.map(column => (
              <li key={column.stage} className={`roadmap-col ${column.tone}`}>
                <h3><span className="roadmap-dot" aria-hidden="true" />{column.stage}</h3>
                <ul>{column.items.map(item => <li key={item}>{item}</li>)}</ul>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="section" id="contribute" aria-labelledby="contribute-title">
        <div className="container contribute">
          <div>
            <p className="eyebrow">Contribute</p>
            <h2 id="contribute-title" className="section-title">Help map more of the world’s code.</h2>
            <p className="section-lede">Codiluce is MIT-licensed and young. These help the most right now:</p>
            <ul className="contrib-list">
              <li>
                <strong>Run it on your repository</strong> and tell us what it gets wrong. Unresolved calls are reported as
                findings: <code>codiluce inspect diagnostics</code> is the best start for an issue. Remove private paths first.
              </li>
              <li>
                <strong>Language and framework packs.</strong> The roadmap lists the order. Each pack brings routes, entry
                points and calls with evidence, and fixtures that prove them.
              </li>
              <li>
                <strong>The map itself:</strong> themes, interactions, performance on very large repositories.
              </li>
            </ul>
            <div className="hero-actions">
              <a href={ISSUES_URL} className="button primary" target="_blank" rel="noreferrer">Open an issue</a>
              <a href={GITHUB_URL} className="button ghost" target="_blank" rel="noreferrer"><GitHubIcon />Star on GitHub</a>
            </div>
          </div>
          <div className="contrib-code">
            <p className="contrib-code-title">Develop locally</p>
            <pre>
              <code><span className="comment"># get the source</span>{'\n'}</code>
              <code><span className="prompt">$ </span>git clone {GITHUB_URL}.git{'\n'}</code>
              <code><span className="prompt">$ </span>cd codiluce && npm ci{'\n'}</code>
              <code>{'\n'}</code>
              <code><span className="comment"># map any repository from the checkout</span>{'\n'}</code>
              <code><span className="prompt">$ </span>npm start -- /path/to/repository{'\n'}</code>
              <code>{'\n'}</code>
              <code><span className="comment"># before a pull request</span>{'\n'}</code>
              <code><span className="prompt">$ </span>npm test && npm run typecheck{'\n'}</code>
              <code><span className="prompt">$ </span>npm run test:e2e{'\n'}</code>
            </pre>
            <p className="contrib-rule">One rule for analyzers: name-only matching never creates an edge. Prove it, or report it.</p>
          </div>
        </div>
      </section>

      <section className="final-cta" aria-labelledby="final-title">
        <div className="container final-inner">
          <div className="final-mark-wrap" aria-hidden="true"><EclipseMark className="final-mark" /></div>
          <h2 id="final-title">See your repository in a minute.</h2>
          <InstallCommand methods={['npx', 'npm', 'source']} />
          <Link href="/docs/" className="text-link">Getting started →</Link>
        </div>
      </section>
    </>
  );
}
