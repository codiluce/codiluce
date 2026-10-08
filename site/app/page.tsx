import Link from 'next/link';
import { EclipseMark } from '../components/EclipseMark';
import { FlowChain } from '../components/FlowChain';
import { HeroShader } from '../components/HeroShader';
import { InstallCommand } from '../components/InstallCommand';
import { Shot } from '../components/Shot';
import { GitHubIcon } from '../components/SiteChrome';
import { CALL_URL, GITHUB_URL, ISSUES_URL, VERSION } from '../lib/site';

const QUESTIONS = [
  { q: 'What does this code do?', a: 'Every file, symbol, route and table sits in one zoomable map, from the whole repository down to a line of source.' },
  { q: 'Which flow is it part of?', a: 'Pages, requests, commands and scheduled tasks are traced end to end, so each file says which flows reach it.' },
  { q: 'What changed since I last looked?', a: 'Every commit is a snapshot. Compare any two to see what was added, removed or moved, and what depends on it.' },
];

function CalendarIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="icon">
      <rect x="1.75" y="2.75" width="12.5" height="11.5" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M1.75 6.5h12.5M5 1.25v3M11 1.25v3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export default function Home() {
  return (
    <>
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-backdrop" aria-hidden="true"><HeroShader /></div>
        <div className="container hero-content">
          <p className="hero-badge"><span className="pulse-dot" aria-hidden="true" />v{VERSION} · early preview · MIT</p>
          <h1 id="hero-title">Bring your code to light</h1>
          <p className="hero-lede">
            Codiluce helps engineers understand their code and its architecture: every flow from the interface to the data,
            linked by evidence, through its whole Git history.
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
            alt="Codiluce map of the BookStack repository at file level: isometric blocks for the files in app/Entities, with the PageRepo class selected and its details in the inspector."
            caption="BookStack, an open-source wiki, at file level. Blocks are files sized by their code; the inspector shows the selected class."
            priority
          />
        </div>
      </section>

      <section className="section" id="goal" aria-labelledby="goal-title">
        <div className="container">
          <p className="eyebrow">Goal</p>
          <h2 id="goal-title" className="section-title">Agents keep changing the code. Humans should still understand it.</h2>
          <p className="section-lede">
            Agents write and change code faster than anyone can review it line by line. Codiluce exists so the people
            responsible for a system still understand its code and architecture, whoever made the last commit.
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
                Codiluce follows a click across the whole system: from the interface, through the request, even when its URL
                is built in code, to the handler that answers it and the tables it reads.
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

      <section className="section contribute-section" id="contribute" aria-labelledby="contribute-title">
        <div className="container">
          <p className="eyebrow">Contribute</p>
          <h2 id="contribute-title" className="section-title">Shaped by the teams who use it.</h2>
          <p className="section-lede">
            Codiluce is open source and early. We would rather build what engineering teams need than guess it, so feedback
            counts as much as code: tell us how your team works, and what you still cannot see in your code.
          </p>

          <div className="ways">
            <article className="way featured">
              <span className="question-index">01</span>
              <h3>Tell us what your team needs</h3>
              <p>
                Which questions about your code take the longest to answer? What is your stack, and how do agents work in it?
                Your answers shape what we build next.
              </p>
              <a href={CALL_URL} className="button primary small" target="_blank" rel="noreferrer"><CalendarIcon />Book a 30-minute call</a>
            </article>
            <article className="way">
              <span className="question-index">02</span>
              <h3>Report what it gets wrong</h3>
              <p>
                Run it on your repository. What the analyzers cannot prove shows up as findings,
                and <code>codiluce inspect diagnostics</code> is the best start for an issue. Remove private paths first.
              </p>
              <a href={ISSUES_URL} className="text-link" target="_blank" rel="noreferrer">Open an issue →</a>
            </article>
            <article className="way">
              <span className="question-index">03</span>
              <h3>Ask for your stack</h3>
              <p>
                Missing a language, a framework, or a question the map cannot answer yet? Open an issue with a public
                repository that shows it. Real code beats any description.
              </p>
              <a href={ISSUES_URL} className="text-link" target="_blank" rel="noreferrer">Request it →</a>
            </article>
          </div>

          <div className="contribute">
            <div>
              <h3 className="contrib-subtitle">Contribute code</h3>
              <ul className="contrib-list">
                <li>
                  <strong>Analyzers for more languages and frameworks.</strong> Each brings routes, entry points and calls with
                  evidence, and fixtures that prove them.
                </li>
                <li>
                  <strong>The map itself:</strong> themes, interactions, performance on very large repositories.
                </li>
                <li>
                  <strong>Docs and examples</strong> from the way your team uses it.
                </li>
              </ul>
              <div className="hero-actions">
                <a href={GITHUB_URL} className="button ghost" target="_blank" rel="noreferrer"><GitHubIcon />Star on GitHub</a>
                <Link href="/docs/how-it-works/" className="text-link">How it works →</Link>
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
