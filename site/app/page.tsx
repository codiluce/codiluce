import Link from 'next/link';
import type { ReactNode } from 'react';
import { AgentTerminal, HookStatus } from '../components/AgentWork';
import { CodeBlock } from '../components/CodeBlock';
import { ComprehensionGap } from '../components/ComprehensionGap';
import { EclipseMark } from '../components/EclipseMark';
import { GoalDiff } from '../components/GoalDiff';
import { HeroShader } from '../components/HeroShader';
import { InstallCommand } from '../components/InstallCommand';
import { MapDemo } from '../components/MapDemo';
import { NextTag } from '../components/NextTag';
import { ShapeGallery } from '../components/ShapeGallery';
import { Stacks } from '../components/Stacks';
import { GitHubIcon } from '../components/SiteChrome';
import { CALL_URL, GITHUB_URL, ISSUES_URL, NEXT_RELEASE, VERSION } from '../lib/site';

const glyph = (d: ReactNode) => <svg viewBox="0 0 24 24" aria-hidden="true" className="more-glyph">{d}</svg>;
const MORE: { title: string; glyph: ReactNode; text: ReactNode; next?: 'pull-requests' }[] = [
  {
    title: 'Impact',
    glyph: glyph(<><circle cx="12" cy="12" r="2.5" /><circle cx="12" cy="12" r="6" opacity="0.6" /><circle cx="12" cy="12" r="9.5" opacity="0.3" /></>),
    text: 'Pick anything, or your uncommitted changes, and see what depends on it, hop by hop, grouped by application, feature and folder.',
  },
  {
    title: 'Pull requests',
    next: 'pull-requests',
    glyph: glyph(<><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="19" r="2" /><path d="M6 7v10M18 17V10a3 3 0 0 0-3-3h-4" /><path d="M13 4.5 10.5 7 13 9.5" /></>),
    text: 'Open pull requests and branches not merged yet light the files they change, with their commits, people and blast radius.',
  },
  {
    title: 'People',
    glyph: glyph(<><circle cx="9" cy="8" r="3" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0" /><circle cx="17" cy="9" r="2.4" opacity="0.6" /><path d="M15.5 14.2A4.5 4.5 0 0 1 21 18.5" opacity="0.6" /></>),
    text: 'Who changed which code, read from Git without a model. Coding agents and bots are marked as such.',
  },
  {
    title: 'Color by',
    glyph: glyph(<><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="8" rx="1.5" opacity="0.6" /><rect x="3" y="13" width="8" height="8" rx="1.5" opacity="0.6" /><rect x="13" y="13" width="8" height="8" rx="1.5" opacity="0.3" /></>),
    text: NEXT_RELEASE.includes('code-health')
      ? <>Color the map by the code no flow reaches, or by who changed it most. Complexity, recent changes and hotspots come with the next release.</>
      : <>Color the map by the code no flow reaches, who changed it most, complexity, recent changes or hotspots.</>,
  },
  {
    title: 'Evidence',
    glyph: glyph(<><circle cx="10.5" cy="10.5" r="6" /><path d="m15 15 5.5 5.5" /><path d="m8 10.5 1.8 1.8L13 9" /></>),
    text: 'Every link opens the file and line that proves it. What cannot be proven shows up as a finding, never as a guess.',
  },
  {
    title: 'Private by design',
    glyph: glyph(<><rect x="4.5" y="10.5" width="15" height="10" rx="2" /><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" /></>),
    text: 'It runs on your machine, reads your code without running it, and never writes to your checkout. Nothing leaves unless you ask.',
  },
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
            Codiluce helps engineers understand their code and its architecture while agents keep changing it: every flow
            from the interface to the data, every commit, and every file an agent touches, linked by evidence.
          </p>
          <InstallCommand />
          <div className="hero-actions">
            <Link href="/docs/" className="button primary">Read the docs</Link>
            <a href={GITHUB_URL} className="button ghost" target="_blank" rel="noreferrer"><GitHubIcon />View on GitHub</a>
          </div>
          <p className="hero-note">Node.js 22.12 or newer. Run it in the repository you want to see.</p>
        </div>
      </section>

      <section className="showcase" aria-label="Codiluce at work">
        <div className="container">
          <MapDemo />
          <p className="demo-note">A scripted replay of the map on a small made-up repository. Run it on yours to see the real thing.</p>
        </div>
      </section>

      <section className="section gap-section" id="why" aria-labelledby="gap-title">
        <div className="container">
          <ComprehensionGap />
        </div>
      </section>

      <section className="section goal-section" id="goal" aria-labelledby="goal-title">
        <div className="container">
          <p className="eyebrow">Goal</p>
          <h2 id="goal-title" className="section-title">Agents keep changing the code. Humans should still understand it.</h2>
          <p className="section-lede">
            Codiluce exists so the people responsible for a system still understand it, whoever made the last commit. It
            answers the questions a review of the diff cannot.
          </p>
          <GoalDiff />
        </div>
      </section>

      <section className="section agents-section" id="agents" aria-labelledby="agents-title">
        <div className="container">
          <p className="eyebrow">Agents</p>
          <h2 id="agents-title" className="section-title">Work with your agents, not behind them.</h2>
          <p className="section-lede">
            Connect Claude Code, Codex or Cursor once. Your agent reads the index instead of guessing from file names,
            explains what it finds on your map, and every file it touches lights up while it works.
          </p>
          <div className="agent-cards">
            <article className="agent-card">
              <AgentTerminal />
              <div className="agent-card-text">
                <h3>Explain it with your agent</h3>
                <p>
                  Ask in your own words. The agent follows flows, blast radius, history and source through Codiluce&apos;s MCP
                  server, and publishes its answer to the map&apos;s Explain column. While it works, the map shows what it is
                  explaining and each tool it calls.<NextTag feature="working-card" />
                </p>
                <ul className="ticks">
                  <li>Every link is checked against the index before the answer is saved</li>
                  <li>Answers are pinned to their commit and say when the code they link changes</li>
                  <li>No agent at hand? Ask in the map, with your own Anthropic or OpenAI key</li>
                </ul>
                <CodeBlock prompt code="claude mcp add codiluce -- npx -y codiluce mcp" />
                <Link href="/docs/explanations/" className="text-link">Explanations →</Link>
              </div>
            </article>
            <article className="agent-card">
              <HookStatus />
              <div className="agent-card-text">
                <h3>Watch them work <NextTag feature="agents" /></h3>
                <p>
                  Open <strong>Agents</strong> beside the map to follow every Claude Code and Codex session at once. Each read,
                  edit and search marks the code it touched in that session&apos;s color, and fades after 30 seconds.
                </p>
                <ul className="ticks">
                  <li>When two sessions touch the same file, both marks show</li>
                  <li>Click a path in the feed to reveal the file, even one added since the last index</li>
                  <li>Only paths, searches and tool names are kept, in memory: never prompts, file contents or output</li>
                </ul>
                <Link href="/docs/agents/" className="text-link">Agents →</Link>
              </div>
            </article>
          </div>
        </div>
      </section>

      <section className="section more-section" id="more" aria-labelledby="more-title">
        <div className="container">
          <p className="eyebrow">And more</p>
          <h2 id="more-title" className="section-title">One map for every question about the code.</h2>
          <ul className="more-grid">
            {MORE.map(item => (
              <li key={item.title} className="more-item">
                {item.glyph}
                <h3>{item.title}{item.next ? <NextTag feature={item.next} /> : null}</h3>
                <p>{item.text}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="section shapes-section" id="shapes" aria-labelledby="shapes-title">
        <div className="container">
          <div className="feature stacked">
            <div className="feature-text">
              <p className="eyebrow">Shapes</p>
              <h2 id="shapes-title" className="section-title">Every kind of file has a shape.</h2>
              <p>
                Controllers are rail turntables sending requests on their way, services are workshops, tables are storage drums,
                pages are browser billboards and tests are lab benches. Codiluce takes each file&apos;s kind from the index where it
                can, and from folder conventions otherwise, with one set of shapes for every language and framework. A folder of
                components and a folder of migrations look different before you read a label.
              </p>
            </div>
            <ShapeGallery />
          </div>
        </div>
      </section>

      <section className="section stacks-section" id="stacks" aria-labelledby="stacks-title">
        <div className="container">
          <p className="eyebrow">Stacks</p>
          <h2 id="stacks-title" className="section-title">Reads the stacks your team ships.</h2>
          <p className="section-lede">
            Codiluce maps any repository, and follows routes, handlers and calls through the languages and frameworks
            below. Every link carries its evidence; what it cannot prove stays visible.
          </p>
          <Stacks />
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
